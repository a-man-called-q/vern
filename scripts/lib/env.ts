import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** The `.env` of a folder (the root when `dir` is empty) and the example it starts from. */
export type EnvFiles = { env: string; example: string };

export function envFiles(root: string, dir: string): EnvFiles {
	return {
		env: resolve(root, dir, ".env"),
		example: resolve(root, dir, ".env.example"),
	};
}

/** A value the examples ship as a placeholder, or none at all. */
export function isUnset(value: string | undefined): boolean {
	return !value || value.startsWith("replace-with-");
}

/** Sets one variable in a `.env` file, starting from `.env.example` if it is missing. */
export function setEnvValue(files: EnvFiles, key: string, value: string): void {
	const source = existsSync(files.env)
		? readFileSync(files.env, "utf8")
		: existsSync(files.example)
			? readFileSync(files.example, "utf8")
			: "";
	const line = `${key}=${value}`;
	const pattern = new RegExp(`^${key}=.*$`, "m");
	const next = pattern.test(source)
		? source.replace(pattern, () => line)
		: `${source}${source === "" || source.endsWith("\n") ? "" : "\n"}${line}\n`;
	writeFileSync(files.env, next);
}
