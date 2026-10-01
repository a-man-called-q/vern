import { describe, expect, test } from "bun:test";
import {
	ensureCompanyUser,
	ensureCompanyUserGrant,
	ensureOrg,
	ensureProjectGrant,
	findOrg,
} from "./zitadel-orgs";
import { seedUsers } from "./zitadel-seed";

type Org = { id: string; name: string; primaryDomain: string };
type User = { id: string; userName: string; orgId: string; machine?: object };
type ProjectGrant = { grantId: string; grantedOrgId: string; grantedRoleKeys: string[] };
type UserGrant = { id: string; userId: string; orgId: string; projectId: string; projectGrantId: string; roleKeys: string[] };

const DEFAULT_ORG = "org-default";

/** A fake ZITADEL that keeps organizations, users, and grants in memory. */
function fakeZitadel(options: { searchLag?: number } = {}) {
	const orgs: Org[] = [{ id: DEFAULT_ORG, name: "Vern", primaryDomain: "vern.localhost" }];
	const users: User[] = [];
	const projectGrants: ProjectGrant[] = [];
	const userGrants: UserGrant[] = [];
	const calls: { method: string; path: string; org: string | null; body: Record<string, any> }[] = [];
	const created: Record<string, any>[] = [];
	let next = 1;
	let lag = options.searchLag ?? 0;
	const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		const org = new Headers(init?.headers).get("x-zitadel-orgid");
		calls.push({ method, path, org, body });

		if (path === "/v2/organizations/_search") {
			const query = body.queries[0];
			if (query.idQuery && lag > 0) {
				lag--;
				return json({ result: [] });
			}
			const matches = orgs.filter((item) =>
				query.nameQuery ? item.name === query.nameQuery.name : item.id === query.idQuery.id,
			);
			return json({ result: matches });
		}
		if (path === "/v2/organizations" && method === "POST") {
			const name = body.name as string;
			const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
			const item = { id: `org${next++}`, name, primaryDomain: `${slug}.localhost` };
			orgs.push(item);
			return json({ organizationId: item.id }, 201);
		}
		const grants = path.match(/^\/management\/v1\/projects\/([^/]+)\/grants(?:\/(_search|[^/]+))?$/);
		if (grants) {
			if (grants[2] === "_search") return json({ result: projectGrants });
			if (method === "POST") {
				projectGrants.push({ grantId: `pg${next++}`, grantedOrgId: body.grantedOrgId, grantedRoleKeys: body.roleKeys });
				return json({ grantId: projectGrants.at(-1)!.grantId });
			}
			if (method === "PUT") {
				const grant = projectGrants.find((item) => item.grantId === grants[2]);
				if (!grant) return json({ message: "not found" }, 404);
				grant.grantedRoleKeys = body.roleKeys;
				return json({});
			}
		}
		if (path === "/management/v1/users/_search") {
			const name = body.queries[0].userNameQuery.userName;
			return json({ result: users.filter((item) => item.userName === name && item.orgId === (org ?? DEFAULT_ORG)) });
		}
		if (path === "/v2/users/human") {
			created.push(body);
			users.push({ id: `user${next++}`, userName: body.username, orgId: body.organization.orgId });
			return json({ userId: users.at(-1)!.id });
		}
		if (path === "/management/v1/users/grants/_search") {
			const userId = body.queries.find((q: any) => q.userIdQuery).userIdQuery.userId;
			return json({ result: userGrants.filter((item) => item.userId === userId && item.orgId === org) });
		}
		const grantRoute = path.match(/^\/management\/v1\/users\/([^/]+)\/grants(?:\/([^/]+))?$/);
		if (grantRoute && method === "POST") {
			userGrants.push({
				id: `ug${next++}`,
				userId: grantRoute[1],
				orgId: org ?? "",
				projectId: body.projectId,
				projectGrantId: body.projectGrantId,
				roleKeys: body.roleKeys,
			});
			return json({ userGrantId: userGrants.at(-1)!.id });
		}
		if (grantRoute && method === "PUT") {
			const grant = userGrants.find((item) => item.id === grantRoute[2]);
			if (!grant) return json({ message: "not found" }, 404);
			grant.roleKeys = body.roleKeys;
			return json({});
		}
		return json({ message: `unexpected ${method} ${path}` }, 500);
	}) as unknown as typeof fetch;

	return { orgs, users, projectGrants, userGrants, calls, created, api: { issuer: "http://localhost:8081", token: "t", fetcher } };
}

const noSleep = async () => {};

describe("ensureOrg", () => {
	test("creates the organization and reads back its domain", async () => {
		const zitadel = fakeZitadel();
		const result = await ensureOrg(zitadel.api, "Acme Ads", noSleep);
		expect(result).toEqual({ org: { id: "org1", name: "Acme Ads", primaryDomain: "acme-ads.localhost" }, created: true });
		// Nobody becomes its administrator: no admins are sent.
		expect(zitadel.calls.find((call) => call.method === "POST" && call.path === "/v2/organizations")?.body).toEqual({ name: "Acme Ads" });
	});

	test("finds an existing organization and creates nothing", async () => {
		const zitadel = fakeZitadel();
		await ensureOrg(zitadel.api, "Acme Ads", noSleep);
		const again = await ensureOrg(zitadel.api, "Acme Ads", noSleep);
		expect(again.created).toBe(false);
		expect(zitadel.orgs).toHaveLength(2);
	});

	test("waits for the search to catch up with the write", async () => {
		const zitadel = fakeZitadel({ searchLag: 3 });
		const sleeps: number[] = [];
		const result = await ensureOrg(zitadel.api, "Acme Ads", async (ms) => void sleeps.push(ms));
		expect(result.org.primaryDomain).toBe("acme-ads.localhost");
		expect(sleeps).toHaveLength(3);
	});

	test("gives up when the organization never shows up", async () => {
		const zitadel = fakeZitadel({ searchLag: 1000 });
		await expect(ensureOrg(zitadel.api, "Acme Ads", noSleep)).rejects.toThrow('did not list it');
	});

	test("findOrg matches the whole name, not a part of it", async () => {
		const zitadel = fakeZitadel();
		expect(await findOrg(zitadel.api, "Ver")).toBeUndefined();
		expect((await findOrg(zitadel.api, "Vern"))?.id).toBe(DEFAULT_ORG);
	});
});

describe("ensureProjectGrant", () => {
	test("grants the roles to the organization once", async () => {
		const zitadel = fakeZitadel();
		const first = await ensureProjectGrant(zitadel.api, "42", "org1", ["advertiser", "owner"]);
		expect(first).toEqual({ id: "pg1", added: ["advertiser", "owner"], roles: ["advertiser", "owner"] });
		const again = await ensureProjectGrant(zitadel.api, "42", "org1", ["owner", "advertiser"]);
		expect(again.added).toEqual([]);
		expect(zitadel.projectGrants).toHaveLength(1);
	});

	test("adds the roles that are missing and removes none", async () => {
		const zitadel = fakeZitadel();
		zitadel.projectGrants.push({ grantId: "pg0", grantedOrgId: "org1", grantedRoleKeys: ["support", "owner"] });
		const result = await ensureProjectGrant(zitadel.api, "42", "org1", ["owner", "advertiser"]);
		expect(result).toEqual({ id: "pg0", added: ["advertiser"], roles: ["support", "owner", "advertiser"] });
		expect(zitadel.projectGrants[0].grantedRoleKeys).toEqual(["support", "owner", "advertiser"]);
	});

	test("keeps one organization's grant apart from another's", async () => {
		const zitadel = fakeZitadel();
		await ensureProjectGrant(zitadel.api, "42", "org1", ["advertiser"]);
		await ensureProjectGrant(zitadel.api, "42", "org2", ["publisher"]);
		expect(zitadel.projectGrants.map((grant) => [grant.grantedOrgId, grant.grantedRoleKeys])).toEqual([
			["org1", ["advertiser"]],
			["org2", ["publisher"]],
		]);
	});
});

describe("ensureCompanyUser and ensureCompanyUserGrant", () => {
	const ada = { login: "ada@acme.localhost", givenName: "Ada", familyName: "Owner" };

	test("creates the user inside the organization with a verified address and a password", async () => {
		const zitadel = fakeZitadel();
		const result = await ensureCompanyUser(zitadel.api, "org1", { ...ada, password: () => "Secret-Pass-1!" });
		expect(result.created).toBe(true);
		expect(zitadel.created[0]).toEqual({
			organization: { orgId: "org1" },
			username: "ada@acme.localhost",
			profile: { givenName: "Ada", familyName: "Owner", displayName: "Ada Owner" },
			email: { email: "ada@acme.localhost", isVerified: true },
			password: { password: "Secret-Pass-1!", changeRequired: false },
		});
	});

	test("finds an existing user without asking for a password", async () => {
		const zitadel = fakeZitadel();
		zitadel.users.push({ id: "u1", userName: "ada@acme.localhost", orgId: "org1" });
		const result = await ensureCompanyUser(zitadel.api, "org1", {
			...ada,
			password: () => {
				throw new Error("no password is needed");
			},
		});
		expect(result).toEqual({ id: "u1", created: false });
	});

	test("does not take a user of another organization for its own", async () => {
		const zitadel = fakeZitadel();
		zitadel.users.push({ id: "u1", userName: "ada@acme.localhost", orgId: "org2" });
		const result = await ensureCompanyUser(zitadel.api, "org1", { ...ada, password: () => "x" });
		expect(result.created).toBe(true);
	});

	test("refuses a service user with the name", async () => {
		const zitadel = fakeZitadel();
		zitadel.users.push({ id: "m1", userName: "ada@acme.localhost", orgId: "org1", machine: {} });
		await expect(ensureCompanyUser(zitadel.api, "org1", { ...ada, password: () => "x" })).rejects.toThrow("service user");
	});

	test("grants roles through the project grant, in the company's organization", async () => {
		const zitadel = fakeZitadel();
		const first = await ensureCompanyUserGrant(zitadel.api, "org1", "u1", "42", "pg1", ["advertiser", "owner"]);
		expect(first.added).toEqual(["advertiser", "owner"]);
		const call = zitadel.calls.find((item) => item.method === "POST" && item.path === "/management/v1/users/u1/grants");
		expect(call?.org).toBe("org1");
		expect(call?.body).toEqual({ projectId: "42", projectGrantId: "pg1", roleKeys: ["advertiser", "owner"] });

		const again = await ensureCompanyUserGrant(zitadel.api, "org1", "u1", "42", "pg1", ["owner"]);
		expect(again.added).toEqual([]);
		expect(zitadel.userGrants).toHaveLength(1);
	});

	test("adds only the missing roles to a grant that exists", async () => {
		const zitadel = fakeZitadel();
		await ensureCompanyUserGrant(zitadel.api, "org1", "u1", "42", "pg1", ["advertiser"]);
		const more = await ensureCompanyUserGrant(zitadel.api, "org1", "u1", "42", "pg1", ["advertiser", "owner"]);
		expect(more).toEqual({ added: ["owner"], roles: ["advertiser", "owner"] });
		expect(zitadel.userGrants[0].roleKeys).toEqual(["advertiser", "owner"]);
	});

	test("a user without roles gets no grant", async () => {
		const zitadel = fakeZitadel();
		await ensureCompanyUserGrant(zitadel.api, "org1", "u1", "42", "pg1", []);
		expect(zitadel.calls).toEqual([]);
	});
});

describe("seedUsers with companies", () => {
	const seed = {
		adminRoles: [],
		users: [],
		companies: [
			{
				name: "Acme Ads",
				roles: ["advertiser"],
				users: [
					{ name: "owner", givenName: "Ada", familyName: "Owner", roles: ["owner"] },
					{ name: "member", givenName: "Max", familyName: "Member", roles: [] },
				],
			},
			{
				name: "Beta Screens",
				roles: ["publisher"],
				users: [{ name: "owner", givenName: "Bo", familyName: "Owner", roles: ["owner"] }],
			},
		],
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

	test("makes each company an organization with its roles, users, and user grants", async () => {
		const zitadel = fakeZitadel();
		const logs: string[] = [];
		const logins = await seedUsers(zitadel.api, seed, options(logs));

		expect(logins).toEqual([
			"owner@acme-ads.localhost",
			"member@acme-ads.localhost",
			"owner@beta-screens.localhost",
		]);
		const [, acme, beta] = zitadel.orgs;
		expect([acme.name, beta.name]).toEqual(["Acme Ads", "Beta Screens"]);
		// The company may use what its users hold; the grant is per company.
		expect(zitadel.projectGrants.map((grant) => [grant.grantedOrgId, grant.grantedRoleKeys])).toEqual([
			[acme.id, ["advertiser", "owner"]],
			[beta.id, ["publisher", "owner"]],
		]);
		// Everyone holds the company's roles; the owner has `owner` on top.
		expect(zitadel.userGrants.map((grant) => [grant.orgId, grant.roleKeys])).toEqual([
			[acme.id, ["advertiser", "owner"]],
			[acme.id, ["advertiser"]],
			[beta.id, ["publisher", "owner"]],
		]);
		expect(logs.join("\n")).not.toContain("Secret-Pass-1!");
	});

	test("the same user name in two companies is two users", async () => {
		const zitadel = fakeZitadel();
		await seedUsers(zitadel.api, seed, options([]));
		const [, acme, beta] = zitadel.orgs;
		const owners = zitadel.users.filter((user) => user.userName.startsWith("owner@"));
		expect(owners.map((user) => user.orgId)).toEqual([acme.id, beta.id]);
	});

	test("running it again changes nothing and asks for no password", async () => {
		const zitadel = fakeZitadel();
		await seedUsers(zitadel.api, seed, options([]));
		const before = JSON.stringify([zitadel.orgs, zitadel.users, zitadel.projectGrants, zitadel.userGrants]);
		zitadel.calls.length = 0;

		const logs: string[] = [];
		const passwords: string[] = [];
		await seedUsers(zitadel.api, seed, options(logs, passwords));
		expect(JSON.stringify([zitadel.orgs, zitadel.users, zitadel.projectGrants, zitadel.userGrants])).toBe(before);
		expect(zitadel.calls.every((call) => call.path.endsWith("_search"))).toBe(true);
		expect(passwords).toEqual([]);
		expect(logs).toEqual([]);
	});
});
