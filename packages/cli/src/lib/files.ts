import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Writes `path` under `root`, creating its folders. */
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

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
