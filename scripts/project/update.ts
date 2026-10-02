import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isTextBuffer, sha256, writeJson } from "../lib/files";
import { AUTH_SERVER } from "../lib/projects";
import { git, gitTry, run } from "../lib/run";
import { requireCargoEdit } from "./cargo-edit";
import {
	CONFIG_PATH,
	type ProjectConfig,
	readConfig,
	UPDATE_STATE_PATH,
} from "./config";
import { updateDependencies, validateProject } from "./dependencies";
import { migrateLayout, planLayoutMigration } from "./layout";
import {
	allChangedUpstreamPaths,
	type Conflict,
	mergeUpstreamFiles,
	safeProjectPath,
	settleConflicts,
} from "./merge";

interface UpdateState {
	schemaVersion: 1;
	branch: string;
	previousSha: string;
	targetSha: string;
	phase: "conflicts" | "dependencies" | "validate";
	conflicts: Conflict[];
}

export interface Options {
	apply: boolean;
	continueUpdate: boolean;
	/** Only move the project to the apps/, services/, deploy/ layout. */
	migrate?: boolean;
}

/** Moves the folders to the current layout, and says what it did. */
function migrateAndReport(root: string): void {
	const { moves, leftovers } = migrateLayout(root);
	for (const move of moves) console.log("Moved " + move.from + " to " + move.to + ".");
	if (leftovers.length > 0) {
		console.log(
			"These files stay where they are: they changed locally, or their new place has its own. Carry what you need over (the auth stack is in " +
				AUTH_SERVER +
				", and deploy/README.md says where the rest of deploy/ went), then delete them:",
		);
		for (const path of leftovers) console.log("  " + path);
	}
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
		// An update from before the layout change ran the old updater, which could
		// not move the folders; the dependency upgrades look for them in place.
		migrateAndReport(root);
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

/**
 * Leaves the review branch of an update that failed before its state was
 * saved, and deletes it. The working tree was clean when the update began, so
 * everything in it that Git does not ignore is the update's own.
 */
function undoReviewBranch(
	root: string,
	branch: string,
	previousBranch: string,
	previousHead: string,
): void {
	git(root, "reset", "--hard", "--quiet");
	git(root, "clean", "-fd", "--quiet");
	if (previousBranch) git(root, "switch", "--quiet", previousBranch);
	else git(root, "switch", "--quiet", "--detach", previousHead);
	git(root, "branch", "-D", "--quiet", branch);
}

export function updateProject(root: string, options: Options): void {
	if (options.migrate) {
		if (git(root, "status", "--porcelain").stdout.trim())
			throw new Error("Working tree must be clean before moving folders.");
		if (planLayoutMigration(root).length === 0) {
			console.log("The project already has the apps/, services/, deploy/ layout.");
			return;
		}
		migrateAndReport(root);
		console.log("Review the moves with `git status`, run `moon run :check`, and commit.");
		return;
	}
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
			const { remaining, settled } = settleConflicts(
				root,
				config,
				state.previousSha,
				state.targetSha,
				state.conflicts,
			);
			if (settled.length > 0) {
				console.log(
					"Merged again without a conflict (the rename had only rebranded them): " +
						settled.join(", "),
				);
				state.conflicts = remaining;
				writeState(root, state);
			}
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
	requireCargoEdit(root);
	const branch = "vern/update-" + targetSha.slice(0, 8);
	if (
		gitTry(root, "show-ref", "--verify", "--quiet", "refs/heads/" + branch)
			.status === 0
	) {
		throw new Error("Review branch already exists: " + branch);
	}
	const previousBranch = git(root, "branch", "--show-current").stdout.trim();
	const previousHead = git(root, "rev-parse", "HEAD").stdout.trim();
	// Moved folders take files Git ignores with them, which Git cannot put back.
	const movesFolders = planLayoutMigration(root).length > 0;
	git(root, "switch", "-c", branch);
	let state: UpdateState;
	let merged: ReturnType<typeof mergeUpstreamFiles>;
	try {
		migrateAndReport(root);
		merged = mergeUpstreamFiles(
			root,
			config,
			config.upstream.lastSyncedSha,
			targetSha,
		);
		state = {
			schemaVersion: 1,
			branch,
			previousSha: config.upstream.lastSyncedSha,
			targetSha,
			phase: merged.conflicts.length > 0 ? "conflicts" : "dependencies",
			conflicts: merged.conflicts,
		};
		writeState(root, state);
	} catch (error) {
		// Without a saved state neither --apply nor --continue can go on from here.
		const message = error instanceof Error ? error.message : String(error);
		if (movesFolders) {
			throw new Error(
				message +
					"\nThe update stopped on " +
					branch +
					", after it began to move folders to the current layout. Discard the changes there, go back to " +
					(previousBranch || previousHead.slice(0, 12)) +
					", and delete " +
					branch +
					" before applying again; the files Git ignores (.env, keys) stay in the moved folders.",
			);
		}
		undoReviewBranch(root, branch, previousBranch, previousHead);
		throw new Error(
			message +
				"\nThe update was undone: the project is back on " +
				(previousBranch || previousHead.slice(0, 12)) +
				" as it was.",
		);
	}
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
