import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "./lib/env";
import { main } from "./zitadel-service-account";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
	mkdirSync(dirname(resolve(root, path)), { recursive: true });
	writeFileSync(resolve(root, path), content);
}

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "vern-service-account-"));
	tempDirs.push(root);
	write(root, ".env.example", "ZITADEL_ISSUER=http://localhost:8081\n");
	write(root, "apps/admin/.env.example", "PORT=3002\nAPP_URL=http://localhost:3002\n");
	return root;
}

type Call = { method: string; path: string; body: unknown; authorization: string | null };

/** A fake ZITADEL Management API with machine users, org members, and tokens. */
function fakeZitadel(
	options: { orgMembers?: { userId: string; roles: string[] }[]; instanceMembers?: { userId: string; roles: string[] }[]; users?: object[] } = {},
) {
	const calls: Call[] = [];
	const users: { id: string; userName: string; machine?: object; human?: object }[] = (options.users as never) ?? [];
	const members = options.orgMembers ?? [];
	const instanceMembers = options.instanceMembers ?? [];
	const tokens = new Map<string, string>();
	let next = 1;
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const authorization = new Headers(init?.headers).get("Authorization");
		calls.push({ method, path, body, authorization });

		if (path === "/auth/v1/users/me") {
			const userId = tokens.get(String(authorization).replace("Bearer ", ""));
			return userId ? json({ user: { id: userId } }) : json({ message: "invalid token" }, 401);
		}
		if (path === "/management/v1/users/_search") {
			const name = body.queries[0].userNameQuery.userName;
			return json({ result: users.filter((user) => user.userName === name) });
		}
		if (path === "/management/v1/users/machine") {
			const user = { id: `user-${next++}`, userName: body.userName, machine: {} };
			users.push(user);
			return json({ userId: user.id });
		}
		if (path === "/management/v1/orgs/me/members/_search") {
			return json({ result: members.filter((member) => member.userId === body.queries[0].userIdQuery.userId) });
		}
		if (path === "/management/v1/orgs/me/members" && method === "POST") {
			members.push({ userId: body.userId, roles: body.roles });
			return json({});
		}
		const update = path.match(/^\/management\/v1\/orgs\/me\/members\/([^/]+)$/);
		if (update && method === "PUT") {
			members.find((member) => member.userId === update[1])!.roles = body.roles;
			return json({});
		}
		if (path === "/admin/v1/members/_search") {
			return json({ result: instanceMembers.filter((member) => member.userId === body.queries[0].userIdQuery.userId) });
		}
		if (path === "/admin/v1/members" && method === "POST") {
			instanceMembers.push({ userId: body.userId, roles: body.roles });
			return json({});
		}
		const instanceUpdate = path.match(/^\/admin\/v1\/members\/([^/]+)$/);
		if (instanceUpdate && method === "PUT") {
			instanceMembers.find((member) => member.userId === instanceUpdate[1])!.roles = body.roles;
			return json({});
		}
		const pat = path.match(/^\/management\/v1\/users\/([^/]+)\/pats$/);
		if (pat && method === "POST") {
			const token = `pat-${next++}`;
			tokens.set(token, pat[1]);
			return json({ tokenId: `t${next}`, token });
		}
		return json({ message: `unexpected ${method} ${path}` }, 500);
	}) as typeof fetch;
	return { calls, fetcher, users, members, instanceMembers, tokens };
}

function run(root: string, zitadel: ReturnType<typeof fakeZitadel>, argv: string[] = ["--app", "admin"], logs: string[] = []) {
	return main(argv, {
		root,
		env: {},
		fetcher: zitadel.fetcher,
		log: (message) => logs.push(message),
		readStackToken: () => "stack-token",
	});
}

describe("zitadel:service-account", () => {
	test("creates the user, grants the role, and stores the token in the app's .env", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		const logs: string[] = [];
		expect(await run(root, zitadel, ["--app", "admin"], logs)).toBe(0);

		expect(zitadel.users).toEqual([{ id: "user-1", userName: "vern-user-admin", machine: {} }]);
		expect(zitadel.members).toEqual([{ userId: "user-1", roles: ["ORG_USER_MANAGER"] }]);
		const token = parseEnv(resolve(root, "apps/admin/.env")).get("ZITADEL_USER_ADMIN_TOKEN");
		expect(token).toBe("pat-2");
		expect(zitadel.tokens.get("pat-2")).toBe("user-1");
		// The setup token manages ZITADEL; the app's token must never show up in the output.
		expect(logs.join("\n")).not.toContain("pat-2");
		expect(logs.join("\n")).not.toContain("stack-token");
		expect(zitadel.calls.find((call) => call.path === "/management/v1/users/machine")?.body).toMatchObject({
			accessTokenType: "ACCESS_TOKEN_TYPE_BEARER",
		});
		expect(zitadel.calls[0].authorization).toBe("Bearer stack-token");
	});

	test("keeps everything, including a token that still works, when run again", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		await run(root, zitadel);
		const before = readFileSync(resolve(root, "apps/admin/.env"), "utf8");
		zitadel.calls.length = 0;

		const logs: string[] = [];
		expect(await run(root, zitadel, ["--app", "admin"], logs)).toBe(0);
		expect(zitadel.users).toHaveLength(1);
		expect(zitadel.members).toHaveLength(1);
		expect(readFileSync(resolve(root, "apps/admin/.env"), "utf8")).toBe(before);
		expect(zitadel.calls.some((call) => call.path.endsWith("/pats"))).toBe(false);
		expect(logs.at(-1)).toContain("keeping the token");
	});

	test("replaces a token ZITADEL no longer accepts", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		await run(root, zitadel);
		zitadel.tokens.clear();
		await run(root, zitadel);
		const token = parseEnv(resolve(root, "apps/admin/.env")).get("ZITADEL_USER_ADMIN_TOKEN");
		expect(token).not.toBe("pat-2");
		expect(zitadel.tokens.get(token as string)).toBe("user-1");
	});

	test("adds the role to a member that has other roles", async () => {
		const root = workspace();
		const zitadel = fakeZitadel({
			users: [{ id: "u9", userName: "vern-user-admin", machine: {} }],
			orgMembers: [{ userId: "u9", roles: ["ORG_OWNER_VIEWER"] }],
		});
		await run(root, zitadel);
		expect(zitadel.members[0].roles).toEqual(["ORG_OWNER_VIEWER", "ORG_USER_MANAGER"]);
		expect(zitadel.users).toHaveLength(1);
	});

	test("takes the user name from the project, and the role and variable from the options", async () => {
		const root = workspace();
		write(
			root,
			".vern/config.json",
			JSON.stringify({
				schemaVersion: 1,
				project: { name: "Acme", slug: "acme" },
				upstream: { url: "https://example.test/vern.git", branch: "main", lastSyncedSha: "abc" },
			}),
		);
		const zitadel = fakeZitadel();
		await run(root, zitadel, ["--app", "admin", "--role", "ORG_USER_PERMISSION_EDITOR", "--env-key", "ACME_ADMIN_TOKEN"]);
		expect(zitadel.users[0].userName).toBe("acme-user-admin");
		expect(zitadel.members[0].roles).toEqual(["ORG_USER_PERMISSION_EDITOR"]);
		expect(parseEnv(resolve(root, "apps/admin/.env")).get("ACME_ADMIN_TOKEN")).toBeTruthy();
	});

	test("grants an instance role, and no organization role with --role none", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		const logs: string[] = [];
		const argv = ["--app", "admin", "--name", "orgs", "--role", "none", "--instance-role", "IAM_ORG_MANAGER", "--env-key", "ZITADEL_ORG_ADMIN_TOKEN"];
		expect(await run(root, zitadel, argv, logs)).toBe(0);

		expect(zitadel.members).toEqual([]);
		expect(zitadel.instanceMembers).toEqual([{ userId: "user-1", roles: ["IAM_ORG_MANAGER"] }]);
		expect(parseEnv(resolve(root, "apps/admin/.env")).get("ZITADEL_ORG_ADMIN_TOKEN")).toBe("pat-2");
		expect(logs.join("\n")).toContain('Granted IAM_ORG_MANAGER to "orgs" in the instance');
		expect(logs.join("\n")).toContain("reaches every organization of the instance");
	});

	test("adds an instance role to a member that has another, and keeps it when run again", async () => {
		const root = workspace();
		const zitadel = fakeZitadel({
			users: [{ id: "u1", userName: "orgs", machine: {} }],
			instanceMembers: [{ userId: "u1", roles: ["IAM_USER_MANAGER"] }],
		});
		const argv = ["--app", "admin", "--name", "orgs", "--role", "none", "--instance-role", "IAM_ORG_MANAGER"];
		await run(root, zitadel, argv);
		expect(zitadel.instanceMembers).toEqual([{ userId: "u1", roles: ["IAM_USER_MANAGER", "IAM_ORG_MANAGER"] }]);

		const logs: string[] = [];
		await run(root, zitadel, argv, logs);
		expect(zitadel.instanceMembers[0].roles).toEqual(["IAM_USER_MANAGER", "IAM_ORG_MANAGER"]);
		expect(logs.join("\n")).toContain("already holds IAM_ORG_MANAGER in the instance");
	});

	test("refuses a user name that belongs to a person", async () => {
		const root = workspace();
		const zitadel = fakeZitadel({ users: [{ id: "u1", userName: "vern-user-admin", human: {} }] });
		await expect(run(root, zitadel)).rejects.toThrow("is not a service user");
		expect(zitadel.members).toHaveLength(0);
	});

	test("needs an app that exists, and a well-formed variable name", async () => {
		const root = workspace();
		await expect(run(root, fakeZitadel(), [])).rejects.toThrow("Pass --app");
		await expect(run(root, fakeZitadel(), ["--app", "missing"])).rejects.toThrow("apps/missing does not exist");
		await expect(run(root, fakeZitadel(), ["--app", "admin", "--env-key", "bad key"])).rejects.toThrow("--env-key");
	});

	test("explains how to get a token when the stack has none", async () => {
		const root = workspace();
		await expect(
			main(["--app", "admin"], { root, env: {}, fetcher: fakeZitadel().fetcher, log: () => {}, readStackToken: () => undefined }),
		).rejects.toThrow("No ZITADEL token found");
	});
});
