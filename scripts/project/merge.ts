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
import { isVernScript, readGitFile } from "./files";
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

/**
 * Folders `moon generate` made in this project: Vern itself ships no moon.yml
 * there, before the update or after it (a folder Vern moved is in one of them).
 */
function generatedProjectDirs(root: string, upstreamFiles: Set<string>[]): Set<string> {
	return new Set(
		listProjects(root)
			.map((project) => project.path)
			.filter((path) => !upstreamFiles.some((files) => files.has(path + "/moon.yml"))),
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
		// `bun run setup -- --kubernetes` writes the project's own list of apps.
		path === "deploy/base/kustomization.yaml" ||
		path.endsWith("/bun.lock") ||
		path.endsWith("/Cargo.lock")
	)
		return true;
	if (path === ".env" || path.endsWith("/.env")) return true;
	const projectDir = path.match(/^(?:apps|services|deploy\/dev)\/[^/]+(?=\/)/)?.[0];
	return Boolean(projectDir && generatedDirs.has(projectDir));
}

function rebrand(data: Buffer, path: string, config: ProjectConfig): Buffer {
	const text = new TextDecoder().decode(data);
	return Buffer.from(
		rebrandText(path, text, { name: "Vern", slug: "vern" }, config.project),
		"utf8",
	);
}

/**
 * Upstream's copy of a file as this project's rename would have written it, so
 * the merge compares like with like. Scripts are never rebranded (see
 * isVernScript).
 */
function rebrandSnapshot(
	path: string,
	data: Buffer,
	config: ProjectConfig,
): Buffer {
	if (!isTextBuffer(data) || isVernScript(path) || path.startsWith(".vern/"))
		return data;
	return rebrand(data, path, config);
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

/** What to do with one file, given its three versions. */
type Plan =
	| { kind: "keep" }
	| { kind: "delete" }
	| { kind: "write"; data: Buffer }
	/** `data` is the text merge with its conflict markers, when there is one. */
	| { kind: "conflict"; data?: Buffer };

function planMerge(
	root: string,
	path: string,
	ours: Buffer | undefined,
	versions: { base?: Buffer; theirs?: Buffer; renamedBase?: Buffer },
): Plan {
	const { base, theirs, renamedBase } = versions;
	// Ours is still upstream's base, or what an older rename made of it.
	const untouched =
		!!ours && !!base && (ours.equals(base) || !!renamedBase?.equals(ours));
	if (!theirs) {
		if (!ours) return { kind: "keep" };
		if (untouched) return { kind: "delete" };
		return { kind: "conflict" };
	}
	if (!ours) return base ? { kind: "conflict" } : { kind: "write", data: theirs };
	if (ours.equals(theirs)) return { kind: "keep" };
	if (!base || untouched) return { kind: "write", data: theirs };
	if (theirs.equals(base)) return { kind: "keep" };
	if (!isTextBuffer(ours) || !isTextBuffer(base) || !isTextBuffer(theirs))
		return { kind: "conflict" };
	const merged = mergeText(root, path, ours, base, theirs);
	return merged.conflicted
		? { kind: "conflict", data: merged.data }
		: { kind: "write", data: merged.data };
}

function snapshots(
	root: string,
	config: ProjectConfig,
	from: string,
	to: string,
	path: string,
): { base?: Buffer; theirs?: Buffer; renamedBase?: Buffer } {
	const baseRaw = readGitFile(root, from, path);
	const targetRaw = readGitFile(root, to, path);
	return {
		base: baseRaw ? rebrandSnapshot(path, baseRaw, config) : undefined,
		theirs: targetRaw ? rebrandSnapshot(path, targetRaw, config) : undefined,
		// A rename used to rebrand most scripts; such a copy is not a local change.
		renamedBase:
			baseRaw && isVernScript(path) && isTextBuffer(baseRaw)
				? rebrand(baseRaw, path, config)
				: undefined,
	};
}

function readWorkingFile(absolute: string): Buffer | undefined {
	return existsSync(absolute) && statSync(absolute).isFile()
		? readFileSync(absolute)
		: undefined;
}

export function mergeUpstreamFiles(
	root: string,
	config: ProjectConfig,
	from: string,
	to: string,
): { updated: string[]; conflicts: Conflict[] } {
	const generatedDirs = generatedProjectDirs(root, [upstreamPaths(root, from), upstreamPaths(root, to)]);
	const updated: string[] = [];
	const conflicts: Conflict[] = [];
	for (const path of allChangedUpstreamPaths(root, from, to)) {
		if (shouldSkipUpstreamPath(path, generatedDirs)) continue;
		const absolute = safeProjectPath(root, path);
		const versions = snapshots(root, config, from, to, path);
		const ours = readWorkingFile(absolute);
		const plan = planMerge(root, path, ours, versions);
		if (plan.kind === "keep") continue;
		if (plan.kind === "delete") {
			unlinkSync(absolute);
			updated.push(path);
		} else if (plan.kind === "write") {
			writeFileSafely(root, path, plan.data);
			updated.push(path);
		} else if (plan.data) {
			writeFileSafely(root, path, plan.data);
			updated.push(path);
			conflicts.push({ path, initialHash: sha256(plan.data) });
		} else {
			conflicts.push({ path, initialHash: ours ? sha256(ours) : "<missing>" });
		}
	}
	return { updated, conflicts };
}

/**
 * Merges again each conflict the user has not touched, from the project's own
 * copy (in HEAD). An older updater counted a script that an older rename had
 * rebranded as changed locally, so every upstream change to it was a
 * conflict; those settle here. Returns the conflicts that remain, and the
 * paths it settled.
 */
export function settleConflicts(
	root: string,
	config: ProjectConfig,
	from: string,
	to: string,
	conflicts: Conflict[],
): { remaining: Conflict[]; settled: string[] } {
	const remaining: Conflict[] = [];
	const settled: string[] = [];
	for (const conflict of conflicts) {
		const absolute = safeProjectPath(root, conflict.path);
		const current = readWorkingFile(absolute);
		const ours = readGitFile(root, "HEAD", conflict.path);
		if (
			(current ? sha256(current) : "<missing>") !== conflict.initialHash ||
			(ours && /^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(ours.toString("utf8")))
		) {
			remaining.push(conflict);
			continue;
		}
		const plan = planMerge(
			root,
			conflict.path,
			ours,
			snapshots(root, config, from, to, conflict.path),
		);
		if (plan.kind === "conflict") {
			remaining.push(conflict);
			continue;
		}
		if (plan.kind === "write") writeFileSafely(root, conflict.path, plan.data);
		else if (plan.kind === "delete" || !ours) rmSync(absolute, { force: true });
		else writeFileSafely(root, conflict.path, ours);
		settled.push(conflict.path);
	}
	return { remaining, settled };
}
