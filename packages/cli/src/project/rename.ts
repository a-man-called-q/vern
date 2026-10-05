import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLI_PACKAGE } from "../lib/commands";
import { writeJson } from "../lib/files";
import { AUTH_SERVER } from "../lib/projects";
import { git, gitTry, run } from "../lib/run";
import {
	CONFIG_PATH,
	type ProjectConfig,
	readConfig,
	UPSTREAM_BRANCH,
	UPSTREAM_URL,
} from "./config";
import { CLI_SOURCE, CLI_WORKFLOW, isVernOnly, listTextFiles } from "./files";
import { rebrandText, replaceIdentity, validateIdentity } from "./identity";

export interface Options {
	name: string;
	slug: string;
	apply: boolean;
	base?: string;
	/** Leave the source of the CLI where it is: for a rename of Vern's own checkout. */
	keepCli?: boolean;
}

function fetchUpstream(root: string, url: string, branch: string): string {
	const ref = "refs/vern/upstream-main";
	run("git", ["fetch", "--no-tags", url, "+refs/heads/" + branch + ":" + ref], { cwd: root });
	return ref;
}

function resolveBase(root: string, url: string, branch: string, explicit?: string): string {
	let upstreamRef: string | undefined;
	if (explicit) {
		const refExists = gitTry(root, "rev-parse", "--verify", "refs/vern/upstream-main");
		upstreamRef = refExists.status === 0 ? "refs/vern/upstream-main" : fetchUpstream(root, url, branch);
		let commit = gitTry(root, "rev-parse", explicit + "^{commit}");
		if (commit.status !== 0) {
			upstreamRef = fetchUpstream(root, url, branch);
			commit = gitTry(root, "rev-parse", explicit + "^{commit}");
		}
		if (commit.status !== 0) throw new Error("Base commit " + explicit + " is not available locally or from upstream.");
		const reachable = gitTry(root, "merge-base", "--is-ancestor", commit.stdout.trim(), upstreamRef);
		if (reachable.status !== 0) throw new Error("Base commit " + explicit + " is not reachable from Vern " + branch + ".");
		return commit.stdout.trim();
	}

	upstreamRef = fetchUpstream(root, url, branch);
	const mergeBase = gitTry(root, "merge-base", "HEAD", upstreamRef);
	if (mergeBase.status === 0) return mergeBase.stdout.trim();

	const localTree = git(root, "rev-parse", "HEAD^{tree}").stdout.trim();
	const history = git(root, "log", "--format=%H%x09%T", upstreamRef).stdout.split(/\r?\n/);
	for (const row of history) {
		const [sha, tree] = row.split("\t");
		if (sha && tree === localTree) return sha;
	}
	throw new Error(
		"Could not infer the Vern baseline. Re-run with --base <sha> from " + url + " (" + branch + ").",
	);
}

function checkComposeData(root: string, oldName: string, newName: string): void {
	if (oldName === newName) return;
	const compose = resolve(root, `${AUTH_SERVER}/docker-compose.yml`);
	if (!existsSync(compose)) return;
	// The stack cannot start without deploy/dev/auth-server/.env (the compose file requires
	// ZITADEL_VERSION from it), so a tree without one owns no containers or volumes.
	// Any `<oldName>` project Docker knows about then belongs to another checkout.
	if (!existsSync(resolve(root, `${AUTH_SERVER}/.env`))) return;
	const volumeList = run("docker", ["volume", "ls", "--format", "{{.Name}}"], {
		cwd: root,
		allowFailure: true,
	});
	if (volumeList.status !== 0) {
		throw new Error("Could not inspect Docker volumes. Start Docker and retry the rename so local auth data can be protected.");
	}
	const running = run(
		"docker",
		["ps", "-aq", "--filter", "label=com.docker.compose.project=" + oldName],
		{ cwd: root, allowFailure: true },
	);
	if (running.status !== 0) throw new Error("Could not inspect Docker containers. Start Docker and retry the rename.");
	if (running.stdout.trim()) {
		throw new Error("Docker Compose project " + oldName + " is running. Stop it before renaming.");
	}
	const prefix = oldName + "_";
	const volumes = volumeList.stdout.split(/\r?\n/).filter((name) => name.startsWith(prefix));
	if (volumes.length > 0) {
		throw new Error(
			"Docker volumes still use the " + oldName + " prefix (" + volumes.join(", ") + "). Rename/migrate the Compose data manually before changing the project name.",
		);
	}
}

function composeProjectName(root: string): string | undefined {
	const path = resolve(root, `${AUTH_SERVER}/docker-compose.yml`);
	if (!existsSync(path)) return undefined;
	const match = readFileSync(path, "utf8").match(/^name:\s*([^\s#]+)/m);
	return match?.[1];
}

/**
 * What only Vern's own repository holds, when this tree still has it: the
 * source of the CLI and its workflow. A project's own packages/cli is not it.
 */
function vernOnlyPaths(root: string): string[] {
	const manifest = resolve(root, CLI_SOURCE, "package.json");
	if (!existsSync(manifest)) return [];
	const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
	if (name !== CLI_PACKAGE) return [];
	return [CLI_SOURCE, CLI_WORKFLOW].filter((path) => existsSync(resolve(root, path)));
}

export function renameProject(root: string, options: Options): string[] {
	const existing = readConfig(root);
	const from = existing?.project ?? { name: "Vern", slug: "vern" };
	const to = { name: options.name.trim(), slug: options.slug };
	validateIdentity(to.name, to.slug);
	if (from.name === to.name && from.slug === to.slug && existing) {
		console.log("Project identity is already " + to.name + " (" + to.slug + "); nothing to change.");
		return [];
	}

	// The source of the CLI names Vern on purpose (the upstream it follows, the
	// identity it renames from), so it leaves, or stays as Vern wrote it.
	const cliSource = vernOnlyPaths(root);
	const changed: Array<{ path: string; content: string }> = [];
	for (const path of listTextFiles(root)) {
		if (cliSource.length > 0 && isVernOnly(path)) continue;
		const absolute = resolve(root, path);
		const source = readFileSync(absolute, "utf8");
		const content = rebrandText(path, source, from, to);
		if (content !== source) changed.push({ path, content });
	}

	const removed = options.keepCli ? [] : cliSource;
	const oldComposeName = composeProjectName(root);
	const newComposeName = oldComposeName
		? replaceIdentity(oldComposeName, from, to)
		: undefined;
	console.log("Rename preview: " + from.name + " (" + from.slug + ") → " + to.name + " (" + to.slug + ")");
	if (changed.length === 0) console.log("  No text files need edits.");
	else for (const item of changed) console.log("  " + item.path);
	if (newComposeName && oldComposeName !== newComposeName) {
		console.log("  Compose project: " + oldComposeName + " → " + newComposeName);
	}
	if (removed.length > 0) {
		console.log("  Removes " + removed.join(" and ") + ": the project installs " + CLI_PACKAGE + " from npm.");
	}
	if (!options.apply) {
		console.log("Preview only. Add --apply to write these changes.");
		return changed.map((item) => item.path);
	}

	const status = git(root, "status", "--porcelain").stdout.trim();
	if (status) throw new Error("Working tree must be clean before applying a rename.");
	if (oldComposeName && newComposeName) checkComposeData(root, oldComposeName, newComposeName);

	const upstreamUrl = existing?.upstream.url ?? UPSTREAM_URL;
	const branch = existing?.upstream.branch ?? UPSTREAM_BRANCH;
	const baseline = existing?.upstream.lastSyncedSha ?? resolveBase(root, upstreamUrl, branch, options.base);
	const config: ProjectConfig = {
		// A second rename keeps what else the project recorded, such as its environments.
		...existing,
		schemaVersion: 1,
		project: to,
		upstream: { url: upstreamUrl, branch, lastSyncedSha: baseline },
	};
	const lockPath = resolve(root, "bun.lock");
	const configPath = resolve(root, CONFIG_PATH);
	const originalFiles = changed.map((item) => ({
		path: resolve(root, item.path),
		content: readFileSync(resolve(root, item.path)),
	}));
	const originalLock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
	const originalConfig = existsSync(configPath) ? readFileSync(configPath) : undefined;
	try {
		for (const item of changed) writeFileSync(resolve(root, item.path), item.content);
		for (const path of removed) rmSync(resolve(root, path), { recursive: true, force: true });
		if (existsSync(lockPath)) run("bun", ["install", "--lockfile-only", "--no-save"], { cwd: root });
		writeJson(configPath, config);
	} catch (error) {
		for (const item of originalFiles) writeFileSync(item.path, item.content);
		// The working tree was clean, so Git has what was removed.
		if (removed.length > 0) git(root, "checkout", "HEAD", "--", ...removed);
		if (originalLock) writeFileSync(lockPath, originalLock);
		else rmSync(lockPath, { force: true });
		if (originalConfig) writeFileSync(configPath, originalConfig);
		else rmSync(configPath, { force: true });
		throw error;
	}
	console.log("Renamed project and wrote " + CONFIG_PATH + ".");
	if (removed.length > 0 && existsSync(resolve(root, "node_modules")))
		console.log("Run `bun install`: the CLI now comes from npm.");
	return changed.map((item) => item.path);
}
