import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The seeding requests must use the routes and fields that the ZITADEL release
// in deploy/dev/auth-server/.env.example defines. CI downloads that release's proto
// files into ZITADEL_PROTO_DIR (see zitadel-app.test.ts); without all of them
// this suite is skipped.
const protoDir = process.env.ZITADEL_PROTO_DIR ?? "";
const FILES = {
	management: "management.proto",
	user: "user.proto",
	userService: "user/v2/user_service.proto",
	userV2: "user/v2/user.proto",
	email: "user/v2/email.proto",
	password: "user/v2/password.proto",
};
const available = !!protoDir && Object.values(FILES).every((file) => existsSync(resolve(protoDir, file)));

describe.skipIf(!available)("user seeding matches the ZITADEL API", () => {
	const proto = (file: string) => (available ? readFileSync(resolve(protoDir, file), "utf8") : "");
	const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

	function fields(file: string, message: string): Set<string> {
		const body = proto(file).match(new RegExp(`\\nmessage ${message}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
		return new Set([...body.matchAll(/^\s+(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => camel(m[1])));
	}

	test("the routes are defined", () => {
		for (const route of [
			'post: "/users/_search"',
			'post: "/users/grants/_search"',
			'post: "/users/{user_id}/grants"',
			'put: "/users/{user_id}/grants/{grant_id}"',
		]) {
			expect(proto(FILES.management).includes(route), route).toBe(true);
		}
		expect(proto(FILES.userService).includes('post: "/v2/users/human"')).toBe(true);
	});

	test("the request bodies only use defined fields", () => {
		const bodies: [string, string, string[]][] = [
			[FILES.management, "ListUserGrantRequest", ["queries"]],
			[FILES.management, "AddUserGrantRequest", ["projectId", "roleKeys"]],
			[FILES.management, "UpdateUserGrantRequest", ["roleKeys"]],
			[FILES.user, "UserGrantQuery", ["projectIdQuery", "userIdQuery"]],
			[FILES.user, "UserGrantProjectIDQuery", ["projectId"]],
			[FILES.user, "UserGrantUserIDQuery", ["userId"]],
			[FILES.userService, "AddHumanUserRequest", ["username", "profile", "email", "password"]],
			[FILES.userV2, "SetHumanProfile", ["givenName", "familyName", "displayName"]],
			[FILES.email, "SetHumanEmail", ["email", "isVerified"]],
			[FILES.password, "Password", ["password", "changeRequired"]],
		];
		for (const [file, message, keys] of bodies) {
			const defined = fields(file, message);
			expect(defined.size, message).toBeGreaterThan(0);
			for (const key of keys) expect(defined.has(key), `${message}.${key}`).toBe(true);
		}
	});
});
