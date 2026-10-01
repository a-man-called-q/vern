import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseAllowRegister } from "./zitadel-login-policy";

describe("parseAllowRegister", () => {
	test.each([
		["true", true],
		["false", false],
		[" TRUE ", true],
		["False", false],
	])("reads %p", (value, expected) => {
		expect(parseAllowRegister(value, ".env")).toBe(expected);
	});

	test.each([[undefined], [""], ["  "]])("treats %p as not chosen", (value) => {
		expect(parseAllowRegister(value, ".env")).toBeUndefined();
	});

	test.each([["yes"], ["1"], ["0"], ["off"]])("rejects %p, naming the file", (value) => {
		expect(() => parseAllowRegister(value, "deploy/.env")).toThrow(
			`ZITADEL_ALLOW_REGISTER must be true or false in deploy/.env, not "${value}"`,
		);
	});
});

// The login policy request must use the route and the fields that the ZITADEL
// release in apps/auth-server/.env.example defines. CI downloads that release's
// proto files into ZITADEL_PROTO_DIR (see zitadel-app.test.ts); without it this
// suite is skipped.
const protoDir = process.env.ZITADEL_PROTO_DIR ?? "";
describe.skipIf(!protoDir || !existsSync(resolve(protoDir, "admin.proto")))("the login policy matches the ZITADEL API", () => {
	const admin = existsSync(resolve(protoDir, "admin.proto")) ? readFileSync(resolve(protoDir, "admin.proto"), "utf8") : "";
	const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

	test("the routes are defined", () => {
		expect(admin.includes('get: "/policies/login"')).toBe(true);
		expect(admin.includes('put: "/policies/login"')).toBe(true);
	});

	test("the update only sends fields the request defines", async () => {
		const body = admin.match(/\nmessage UpdateLoginPolicyRequest \{([\s\S]*?)\n\}/)?.[1] ?? "";
		const defined = new Set([...body.matchAll(/^\s+(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => camel(m[1])));
		expect(defined.size).toBeGreaterThan(0);

		const sent: string[] = [];
		const policy = Object.fromEntries(
			[
				"allowUsernamePassword", "allowRegister", "allowExternalIdp", "forceMfa", "forceMfaLocalOnly",
				"passwordlessType", "hidePasswordReset", "ignoreUnknownUsernames", "defaultRedirectUri", "passwordCheckLifetime",
				"externalLoginCheckLifetime", "mfaInitSkipLifetime", "secondFactorCheckLifetime",
				"multiFactorCheckLifetime", "allowDomainDiscovery", "disableLoginWithEmail", "disableLoginWithPhone",
				// Returned by the read, not accepted by the update.
				"details", "isDefault", "secondFactors", "multiFactors",
			].map((key) => [key, true]),
		);
		const { ensureSelfRegistration } = await import("./zitadel-login-policy");
		const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "PUT") {
				sent.push(...Object.keys(JSON.parse(String(init.body))));
				return new Response("{}");
			}
			return new Response(JSON.stringify({ policy }));
		}) as typeof fetch;
		await ensureSelfRegistration({ issuer: "http://localhost:8081", token: "t", fetcher }, false);

		expect(sent.length).toBeGreaterThan(0);
		for (const key of sent) expect(defined.has(key), `UpdateLoginPolicyRequest.${key}`).toBe(true);
		for (const key of defined) expect(sent.includes(key), `${key} is sent back`).toBe(true);
	});
});
