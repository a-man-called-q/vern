import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOidcConfig, provisionApplication } from "./oidc";
import { fakeZitadel } from "./testing";

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
