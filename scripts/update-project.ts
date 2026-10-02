import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
	cargoConditions,
	restoreCargoConditions,
	stripCargoConditions,
} from "./cargo-template";
import {
	demoDependencies,
	formatPackageTemplate,
	renderPackageTemplate,
} from "./package-template";
import {
	CONFIG_PATH,
	git,
	gitTry,
	isTextBuffer,
	type ProjectConfig,
	ROOT,
	readConfig,
	readGitFile,
	rebrandText,
	run,
	sha256,
	UPDATE_STATE_PATH,
	writeFileSafely,
	writeJson,
} from "./project-utils";

interface UpdateState {
	schemaVersion: 1;
	branch: string;
	previousSha: string;
	targetSha: string;
	phase: "conflicts" | "dependencies" | "validate";
	conflicts: Array<{ path: string; initialHash: string }>;
}

export interface Options {
	apply: boolean;
	continueUpdate: boolean;
}

function parseArgs(argv: string[]): Options | undefined {
	let apply = false;
	let continueUpdate = false;
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") return undefined;
		if (arg === "--apply") apply = true;
		else if (arg === "--continue") continueUpdate = true;
		else throw new Error("Unknown option: " + arg);
	}
	if (apply && continueUpdate)
		throw new Error("Use either --apply or --continue.");
	return { apply, continueUpdate };
}

function help(): void {
	console.log(
		"Usage: bun scripts/update-project.ts [--apply | --continue]\n\nDefault: fetch Vern main and preview changed files.\n--apply: create a review branch, merge upstream changes, upgrade dependencies, and validate.\n--continue: resume a pending update after resolving file conflicts or a failed dependency/validation step.",
	);
}

function readState(root: string): UpdateState | undefined {
	const path = resolve(root, UPDATE_STATE_PATH);
	if (!existsSync(path)) return undefined;
	const state = JSON.parse(readFileSync(path, "utf8")) as UpdateState;
	if (
		state.schemaVersion !== 1 ||
		!state.branch ||
		!state.targetSha ||
		!state.phase
	) {
		throw new Error(UPDATE_STATE_PATH + " is malformed.");
	}
	return state;
}

function writeState(root: string, state: UpdateState): void {
	writeJson(resolve(root, UPDATE_STATE_PATH), state);
}

function fetchMain(root: string, config: ProjectConfig): string {
	const ref = "refs/vern/upstream-main";
	run(
		"git",
		[
			"fetch",
			"--no-tags",
			config.upstream.url,
			"+refs/heads/" + config.upstream.branch + ":" + ref,
		],
		{ cwd: root },
	);
	return git(root, "rev-parse", ref).stdout.trim();
}

function verifyCargoEdit(root: string): void {
	const result = run("cargo", ["upgrade", "--help"], {
		cwd: root,
		allowFailure: true,
	});
	if (
		result.status !== 0 ||
		!result.stdout.includes("Upgrade dependency version requirements")
	) {
		throw new Error(
			"cargo-edit is required to update Rust dependencies. Install it with: cargo install cargo-edit",
		);
	}
}

function upstreamPaths(root: string, revision: string): Set<string> {
	return new Set(
		git(root, "ls-tree", "-r", "--name-only", revision)
			.stdout.split(/\r?\n/)
			.filter(Boolean),
	);
}

function generatedAppDirs(root: string, baseFiles: Set<string>): Set<string> {
	const apps = resolve(root, "apps");
	if (!existsSync(apps)) return new Set();
	return new Set(
		readdirSync(apps, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.filter((name) => !baseFiles.has("apps/" + name + "/moon.yml")),
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
	const appMatch = path.match(/^apps\/([^/]+)\//);
	return Boolean(appMatch && generatedDirs.has(appMatch[1]));
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

function allChangedUpstreamPaths(
	root: string,
	from: string,
	to: string,
): string[] {
	return git(root, "diff", "--name-only", "--no-renames", from, to)
		.stdout.split(/\r?\n/)
		.filter(Boolean)
		.sort();
}

function safeProjectPath(root: string, path: string): string {
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
	const tempDir = mkTemp("vern-merge-");
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

function mergeUpstreamFiles(
	root: string,
	config: ProjectConfig,
	from: string,
	to: string,
): { updated: string[]; conflicts: UpdateState["conflicts"] } {
	const baseFiles = upstreamPaths(root, from);
	const generatedDirs = generatedAppDirs(root, baseFiles);
	const updated: string[] = [];
	const conflicts: UpdateState["conflicts"] = [];
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

function assertCargoEdit(root: string): void {
	verifyCargoEdit(root);
}

const START_PACKAGE = "@tanstack/react-start";
const ROUTER_PACKAGE = "@tanstack/react-router";

/**
 * `bun update --latest` bumps every @tanstack package on its own, but
 * @tanstack/react-start depends on one exact @tanstack/react-router. A second
 * router copy breaks route context at runtime, so the app's direct dependency
 * follows the version react-start uses. `searchRoots` are folders whose
 * node_modules hold the installed react-start. Returns whether it rewrote the file.
 */
export function alignRouterWithStart(
	manifestPath: string,
	searchRoots: string[],
): boolean {
	const text = readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(text) as {
		dependencies?: Record<string, string>;
	};
	const current = manifest.dependencies?.[ROUTER_PACKAGE];
	if (!current || !manifest.dependencies?.[START_PACKAGE]) return false;
	for (const searchRoot of searchRoots) {
		const installed = resolve(
			searchRoot,
			"node_modules",
			START_PACKAGE,
			"package.json",
		);
		if (!existsSync(installed)) continue;
		const wanted = (
			JSON.parse(readFileSync(installed, "utf8")) as {
				dependencies?: Record<string, string>;
			}
		).dependencies?.[ROUTER_PACKAGE];
		if (!wanted || wanted === current) return false;
		writeFileSync(
			manifestPath,
			text.replace(
				`"${ROUTER_PACKAGE}": "${current}"`,
				`"${ROUTER_PACKAGE}": "${wanted}"`,
			),
		);
		return true;
	}
	return false;
}

function alignWorkspaceRouters(root: string): void {
	const apps = resolve(root, "apps");
	if (!existsSync(apps)) return;
	for (const entry of readdirSync(apps, { withFileTypes: true })) {
		const manifest = resolve(apps, entry.name, "package.json");
		if (!entry.isDirectory() || !existsSync(manifest)) continue;
		alignRouterWithStart(manifest, [resolve(apps, entry.name), root]);
	}
}

function updateBunTemplate(
	root: string,
	template: string,
	label: string,
): void {
	const path = resolve(root, ".templates", template, "package.json.tera");
	if (!existsSync(path)) return;
	const tempRoot = mkTemp("vern-" + template + "-template-");
	try {
		const original = readFileSync(path, "utf8");
		const renderedName = "vern-template-" + template;
		// Every dependency is upgraded, the demo-only ones included: they go
		// back inside their block when the template is written.
		const withDemos = renderPackageTemplate(original, true);
		const rendered = withDemos.replace(
			'"name": "{{ name | kebab_case }}"',
			'"name": "' + renderedName + '"',
		);
		if (rendered === withDemos)
			throw new Error(
				"Could not render the " + label + " package name placeholder.",
			);
		const manifest = JSON.parse(rendered) as Record<string, unknown>;
		const workspaceDependencies: Record<string, Record<string, string>> = {};
		for (const section of ["dependencies", "devDependencies"]) {
			const values = manifest[section] as Record<string, string> | undefined;
			if (!values) continue;
			for (const [name, version] of Object.entries(values)) {
				if (version.startsWith("workspace:")) {
					let sectionDependencies = workspaceDependencies[section];
					if (!sectionDependencies) {
						sectionDependencies = {};
						workspaceDependencies[section] = sectionDependencies;
					}
					sectionDependencies[name] = version;
					delete values[name];
				}
			}
		}
		writeFileSync(
			resolve(tempRoot, "package.json"),
			JSON.stringify(manifest, null, 2) + "\n",
		);
		run("bun", ["update", "--latest"], { cwd: tempRoot });
		alignRouterWithStart(resolve(tempRoot, "package.json"), [tempRoot]);
		const updated = JSON.parse(
			readFileSync(resolve(tempRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;
		updated.name = "{{ name | kebab_case }}";
		for (const [section, entries] of Object.entries(workspaceDependencies)) {
			const sectionDependencies = updated[section] as
				| Record<string, string>
				| undefined;
			updated[section] = { ...sectionDependencies, ...entries };
		}
		writeFileSync(
			path,
			formatPackageTemplate(updated, demoDependencies(original)),
		);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function mkTemp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function updateRustTemplate(root: string): void {
	const path = resolve(root, ".templates/axum/Cargo.toml.tera");
	if (!existsSync(path)) return;
	const tempRoot = mkTemp("vern-rust-template-");
	try {
		const original = readFileSync(path, "utf8");
		const named = original.replace(
			'"{{ name | kebab_case }}"',
			'"vern-template-axum"',
		);
		if (named === original)
			throw new Error("Could not render the Axum Cargo name placeholder.");
		writeFileSync(resolve(tempRoot, "Cargo.toml"), stripCargoConditions(named));
		mkdirSync(resolve(tempRoot, "src"), { recursive: true });
		writeFileSync(resolve(tempRoot, "src/main.rs"), "fn main() {}\n");
		run(
			"cargo",
			[
				"upgrade",
				"--manifest-path",
				resolve(tempRoot, "Cargo.toml"),
				"--incompatible",
				"allow",
				"--pinned",
				"allow",
			],
			{ cwd: tempRoot },
		);
		const updated = readFileSync(
			resolve(tempRoot, "Cargo.toml"),
			"utf8",
		).replace('"vern-template-axum"', '"{{ name | kebab_case }}"');
		writeFileSync(
			path,
			restoreCargoConditions(updated, cargoConditions(original)),
		);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function updateDependencies(root: string): void {
	assertCargoEdit(root);
	run("bun", ["update", "--latest", "--recursive"], { cwd: root });
	alignWorkspaceRouters(root);
	updateBunTemplate(root, "tanstack", "TanStack");
	updateBunTemplate(root, "next", "Next.js");

	const apps = resolve(root, "apps");
	if (existsSync(apps)) {
		for (const entry of readdirSync(apps, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifest = resolve(apps, entry.name, "Cargo.toml");
			if (!existsSync(manifest)) continue;
			run(
				"cargo",
				[
					"upgrade",
					"--manifest-path",
					manifest,
					"--incompatible",
					"allow",
					"--pinned",
					"allow",
				],
				{ cwd: root },
			);
			run("cargo", ["update", "--manifest-path", manifest], { cwd: root });
		}
	}
	updateRustTemplate(root);
	if (existsSync(resolve(root, "bun.lock")))
		run("bun", ["install"], { cwd: root });
}

function validateProject(root: string): void {
	run("bun", ["install", "--frozen-lockfile"], { cwd: root });
	run("moon", ["run", ":check"], { cwd: root });
	run("moon", ["run", ":test"], { cwd: root });
}

function printPreview(root: string, from: string, to: string): void {
	const files = allChangedUpstreamPaths(root, from, to);
	console.log("Vern main: " + from.slice(0, 12) + " → " + to.slice(0, 12));
	if (files.length === 0) console.log("No upstream file changes.");
	else {
		console.log("Changed upstream files (" + files.length + "):");
		for (const path of files) console.log("  " + path);
	}
	console.log(
		"Apply will also upgrade Bun and Rust dependencies, including major versions, then run workspace checks and tests.",
	);
}

function checkUnresolved(root: string, state: UpdateState): void {
	const unresolved: string[] = [];
	for (const conflict of state.conflicts) {
		const absolute = safeProjectPath(root, conflict.path);
		const current =
			existsSync(absolute) && statSync(absolute).isFile()
				? readFileSync(absolute)
				: undefined;
		const currentHash = current ? sha256(current) : "<missing>";
		if (currentHash === conflict.initialHash) {
			unresolved.push(conflict.path);
			continue;
		}
		if (current && isTextBuffer(current)) {
			const text = new TextDecoder().decode(current);
			if (/^(<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(text))
				unresolved.push(conflict.path);
		}
	}
	if (unresolved.length > 0) {
		throw new Error(
			"Resolve these conflicts, then rerun --continue: " +
				unresolved.join(", "),
		);
	}
}

function applyDependenciesAndValidation(
	root: string,
	config: ProjectConfig,
	state: UpdateState,
): void {
	if (state.phase === "dependencies") {
		updateDependencies(root);
		config.upstream.lastSyncedSha = state.targetSha;
		writeJson(resolve(root, CONFIG_PATH), config);
		state.phase = "validate";
		writeState(root, state);
	}
	validateProject(root);
	rmSync(resolve(root, UPDATE_STATE_PATH), { force: true });
	console.log(
		"Vern files and dependencies are updated on branch " + state.branch + ".",
	);
}

export function updateProject(root: string, options: Options): void {
	const config = readConfig(root);
	if (!config)
		throw new Error(
			"Run rename-project.ts first to create " + CONFIG_PATH + ".",
		);

	if (options.continueUpdate) {
		const state = readState(root);
		if (!state) throw new Error("There is no pending update to continue.");
		const currentBranch = git(root, "branch", "--show-current").stdout.trim();
		if (currentBranch !== state.branch)
			throw new Error("Switch back to " + state.branch + " before continuing.");
		if (state.phase === "conflicts") {
			checkUnresolved(root, state);
			state.phase = "dependencies";
			writeState(root, state);
		}
		applyDependenciesAndValidation(root, config, state);
		return;
	}

	if (readState(root))
		throw new Error(
			"A prior update is pending. Resolve it and run with --continue.",
		);
	const targetSha = fetchMain(root, config);
	const ancestor = gitTry(
		root,
		"merge-base",
		"--is-ancestor",
		config.upstream.lastSyncedSha,
		targetSha,
	);
	if (ancestor.status !== 0)
		throw new Error(
			"The saved upstream SHA is not an ancestor of Vern main. Check .vern/config.json.",
		);
	if (!options.apply) {
		printPreview(root, config.upstream.lastSyncedSha, targetSha);
		console.log(
			"Preview only. Add --apply to create a review branch and apply the update.",
		);
		return;
	}

	const dirty = git(root, "status", "--porcelain").stdout.trim();
	if (dirty)
		throw new Error(
			"Working tree must be clean before applying an upstream update.",
		);
	verifyCargoEdit(root);
	const branch = "vern/update-" + targetSha.slice(0, 8);
	if (
		gitTry(root, "show-ref", "--verify", "--quiet", "refs/heads/" + branch)
			.status === 0
	) {
		throw new Error("Review branch already exists: " + branch);
	}
	git(root, "switch", "-c", branch);
	const merged = mergeUpstreamFiles(
		root,
		config,
		config.upstream.lastSyncedSha,
		targetSha,
	);
	const state: UpdateState = {
		schemaVersion: 1,
		branch,
		previousSha: config.upstream.lastSyncedSha,
		targetSha,
		phase: merged.conflicts.length > 0 ? "conflicts" : "dependencies",
		conflicts: merged.conflicts,
	};
	writeState(root, state);
	if (merged.conflicts.length > 0) {
		console.error(
			"Upstream merge has conflicts: " +
				merged.conflicts.map((item) => item.path).join(", "),
		);
		console.error("Resolve them on " + branch + " and rerun with --continue.");
		process.exitCode = 1;
		return;
	}
	console.log(
		"Merged upstream files: " +
			(merged.updated.length ? merged.updated.join(", ") : "none"),
	);
	applyDependenciesAndValidation(root, config, state);
}

if (import.meta.main) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (!options) help();
		else updateProject(ROOT, options);
	} catch (error) {
		console.error(
			"update-project: " +
				(error instanceof Error ? error.message : String(error)),
		);
		process.exitCode = 1;
	}
}
