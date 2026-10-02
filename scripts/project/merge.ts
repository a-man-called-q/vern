import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isTextBuffer, sha256, writeFileSafely } from "../lib/files";
import { listProjects } from "../lib/projects";
import { git, run } from "../lib/run";
import { CONFIG_PATH, type ProjectConfig, UPDATE_STATE_PATH } from "./config";
import { readGitFile } from "./files";
import { rebrandText } from "./identity";

/** A file the merge left for the user, and its hash then, to tell when it is resolved. */
export type Conflict = { path: string; initialHash: string };

function upstreamPaths(root: string, revision: string): Set<string> {
	return new Set(
		git(root, "ls-tree", "-r", "--name-only", revision)
			.stdout.split(/\r?\n/)
			.filter(Boolean),
	);
}

/** Folders `moon generate` made in this project: Vern itself ships no moon.yml there. */
function generatedProjectDirs(root: string, baseFiles: Set<string>): Set<string> {
	return new Set(
		listProjects(root)
			.map((project) => project.path)
			.filter((path) => !baseFiles.has(path + "/moon.yml")),
	);
}

function shouldSkipUpstreamPath(
	path: string,
	generatedDirs: Set<string>,
): boolean {
	if (
		path === UPDATE_STATE_PATH ||
		path === CONFIG_PATH ||
		path === "bun.lock" ||
		path.endsWith("/bun.lock") ||
		path.endsWith("/Cargo.lock")
	)
		return true;
	if (path === ".env" || path.endsWith("/.env")) return true;
	const projectDir = path.match(/^(?:apps|services|infra)\/[^/]+(?=\/)/)?.[0];
	return Boolean(projectDir && generatedDirs.has(projectDir));
}

function rebrandSnapshot(
	path: string,
	data: Buffer,
	config: ProjectConfig,
): Buffer {
	if (
		!isTextBuffer(data) ||
		path.startsWith("scripts/") ||
		path.startsWith(".vern/")
	)
		return data;
	const text = new TextDecoder().decode(data);
	return Buffer.from(
		rebrandText(path, text, { name: "Vern", slug: "vern" }, config.project),
		"utf8",
	);
}

export function allChangedUpstreamPaths(
	root: string,
	from: string,
	to: string,
): string[] {
	return git(root, "diff", "--name-only", "--no-renames", from, to)
		.stdout.split(/\r?\n/)
		.filter(Boolean)
		.sort();
}

export function safeProjectPath(root: string, path: string): string {
	if (path.startsWith("/") || path.split("/").includes("..")) {
		throw new Error("Upstream contains an unsafe path: " + path);
	}
	const absolute = resolve(root, path);
	if (!absolute.startsWith(root + sep))
		throw new Error("Upstream path escapes the project: " + path);
	return absolute;
}

function mergeText(
	root: string,
	path: string,
	ours: Buffer,
	base: Buffer,
	theirs: Buffer,
): { data: Buffer; conflicted: boolean } {
	const tempDir = mkdtempSync(join(tmpdir(), "vern-merge-"));
	const localTemp = join(tempDir, "ours");
	const baseTemp = localTemp + ".base";
	const targetTemp = localTemp + ".theirs";
	try {
		writeFileSync(localTemp, ours);
		writeFileSync(baseTemp, base);
		writeFileSync(targetTemp, theirs);
		const result = run(
			"git",
			["merge-file", "-p", "--", localTemp, baseTemp, targetTemp],
			{ cwd: root, allowFailure: true },
		);
		if (result.status > 1) {
			throw new Error(
				"git merge-file failed for " + path + ": " + result.stderr.trim(),
			);
		}
		return {
			data: Buffer.from(result.stdout, "utf8"),
			conflicted: result.status === 1,
		};
	} finally {
		rmSync(localTemp, { force: true });
		rmSync(baseTemp, { force: true });
		rmSync(targetTemp, { force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}
}

export function mergeUpstreamFiles(
	root: string,
	config: ProjectConfig,
	from: string,
	to: string,
): { updated: string[]; conflicts: Conflict[] } {
	const baseFiles = upstreamPaths(root, from);
	const generatedDirs = generatedProjectDirs(root, baseFiles);
	const updated: string[] = [];
	const conflicts: Conflict[] = [];
	for (const path of allChangedUpstreamPaths(root, from, to)) {
		if (shouldSkipUpstreamPath(path, generatedDirs)) continue;
		const absolute = safeProjectPath(root, path);
		const baseRaw = readGitFile(root, from, path);
		const targetRaw = readGitFile(root, to, path);
		const base = baseRaw ? rebrandSnapshot(path, baseRaw, config) : undefined;
		const theirs = targetRaw
			? rebrandSnapshot(path, targetRaw, config)
			: undefined;
		const ours =
			existsSync(absolute) && statSync(absolute).isFile()
				? readFileSync(absolute)
				: undefined;

		if (!theirs) {
			if (!ours) continue;
			if (base && ours.equals(base)) {
				unlinkSync(absolute);
				updated.push(path);
				continue;
			}
			conflicts.push({ path, initialHash: sha256(ours) });
			continue;
		}
		if (!ours) {
			if (base) {
				conflicts.push({ path, initialHash: "<missing>" });
				continue;
			}
			writeFileSafely(root, path, theirs);
			updated.push(path);
			continue;
		}
		if (ours.equals(theirs)) continue;
		if (!base || ours.equals(base)) {
			writeFileSafely(root, path, theirs);
			updated.push(path);
			continue;
		}
		if (theirs.equals(base)) continue;
		if (!isTextBuffer(ours) || !isTextBuffer(base) || !isTextBuffer(theirs)) {
			conflicts.push({ path, initialHash: sha256(ours) });
			continue;
		}
		const merged = mergeText(root, path, ours, base, theirs);
		writeFileSafely(root, path, merged.data);
		updated.push(path);
		if (merged.conflicted)
			conflicts.push({ path, initialHash: sha256(merged.data) });
	}
	return { updated, conflicts };
}
