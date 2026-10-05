import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseEnv } from "../lib/env";
import { isTextBuffer } from "../lib/files";
import { AUTH_SERVER, DEV_STACKS, type ProjectRoot, rootFor } from "../lib/projects";
import { git, gitTry } from "../lib/run";

// The layout changed twice. Projects first shared one flat apps/; then the
// Axum APIs moved to services/ and the Compose stacks to infra/; now the stacks
// live in deploy/dev/, beside the other environments in deploy/. This moves
// the folders of a project made before either change, fixes the paths written
// into them, and carries the local settings of a deployment to the folder of
// its environment.

/** Where the auth stack used to be, oldest first. */
export const OLD_AUTH_SERVERS = ["apps/auth-server", "infra/auth-server"];
const OLD_STACKS = "infra";

export type LayoutMove = { from: string; to: string };

export type LayoutMigration = {
	moves: LayoutMove[];
	/** Files that could not move: changed locally, or already at the new place. */
	leftovers: string[];
};

function folders(root: string, dir: string): string[] {
	const absolute = resolve(root, dir);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `${dir}/${entry.name}`);
}

/**
 * The local settings of a deployment that Git does not track, and where they
 * belong now. One deploy/.env used to serve the server and the rehearsal on a
 * laptop; its hostnames tell which one it was.
 */
function deployStateMoves(root: string): LayoutMove[] {
	const env = parseEnv(resolve(root, "deploy/.env"));
	const compose = env.get("AUTH_DOMAIN")?.endsWith("localtest.me") ? "local" : "prod";
	const candidates: LayoutMove[] = [
		{ from: "deploy/.env", to: `deploy/${compose}/.env` },
		{ from: "deploy/secrets", to: `deploy/${compose}/secrets` },
		{ from: "deploy/.local", to: "deploy/local/certs" },
	];
	for (const [overlay, target] of [
		["local", "local"],
		["production", "prod"],
	]) {
		for (const name of ["settings.env", "generated"]) {
			candidates.push({ from: `deploy/k8s/overlays/${overlay}/${name}`, to: `deploy/${target}/${name}` });
		}
	}
	return candidates.filter((move) => existsSync(resolve(root, move.from)) && !existsSync(resolve(root, move.to)));
}

/**
 * What `migrateLayout` would move: every folder under apps/ that is not a web
 * app, every stack still under infra/, and a deployment's local settings.
 */
export function planLayoutMigration(root: string): LayoutMove[] {
	const moves: LayoutMove[] = [];
	for (const from of folders(root, "apps")) {
		const target: ProjectRoot | undefined = OLD_AUTH_SERVERS.includes(from) ? DEV_STACKS : rootFor(root, from);
		if (target && target !== "apps") moves.push({ from, to: `${target}/${from.slice("apps/".length)}` });
	}
	for (const from of folders(root, OLD_STACKS)) {
		moves.push({ from, to: `${DEV_STACKS}/${from.slice(OLD_STACKS.length + 1)}` });
	}
	return [...moves.sort((a, b) => a.from.localeCompare(b.from)), ...deployStateMoves(root)];
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
	if (!existsSync(dir)) return;
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

/** `path` where it stands as a whole path, not as the end of a longer one. */
function wholePath(path: string): RegExp {
	return new RegExp(`(^|[^\\w./-])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\w-])`, "gm");
}

/**
 * The paths a generator wrote into a project, for where it now lives: the
 * Dockerfile's build hint, the data project's walk over the APIs' init.sql
 * (a stack is now three levels below the root), and any mention of the auth
 * stack.
 */
function fixMovedProject(root: string, move: LayoutMove): void {
	for (const file of filesUnder(resolve(root, move.to))) {
		if (/\/(node_modules|target)\//.test(file)) continue;
		rewrite(file, [
			[wholePath(move.from), `$1${move.to}`],
			...OLD_AUTH_SERVERS.map((old): [RegExp, string] => [wholePath(old), `$1${AUTH_SERVER}`]),
			["apps/*/db/init.sql", "services/*/db/init.sql"],
		]);
	}
	if (!move.to.startsWith(`${DEV_STACKS}/`)) return;
	rewrite(resolve(root, move.to, "up.sh"), [
		// As the flat apps/ had it, then as infra/ had it.
		[/(^|[\s"'=])\.\.\/\*\/db\/init\.sql/gm, "$1../../../services/*/db/init.sql"],
		[/(^|[\s"'=])\.\.\/\.\.\/services\/\*\/db\/init\.sql/gm, "$1../../../services/*/db/init.sql"],
		["${file#../}", "${file#../../../}"],
		["${file#../../}", "${file#../../../}"],
	]);
}

/**
 * What is left of an old auth stack folder after an update brought
 * deploy/dev/auth-server: the local `.env` and other files Git does not track
 * move over when the new folder has none of its own. A tracked file still
 * there was changed locally before the move: it stays for the user to carry
 * over.
 */
function moveAuthLeftovers(root: string, old: string): string[] {
	const from = resolve(root, old);
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
	return leftovers;
}

/** The Compose file finds an environment's secrets/ by DEPLOY_ENV, which the one deploy/.env did not need. */
function nameEnvironment(envFile: string): void {
	const text = readFileSync(envFile, "utf8");
	if (/^DEPLOY_ENV=/m.test(text)) return;
	const environment = basename(dirname(envFile));
	writeFileSync(envFile, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}DEPLOY_ENV=${environment}\n`);
}

/** The list of apps `setup` wrote in the old layout; it writes deploy/base's again. */
const OLD_APP_LIST = "deploy/k8s/base/kustomization.yaml";

/**
 * The files of the old deploy/ layout that stay after `migrateLayout`: an
 * update removes the ones a project never touched, so these were changed
 * locally, or their new place already has a file.
 */
export function deployLeftovers(root: string): string[] {
	// Before that update, they are simply the project's deploy/.
	if (!existsSync(resolve(root, "deploy/compose")) && !existsSync(resolve(root, "deploy/base"))) return [];
	const moving = deployStateMoves(root).map((move) => move.from);
	const old = ["deploy/docker-compose.yml", "deploy/docker-compose.local.yml", "deploy/.env.example", "deploy/k8s"];
	return old
		.flatMap((path) => {
			const absolute = resolve(root, path);
			if (!existsSync(absolute)) return [];
			return statSync(absolute).isDirectory() ? filesUnder(absolute).map((file) => relative(root, file)) : [path];
		})
		.filter((path) => path !== OLD_APP_LIST && !moving.some((from) => path === from || path.startsWith(`${from}/`)));
}

/**
 * Moves every API to services/ and every Compose stack to deploy/dev/ (with
 * `git mv`, so their local `.env` and keys go along), fixes the paths written
 * into them, and moves a deployment's settings and Secrets to its
 * environment's folder. Running it again changes nothing.
 */
export function migrateLayout(root: string): LayoutMigration {
	const moves: LayoutMove[] = [];
	const leftovers: string[] = [];
	for (const move of planLayoutMigration(root)) {
		if (OLD_AUTH_SERVERS.includes(move.from) && existsSync(resolve(root, move.to))) {
			leftovers.push(...moveAuthLeftovers(root, move.from));
			continue;
		}
		if (existsSync(resolve(root, move.to))) {
			throw new Error(`Cannot move ${move.from} to ${move.to}: ${move.to} exists. Rename one of them first.`);
		}
		mkdirSync(resolve(root, dirname(move.to)), { recursive: true });
		if (isTracked(root, move.from)) git(root, "mv", move.from, move.to);
		else renameSync(resolve(root, move.from), resolve(root, move.to));
		if (!move.from.startsWith("deploy/")) fixMovedProject(root, move);
		else if (move.from === "deploy/.env") nameEnvironment(resolve(root, move.to));
		moves.push(move);
	}
	rmSync(resolve(root, OLD_APP_LIST), { force: true });
	removeEmptyDirs(resolve(root, OLD_STACKS));
	removeEmptyDirs(resolve(root, "deploy/k8s"));
	leftovers.push(...deployLeftovers(root));
	return { moves, leftovers: leftovers.sort() };
}
