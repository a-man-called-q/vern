import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The mail setup must use the routes and fields that the ZITADEL release in
// apps/auth-server/.env.example defines. CI downloads that release's proto files
// into ZITADEL_PROTO_DIR (see zitadel-app.test.ts); without them this suite is
// skipped.
const protoDir = process.env.ZITADEL_PROTO_DIR ?? "";
const FILES = { admin: "admin.proto", settings: "settings.proto" };
const available = !!protoDir && Object.values(FILES).every((file) => existsSync(resolve(protoDir, file)));

describe.skipIf(!available)("the SMTP setup matches the ZITADEL admin API", () => {
	const proto = (file: string) => (available ? readFileSync(resolve(protoDir, file), "utf8") : "");
	const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

	function fields(file: string, message: string): Set<string> {
		const body = proto(file).match(new RegExp(`\\nmessage ${message}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
		return new Set([...body.matchAll(/^\s+(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => camel(m[1])));
	}

	test("the routes are defined", () => {
		for (const [verb, route] of [
			["post", "/smtp/_search"],
			["post", "/smtp"],
			["put", "/smtp/{id}"],
			["put", "/smtp/{id}/password"],
			["post", "/smtp/{id}/_activate"],
		]) {
			const pattern = new RegExp(`${verb}:\\s*"${route.replace(/[{}]/g, "\\$&")}"`);
			expect(pattern.test(proto(FILES.admin)), `${verb} ${route}`).toBe(true);
		}
	});

	test("the request bodies and the configuration only use defined fields", () => {
		const settings = ["senderAddress", "senderName", "tls", "host", "user", "replyToAddress", "description"];
		const bodies: [string, string, string[]][] = [
			[FILES.admin, "AddSMTPConfigRequest", [...settings, "password"]],
			[FILES.admin, "UpdateSMTPConfigRequest", settings],
			[FILES.admin, "UpdateSMTPConfigPasswordRequest", ["password"]],
			[FILES.admin, "AddSMTPConfigResponse", ["id"]],
			// What the search reads back.
			[FILES.settings, "SMTPConfig", [...settings, "id", "state"]],
		];
		for (const [file, message, keys] of bodies) {
			const defined = fields(file, message);
			expect(defined.size, message).toBeGreaterThan(0);
			for (const key of keys) expect(defined.has(key), `${message}.${key}`).toBe(true);
		}
		expect(proto(FILES.settings)).toContain("SMTP_CONFIG_ACTIVE");
	});
});
