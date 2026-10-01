import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "./env-files";
import { findApps, setup } from "./setup";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
	mkdirSync(dirname(resolve(root, path)), { recursive: true });
	writeFileSync(resolve(root, path), content);
}

/** A workspace with one web app and one API, as the generators create them. */
function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "vern-setup-"));
	tempDirs.push(root);
	write(root, ".env.example", "ZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=replace-with-your-zitadel-project-id\n");
	write(root, "apps/auth-server/.env.example", "ZITADEL_ORG_NAME=Vern\nZITADEL_ADMIN_USERNAME=zitadel-admin\n");
	write(
		root,
		"apps/dashboard/.env.example",
		"PORT=3000\nAPP_URL=http://localhost:3000\nZITADEL_CLIENT_ID=replace-with-your-zitadel-client-id\nSESSION_SECRET=\nAPI_BASE_URL=\n",
	);
	write(
		root,
		"apps/api/.env.example",
		"PORT=4000\nZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=replace-with-your-zitadel-project-id\nZITADEL_API_KEY_FILE=./secrets/zitadel-api-key.json\n",
	);
	mkdirSync(resolve(root, "apps/storybook"), { recursive: true });
	return root;
}

type Call = { method: string; path: string; body: unknown };

/** A fake ZITADEL Management API that keeps projects and apps in memory. */
function fakeZitadel() {
	const calls: Call[] = [];
	const projects: { id: string; name: string }[] = [];
	const apps: { id: string; name: string; oidcConfig?: { clientId: string }; apiConfig?: object }[] = [];
	const keys: { appId: string; keyId: string }[] = [];
	let next = 100;
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		if (path === "/.well-known/openid-configuration") return json({ issuer: String(input) });
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, path, body });
		if (path === "/management/v1/projects/_search") {
			const name = body.queries[0].nameQuery.name;
			return json({ result: projects.filter((p) => p.name === name) });
		}
		if (path === "/management/v1/projects" && method === "POST") {
			const project = { id: String(next++), name: body.name };
			projects.push(project);
			return json({ id: project.id });
		}
		const project = path.match(/^\/management\/v1\/projects\/([^/]+)$/);
		if (project && method === "GET") {
			return projects.some((p) => p.id === project[1]) ? json({ project: {} }) : json({ message: "not found" }, 404);
		}
		if (path.endsWith("/apps/_search")) {
			const name = body.queries[0].nameQuery.name;
			return json({ result: apps.filter((a) => a.name === name) });
		}
		if (path.endsWith("/apps/oidc")) {
			const app = { id: String(next++), name: body.name, oidcConfig: { clientId: `client-${body.name}` } };
			apps.push(app);
			return json({ appId: app.id, clientId: app.oidcConfig.clientId });
		}
		if (path.endsWith("/oidc_config")) return json({ message: "No changes (COMMAND-1m88i)" }, 400);
		if (path.endsWith("/apps/api")) {
			const app = { id: String(next++), name: body.name, apiConfig: {} };
			apps.push(app);
			return json({ appId: app.id, clientId: `client-${body.name}` });
		}
		const key = path.match(/\/apps\/([^/]+)\/keys(?:\/([^/]+))?$/);
		if (key && method === "GET") {
			return keys.some((k) => k.appId === key[1] && k.keyId === key[2]) ? json({ key: {} }) : json({ message: "not found" }, 404);
		}
		if (key) {
			const keyId = `k${keys.length + 1}`;
			keys.push({ appId: key[1], keyId });
			const keyDetails = Buffer.from(JSON.stringify({ type: "application", keyId, key: "PEM", appId: key[1], clientId: "c1" })).toString("base64");
			return json({ id: keyId, keyDetails });
		}
		return json({ message: `unexpected ${method} ${path}` }, 500);
	}) as typeof fetch;
	return { calls, fetcher, projects, apps, keys };
}

function deps(root: string, zitadel: ReturnType<typeof fakeZitadel>, logs: string[] = []) {
	return {
		root,
		env: {},
		fetcher: zitadel.fetcher,
		log: (message: string) => logs.push(message),
		startAuthStack: () => {},
		readStackToken: () => "stack-token",
		randomSecret: () => "generated-secret",
	};
}

describe("findApps", () => {
	test("tells web apps and APIs apart by their .env.example", () => {
		expect(findApps(workspace()).map((app) => `${app.name}:${app.kind}`)).toEqual(["api:api", "dashboard:web"]);
	});
});

describe("setup", () => {
	test("creates the project, the applications, and every .env", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		expect(await setup([], deps(root, zitadel))).toBe(0);

		const rootEnv = parseEnv(resolve(root, ".env"));
		expect(rootEnv.get("ZITADEL_PROJECT_ID")).toBe("100");
		expect(zitadel.projects).toEqual([{ id: "100", name: "Vern" }]);
		expect(existsSync(resolve(root, "apps/auth-server/.env"))).toBe(true);

		const web = parseEnv(resolve(root, "apps/dashboard/.env"));
		expect(web.get("ZITADEL_CLIENT_ID")).toBe("client-dashboard");
		expect(web.get("SESSION_SECRET")).toBe("generated-secret");
		expect(web.get("API_BASE_URL")).toBe("http://localhost:4000");

		const api = parseEnv(resolve(root, "apps/api/.env"));
		expect(api.get("ZITADEL_PROJECT_ID")).toBe("100");
		const keyFile = resolve(root, "apps/api/secrets/zitadel-api-key.json");
		expect(JSON.parse(readFileSync(keyFile, "utf8")).keyId).toBe("k1");
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);

		const created = zitadel.calls.find((call) => call.path.endsWith("/apps/oidc"));
		expect(created?.body).toMatchObject({ redirectUris: ["http://localhost:3000/auth/callback"], devMode: true });
	});

	describe("with several APIs", () => {
		function twoApis(): string {
			const root = workspace();
			write(
				root,
				"apps/ads-api/.env.example",
				"PORT=4001\nZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=replace-with-your-zitadel-project-id\nZITADEL_API_KEY_FILE=./secrets/zitadel-api-key.json\n",
			);
			return root;
		}

		test("wires the API a web app names in API_APP", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APP=ads-api\n");
			expect(await setup([], deps(root, fakeZitadel()))).toBe(0);
			expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("API_BASE_URL")).toBe("http://localhost:4001");
		});

		test("says which web app has no API when none is named", async () => {
			const root = twoApis();
			const logs: string[] = [];
			expect(await setup([], deps(root, fakeZitadel(), logs))).toBe(0);
			expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("API_BASE_URL")).toBe("");
			expect(logs).toContain(
				"apps/dashboard: API_BASE_URL is not set (2 APIs found: ads-api, api). Set API_APP=<api> in apps/dashboard/.env and run this again.",
			);
		});

		test("fails on an API_APP that is not an API", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APP=billing\n");
			await expect(setup([], deps(root, fakeZitadel()))).rejects.toThrow(
				"apps/dashboard: API_APP=billing does not name an Axum API with a PORT under apps/ (found: ads-api, api)",
			);
		});

		test("keeps an API_BASE_URL that was set by hand", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APP=ads-api\nAPI_BASE_URL=https://api.acme.test\n");
			await setup([], deps(root, fakeZitadel()));
			expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("API_BASE_URL")).toBe("https://api.acme.test");
		});
	});

	test("says nothing about APIs when there are none", async () => {
		const root = workspace();
		rmSync(resolve(root, "apps/api"), { recursive: true });
		const logs: string[] = [];
		await setup([], deps(root, fakeZitadel(), logs));
		expect(logs.some((line) => line.includes("API_BASE_URL"))).toBe(false);
	});

	test("keeps what already exists when run again", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		await setup([], deps(root, zitadel));
		write(root, "apps/dashboard/.env", readFileSync(resolve(root, "apps/dashboard/.env"), "utf8").replace("generated-secret", "kept-secret"));
		zitadel.calls.length = 0;

		expect(await setup([], deps(root, zitadel))).toBe(0);
		expect(zitadel.projects).toHaveLength(1);
		expect(zitadel.apps).toHaveLength(2);
		expect(zitadel.calls.some((call) => call.path.endsWith("/keys"))).toBe(false);
		expect(zitadel.calls.some((call) => call.method === "POST" && call.path === "/management/v1/projects")).toBe(false);
		expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("SESSION_SECRET")).toBe("kept-secret");
	});

	test("replaces a key that ZITADEL no longer knows", async () => {
		const root = workspace();
		write(root, "apps/api/secrets/zitadel-api-key.json", JSON.stringify({ appId: "old", keyId: "gone", key: "PEM" }));
		const zitadel = fakeZitadel();
		await setup([], deps(root, zitadel));
		const key = JSON.parse(readFileSync(resolve(root, "apps/api/secrets/zitadel-api-key.json"), "utf8"));
		expect(key.keyId).toBe("k1");
	});

	test("replaces a project ID that ZITADEL no longer knows", async () => {
		const root = workspace();
		write(root, ".env", "ZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=999\n");
		const zitadel = fakeZitadel();
		await setup([], deps(root, zitadel));
		expect(parseEnv(resolve(root, ".env")).get("ZITADEL_PROJECT_ID")).toBe("100");
	});

	test("prefers ZITADEL_PAT over the stack's token", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		const tokens: string[] = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("Authorization");
			if (authorization) tokens.push(authorization);
			return zitadel.fetcher(input, init);
		}) as typeof fetch;
		await setup([], { ...deps(root, zitadel), fetcher, env: { ZITADEL_PAT: "user-token" } });
		expect(new Set(tokens)).toEqual(new Set(["Bearer user-token"]));
	});

	test("fills in the production settings with --deploy", async () => {
		const root = workspace();
		write(
			root,
			"deploy/.env.example",
			"AUTH_DOMAIN=auth.example.com\nAPP_DOMAIN=app.example.com\nAPI_DOMAIN=api.example.com\nACME_EMAIL=admin@example.com\nWEB_APP=dashboard\nAPI_APP=api\nZITADEL_ORG_NAME=Vern\nZITADEL_MASTERKEY=\nZITADEL_ADMIN_PASSWORD=\nPOSTGRES_PASSWORD=\nREDIS_PASSWORD=\nWEB_SESSION_SECRET=\nZITADEL_PROJECT_ID=\nWEB_CLIENT_ID=\n",
		);
		const zitadel = fakeZitadel();
		const composeCalls: string[][] = [];
		const run = () =>
			setup(["--deploy"], {
				...deps(root, zitadel),
				runCompose: (_root, args) => composeCalls.push(args),
				randomSecret: (kind, bytes) => `${kind}-${bytes}`,
			});

		await expect(run()).rejects.toThrow("Set AUTH_DOMAIN");
		expect(existsSync(resolve(root, "deploy/.env"))).toBe(true);

		write(
			root,
			"deploy/.env",
			readFileSync(resolve(root, "deploy/.env"), "utf8")
				.replace("auth.example.com", "auth.acme.test")
				.replace("app.example.com", "app.acme.test")
				.replace("api.example.com", "api.acme.test")
				.replace("admin@example.com", "ops@acme.test"),
		);
		expect(await run()).toBe(0);

		const env = parseEnv(resolve(root, "deploy/.env"));
		expect(env.get("ZITADEL_MASTERKEY")).toBe("hex-16");
		expect(env.get("ZITADEL_ADMIN_PASSWORD")).toBe("password-18");
		expect(env.get("WEB_SESSION_SECRET")).toBe("base64-32");
		expect(env.get("ZITADEL_PROJECT_ID")).toBe("100");
		expect(env.get("WEB_CLIENT_ID")).toBe("client-dashboard");

		const created = zitadel.calls.find((call) => call.path.endsWith("/apps/oidc"));
		expect(created?.body).toMatchObject({ redirectUris: ["https://app.acme.test/auth/callback"], devMode: false });

		const keyFile = resolve(root, "deploy/secrets/api-key.json");
		expect(JSON.parse(readFileSync(keyFile, "utf8")).keyId).toBe("k1");
		expect(statSync(keyFile).mode & 0o777).toBe(0o644);
		expect(statSync(dirname(keyFile)).mode & 0o777).toBe(0o700);

		expect(composeCalls.map((args) => args.slice(args.indexOf("up")).join(" "))).toEqual([
			"up --detach --wait traefik zitadel-api zitadel-login auth-server postgres redis",
			"up --detach --wait --build",
		]);
	});

	test("refuses --deploy for an app that does not exist", async () => {
		const root = workspace();
		write(
			root,
			"deploy/.env",
			"AUTH_DOMAIN=auth.acme.test\nAPP_DOMAIN=app.acme.test\nAPI_DOMAIN=api.acme.test\nACME_EMAIL=ops@acme.test\nWEB_APP=shop\nAPI_APP=api\n",
		);
		await expect(setup(["--deploy"], deps(root, fakeZitadel()))).rejects.toThrow("WEB_APP=shop");
	});

	test("waits for the issuer to answer before calling it", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		let discoveryCalls = 0;
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/.well-known/openid-configuration") && ++discoveryCalls < 3) {
				return new Response("not yet", { status: 404 });
			}
			return zitadel.fetcher(input, init);
		}) as typeof fetch;
		const logs: string[] = [];
		await setup([], { ...deps(root, zitadel, logs), fetcher, sleep: async () => {} });
		expect(discoveryCalls).toBe(3);
		expect(logs.filter((line) => line.startsWith("Waiting for ZITADEL"))).toHaveLength(1);
	});

	test("gives up on an issuer that never answers", async () => {
		const root = workspace();
		const fetcher = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
		await expect(
			setup([], { ...deps(root, fakeZitadel()), fetcher, sleep: async () => {}, issuerTimeoutMs: 0 }),
		).rejects.toThrow("ZITADEL did not answer");
	});

	test("explains how to get a token when the stack has none", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		await expect(setup([], { ...deps(root, zitadel), readStackToken: () => undefined })).rejects.toThrow(
			"No ZITADEL token found",
		);
	});
});
