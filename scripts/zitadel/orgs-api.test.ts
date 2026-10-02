import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The organization and instance-member requests must use the routes and fields
// that the ZITADEL release in apps/auth-server/.env.example defines. CI downloads
// that release's proto files into ZITADEL_PROTO_DIR (see zitadel-app.test.ts);
// without all of them this suite is skipped.
const protoDir = process.env.ZITADEL_PROTO_DIR ?? "";
const FILES = {
	management: "management.proto",
	admin: "admin.proto",
	project: "project.proto",
	member: "member.proto",
	object: "object.proto",
	user: "user.proto",
	userService: "user/v2/user_service.proto",
	orgService: "org/v2/org_service.proto",
	org: "org/v2/org.proto",
	orgQuery: "org/v2/query.proto",
};
const available = !!protoDir && Object.values(FILES).every((file) => existsSync(resolve(protoDir, file)));

describe.skipIf(!available)("organization provisioning matches the ZITADEL API", () => {
	const proto = (file: string) => (available ? readFileSync(resolve(protoDir, file), "utf8") : "");
	const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

	function fields(file: string, message: string): Set<string> {
		const body = proto(file).match(new RegExp(`\\nmessage ${message}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
		return new Set([...body.matchAll(/^\s+(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*\d+/gm)].map((m) => camel(m[1])));
	}

	test("the routes are defined", () => {
		const routes: [string, string][] = [
			[FILES.orgService, 'post: "/v2/organizations"'],
			[FILES.orgService, 'post: "/v2/organizations/_search"'],
			[FILES.userService, 'post: "/v2/users/human"'],
			[FILES.management, 'post: "/projects/{project_id}/grants/_search"'],
			[FILES.management, 'post: "/projects/{project_id}/grants"'],
			[FILES.management, 'put: "/projects/{project_id}/grants/{grant_id}"'],
			[FILES.management, 'post: "/users/grants/_search"'],
			[FILES.management, 'post: "/users/{user_id}/grants"'],
			[FILES.management, 'put: "/users/{user_id}/grants/{grant_id}"'],
			[FILES.admin, 'post: "/members/_search"'],
			[FILES.admin, 'post: "/members"'],
			[FILES.admin, 'put: "/members/{user_id}"'],
		];
		for (const [file, route] of routes) expect(proto(file).includes(route), `${file} ${route}`).toBe(true);
	});

	test("the request bodies and responses only use defined fields", () => {
		const bodies: [string, string, string[]][] = [
			[FILES.orgService, "AddOrganizationRequest", ["name"]],
			[FILES.orgService, "AddOrganizationResponse", ["organizationId"]],
			[FILES.orgService, "ListOrganizationsRequest", ["queries"]],
			[FILES.orgService, "ListOrganizationsResponse", ["result"]],
			[FILES.orgQuery, "SearchQuery", ["nameQuery", "idQuery"]],
			[FILES.orgQuery, "OrganizationNameQuery", ["name", "method"]],
			[FILES.orgQuery, "OrganizationIDQuery", ["id"]],
			[FILES.org, "Organization", ["id", "name", "primaryDomain"]],
			[FILES.userService, "AddHumanUserRequest", ["organization", "username", "profile", "email", "password"]],
			[FILES.userService, "AddHumanUserResponse", ["userId"]],
			[FILES.management, "ListProjectGrantsRequest", ["query"]],
			[FILES.management, "ListProjectGrantsResponse", ["result"]],
			[FILES.management, "AddProjectGrantRequest", ["grantedOrgId", "roleKeys"]],
			[FILES.management, "AddProjectGrantResponse", ["grantId"]],
			[FILES.management, "UpdateProjectGrantRequest", ["roleKeys"]],
			[FILES.object, "ListQuery", ["limit"]],
			[FILES.project, "GrantedProject", ["grantId", "grantedOrgId", "grantedRoleKeys"]],
			[FILES.management, "ListUserGrantRequest", ["queries"]],
			[FILES.management, "AddUserGrantRequest", ["projectId", "projectGrantId", "roleKeys"]],
			[FILES.user, "UserGrant", ["id", "roleKeys"]],
			[FILES.admin, "ListIAMMembersRequest", ["queries"]],
			[FILES.admin, "ListIAMMembersResponse", ["result"]],
			[FILES.admin, "AddIAMMemberRequest", ["userId", "roles"]],
			[FILES.admin, "UpdateIAMMemberRequest", ["roles"]],
			[FILES.member, "SearchQuery", ["userIdQuery"]],
			[FILES.member, "Member", ["userId", "roles"]],
		];
		for (const [file, message, keys] of bodies) {
			const defined = fields(file, message);
			expect(defined.size, message).toBeGreaterThan(0);
			for (const key of keys) expect(defined.has(key), `${message}.${key}`).toBe(true);
		}
	});
});
