import { chmodSync, existsSync, readdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileSafely, writeJson } from "../lib/files";
import { git, gitTry } from "../lib/run";
import { CONFIG_PATH, type ProjectConfig, readConfig } from "./config";
import {
	choicesFor,
	describeEnvironments,
	ENVIRONMENTS,
	type Environment,
	type Environments,
	IMAGES_WORKFLOW,
	isSetupOutput,
	isUsed,
	keyFiles,
	METHOD_LABELS,
	METHODS,
	purposeOf,
	SETUP_OUTPUT,
} from "./environments";
import { readGitFile } from "./files";
import { rebrandSnapshot } from "./merge";

export type StackResult = {
	environments: Environments;
	/** Vern's files of a way the project no longer uses, now deleted. */
	removed: string[];
	/** Vern's files of a way the project uses again, back from upstream. */
	restored: string[];
	/** What `setup` wrote for a way an environment no longer runs with; Git ignores it, so it stays. */
	leftovers: string[];
};

function filesUnder(root: string, dir: string): string[] {
	const absolute = resolve(root, dir);
	if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
	return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
		const path = `${dir}/${entry.name}`;
		// An environment's settings and secrets are not Vern's.
		if (isSetupOutput(path)) return [];
		return entry.isDirectory() ? filesUnder(root, path) : [path];
	});
}

function foldersOf(root: string, dir: string): string[] {
	const absolute = resolve(root, dir);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${dir}/${entry.name}`);
}

/** Every file in the project that belongs to one way of running an environment. */
function methodFiles(root: string): string[] {
	const dirs = [
		"deploy/compose",
		"deploy/base",
		...ENVIRONMENTS.map((environment) => `deploy/${environment}`),
		...[".templates", ".vern/templates", "apps", "services"].flatMap((parent) => foldersOf(root, parent).map((dir) => `${dir}/k8s`)),
	];
	return [...dirs.flatMap((dir) => filesUnder(root, dir)), ...(existsSync(resolve(root, IMAGES_WORKFLOW)) ? [IMAGES_WORKFLOW] : [])]
		.filter((path) => purposeOf(path) !== undefined)
		.sort();
}

/** Of `paths`, the ones Git would lose: changed since the last commit, or never committed. */
function uncommitted(root: string, paths: string[]): string[] {
	if (paths.length === 0 || gitTry(root, "rev-parse", "--is-inside-work-tree").status !== 0) return [];
	const changed = new Set(
		git(root, "status", "--porcelain", "--untracked-files=all")
			.stdout.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => line.slice(3).split(" -> ")),
	);
	return paths.filter((path) => changed.has(path));
}

function removeFiles(root: string, paths: string[]): void {
	for (const path of paths) {
		rmSync(resolve(root, path), { force: true });
		// A folder Vern's files leave empty goes with them.
		for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
			const absolute = resolve(root, dir);
			if (!existsSync(absolute) || readdirSync(absolute).length > 0) break;
			rmdirSync(absolute);
		}
	}
}

/** The upstream commit the project is synced to, fetched when a new project does not have it yet. */
function upstreamCommit(root: string, config: ProjectConfig): string {
	const sha = config.upstream.lastSyncedSha;
	const has = () => gitTry(root, "cat-file", "-e", `${sha}^{commit}`).status === 0;
	if (has()) return sha;
	const fetched = gitTry(root, "fetch", "--no-tags", config.upstream.url, `+refs/heads/${config.upstream.branch}:refs/vern/upstream-main`);
	if (fetched.status !== 0 || !has()) {
		throw new Error(
			`Bringing files back needs Vern's commit ${sha.slice(0, 12)}, which could not be fetched from ${config.upstream.url}.${fetched.stderr.trim() ? `\n${fetched.stderr.trim()}` : ""}`,
		);
	}
	return sha;
}

/**
 * Writes the upstream files of what the project uses now and does not have
 * (it did not use it before, or its key file is gone), as the project's rename
 * would have written them. A file that is there is kept.
 */
function restoreFiles(root: string, config: ProjectConfig, next: Environments): string[] {
	const wanted = keyFiles(next).filter(({ file, used }) => used && (!isUsed(file, config.environments) || !existsSync(resolve(root, file))));
	// Nothing to bring back, and no need for Vern's history.
	if (wanted.length === 0) return [];
	const back = (path: string) => {
		const purpose = purposeOf(path);
		return Boolean(purpose && wanted.some((item) => item.method === purpose.method && item.environment === purpose.environment));
	};
	const sha = upstreamCommit(root, config);
	const restored: string[] = [];
	for (const line of git(root, "ls-tree", "-r", sha).stdout.split(/\r?\n/)) {
		const match = line.match(/^(\d+) blob \S+\t(.+)$/);
		if (!match) continue;
		const [, mode, path] = match as unknown as [string, string, string];
		if (!back(path) || existsSync(resolve(root, path))) continue;
		const data = readGitFile(root, sha, path);
		if (!data) continue;
		writeFileSafely(root, path, rebrandSnapshot(path, data, config));
		if (mode === "100755") chmodSync(resolve(root, path), 0o755);
		restored.push(path);
	}
	return restored;
}

/** What `setup` left in an environment's folder for a way it no longer runs with. */
function findLeftovers(root: string, environments: Environments): string[] {
	return ENVIRONMENTS.flatMap((environment) =>
		METHODS.filter((method) => environments[environment] !== method).flatMap((method) =>
			SETUP_OUTPUT[method].map((name) => `deploy/${environment}/${name}`).filter((path) => existsSync(resolve(root, path))),
		),
	);
}

/**
 * Records how each environment runs in .vern/config.json and makes the project
 * hold only that: Vern's files of a way no environment uses are deleted, and
 * the ones of a way chosen again come back from upstream. An environment that
 * `requested` does not name keeps its choice.
 */
export function chooseEnvironments(root: string, requested: Partial<Environments>): StackResult {
	const config = readConfig(root);
	if (!config) {
		throw new Error(
			`${CONFIG_PATH} is missing: this is not a project yet (or it is the Vern template itself, which keeps both ways). Run rename-project.ts first.`,
		);
	}
	const next = {} as Environments;
	for (const environment of ENVIRONMENTS) {
		const choice = requested[environment] ?? config.environments?.[environment];
		if (!choice) {
			throw new Error(
				`Say how ${environment} runs: --${environment} ${choicesFor(environment).join("|")}. The first time, every environment needs a choice.`,
			);
		}
		if (!choicesFor(environment).includes(choice)) {
			throw new Error(`--${environment} takes ${choicesFor(environment).join(", ").replace(/, (\w+)$/, ", or $1")}.`);
		}
		next[environment] = choice;
	}

	const remove = methodFiles(root).filter((path) => !isUsed(path, next));
	const unsaved = uncommitted(root, remove);
	if (unsaved.length > 0) {
		throw new Error(
			`These files would be deleted, and have changes that are not committed. Commit or discard them first:\n${unsaved.map((path) => `  ${path}`).join("\n")}`,
		);
	}
	// First what can fail (it may need the network), so a failure changes nothing.
	const restored = restoreFiles(root, config, next);
	removeFiles(root, remove);
	writeJson(resolve(root, CONFIG_PATH), { ...config, environments: next } satisfies ProjectConfig);
	return { environments: next, removed: remove, restored, leftovers: findLeftovers(root, next) };
}

/** `deploy/compose (5 files)`: paths by the folder they were in. */
function byFolder(paths: string[]): string[] {
	const counts = new Map<string, number>();
	for (const path of paths) {
		const parts = path.split("/");
		const folder = parts[0] === "deploy" ? parts.slice(0, 2).join("/") : path === IMAGES_WORKFLOW ? path : path.slice(0, path.indexOf("/k8s/") + 4);
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
	}
	return [...counts].map(([folder, count]) => (folder === IMAGES_WORKFLOW ? folder : `${folder} (${count} file${count === 1 ? "" : "s"})`));
}

/** What the command prints after a choice. */
export function describeResult(result: StackResult): string[] {
	const { environments } = result;
	const lines = [`Environments: ${describeEnvironments(environments)} (saved in ${CONFIG_PATH}).`];
	if (result.removed.length > 0) lines.push("Removed, because no environment uses it:", ...byFolder(result.removed).map((line) => `  ${line}`));
	if (result.restored.length > 0) lines.push("Brought back from Vern:", ...byFolder(result.restored).map((line) => `  ${line}`));
	if (result.removed.length === 0 && result.restored.length === 0) lines.push("The project already holds exactly what these need.");
	if (result.leftovers.length > 0) {
		lines.push(
			"Still there, from the way an environment ran before (Git ignores them, and they may hold secrets). Delete them once you no longer need them:",
			...result.leftovers.map((path) => `  ${path}`),
		);
	}
	const first = ENVIRONMENTS.filter((environment) => environments[environment] !== "none").map((environment) => {
		const method = environments[environment] as keyof typeof METHOD_LABELS;
		return `  bun run setup -- --env ${environment}   # ${METHOD_LABELS[method]}`;
	});
	lines.push("Set an environment up, or run it again, with:", ...first);
	return lines;
}

export function environmentFlag(name: string): Environment | undefined {
	return ENVIRONMENTS.find((environment) => `--${environment}` === name);
}
