import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The role and service-account requests must use the routes and fields that
// the ZITADEL release in deploy/dev/auth-server/.env.example defines. CI downloads
// that release's proto files into ZITADEL_PROTO_DIR (see zitadel-app.test.ts);
// without it this suite is skipped.
const protoDir = process.env.ZITADEL_PROTO_DIR ?? "";
describe.skipIf(!protoDir || !existsSync(resolve(protoDir, "management.proto")))("roles and service accounts match the ZITADEL API", () => {
	const management = existsSync(resolve(protoDir, "management.proto")) ? readFileSync(resolve(protoDir, "management.proto"), "utf8") : "";
	const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

	function messageFields(message: string): Set<string> {
		const body = management.match(new RegExp(`\\nmessage ${message} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
		return new Set([...body.matchAll(/^\s+(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => camel(m[1])));
	}

	test("the routes are defined", () => {
		for (const route of [
			'post: "/projects/{project_id}/roles"',
			'post: "/users/_search"',
			'post: "/users/machine"',
			'post: "/orgs/me/members/_search"',
			'post: "/orgs/me/members"',
			'put: "/orgs/me/members/{user_id}"',
			'post: "/users/{user_id}/pats"',
		]) {
			expect(management.includes(route), route).toBe(true);
		}
	});

	test("the request bodies only use defined fields", () => {
		const bodies: Record<string, string[]> = {
			AddProjectRoleRequest: ["roleKey", "displayName", "group"],
			AddMachineUserRequest: ["userName", "name", "description", "accessTokenType"],
			AddOrgMemberRequest: ["userId", "roles"],
			UpdateOrgMemberRequest: ["roles"],
			ListOrgMembersRequest: ["queries"],
			ListUsersRequest: ["queries"],
		};
		for (const [message, keys] of Object.entries(bodies)) {
			const fields = messageFields(message);
			expect(fields.size, message).toBeGreaterThan(0);
			for (const key of keys) expect(fields.has(key), `${message}.${key}`).toBe(true);
		}
	});

});
