import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFiles, setEnvValue } from "./env";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vern-env-"));
	tempDirs.push(dir);
	return dir;
}

describe("setEnvValue", () => {
	test("replaces the existing line and keeps the rest", () => {
		const dir = tempDir();
		const env = join(dir, ".env");
		writeFileSync(env, "PORT=3001\nZITADEL_CLIENT_ID=old\nSESSION_SECRET=keep\n");
		setEnvValue({ env, example: join(dir, ".env.example") }, "ZITADEL_CLIENT_ID", "new-id");
		expect(readFileSync(env, "utf8")).toBe("PORT=3001\nZITADEL_CLIENT_ID=new-id\nSESSION_SECRET=keep\n");
	});

	test("starts from .env.example when there is no .env", () => {
		const dir = tempDir();
		writeFileSync(join(dir, ".env.example"), "PORT=3001\nZITADEL_CLIENT_ID=replace-me\n");
		setEnvValue(envFiles(dir, ""), "ZITADEL_CLIENT_ID", "new-id");
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe("PORT=3001\nZITADEL_CLIENT_ID=new-id\n");
	});

	test("appends the line when the file does not have one", () => {
		const dir = tempDir();
		const env = join(dir, ".env");
		writeFileSync(env, "PORT=3001");
		setEnvValue({ env, example: join(dir, ".env.example") }, "ZITADEL_CLIENT_ID", "new-id");
		expect(readFileSync(env, "utf8")).toBe("PORT=3001\nZITADEL_CLIENT_ID=new-id\n");
	});
});

