import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const UPSTREAM_URL = "https://github.com/a-man-called-q/vern.git";
export const UPSTREAM_BRANCH = "main";
export const CONFIG_PATH = ".vern/config.json";
export const UPDATE_STATE_PATH = ".vern/update-state.json";

export interface ProjectConfig {
	schemaVersion: 1;
	project: { name: string; slug: string };
	upstream: { url: string; branch: string; lastSyncedSha: string };
}

export interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

export function run(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		allowFailure?: boolean;
		env?: NodeJS.ProcessEnv;
	} = {},
): CommandResult {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? ROOT,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error) {
		if (options.allowFailure)
			return { status: 127, stdout: "", stderr: result.error.message };
		throw new Error(`${command} could not run: ${result.error.message}`);
	}
	const response = {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
	if (response.status !== 0 && !options.allowFailure) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${response.status}).\n${response.stderr.trim()}`,
		);
	}
	return response;
}

export function readConfig(root = ROOT): ProjectConfig | undefined {
	const path = resolve(root, CONFIG_PATH);
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
	if (
		value.schemaVersion !== 1 ||
		!value.project?.name ||
		!value.project?.slug ||
		!value.upstream?.url ||
		!value.upstream?.branch ||
		!value.upstream?.lastSyncedSha
	) {
		throw new Error(`${CONFIG_PATH} has an unsupported or incomplete format.`);
	}
	return value;
}

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function git(root: string, ...args: string[]): CommandResult {
	return run("git", args, { cwd: root });
}

export function gitTry(root: string, ...args: string[]): CommandResult {
	return run("git", args, { cwd: root, allowFailure: true });
}

export function getGitFiles(root: string): string[] {
	return git(root, "ls-files", "-z").stdout.split("\0").filter(Boolean);
}

export function isEnvironmentFile(path: string): boolean {
	const name = basename(path);
	return (
		name === ".env" || (name.startsWith(".env.") && name !== ".env.example")
	);
}

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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceIdentity(
	text: string,
	from: { name: string; slug: string },
	to: { name: string; slug: string },
): string {
	if (from.name === to.name && from.slug === to.slug) return text;
	const urls: string[] = [];
	const configPaths: string[] = [];
	const protectedText = text
		.replace(/https?:\/\/[^\s"'`<>]+/g, (url) => {
			const marker = `__VERN_PRESERVED_URL_${urls.length}__`;
			urls.push(url);
			return marker;
		})
		.replace(/\.vern(?=\/|$)/g, () => {
			const marker = `__VERN_CONFIG_PATH_${configPaths.length}__`;
			configPaths.push(".vern");
			return marker;
		});
	let output = protectedText
		.replaceAll(`@${from.slug}/`, `@${to.slug}/`)
		.replaceAll(`${from.slug}-auth`, `${to.slug}-auth`)
		.replaceAll(`--${from.slug}-`, `--${to.slug}-`)
		.replace(new RegExp(`\\b${escapeRegExp(from.name)}\\b`, "g"), to.name)
		.replace(
			new RegExp(`\\b${escapeRegExp(from.slug.toUpperCase())}\\b`, "g"),
			to.slug.toUpperCase(),
		)
		.replace(new RegExp(`\\b${escapeRegExp(from.slug)}\\b`, "g"), to.slug);
	output = output.replace(
		/__VERN_PRESERVED_URL_(\d+)__/g,
		(_match, index: string) => urls[Number(index)],
	);
	output = output.replace(
		/__VERN_CONFIG_PATH_(\d+)__/g,
		(_match, index: string) => configPaths[Number(index)],
	);
	return output;
}

export function validateIdentity(name: string, slug: string): void {
	if (!name.trim()) throw new Error("--name must not be empty.");
	if (!/^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u.test(name.trim())) {
		throw new Error(
			"--name may contain letters, numbers, spaces, periods, and hyphens.",
		);
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new Error(
			"--slug must be lowercase kebab-case (for example, acme-platform).",
		);
	}
}

export function treeSha(root: string, revision: string): string {
	return git(root, "rev-parse", `${revision}^{tree}`).stdout.trim();
}

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
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

export function writeFileSafely(
	root: string,
	path: string,
	contents: Buffer | string,
): void {
	const absolute = resolve(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

export function isTextBuffer(value: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(value);
		return true;
	} catch {
		return false;
	}
}
