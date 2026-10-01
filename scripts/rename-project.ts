import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CONFIG_PATH,
	ROOT,
	UPSTREAM_BRANCH,
	UPSTREAM_URL,
	git,
	gitTry,
	listTextFiles,
	readConfig,
	rebrandText,
	replaceIdentity,
	run,
	validateIdentity,
	writeJson,
	type ProjectConfig,
} from "./project-utils";

export interface Options {
	name: string;
	slug: string;
	apply: boolean;
	base?: string;
}

const protectedScripts = new Set([
	"scripts/project-utils.ts",
	"scripts/rename-project.ts",
	"scripts/project-scripts.test.ts",
	"scripts/update-project.ts",
	"scripts/doctor.ts",
]);

function parseArgs(argv: string[]): Options | undefined {
	let name = "";
	let slug = "";
	let apply = false;
	let base: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") return undefined;
		if (arg === "--apply") apply = true;
		else if (arg === "--name") name = argv[++i] ?? "";
		else if (arg === "--slug") slug = argv[++i] ?? "";
		else if (arg === "--base") base = argv[++i];
		else throw new Error("Unknown option: " + arg);
	}
	if (!name || !slug) throw new Error("Provide both --name and --slug.");
	validateIdentity(name, slug);
	return { name: name.trim(), slug, apply, base };
}

function help(): void {
	console.log("Usage: bun scripts/rename-project.ts --name <display name> --slug <kebab-case> [--apply] [--base <sha>]\n\nPreview is the default. Add --apply to rewrite the workspace and record its Vern upstream baseline.\nIf the baseline cannot be inferred from Git history or a matching tree, provide --base.");
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
	const compose = resolve(root, "apps/auth-server/docker-compose.yml");
	if (!existsSync(compose)) return;
	// The stack cannot start without apps/auth-server/.env (the compose file requires
	// ZITADEL_VERSION from it), so a tree without one owns no containers or volumes.
	// Any `<oldName>` project Docker knows about then belongs to another checkout.
	if (!existsSync(resolve(root, "apps/auth-server/.env"))) return;
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
	const path = resolve(root, "apps/auth-server/docker-compose.yml");
	if (!existsSync(path)) return undefined;
	const match = readFileSync(path, "utf8").match(/^name:\s*([^\s#]+)/m);
	return match?.[1];
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

	const changed: Array<{ path: string; content: string }> = [];
	for (const path of listTextFiles(root)) {
		if (protectedScripts.has(path)) continue;
		const absolute = resolve(root, path);
		const source = readFileSync(absolute, "utf8");
		const content = rebrandText(path, source, from, to);
		if (content !== source) changed.push({ path, content });
	}

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
		if (existsSync(lockPath)) run("bun", ["install", "--lockfile-only", "--no-save"], { cwd: root });
		writeJson(configPath, config);
	} catch (error) {
		for (const item of originalFiles) writeFileSync(item.path, item.content);
		if (originalLock) writeFileSync(lockPath, originalLock);
		else rmSync(lockPath, { force: true });
		if (originalConfig) writeFileSync(configPath, originalConfig);
		else rmSync(configPath, { force: true });
		throw error;
	}
	console.log("Renamed project and wrote " + CONFIG_PATH + ".");
	return changed.map((item) => item.path);
}

if (import.meta.main) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (!options) help();
		else renameProject(ROOT, options);
	} catch (error) {
		console.error("rename-project: " + (error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
	}
}
