import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The root of the project the folder `from` is in: the nearest folder, going
 * up, that holds Moon's workspace file. `from` itself when there is none.
 */
export function findRoot(from: string): string {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		if (existsSync(resolve(dir, ".moon/workspace.yml"))) return dir;
		if (dir === dirname(dir)) return resolve(from);
	}
}

/**
 * The repository root: every command works from here unless told otherwise.
 * The CLI is installed in node_modules, so the project is the one it is run in.
 */
export const ROOT = findRoot(process.cwd());
