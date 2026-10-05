import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isLocalIssuer, readSeedUsers, seedUsers } from "./seed";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedFile(content: string | undefined): string {
	const root = mkdtempSync(join(tmpdir(), "vern-seed-"));
	tempDirs.push(root);
	if (content !== undefined) writeFileSync(resolve(root, "seed-users.json"), content);
	return root;
}

const ROLES = ["admin", "publisher", "advertiser"];

describe("readSeedUsers", () => {
	test("reads the admin roles and the users", () => {
		const root = seedFile(
			JSON.stringify({
				adminRoles: ["admin"],
				users: [
					{ name: "publisher", givenName: "Demo", familyName: "Publisher", roles: ["publisher"] },
					{ name: "nobody.1", givenName: "No", familyName: "Role" },
				],
			}),
		);
		expect(readSeedUsers(root, ROLES)).toEqual({
			adminRoles: ["admin"],
			users: [
				{ name: "publisher", givenName: "Demo", familyName: "Publisher", roles: ["publisher"] },
				{ name: "nobody.1", givenName: "No", familyName: "Role", roles: [] },
			],
			companies: [],
		});
	});

	test("a missing file or an empty one means nothing to seed", () => {
		expect(readSeedUsers(seedFile(undefined), ROLES)).toEqual({ adminRoles: [], users: [], companies: [] });
		expect(readSeedUsers(seedFile("{}"), ROLES)).toEqual({ adminRoles: [], users: [], companies: [] });
		expect(readSeedUsers(seedFile('{"adminRoles":[],"users":[]}'), [])).toEqual({ adminRoles: [], users: [], companies: [] });
	});

	test("reads the companies, each with its roles and users", () => {
		const root = seedFile(
			JSON.stringify({
				companies: [
					{
						name: "Acme Ads",
						roles: ["advertiser"],
						users: [
							{ name: "owner", givenName: "Ada", familyName: "Owner", roles: ["admin"] },
							{ name: "member", givenName: "Max", familyName: "Member" },
						],
					},
					{ name: "Empty Co" },
				],
			}),
		);
		expect(readSeedUsers(root, ROLES).companies).toEqual([
			{
				name: "Acme Ads",
				roles: ["advertiser"],
				users: [
					{ name: "owner", givenName: "Ada", familyName: "Owner", roles: ["admin"] },
					{ name: "member", givenName: "Max", familyName: "Member", roles: [] },
				],
			},
			{ name: "Empty Co", roles: [], users: [] },
		]);
	});

	const user = { name: "a", givenName: "A", familyName: "B", roles: ["publisher"] };
	const company = { name: "Acme", roles: ["advertiser"], users: [user] };
	test.each([
		["companies that are not a list", '{"companies":{}}', "companies must be an array"],
		["a company that is not an object", '{"companies":["a"]}', "each company must be an object"],
		["a company key that does not exist", JSON.stringify({ companies: [{ ...company, domain: "x" }] }), "a company has unknown key: domain"],
		["a company without a name", JSON.stringify({ companies: [{ ...company, name: "" }] }), "a company name must be a string"],
		["a duplicate company", JSON.stringify({ companies: [company, company] }), 'company "Acme" is listed twice'],
		["an undeclared company role", JSON.stringify({ companies: [{ ...company, roles: ["root"] }] }), 'lists "root", which roles.json does not declare'],
		["an undeclared role of a company user", JSON.stringify({ companies: [{ ...company, users: [{ ...user, roles: ["root"] }] }] }), 'lists "root", which roles.json does not declare'],
		["a duplicate user in a company", JSON.stringify({ companies: [{ ...company, users: [user, user] }] }), 'user "a" is listed twice'],
		["an upper-case name in a company", JSON.stringify({ companies: [{ ...company, users: [{ ...user, name: "Ada" }] }] }), 'user name "Ada" must be lowercase'],
	])("rejects %s", (_name, content, message) => {
		expect(() => readSeedUsers(seedFile(content), ROLES)).toThrow(message);
	});

	test.each([
		["not JSON", "{adminRoles", "seed-users.json is not valid JSON"],
		["an array", "[]", "the file must be an object"],
		["a misspelled key", '{"adminRole":["admin"]}', "the file has unknown key: adminRole"],
		["admin roles that are not a list", '{"adminRoles":"admin"}', "adminRoles must be an array"],
		["an undeclared admin role", '{"adminRoles":["root"]}', 'lists "root", which roles.json does not declare'],
		["a role listed twice", '{"adminRoles":["admin","admin"]}', 'lists "admin" twice'],
		["users that are not a list", '{"users":{}}', "users must be an array"],
		["a user that is not an object", '{"users":["a"]}', "each user must be an object"],
		["a user key that does not exist", JSON.stringify({ users: [{ ...user, email: "x" }] }), "a user has unknown key: email"],
		["a missing name", JSON.stringify({ users: [{ ...user, name: undefined }] }), "a user name must be a string"],
		["an upper-case name", JSON.stringify({ users: [{ ...user, name: "Alice" }] }), 'user name "Alice" must be lowercase'],
		["a name with an @", JSON.stringify({ users: [{ ...user, name: "a@b" }] }), 'user name "a@b" must be lowercase'],
		["a name that starts with a dot", JSON.stringify({ users: [{ ...user, name: ".a" }] }), 'user name ".a" must be lowercase'],
		["a duplicate user", JSON.stringify({ users: [user, user] }), 'user "a" is listed twice'],
		["no given name", JSON.stringify({ users: [{ ...user, givenName: "" }] }), 'the givenName of "a"'],
		["no family name", JSON.stringify({ users: [{ ...user, familyName: 3 }] }), 'the familyName of "a"'],
		["an undeclared user role", JSON.stringify({ users: [{ ...user, roles: ["root"] }] }), 'lists "root", which roles.json does not declare'],
	])("rejects %s", (_name, content, message) => {
		expect(() => readSeedUsers(seedFile(content), ROLES)).toThrow(message);
	});
});

describe("isLocalIssuer", () => {
	test.each([
		["http://localhost:8081", true],
		["http://127.0.0.1:8081", true],
		["http://[::1]:8081", true],
		["https://auth.acme.test", false],
		["http://localhost.acme.test", false],
		["http://foo.localhost:8081", false],
		["http://10.0.0.5:8081", false],
		["not a url", false],
	])("%s is %p", (issuer, local) => {
		expect(isLocalIssuer(issuer)).toBe(local);
	});
});

type FakeUser = { id: string; userName: string; machine?: object; human?: object };
type FakeGrant = { id: string; userId: string; projectId: string; roleKeys: string[] };

/** A fake ZITADEL that keeps users and grants in memory. */
function fakeZitadel(users: FakeUser[] = []) {
	const grants: FakeGrant[] = [];
	const calls: { method: string; path: string; body: Record<string, any> }[] = [];
	const created: Record<string, any>[] = [];
	let nextUser = 1;
	let nextGrant = 1;
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		calls.push({ method, path, body });
		if (path === "/management/v1/users/_search") {
			return json({ result: users.filter((user) => user.userName === body.queries[0].userNameQuery.userName) });
		}
		if (path === "/v2/users/human") {
			created.push(body);
			const user = { id: `new${nextUser++}`, userName: body.username, human: {} };
			users.push(user);
			return json({ userId: user.id });
		}
		if (path === "/management/v1/users/grants/_search") {
			const userId = body.queries.find((q: any) => q.userIdQuery).userIdQuery.userId;
			const projectId = body.queries.find((q: any) => q.projectIdQuery).projectIdQuery.projectId;
			return json({ result: grants.filter((grant) => grant.userId === userId && grant.projectId === projectId) });
		}
		const create = path.match(/^\/management\/v1\/users\/([^/]+)\/grants$/);
		if (create && method === "POST") {
			grants.push({ id: `g${nextGrant++}`, userId: create[1], projectId: body.projectId, roleKeys: body.roleKeys });
			return json({ userGrantId: "g" });
		}
		const update = path.match(/^\/management\/v1\/users\/([^/]+)\/grants\/([^/]+)$/);
		if (update && method === "PUT") {
			const grant = grants.find((item) => item.id === update[2] && item.userId === update[1]);
			if (!grant) return json({ message: "not found" }, 404);
			grant.roleKeys = body.roleKeys;
			return json({});
		}
		return json({ message: `unexpected ${method} ${path}` }, 500);
	}) as unknown as typeof fetch;
	return { users, grants, calls, created, api: { issuer: "http://localhost:8081", token: "t", fetcher } };
}

describe("seedUsers", () => {
	const admin: FakeUser = { id: "admin1", userName: "zitadel-admin@vern.localhost", human: {} };
	const seed = {
		adminRoles: ["admin"],
		users: [
			{ name: "publisher", givenName: "Demo", familyName: "Publisher", roles: ["publisher"] },
			{ name: "advertiser", givenName: "Demo", familyName: "Advertiser", roles: ["advertiser"] },
		],
		companies: [],
	};
	function options(logs: string[], passwords: string[] = []) {
		return {
			projectId: "42",
			domain: "vern.localhost",
			adminName: "zitadel-admin@vern.localhost",
			password: () => {
				passwords.push("asked");
				return "Secret-Pass-1!";
			},
			log: (message: string) => logs.push(message),
		};
	}

	test("grants the admin roles and creates each user with its roles", async () => {
		const zitadel = fakeZitadel([{ ...admin }]);
		const logs: string[] = [];
		const logins = await seedUsers(zitadel.api, seed, options(logs));

		expect(logins).toEqual(["publisher@vern.localhost", "advertiser@vern.localhost"]);
		expect(zitadel.grants.map((grant) => [grant.userId, grant.projectId, grant.roleKeys])).toEqual([
			["admin1", "42", ["admin"]],
			["new1", "42", ["publisher"]],
			["new2", "42", ["advertiser"]],
		]);
		expect(zitadel.created[0]).toEqual({
			username: "publisher@vern.localhost",
			profile: { givenName: "Demo", familyName: "Publisher", displayName: "Demo Publisher" },
			email: { email: "publisher@vern.localhost", isVerified: true },
			password: { password: "Secret-Pass-1!", changeRequired: false },
		});
		expect(logs).toEqual([
			"Granted admin to zitadel-admin@vern.localhost",
			"Created user publisher@vern.localhost",
			"Granted publisher to publisher@vern.localhost",
			"Created user advertiser@vern.localhost",
			"Granted advertiser to advertiser@vern.localhost",
		]);
		expect(logs.join("\n")).not.toContain("Secret-Pass-1!");
	});

	test("running it again changes nothing and asks for no password", async () => {
		const zitadel = fakeZitadel([{ ...admin }]);
		await seedUsers(zitadel.api, seed, options([]));
		const before = JSON.stringify([zitadel.users, zitadel.grants]);
		zitadel.calls.length = 0;

		const logs: string[] = [];
		const passwords: string[] = [];
		await seedUsers(zitadel.api, seed, options(logs, passwords));
		expect(JSON.stringify([zitadel.users, zitadel.grants])).toBe(before);
		expect(zitadel.calls.every((call) => call.path.endsWith("_search"))).toBe(true);
		expect(passwords).toEqual([]);
		expect(logs).toEqual([]);
	});

	test("leaves an existing user alone and only adds the roles it lacks", async () => {
		const zitadel = fakeZitadel([{ ...admin }, { id: "p1", userName: "publisher@vern.localhost", human: {} }]);
		zitadel.grants.push({ id: "g0", userId: "p1", projectId: "42", roleKeys: ["support"] });
		zitadel.grants.push({ id: "gadmin", userId: "admin1", projectId: "42", roleKeys: ["admin", "support"] });
		const passwords: string[] = [];
		const logs: string[] = [];
		await seedUsers(zitadel.api, { adminRoles: ["admin"], users: [seed.users[0]], companies: [] }, options(logs, passwords));

		expect(zitadel.created).toEqual([]);
		expect(passwords).toEqual([]);
		expect(zitadel.grants.find((grant) => grant.userId === "p1")?.roleKeys).toEqual(["support", "publisher"]);
		expect(zitadel.grants.find((grant) => grant.userId === "admin1")?.roleKeys).toEqual(["admin", "support"]);
		expect(logs).toEqual(["Granted publisher to publisher@vern.localhost"]);
		expect(zitadel.calls.some((call) => call.method === "DELETE")).toBe(false);
	});

	test("a user without roles is created without a grant", async () => {
		const zitadel = fakeZitadel([{ ...admin }]);
		await seedUsers(zitadel.api, { adminRoles: [], users: [{ name: "nobody", givenName: "No", familyName: "Role", roles: [] }], companies: [] }, options([]));
		expect(zitadel.users.map((user) => user.userName)).toEqual(["zitadel-admin@vern.localhost", "nobody@vern.localhost"]);
		expect(zitadel.grants).toEqual([]);
	});

	test("says so when the bootstrap admin does not exist", async () => {
		const zitadel = fakeZitadel([]);
		const logs: string[] = [];
		await seedUsers(zitadel.api, { adminRoles: ["admin"], users: [], companies: [] }, options(logs));
		expect(logs).toEqual(["No user zitadel-admin@vern.localhost; not granting admin"]);
		expect(zitadel.grants).toEqual([]);
	});

	test("refuses a service user that has a seeded login name", async () => {
		const zitadel = fakeZitadel([{ id: "m1", userName: "publisher@vern.localhost", machine: {} }]);
		await expect(seedUsers(zitadel.api, { adminRoles: [], users: [seed.users[0]], companies: [] }, options([]))).rejects.toThrow(
			'"publisher@vern.localhost" exists but is a service user',
		);
		expect(zitadel.grants).toEqual([]);
	});

	test("refuses a project ID that is not an ID", async () => {
		const zitadel = fakeZitadel([]);
		await expect(seedUsers(zitadel.api, seed, { ...options([]), projectId: "../x" })).rejects.toThrow("project ID");
		expect(zitadel.calls).toEqual([]);
	});
});
