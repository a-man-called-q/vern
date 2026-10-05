import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureProjectRoles, readProjectRoles } from "./roles";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rolesFile(content: string | undefined): string {
	const root = mkdtempSync(join(tmpdir(), "vern-roles-"));
	tempDirs.push(root);
	mkdirSync(root, { recursive: true });
	if (content !== undefined) writeFileSync(resolve(root, "roles.json"), content);
	return root;
}

describe("readProjectRoles", () => {
	test("reads keys and objects, defaulting the display name to the key", () => {
		const root = rolesFile(
			JSON.stringify(["publisher", { key: "admin", displayName: "Administrator", group: "Staff" }, { key: "support" }]),
		);
		expect(readProjectRoles(root)).toEqual([
			{ key: "publisher", displayName: "publisher" },
			{ key: "admin", displayName: "Administrator", group: "Staff" },
			{ key: "support", displayName: "support" },
		]);
	});

	test("a missing file or an empty list means no roles", () => {
		expect(readProjectRoles(rolesFile(undefined))).toEqual([]);
		expect(readProjectRoles(rolesFile("[]"))).toEqual([]);
	});

	test.each([
		["not JSON", "[publisher", "roles.json is not valid JSON"],
		["an object", '{"publisher":true}', "must be an array"],
		["a number entry", "[1]", "each role must be a string or an object"],
		["a null entry", "[null]", "each role must be a string or an object"],
		["an empty key", '[""]', "a role key must be a string"],
		["a key with a space", '["site admin"]', 'role key "site admin" may only contain'],
		["a duplicate", '["a","a"]', 'role "a" is listed twice'],
		["a bad display name", '[{"key":"a","displayName":5}]', 'the display name of "a"'],
		["a bad group", '[{"key":"a","group":""}]', 'the group of "a"'],
	])("rejects %s", (_name, content, message) => {
		expect(() => readProjectRoles(rolesFile(content))).toThrow(message);
	});
});

describe("ensureProjectRoles", () => {
	function fakeApi(existing: string[]) {
		const posted: { path: string; body: Record<string, unknown> }[] = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			posted.push({ path: new URL(String(input)).pathname, body });
			if (existing.includes(body.roleKey)) {
				return new Response(JSON.stringify({ message: "Role already exists" }), { status: 409 });
			}
			if (body.roleKey === "boom") return new Response(JSON.stringify({ message: "nope" }), { status: 500 });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		return { posted, api: { issuer: "http://localhost:8081", token: "t", fetcher } };
	}

	test("posts each role and separates new from existing ones", async () => {
		const { api, posted } = fakeApi(["admin"]);
		const result = await ensureProjectRoles(api, "42", [
			{ key: "publisher", displayName: "Publisher", group: "Market" },
			{ key: "admin", displayName: "admin" },
		]);
		expect(result).toEqual({ created: ["publisher"], existing: ["admin"] });
		expect(posted[0]).toEqual({
			path: "/management/v1/projects/42/roles",
			body: { roleKey: "publisher", displayName: "Publisher", group: "Market" },
		});
		expect(posted[1].body).toEqual({ roleKey: "admin", displayName: "admin" });
	});

	test("lets other failures through", async () => {
		const { api } = fakeApi([]);
		await expect(ensureProjectRoles(api, "42", [{ key: "boom", displayName: "boom" }])).rejects.toThrow("HTTP 500");
	});

	test("refuses a project ID that is not an ID", async () => {
		const { api } = fakeApi([]);
		await expect(ensureProjectRoles(api, "../x", [])).rejects.toThrow("project ID");
	});
});
