import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { isTextBuffer, sha256, writeFileSafely } from "../lib/files";
import { listProjects } from "../lib/projects";
import { git, run } from "../lib/run";
import { CONFIG_PATH, type ProjectConfig, UPDATE_STATE_PATH } from "./config";
import { type Environments, isUsed } from "./environments";
import { isVernOnly, isVernScript, readGitFile } from "./files";
import { rebrandText, replaceIdentity } from "./identity";

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
	environments: Environments | undefined,
): boolean {
	// The source of the CLI: the project installs the package.
	if (isVernOnly(path)) return true;
	// A way to run an environment that the project does not use stays out.
	if (!isUsed(path, environments)) return true;
	if (
		path === UPDATE_STATE_PATH ||
		path === CONFIG_PATH ||
		path === "bun.lock" ||
		// One lockfile for the Cargo workspace: it names the project's own APIs.
		path === "Cargo.lock" ||
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
 * the merge compares like with like. The scripts of a project from before the
 * CLI was a package are never rebranded (see isVernScript). What Vern ships
 * under .vern/ (the templates, the recipes) is:
 * a rename rewrites it like any other file.
 */
export function rebrandSnapshot(
	path: string,
	data: Buffer,
	config: ProjectConfig,
): Buffer {
	if (!isTextBuffer(data) || isVernScript(path))
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
		// The exit status is the number of conflicts, capped at 127; an error is
		// 255. `run` also answers 127, with no output, when git could not start.
		if (result.status > 127 || (result.status === 127 && !result.stdout)) {
			throw new Error(
				"git merge-file failed for " + path + ": " + result.stderr.trim(),
			);
		}
		return {
			data: Buffer.from(result.stdout, "utf8"),
			conflicted: result.status > 0,
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
		// A rename used to rebrand most scripts, and to leave the imports it
		// renamed as they were, unsorted; such a copy is not a local change.
		renamedBase:
			baseRaw && isTextBuffer(baseRaw)
				? Buffer.from(
						replaceIdentity(
							new TextDecoder().decode(baseRaw),
							{ name: "Vern", slug: "vern" },
							config.project,
						),
						"utf8",
					)
				: undefined,
	};
}

function readWorkingFile(absolute: string): Buffer | undefined {
	return existsSync(absolute) && statSync(absolute).isFile()
		? readFileSync(absolute)
		: undefined;
}

/** Removes the folders a deleted file leaves empty, so a folder Vern moved does not stay behind. */
function removeEmptyParents(root: string, absolute: string): void {
	for (
		let dir = dirname(absolute);
		dir.startsWith(resolve(root) + sep) && existsSync(dir) && readdirSync(dir).length === 0;
		dir = dirname(dir)
	)
		rmdirSync(dir);
}

export function mergeUpstreamFiles(
	root: string,
	config: ProjectConfig,
	from: string,
	to: string,
): { updated: string[]; conflicts: Conflict[] } {
	const generatedDirs = generatedProjectDirs(root, [upstreamPaths(root, from), upstreamPaths(root, to)]);
	// Every file is planned before the first is written, so a merge that fails
	// leaves the working tree as it was.
	const plans: { path: string; absolute: string; ours?: Buffer; plan: Plan }[] = [];
	for (const path of allChangedUpstreamPaths(root, from, to)) {
		if (shouldSkipUpstreamPath(path, generatedDirs, config.environments)) continue;
		const absolute = safeProjectPath(root, path);
		const versions = snapshots(root, config, from, to, path);
		const ours = readWorkingFile(absolute);
		plans.push({ path, absolute, ours, plan: planMerge(root, path, ours, versions) });
	}
	const updated: string[] = [];
	const conflicts: Conflict[] = [];
	for (const { path, absolute, ours, plan } of plans) {
		if (plan.kind === "keep") continue;
		if (plan.kind === "delete") {
			unlinkSync(absolute);
			removeEmptyParents(root, absolute);
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
		else if (plan.kind === "delete" || !ours) {
			rmSync(absolute, { force: true });
			removeEmptyParents(root, absolute);
		} else writeFileSafely(root, conflict.path, ours);
		settled.push(conflict.path);
	}
	return { remaining, settled };
}
