import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { CONFIG_PATH, UPDATE_STATE_PATH } from "./config";

function isEnvironmentFile(path: string): boolean {
	const name = basename(path);
	return (
		name === ".env" || (name.startsWith(".env.") && name !== ".env.example")
	);
}

/** Files a rename never touches: local settings, and what tools build or install. */
export function isIgnoredProjectFile(path: string): boolean {
	return (
		path === CONFIG_PATH ||
		path === UPDATE_STATE_PATH ||
		isEnvironmentFile(path) ||
		path
			.split(sep)
			.some((part) =>
				[
					"node_modules",
					".git",
					".moon",
					"target",
					"dist",
					"dist-ssr",
					"storybook-static",
					"coverage",
					".output",
					".next",
					".vite",
				].includes(part),
			)
	);
}

export function listTextFiles(root: string): string[] {
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = resolve(directory, entry.name);
			const path = relative(root, absolute);
			if (isIgnoredProjectFile(path)) continue;
			if (entry.isDirectory()) {
				visit(absolute);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(
					readFileSync(absolute),
				);
				files.push(path);
			} catch {
				// Binary assets are intentionally left alone; textual SVGs are decoded above.
			}
		}
	};
	visit(root);
	return files.sort();
}

export function readGitFile(
	root: string,
	revision: string,
	path: string,
): Buffer | undefined {
	const result = spawnSync("git", ["show", `${revision}:${path}`], {
		cwd: root,
		encoding: null,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) return undefined;
	return result.stdout;
}

/**
 * scripts/ is Vern's tooling, which names Vern on purpose (the upstream it
 * follows, the identity it renames from, defaults). A rename leaves it as it
 * is, and an update merges upstream's copy as it is, so a project's scripts
 * stay byte for byte Vern's and merge cleanly.
 */
export function isVernScript(path: string): boolean {
	return path.startsWith("scripts/");
}
