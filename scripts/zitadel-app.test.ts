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
import {
	buildOidcConfig,
	main,
	provisionApplication,
	writeClientId,
} from "./zitadel-app";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "vern-zitadel-app-"));
	tempDirs.push(dir);
	return dir;
}

type Call = { method: string; url: string; headers: Headers; body: unknown };

/** A fake ZITADEL: answers each call in order and records what was sent. */
function fakeZitadel(responses: { status?: number; body: unknown }[]) {
	const calls: Call[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			method: init?.method ?? "GET",
			url: String(input),
			headers: new Headers(init?.headers),
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra request");
		return new Response(JSON.stringify(next.body), {
			status: next.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return { calls, fetcher };
}

const config = buildOidcConfig({ appUrl: "http://localhost:3001" });
const base = {
	issuer: "http://localhost:8081",
	projectId: "392733015878402051",
	name: "web",
	config,
	token: "pat-secret-value",
};

describe("buildOidcConfig", () => {
	test("targets the app's callback URLs with PKCE and refresh tokens", () => {
		expect(config.redirectUris).toEqual(["http://localhost:3001/auth/callback"]);
		expect(config.postLogoutRedirectUris).toEqual([
			"http://localhost:3001/auth/logout/callback",
		]);
		expect(config.authMethodType).toBe("OIDC_AUTH_METHOD_TYPE_NONE");
		expect(config.grantTypes).toEqual([
			"OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
			"OIDC_GRANT_TYPE_REFRESH_TOKEN",
		]);
	});

	test("Development Mode is on for localhost HTTP and off for HTTPS", () => {
		expect(config.devMode).toBe(true);
		const production = buildOidcConfig({ appUrl: "https://app.example.com" });
		expect(production.devMode).toBe(false);
		expect(production.redirectUris).toEqual(["https://app.example.com/auth/callback"]);
	});

	test("refuses plain HTTP for anything but localhost", () => {
		expect(() => buildOidcConfig({ appUrl: "http://app.example.com" })).toThrow(/HTTPS/);
	});

	test("refuses a URL with a path", () => {
		expect(() => buildOidcConfig({ appUrl: "https://app.example.com/base" })).toThrow(/without a path/);
	});

	test("profile claims in the ID token are opt-in", () => {
		expect(config.idTokenUserinfoAssertion).toBe(false);
		expect(buildOidcConfig({ appUrl: "http://localhost:3001", profileInIdToken: true }).idTokenUserinfoAssertion).toBe(true);
	});
});

describe("provisionApplication", () => {
	test("creates the application when none has that name", async () => {
		const api = fakeZitadel([
			{ body: { result: [] } },
			{ body: { appId: "app-1", clientId: "client-1" } },
		]);
		const result = await provisionApplication({ ...base, fetcher: api.fetcher });

		expect(result).toEqual({ action: "created", appId: "app-1", clientId: "client-1" });
		expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
			"POST http://localhost:8081/management/v1/projects/392733015878402051/apps/_search",
			"POST http://localhost:8081/management/v1/projects/392733015878402051/apps/oidc",
		]);
		expect(api.calls[0].body).toEqual({
			queries: [{ nameQuery: { name: "web", method: "TEXT_QUERY_METHOD_EQUALS" } }],
		});
		expect(api.calls[1].body).toMatchObject({
			name: "web",
			version: "OIDC_VERSION_1_0",
			redirectUris: ["http://localhost:3001/auth/callback"],
			devMode: true,
		});
		expect(api.calls[1].headers.get("authorization")).toBe("Bearer pat-secret-value");
	});

	test("updates an existing application instead of duplicating it", async () => {
		const api = fakeZitadel([
			{ body: { result: [{ id: "app-9", name: "web", oidcConfig: { clientId: "client-9" } }] } },
			{ body: {} },
		]);
		const result = await provisionApplication({ ...base, fetcher: api.fetcher });

		expect(result).toEqual({ action: "updated", appId: "app-9", clientId: "client-9" });
		expect(api.calls[1].method).toBe("PUT");
		expect(api.calls[1].url).toBe(
			"http://localhost:8081/management/v1/projects/392733015878402051/apps/app-9/oidc_config",
		);
		expect(api.calls[1].body).toEqual(config);
	});

	test("reports unchanged when ZITADEL says there is nothing to change", async () => {
		const api = fakeZitadel([
			{ body: { result: [{ id: "app-9", name: "web", oidcConfig: { clientId: "client-9" } }] } },
			{ status: 400, body: { code: 9, message: "No changes (COMMAND-1m88i)" } },
		]);
		const result = await provisionApplication({ ...base, fetcher: api.fetcher });
		expect(result).toEqual({ action: "unchanged", appId: "app-9", clientId: "client-9" });
	});

	test("surfaces ZITADEL's message without leaking the token", async () => {
		const api = fakeZitadel([
			{ status: 403, body: { code: 7, message: "membership not found (AUTH-5mkiR)" } },
		]);
		const failure = provisionApplication({ ...base, fetcher: api.fetcher });
		await expect(failure).rejects.toThrow(/HTTP 403 membership not found/);
		await failure.catch((error: Error) => {
			expect(error.message).not.toContain("pat-secret-value");
		});
	});

	test("does not adopt a same-named application that is not OIDC", async () => {
		const api = fakeZitadel([{ body: { result: [{ id: "app-2", name: "web", apiConfig: {} }] } }]);
		await expect(provisionApplication({ ...base, fetcher: api.fetcher })).rejects.toThrow(/not an OIDC/);
	});

	test("sends the organization header only when asked", async () => {
		const api = fakeZitadel([{ body: { result: [] } }, { body: { appId: "a", clientId: "c" } }]);
		await provisionApplication({ ...base, orgId: "org-1", fetcher: api.fetcher });
		expect(api.calls[0].headers.get("x-zitadel-orgid")).toBe("org-1");

		const other = fakeZitadel([{ body: { result: [] } }, { body: { appId: "a", clientId: "c" } }]);
		await provisionApplication({ ...base, fetcher: other.fetcher });
		expect(other.calls[0].headers.has("x-zitadel-orgid")).toBe(false);
	});

	test("rejects a project ID that could alter the request path", async () => {
		await expect(provisionApplication({ ...base, projectId: "../admin" })).rejects.toThrow(/project ID/);
	});
});

describe("writeClientId", () => {
	test("replaces the existing line and keeps the rest", () => {
		const dir = tempDir();
		const env = join(dir, ".env");
		writeFileSync(env, "PORT=3001\nZITADEL_CLIENT_ID=old\nSESSION_SECRET=keep\n");
		writeClientId(env, join(dir, ".env.example"), "new-id");
		expect(readFileSync(env, "utf8")).toBe("PORT=3001\nZITADEL_CLIENT_ID=new-id\nSESSION_SECRET=keep\n");
	});

	test("starts from .env.example when there is no .env", () => {
		const dir = tempDir();
		writeFileSync(join(dir, ".env.example"), "PORT=3001\nZITADEL_CLIENT_ID=replace-me\n");
		writeClientId(join(dir, ".env"), join(dir, ".env.example"), "new-id");
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe("PORT=3001\nZITADEL_CLIENT_ID=new-id\n");
	});

	test("appends the line when the file does not have one", () => {
		const dir = tempDir();
		const env = join(dir, ".env");
		writeFileSync(env, "PORT=3001");
		writeClientId(env, join(dir, ".env.example"), "new-id");
		expect(readFileSync(env, "utf8")).toBe("PORT=3001\nZITADEL_CLIENT_ID=new-id\n");
	});
});

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

// The request bodies must use field names and enum values that the ZITADEL
// release in apps/auth-server/.env.example really defines. CI downloads that
// release's proto/zitadel files into ZITADEL_PROTO_DIR; without it this suite
// is skipped.
const protoDir = process.env.ZITADEL_PROTO_DIR ?? "";
describe.skipIf(!protoDir || !existsSync(resolve(protoDir, "management.proto")))("matches the ZITADEL API", () => {
	const management = existsSync(resolve(protoDir, "management.proto")) ? readFileSync(resolve(protoDir, "management.proto"), "utf8") : "";
	const app = existsSync(resolve(protoDir, "app.proto")) ? readFileSync(resolve(protoDir, "app.proto"), "utf8") : "";
	const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

	function messageFields(source: string, message: string): Set<string> {
		const body = source.match(new RegExp(`\\nmessage ${message} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
		return new Set([...body.matchAll(/^\s+(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => camel(m[1])));
	}
	function enumValues(name: string): Set<string> {
		const body = app.match(new RegExp(`\\nenum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
		return new Set([...body.matchAll(/^\s+(\w+)\s*=/gm)].map((m) => m[1]));
	}

	test("create and update requests only use defined fields", () => {
		const create = messageFields(management, "AddOIDCAppRequest");
		const update = messageFields(management, "UpdateOIDCAppConfigRequest");
		expect(create.size).toBeGreaterThan(10);
		for (const key of Object.keys(config)) {
			expect(create.has(key), `AddOIDCAppRequest.${key}`).toBe(true);
			expect(update.has(key), `UpdateOIDCAppConfigRequest.${key}`).toBe(true);
		}
		expect(create.has("name") && create.has("version")).toBe(true);
	});

	test("enum values exist", () => {
		expect(enumValues("OIDCResponseType").has(config.responseTypes[0])).toBe(true);
		for (const grant of config.grantTypes) expect(enumValues("OIDCGrantType").has(grant), grant).toBe(true);
		expect(enumValues("OIDCAppType").has(config.appType)).toBe(true);
		expect(enumValues("OIDCAuthMethodType").has(config.authMethodType)).toBe(true);
		expect(enumValues("OIDCTokenType").has(config.accessTokenType)).toBe(true);
		expect(enumValues("OIDCVersion").has("OIDC_VERSION_1_0")).toBe(true);
	});

	test("the routes the client calls are defined", () => {
		for (const route of ['post: "/projects/{project_id}/apps/_search"', 'post: "/projects/{project_id}/apps/oidc"', 'put: "/projects/{project_id}/apps/{app_id}/oidc_config"']) {
			expect(management.includes(route), route).toBe(true);
		}
	});
});
