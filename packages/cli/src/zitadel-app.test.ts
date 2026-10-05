import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main } from "./zitadel-app";
import { fakeZitadel } from "./zitadel/testing";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vern-zitadel-app-"));
	tempDirs.push(dir);
	return dir;
}

describe("command line", () => {
	function repo() {
		const root = tempDir();
		mkdirSync(join(root, "apps/web"), { recursive: true });
		writeFileSync(join(root, ".env.example"), "ZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=392733015878402051\n");
		writeFileSync(join(root, "apps/web/.env.example"), "PORT=3001\nAPP_URL=http://localhost:3001\nZITADEL_CLIENT_ID=replace-me\n");
		return root;
	}
	const noNetwork = (async () => {
		throw new Error("no request expected");
	}) as unknown as typeof fetch;

	test("--dry-run prints the configuration and never calls ZITADEL", async () => {
		const lines: string[] = [];
		const code = await main(["--app", "web", "--dry-run"], { root: repo(), env: {}, fetcher: noNetwork, log: (m) => lines.push(m) });
		expect(code).toBe(0);
		const printed = JSON.parse(lines.join("\n"));
		expect(printed.projectId).toBe("392733015878402051");
		expect(printed.config.redirectUris).toEqual(["http://localhost:3001/auth/callback"]);
	});

	test("needs a token", async () => {
		await expect(main(["--app", "web"], { root: repo(), env: {}, fetcher: noNetwork, log: () => {} })).rejects.toThrow(/ZITADEL_PAT/);
	});

	test("reads the token from a file and writes the client ID with --write-env", async () => {
		const root = repo();
		const tokenFile = join(root, "token.txt");
		writeFileSync(tokenFile, "file-token\n");
		const api = fakeZitadel([{ body: { result: [] } }, { body: { appId: "a1", clientId: "c1" } }]);
		const lines: string[] = [];

		const code = await main(["--app", "web", "--pat-file", tokenFile, "--write-env"], { root, env: {}, fetcher: api.fetcher, log: (m) => lines.push(m) });

		expect(code).toBe(0);
		expect(api.calls[0].headers.get("authorization")).toBe("Bearer file-token");
		expect(readFileSync(join(root, "apps/web/.env"), "utf8")).toContain("ZITADEL_CLIENT_ID=c1");
		expect(lines.join("\n")).toContain("ZITADEL_CLIENT_ID=c1");
		expect(lines.join("\n")).not.toContain("file-token");
	});

	test("flags beat the environment, which beats the .env files", async () => {
		const root = repo();
		const api = fakeZitadel([{ body: { result: [] } }, { body: { appId: "a", clientId: "c" } }]);
		await main(["--app", "web", "--project", "from-flag"], {
			root,
			env: { ZITADEL_PAT: "t", ZITADEL_ISSUER: "https://auth.example.com", APP_URL: "https://web.example.com" },
			fetcher: api.fetcher,
			log: () => {},
		});
		expect(api.calls[0].url).toBe("https://auth.example.com/management/v1/projects/from-flag/apps/_search");
		expect(api.calls[1].body).toMatchObject({ redirectUris: ["https://web.example.com/auth/callback"], devMode: false });
	});
});
