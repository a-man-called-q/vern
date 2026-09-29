import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function parseEnv(path: string): Map<string, string> {
	const values = new Map<string, string>();
	if (!existsSync(path)) return values;

	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match) continue;

		let value = match[2];
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		values.set(match[1], value);
	}

	return values;
}

export function mergeEnv(...sources: Map<string, string>[]): Map<string, string> {
	return new Map(sources.flatMap((source) => [...source.entries()]));
}

/** Root `.env.example` and `.env`, then the project's own; later files win. */
export function readEffectiveEnv(root: string, projectPath: string): Map<string, string> {
	const rootSources = [
		parseEnv(resolve(root, ".env.example")),
		parseEnv(resolve(root, ".env")),
	];
	if (!projectPath) return mergeEnv(...rootSources);
	return mergeEnv(
		...rootSources,
		parseEnv(resolve(root, projectPath, ".env.example")),
		parseEnv(resolve(root, projectPath, ".env")),
	);
}
