import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isTextBuffer } from "../lib/files";
import { AUTH_SERVER, type ProjectRoot, rootFor } from "../lib/projects";
import { git, gitTry } from "../lib/run";

// Projects used to share one flat apps/. Web apps stay there; Axum APIs now
// live in services/ and the Compose stacks in infra/. This moves the folders of
// a project made before that change and fixes the paths written into them.

const OLD_AUTH_SERVER = "apps/auth-server";

export type LayoutMove = { from: string; to: string };

export type LayoutMigration = {
	moves: LayoutMove[];
	/** Files of the old auth stack folder that could not move: changed locally, or already there. */
	leftovers: string[];
};

/** What `migrateLayout` would move: every folder under apps/ that is not a web app. */
export function planLayoutMigration(root: string): LayoutMove[] {
	const apps = resolve(root, "apps");
	if (!existsSync(apps)) return [];
	const moves: LayoutMove[] = [];
	for (const entry of readdirSync(apps, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const from = `apps/${entry.name}`;
		const target: ProjectRoot | undefined =
			from === OLD_AUTH_SERVER ? "infra" : rootFor(root, from);
		if (target && target !== "apps") moves.push({ from, to: `${target}/${entry.name}` });
	}
	return moves.sort((a, b) => a.from.localeCompare(b.from));
}

function isTracked(root: string, path: string): boolean {
	return gitTry(root, "ls-files", "--error-unmatch", "--", path).status === 0;
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		return entry.isDirectory() ? filesUnder(path) : [path];
	});
}

function removeEmptyDirs(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name));
	}
	if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Replaces each `[from, to]` in the file, and writes it only when it changed. */
function rewrite(path: string, replacements: [RegExp | string, string][]): void {
	if (!existsSync(path) || !statSync(path).isFile()) return;
	const data = readFileSync(path);
	if (!isTextBuffer(data)) return;
	const text = data.toString("utf8");
	let next = text;
	for (const [from, to] of replacements) next = next.replaceAll(from, to);
	if (next !== text) writeFileSync(path, next);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The paths a generator wrote into a project, for where it now lives: the
 * Dockerfile's build hint, the data project's walk over the APIs' init.sql,
 * and any mention of the auth stack.
 */
function fixMovedProject(root: string, move: LayoutMove): void {
	for (const file of filesUnder(resolve(root, move.to))) {
		if (/\/(node_modules|target)\//.test(file)) continue;
		rewrite(file, [
			[new RegExp(`(^|[^\\w./-])${escapeRegExp(move.from)}(?=$|[^\\w-])`, "gm"), `$1${move.to}`],
			[OLD_AUTH_SERVER, AUTH_SERVER],
			["apps/*/db/init.sql", "services/*/db/init.sql"],
		]);
	}
	const upScript = resolve(root, move.to, "up.sh");
	rewrite(upScript, [
		["../*/db/init.sql", "../../services/*/db/init.sql"],
		["${file#../}", "${file#../../}"],
	]);
}

/** deploy/ names the folders it builds, and the auth stack's brand and nginx files. */
function fixDeploy(root: string, moves: LayoutMove[]): void {
	const deploy = resolve(root, "deploy");
	if (!existsSync(deploy)) return;
	const replacements: [RegExp, string][] = moves.map((move) => [
		new RegExp(`(^|[^\\w-])${escapeRegExp(move.from)}(?=$|[^\\w-])`, "gm"),
		`$1${move.to}`,
	]);
	replacements.push(
		[/(^|[^\w-])apps\/auth-server(?=$|[^\w-])/gm, `$1${AUTH_SERVER}`],
		[/(^|[^\w-])\.\.\/apps\/\$\{API_APP/gm, "$1../services/${API_APP"],
	);
	for (const file of readdirSync(deploy)) {
		if (/\.ya?ml$/.test(file)) rewrite(join(deploy, file), replacements);
	}
}

/**
 * What is left of apps/auth-server after an update brought infra/auth-server:
 * the local `.env` and other files Git does not track move over when
 * infra/auth-server has none of its own. A tracked file still there was changed
 * locally before the move: it stays for the user to carry over.
 */
function moveAuthLeftovers(root: string): string[] {
	const from = resolve(root, OLD_AUTH_SERVER);
	const leftovers: string[] = [];
	for (const file of filesUnder(from)) {
		const path = relative(root, file);
		const target = resolve(root, AUTH_SERVER, relative(from, file));
		if (isTracked(root, path) || existsSync(target)) {
			leftovers.push(path);
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		renameSync(file, target);
	}
	removeEmptyDirs(from);
	return leftovers.sort();
}

/**
 * Moves every API to services/ and every Compose stack to infra/ (with `git
 * mv`, so their local `.env` and keys go along), then fixes the paths written
 * into them and into deploy/. Running it again changes nothing.
 */
export function migrateLayout(root: string): LayoutMigration {
	const moves: LayoutMove[] = [];
	let leftovers: string[] = [];
	for (const move of planLayoutMigration(root)) {
		if (move.from === OLD_AUTH_SERVER && existsSync(resolve(root, move.to))) {
			leftovers = moveAuthLeftovers(root);
			continue;
		}
		if (existsSync(resolve(root, move.to))) {
			throw new Error(`Cannot move ${move.from} to ${move.to}: ${move.to} exists. Rename one of them first.`);
		}
		mkdirSync(resolve(root, dirname(move.to)), { recursive: true });
		if (isTracked(root, move.from)) git(root, "mv", move.from, move.to);
		else renameSync(resolve(root, move.from), resolve(root, move.to));
		fixMovedProject(root, move);
		moves.push(move);
	}
	fixDeploy(root, moves);
	return { moves, leftovers };
}
