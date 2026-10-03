import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ROOT } from "../lib/paths";
import { findApps } from "../lib/projects";
import { parseEnv } from "../lib/env";
import { apiUrlKey } from "./api-urls";
import { setup } from "./setup";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
	mkdirSync(dirname(resolve(root, path)), { recursive: true });
	writeFileSync(resolve(root, path), content);
}

/** A workspace with one web app and one API, as the generators create them. */
function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "vern-setup-"));
	tempDirs.push(root);
	write(root, ".env.example", "ZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=replace-with-your-zitadel-project-id\n");
	write(root, "deploy/dev/auth-server/.env.example", "ZITADEL_ORG_NAME=Vern\nZITADEL_ADMIN_USERNAME=zitadel-admin\n");
	write(
		root,
		"apps/dashboard/.env.example",
		"PORT=3000\nAPP_URL=http://localhost:3000\nZITADEL_CLIENT_ID=replace-with-your-zitadel-client-id\nSESSION_SECRET=\nAPI_BASE_URL=\n",
	);
	write(
		root,
		"services/api/.env.example",
		"PORT=4000\nZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=replace-with-your-zitadel-project-id\nZITADEL_API_KEY_FILE=./secrets/zitadel-api-key.json\n",
	);
	mkdirSync(resolve(root, "apps/storybook"), { recursive: true });
	return root;
}

type Call = { method: string; path: string; body: unknown };

/** A fake ZITADEL Management API that keeps projects and apps in memory. */
function fakeZitadel() {
	const calls: Call[] = [];
	const projects: { id: string; name: string }[] = [];
	const apps: { id: string; name: string; oidcConfig?: { clientId: string }; apiConfig?: object }[] = [];
	const keys: { appId: string; keyId: string }[] = [];
	const roles: { projectId: string; roleKey: string; displayName: string; group?: string }[] = [];
	const users: { id: string; userName: string; password?: string }[] = [
		{ id: "admin1", userName: "zitadel-admin@vern.localhost" },
	];
	const grants: { id: string; userId: string; projectId: string; roleKeys: string[] }[] = [];
	// Like ZITADEL's JSON, the settings leave out a flag that is false.
	const loginPolicy: { settings: Record<string, unknown> } = {
		settings: {
			allowUsernamePassword: true,
			allowExternalIdp: true,
			forceMfa: true,
			passwordlessType: "PASSWORDLESS_TYPE_ALLOWED",
			passwordCheckLifetime: "864000s",
		},
	};
	// ZITADEL's JSON also leaves out a false flag and an empty string.
	const smtp: Record<string, unknown>[] = [];
	const smtpPasswords = new Map<string, string>();
	let nextSmtp = 1;
	const present = (body: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(body).filter(([, value]) => value !== false && value !== ""));
	const flagsOnly = (settings: Record<string, unknown>) =>
		JSON.stringify(Object.entries(settings).filter(([, value]) => value !== false).sort(([a], [b]) => a.localeCompare(b)));
	const instanceMembers: { userId: string; roles: string[] }[] = [];
	const tokens = new Map<string, string>();
	let next = 100;
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		if (path === "/.well-known/openid-configuration") return json({ issuer: String(input) });
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, path, body });
		if (path === "/management/v1/projects/_search") {
			const name = body.queries[0].nameQuery.name;
			return json({ result: projects.filter((p) => p.name === name) });
		}
		if (path === "/management/v1/projects" && method === "POST") {
			const project = { id: String(next++), name: body.name };
			projects.push(project);
			return json({ id: project.id });
		}
		const role = path.match(/^\/management\/v1\/projects\/([^/]+)\/roles$/);
		if (role && method === "POST") {
			if (roles.some((r) => r.projectId === role[1] && r.roleKey === body.roleKey)) {
				return json({ code: 6, message: "Role already exists (PROJECT-vq8wu)" }, 409);
			}
			roles.push({ projectId: role[1], ...body });
			return json({});
		}
		if (path === "/management/v1/users/_search") {
			return json({ result: users.filter((u) => u.userName === body.queries[0].userNameQuery.userName) });
		}
		if (path === "/management/v1/users/machine") {
			const user = { id: `machine${next++}`, userName: body.userName, machine: {} };
			users.push(user as never);
			return json({ userId: user.id });
		}
		const pat = path.match(/^\/management\/v1\/users\/([^/]+)\/pats$/);
		if (pat && method === "POST") {
			const token = `pat-${next++}`;
			tokens.set(token, pat[1]);
			return json({ token });
		}
		if (path === "/auth/v1/users/me") {
			const userId = tokens.get(String(new Headers(init?.headers).get("Authorization")).replace("Bearer ", ""));
			return userId ? json({ user: { id: userId } }) : json({ message: "invalid token" }, 401);
		}
		if (path === "/admin/v1/members/_search") {
			return json({ result: instanceMembers.filter((m) => m.userId === body.queries[0].userIdQuery.userId) });
		}
		if (path === "/admin/v1/members" && method === "POST") {
			instanceMembers.push({ userId: body.userId, roles: body.roles });
			return json({});
		}
		if (path === "/v2/users/human") {
			const user = { id: `user${next++}`, userName: body.username, password: body.password.password };
			users.push(user);
			return json({ userId: user.id });
		}
		if (path === "/management/v1/users/grants/_search") {
			const userId = body.queries[0].userIdQuery.userId;
			return json({ result: grants.filter((g) => g.userId === userId) });
		}
		const grant = path.match(/^\/management\/v1\/users\/([^/]+)\/grants(?:\/([^/]+))?$/);
		if (grant && method === "POST") {
			grants.push({ id: `grant${next++}`, userId: grant[1], ...body });
			return json({});
		}
		if (grant && method === "PUT") {
			const existing = grants.find((g) => g.id === grant[2]);
			if (existing) existing.roleKeys = body.roleKeys;
			return json({});
		}
		const project = path.match(/^\/management\/v1\/projects\/([^/]+)$/);
		if (project && method === "GET") {
			return projects.some((p) => p.id === project[1]) ? json({ project: {} }) : json({ message: "not found" }, 404);
		}
		if (path.endsWith("/apps/_search")) {
			const name = body.queries[0].nameQuery.name;
			return json({ result: apps.filter((a) => a.name === name) });
		}
		if (path.endsWith("/apps/oidc")) {
			const app = { id: String(next++), name: body.name, oidcConfig: { clientId: `client-${body.name}` } };
			apps.push(app);
			return json({ appId: app.id, clientId: app.oidcConfig.clientId });
		}
		if (path.endsWith("/oidc_config")) return json({ message: "No changes (COMMAND-1m88i)" }, 400);
		if (path.endsWith("/apps/api")) {
			const app = { id: String(next++), name: body.name, apiConfig: {} };
			apps.push(app);
			return json({ appId: app.id, clientId: `client-${body.name}` });
		}
		const key = path.match(/\/apps\/([^/]+)\/keys(?:\/([^/]+))?$/);
		if (key && method === "GET") {
			return keys.some((k) => k.appId === key[1] && k.keyId === key[2]) ? json({ key: {} }) : json({ message: "not found" }, 404);
		}
		if (key) {
			const keyId = `k${keys.length + 1}`;
			keys.push({ appId: key[1], keyId });
			const keyDetails = Buffer.from(JSON.stringify({ type: "application", keyId, key: "PEM", appId: key[1], clientId: "c1" })).toString("base64");
			return json({ id: keyId, keyDetails });
		}
		if (path === "/admin/v1/smtp/_search") return json(smtp.length > 0 ? { result: smtp } : { details: {} });
		if (path === "/admin/v1/smtp" && method === "POST") {
			const { password, ...settings } = body;
			const config = { id: `smtp${nextSmtp++}`, state: "SMTP_CONFIG_INACTIVE", ...present(settings) };
			smtp.push(config);
			if (password) smtpPasswords.set(config.id, String(password));
			return json({ id: config.id });
		}
		const smtpRoute = path.match(/^\/admin\/v1\/smtp\/([^/]+)(?:\/(_activate|password))?$/);
		if (smtpRoute) {
			const config = smtp.find((item) => item.id === smtpRoute[1]);
			if (!config) return json({ message: "not found" }, 404);
			if (smtpRoute[2] === "_activate") {
				for (const other of smtp) other.state = "SMTP_CONFIG_INACTIVE";
				config.state = "SMTP_CONFIG_ACTIVE";
			} else if (smtpRoute[2] === "password") {
				smtpPasswords.set(String(config.id), body.password);
			} else {
				const { state, id } = config;
				for (const key of Object.keys(config)) delete config[key];
				Object.assign(config, { id, state, ...present(body) });
			}
			return json({});
		}
		if (path === "/admin/v1/policies/login" && method === "GET") {
			return json({
				policy: {
					details: { sequence: "19" },
					isDefault: true,
					secondFactors: ["SECOND_FACTOR_TYPE_OTP"],
					multiFactors: ["MULTI_FACTOR_TYPE_U2F_WITH_VERIFICATION"],
					...loginPolicy.settings,
				},
			});
		}
		if (path === "/admin/v1/policies/login" && method === "PUT") {
			if (flagsOnly(body) === flagsOnly(loginPolicy.settings)) {
				return json({ code: 9, message: "Default Login Policy has not been changed (INSTANCE-5M9vdd)" }, 400);
			}
			loginPolicy.settings = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== false));
			return json({ details: { sequence: "20" } });
		}
		return json({ message: `unexpected ${method} ${path}` }, 500);
	}) as typeof fetch;
	return { calls, fetcher, projects, apps, keys, roles, users, grants, loginPolicy, smtp, smtpPasswords, instanceMembers, tokens };
}

function deps(root: string, zitadel: ReturnType<typeof fakeZitadel>, logs: string[] = []) {
	return {
		root,
		env: {},
		fetcher: zitadel.fetcher,
		log: (message: string) => logs.push(message),
		startAuthStack: () => {},
		readStackToken: () => "stack-token",
		randomSecret: () => "generated-secret",
		generateAppManifests: (target: string, app: { path: string }) =>
			write(target, `${app.path}/k8s/kustomization.yaml`, "resources: []\n"),
	};
}

describe("findApps", () => {
	test("tells web apps and APIs apart by their .env.example", () => {
		expect(findApps(workspace()).map((app) => `${app.name}:${app.kind}`)).toEqual(["api:api", "dashboard:web"]);
	});
});

describe("setup", () => {
	test("creates the project, the applications, and every .env", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		expect(await setup([], deps(root, zitadel))).toBe(0);

		const rootEnv = parseEnv(resolve(root, ".env"));
		expect(rootEnv.get("ZITADEL_PROJECT_ID")).toBe("100");
		expect(zitadel.projects).toEqual([{ id: "100", name: "Vern" }]);
		expect(existsSync(resolve(root, "deploy/dev/auth-server/.env"))).toBe(true);

		const web = parseEnv(resolve(root, "apps/dashboard/.env"));
		expect(web.get("ZITADEL_CLIENT_ID")).toBe("client-dashboard");
		expect(web.get("SESSION_SECRET")).toBe("generated-secret");
		expect(web.get("API_BASE_URL")).toBe("http://localhost:4000");

		const api = parseEnv(resolve(root, "services/api/.env"));
		expect(api.get("ZITADEL_PROJECT_ID")).toBe("100");
		const keyFile = resolve(root, "services/api/secrets/zitadel-api-key.json");
		expect(JSON.parse(readFileSync(keyFile, "utf8")).keyId).toBe("k1");
		expect(statSync(keyFile).mode & 0o777).toBe(0o600);

		const created = zitadel.calls.find((call) => call.path.endsWith("/apps/oidc"));
		expect(created?.body).toMatchObject({ redirectUris: ["http://localhost:3000/auth/callback"], devMode: true });
	});

	describe("an API that creates organizations", () => {
		function tenants(): string {
			const root = workspace();
			write(
				root,
				"services/tenants/.env.example",
				"PORT=4003\nZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=replace-with-your-zitadel-project-id\nZITADEL_API_KEY_FILE=./secrets/zitadel-api-key.json\nZITADEL_ORG_ADMIN_TOKEN=\n",
			);
			return root;
		}

		test("gets a service user with the instance role and its token", async () => {
			const root = tenants();
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			expect(await setup([], deps(root, zitadel, logs))).toBe(0);

			const user = zitadel.users.find((item) => item.userName === "vern-tenants-orgs");
			expect(user).toBeDefined();
			expect(zitadel.instanceMembers).toEqual([{ userId: user!.id, roles: ["IAM_ORG_MANAGER"] }]);
			const token = parseEnv(resolve(root, "services/tenants/.env")).get("ZITADEL_ORG_ADMIN_TOKEN");
			expect(zitadel.tokens.get(token!)).toBe(user!.id);
			// An API that does not ask for the token does not get one.
			expect(parseEnv(resolve(root, "services/api/.env")).get("ZITADEL_ORG_ADMIN_TOKEN")).toBeUndefined();
			expect(logs.join("\n")).not.toContain(token!);
		});

		test("keeps a token that still works when run again", async () => {
			const root = tenants();
			const zitadel = fakeZitadel();
			await setup([], deps(root, zitadel));
			const before = readFileSync(resolve(root, "services/tenants/.env"), "utf8");

			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));
			expect(readFileSync(resolve(root, "services/tenants/.env"), "utf8")).toBe(before);
			expect(zitadel.instanceMembers).toHaveLength(1);
			expect(logs.join("\n")).toContain("keeping the token in ZITADEL_ORG_ADMIN_TOKEN");
		});
	});

	describe("with several APIs", () => {
		function twoApis(): string {
			const root = workspace();
			write(
				root,
				"services/ads-api/.env.example",
				"PORT=4001\nZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=replace-with-your-zitadel-project-id\nZITADEL_API_KEY_FILE=./secrets/zitadel-api-key.json\n",
			);
			return root;
		}

		test("wires the API a web app names in API_APP", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APP=ads-api\n");
			expect(await setup([], deps(root, fakeZitadel()))).toBe(0);
			expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("API_BASE_URL")).toBe("http://localhost:4001");
		});

		test("says which web app has no API when none is named", async () => {
			const root = twoApis();
			const logs: string[] = [];
			expect(await setup([], deps(root, fakeZitadel(), logs))).toBe(0);
			expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("API_BASE_URL")).toBe("");
			expect(logs).toContain(
				"apps/dashboard: API_BASE_URL is not set (2 APIs found: ads-api, api). Set API_APP=<api> in apps/dashboard/.env and run this again.",
			);
		});

		test("fails on an API_APP that is not an API", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APP=billing\n");
			await expect(setup([], deps(root, fakeZitadel()))).rejects.toThrow(
				"apps/dashboard: API_APP=billing does not name an Axum API with a PORT under services/ (found: ads-api, api)",
			);
		});

		test("keeps an API_BASE_URL that was set by hand", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APP=ads-api\nAPI_BASE_URL=https://api.acme.test\n");
			await setup([], deps(root, fakeZitadel()));
			expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("API_BASE_URL")).toBe("https://api.acme.test");
		});

		test("gives every API in API_APPS a variable with its URL", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APPS=ads-api, api\n");
			const logs: string[] = [];
			expect(await setup([], deps(root, fakeZitadel(), logs))).toBe(0);
			const env = parseEnv(resolve(root, "apps/dashboard/.env"));
			expect(env.get("ADS_API_API_URL")).toBe("http://localhost:4001");
			expect(env.get("API_API_URL")).toBe("http://localhost:4000");
			// The app reaches its APIs by name, so it is not told that API_BASE_URL is missing.
			expect(logs.some((line) => line.includes("API_BASE_URL is not set"))).toBe(false);
		});

		test("API_APPS comes from the example file too, and works next to API_APP", async () => {
			const root = twoApis();
			write(
				root,
				"apps/dashboard/.env.example",
				"PORT=3000\nAPP_URL=http://localhost:3000\nZITADEL_CLIENT_ID=replace-with-your-zitadel-client-id\nSESSION_SECRET=\nAPI_APP=api\nAPI_BASE_URL=\nAPI_APPS=ads-api\n",
			);
			await setup([], deps(root, fakeZitadel()));
			const env = parseEnv(resolve(root, "apps/dashboard/.env"));
			expect(env.get("API_BASE_URL")).toBe("http://localhost:4000");
			expect(env.get("ADS_API_API_URL")).toBe("http://localhost:4001");
		});

		test("keeps a variable that was set by hand, and fails on a name that is not an API", async () => {
			const root = twoApis();
			write(root, "apps/dashboard/.env", "API_APPS=ads-api\nADS_API_API_URL=https://ads.acme.test\n");
			await setup([], deps(root, fakeZitadel()));
			expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("ADS_API_API_URL")).toBe("https://ads.acme.test");

			write(root, "apps/dashboard/.env", "API_APPS=ads-api,billing\n");
			await expect(setup([], deps(root, fakeZitadel()))).rejects.toThrow(
				"apps/dashboard: API_APPS names billing, which is not an Axum API with a PORT under services/ (found: ads-api, api)",
			);
		});
	});

	describe("apiUrlKey", () => {
		test("makes a variable name from an app name", () => {
			expect(apiUrlKey("inventory")).toBe("INVENTORY_API_URL");
			expect(apiUrlKey("billing-api")).toBe("BILLING_API_API_URL");
			expect(() => apiUrlKey("9lives")).toThrow("cannot be made into a variable name");
		});
	});

	test("says nothing about APIs when there are none", async () => {
		const root = workspace();
		rmSync(resolve(root, "services/api"), { recursive: true });
		const logs: string[] = [];
		await setup([], deps(root, fakeZitadel(), logs));
		expect(logs.some((line) => line.includes("API_BASE_URL"))).toBe(false);
	});

	describe("with roles.json", () => {
		test("creates the declared roles on the project, once", async () => {
			const root = workspace();
			write(
				root,
				"roles.json",
				JSON.stringify(["publisher", { key: "advertiser", displayName: "Advertiser", group: "Marketplace" }]),
			);
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			expect(await setup([], deps(root, zitadel, logs))).toBe(0);
			expect(zitadel.roles).toEqual([
				{ projectId: "100", roleKey: "publisher", displayName: "publisher" },
				{ projectId: "100", roleKey: "advertiser", displayName: "Advertiser", group: "Marketplace" },
			]);
			expect(logs).toContain("Created ZITADEL project roles: publisher, advertiser");

			logs.length = 0;
			expect(await setup([], deps(root, zitadel, logs))).toBe(0);
			expect(zitadel.roles).toHaveLength(2);
			expect(logs).toContain("Project roles already there: publisher, advertiser");
		});

		test("creates only the roles that are missing", async () => {
			const root = workspace();
			write(root, "roles.json", JSON.stringify(["publisher"]));
			const zitadel = fakeZitadel();
			await setup([], deps(root, zitadel));
			write(root, "roles.json", JSON.stringify(["publisher", "admin"]));
			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));
			expect(zitadel.roles.map((role) => role.roleKey)).toEqual(["publisher", "admin"]);
			expect(logs).toContain("Created ZITADEL project roles: admin");
			expect(logs).toContain("Project roles already there: publisher");
		});

		test("stops before calling ZITADEL when the file is wrong", async () => {
			const root = workspace();
			write(root, "roles.json", '{"publisher": true}');
			const zitadel = fakeZitadel();
			await expect(setup([], deps(root, zitadel))).rejects.toThrow("roles.json must be an array");
			expect(zitadel.roles).toHaveLength(0);
		});

		test("does nothing without a roles.json", async () => {
			const root = workspace();
			const zitadel = fakeZitadel();
			await setup([], deps(root, zitadel));
			expect(zitadel.roles).toHaveLength(0);
		});

		test("also creates them with --compose", async () => {
			const root = workspace();
			write(root, "roles.json", JSON.stringify(["publisher"]));
			write(
				root,
				"deploy/prod/.env",
				"AUTH_DOMAIN=auth.acme.test\nAPP_DOMAIN=app.acme.test\nAPI_DOMAIN=api.acme.test\nACME_EMAIL=ops@acme.test\nWEB_APP=dashboard\nAPI_APP=api\n",
			);
			const zitadel = fakeZitadel();
			await setup(["--compose", "prod"], { ...deps(root, zitadel), runCompose: () => {} });
			expect(zitadel.roles.map((role) => role.roleKey)).toEqual(["publisher"]);
		});
	});

	describe("with seed-users.json", () => {
		const SEED = {
			adminRoles: ["admin"],
			users: [{ name: "publisher", givenName: "Demo", familyName: "Publisher", roles: ["publisher"] }],
		};
		function seeded(seed: unknown = SEED): string {
			const root = workspace();
			write(root, "roles.json", JSON.stringify(["admin", "publisher"]));
			write(root, "seed-users.json", JSON.stringify(seed));
			return root;
		}
		const passwordOf = (root: string) => parseEnv(resolve(root, "deploy/dev/auth-server/.env")).get("ZITADEL_SEED_PASSWORD");

		test("grants the admin and creates the users with a generated password, once", async () => {
			const root = seeded();
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			expect(await setup([], deps(root, zitadel, logs))).toBe(0);

			expect(zitadel.users.map((user) => user.userName)).toEqual([
				"zitadel-admin@vern.localhost",
				"publisher@vern.localhost",
			]);
			expect(zitadel.users[1].password).toBe("generated-secret");
			expect(zitadel.grants).toMatchObject([
				{ userId: "admin1", projectId: "100", roleKeys: ["admin"] },
				{ userId: zitadel.users[1].id, projectId: "100", roleKeys: ["publisher"] },
			]);
			expect(passwordOf(root)).toBe("generated-secret");
			expect(logs).toContain("Generated ZITADEL_SEED_PASSWORD in deploy/dev/auth-server/.env");
			expect(logs).toContain("Seeded users: publisher@vern.localhost (password: ZITADEL_SEED_PASSWORD in deploy/dev/auth-server/.env)");
			expect(logs.join("\n")).not.toContain("generated-secret");

			zitadel.calls.length = 0;
			expect(await setup([], deps(root, zitadel))).toBe(0);
			expect(zitadel.users).toHaveLength(2);
			expect(zitadel.grants).toHaveLength(2);
			expect(zitadel.calls.some((call) => call.path === "/v2/users/human")).toBe(false);
		});

		test("keeps a password that is already set", async () => {
			const root = seeded();
			write(root, "deploy/dev/auth-server/.env", "ZITADEL_SEED_PASSWORD=my-own-Passw0rd!\n");
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));
			expect(zitadel.users[1].password).toBe("my-own-Passw0rd!");
			expect(passwordOf(root)).toBe("my-own-Passw0rd!");
			expect(logs.some((line) => line.startsWith("Generated"))).toBe(false);
		});

		test("does not seed a ZITADEL that is not on this machine", async () => {
			const root = seeded();
			write(root, ".env", "ZITADEL_ISSUER=https://auth.acme.test\n");
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			expect(await setup([], deps(root, zitadel, logs))).toBe(0);
			expect(zitadel.users).toHaveLength(1);
			expect(zitadel.grants).toHaveLength(0);
			expect(passwordOf(root)).toBeUndefined();
			expect(logs).toContain(
				"Not seeding seed-users.json: ZITADEL_ISSUER (https://auth.acme.test) is not on this machine. Grant roles and create users in the Console.",
			);
		});

		test("--no-seed skips it, even when the file is wrong", async () => {
			const root = seeded({ adminRoles: ["root"] });
			const zitadel = fakeZitadel();
			expect(await setup(["--no-seed"], deps(root, zitadel))).toBe(0);
			expect(zitadel.users).toHaveLength(1);
			expect(zitadel.grants).toHaveLength(0);
		});

		test("--compose never seeds", async () => {
			const root = seeded();
			write(
				root,
				"deploy/prod/.env",
				"AUTH_DOMAIN=auth.acme.test\nAPP_DOMAIN=app.acme.test\nAPI_DOMAIN=api.acme.test\nACME_EMAIL=ops@acme.test\nWEB_APP=dashboard\nAPI_APP=api\n",
			);
			const zitadel = fakeZitadel();
			await setup(["--compose", "prod"], { ...deps(root, zitadel), runCompose: () => {} });
			expect(zitadel.users).toHaveLength(1);
			expect(zitadel.grants).toHaveLength(0);
		});

		test("stops before starting anything when a role is not declared in roles.json", async () => {
			const root = seeded({ users: [{ name: "x", givenName: "X", familyName: "Y", roles: ["root"] }] });
			const zitadel = fakeZitadel();
			let started = false;
			await expect(
				setup([], {
					...deps(root, zitadel),
					startAuthStack: () => {
						started = true;
					},
				}),
			).rejects.toThrow('the roles of "x" lists "root", which roles.json does not declare');
			expect(started).toBe(false);
			expect(zitadel.calls).toHaveLength(0);
		});

		test("does nothing without a seed-users.json", async () => {
			const root = workspace();
			const zitadel = fakeZitadel();
			await setup([], deps(root, zitadel));
			expect(zitadel.users).toHaveLength(1);
			expect(zitadel.grants).toHaveLength(0);
			expect(passwordOf(root)).toBeUndefined();
		});
	});

	describe("with ZITADEL_ALLOW_REGISTER", () => {
		const policyCalls = (zitadel: ReturnType<typeof fakeZitadel>, method: string) =>
			zitadel.calls.filter((call) => call.method === method && call.path === "/admin/v1/policies/login");

		test("turns sign-up off on an instance that has it on, keeping the other settings", async () => {
			const root = workspace();
			write(root, "deploy/dev/auth-server/.env", "ZITADEL_ALLOW_REGISTER=false\n");
			const zitadel = fakeZitadel();
			zitadel.loginPolicy.settings.allowRegister = true;
			const logs: string[] = [];
			expect(await setup([], deps(root, zitadel, logs))).toBe(0);

			expect(zitadel.loginPolicy.settings).toEqual({
				allowUsernamePassword: true,
				allowExternalIdp: true,
				forceMfa: true,
				passwordlessType: "PASSWORDLESS_TYPE_ALLOWED",
				passwordCheckLifetime: "864000s",
			});
			// Only what the update accepts is sent back.
			const [update] = policyCalls(zitadel, "PUT");
			expect(Object.keys(update.body as object).sort()).toEqual([
				"allowExternalIdp",
				"allowRegister",
				"allowUsernamePassword",
				"forceMfa",
				"passwordCheckLifetime",
				"passwordlessType",
			]);
			expect(logs).toContain("Turned self-registration off in ZITADEL (ZITADEL_ALLOW_REGISTER=false in deploy/dev/auth-server/.env)");
			expect(logs.some((line) => line.startsWith("The sign-in pages follow within 15 minutes"))).toBe(true);
		});

		test("turns sign-up on when asked to", async () => {
			const root = workspace();
			write(root, "deploy/dev/auth-server/.env", "ZITADEL_ALLOW_REGISTER=true\n");
			const zitadel = fakeZitadel();
			await setup([], deps(root, zitadel));
			expect(zitadel.loginPolicy.settings.allowRegister).toBe(true);
			expect(zitadel.loginPolicy.settings.forceMfa).toBe(true);
		});

		test("leaves the policy alone when it already matches", async () => {
			const root = workspace();
			write(root, "deploy/dev/auth-server/.env", "ZITADEL_ALLOW_REGISTER=false\n");
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));
			expect(policyCalls(zitadel, "PUT")).toHaveLength(0);
			expect(logs).toContain("Self-registration is off (ZITADEL_ALLOW_REGISTER=false in deploy/dev/auth-server/.env)");
			expect(logs.some((line) => line.startsWith("The sign-in pages follow"))).toBe(false);
		});

		test("takes a new project's choice from the copied .env.example", async () => {
			const root = workspace();
			write(root, "deploy/dev/auth-server/.env.example", "ZITADEL_ORG_NAME=Vern\nZITADEL_ALLOW_REGISTER=false\n");
			const zitadel = fakeZitadel();
			zitadel.loginPolicy.settings.allowRegister = true;
			await setup([], deps(root, zitadel));
			expect(zitadel.loginPolicy.settings.allowRegister).toBeUndefined();
		});

		test("without a value, changes nothing and says that anyone can sign up", async () => {
			const root = workspace();
			const zitadel = fakeZitadel();
			zitadel.loginPolicy.settings.allowRegister = true;
			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));
			expect(policyCalls(zitadel, "PUT")).toHaveLength(0);
			expect(zitadel.loginPolicy.settings.allowRegister).toBe(true);
			expect(logs.find((line) => line.startsWith("Anyone can create an account"))).toContain(
				"Set ZITADEL_ALLOW_REGISTER=false in deploy/dev/auth-server/.env",
			);
		});

		test("without a value, says nothing when sign-up is already off", async () => {
			const root = workspace();
			const logs: string[] = [];
			await setup([], deps(root, fakeZitadel(), logs));
			expect(logs.filter((line) => /self-registration|create an account/i.test(line))).toEqual([]);
		});

		test("treats ZITADEL's refusal of a no-op update as nothing to do", async () => {
			const root = workspace();
			write(root, "deploy/dev/auth-server/.env", "ZITADEL_ALLOW_REGISTER=false\n");
			const zitadel = fakeZitadel();
			zitadel.loginPolicy.settings.allowRegister = true;
			const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const response = await zitadel.fetcher(input, init);
				// Another run closes it between our read and our update.
				if ((init?.method ?? "GET") === "GET" && new URL(String(input)).pathname === "/admin/v1/policies/login") {
					delete zitadel.loginPolicy.settings.allowRegister;
				}
				return response;
			}) as typeof fetch;
			expect(await setup([], { ...deps(root, zitadel), fetcher })).toBe(0);
		});

		test("stops before starting anything on a value that is not true or false", async () => {
			const root = workspace();
			write(root, "deploy/dev/auth-server/.env", "ZITADEL_ALLOW_REGISTER=nope\n");
			let started = false;
			await expect(
				setup([], {
					...deps(root, fakeZitadel()),
					startAuthStack: () => {
						started = true;
					},
				}),
			).rejects.toThrow('ZITADEL_ALLOW_REGISTER must be true or false in deploy/dev/auth-server/.env, not "nope"');
			expect(started).toBe(false);
		});

		test("applies deploy/prod/.env with --compose", async () => {
			const root = workspace();
			write(
				root,
				"deploy/prod/.env",
				"AUTH_DOMAIN=auth.acme.test\nAPP_DOMAIN=app.acme.test\nAPI_DOMAIN=api.acme.test\nACME_EMAIL=ops@acme.test\nWEB_APP=dashboard\nAPI_APP=api\nZITADEL_ALLOW_REGISTER=false\n",
			);
			const zitadel = fakeZitadel();
			zitadel.loginPolicy.settings.allowRegister = true;
			await setup(["--compose", "prod"], { ...deps(root, zitadel), runCompose: () => {} });
			expect(zitadel.loginPolicy.settings.allowRegister).toBeUndefined();
		});
	});

	describe("mail", () => {
		const smtpCalls = (zitadel: ReturnType<typeof fakeZitadel>) =>
			zitadel.calls.filter((call) => call.path.startsWith("/admin/v1/smtp") && !call.path.endsWith("_search"));
		const deployEnv =
			"AUTH_DOMAIN=auth.acme.test\nAPP_DOMAIN=app.acme.test\nAPI_DOMAIN=api.acme.test\nACME_EMAIL=ops@acme.test\nWEB_APP=dashboard\nAPI_APP=api\n";

		test("points ZITADEL at Mailpit locally, and says where to read the mail", async () => {
			const root = workspace();
			write(root, "deploy/dev/auth-server/.env", "ZITADEL_ORG_NAME=Vern\nMAIL_UI_PORT=8030\n");
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));

			expect(zitadel.smtp).toEqual([
				{
					id: "smtp1",
					state: "SMTP_CONFIG_ACTIVE",
					senderAddress: "no-reply@vern.localhost",
					senderName: "Vern",
					host: "mailpit:1025",
					description: "Vern",
				},
			]);
			expect(logs).toContain("ZITADEL sends mail to Mailpit; read it at http://localhost:8030");
		});

		test("running it again leaves the configuration alone", async () => {
			const root = workspace();
			const zitadel = fakeZitadel();
			await setup([], deps(root, zitadel));
			zitadel.calls.length = 0;
			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));
			expect(smtpCalls(zitadel)).toEqual([]);
			expect(zitadel.smtp).toHaveLength(1);
			expect(logs).toContain("ZITADEL sends mail to Mailpit; read it at http://localhost:8025");
		});

		test("does not replace a mail setup someone made in the Console", async () => {
			const root = workspace();
			const zitadel = fakeZitadel();
			zitadel.smtp.push({ id: "console1", state: "SMTP_CONFIG_ACTIVE", host: "smtp.gmail.com:587", description: "Gmail" });
			const logs: string[] = [];
			await setup([], deps(root, zitadel, logs));
			expect(zitadel.smtp).toHaveLength(1);
			expect(smtpCalls(zitadel)).toEqual([]);
			expect(logs).toContain("ZITADEL sends mail through smtp.gmail.com:587, set up in the Console; leaving it as it is.");
		});

		test("--compose applies the SMTP_* of deploy/prod/.env, password included", async () => {
			const root = workspace();
			write(
				root,
				"deploy/prod/.env",
				`${deployEnv}SMTP_HOST=smtp.acme.test:587\nSMTP_FROM_ADDRESS=hello@acme.test\nSMTP_FROM_NAME=Acme\nSMTP_USER=apikey\nSMTP_PASSWORD=s3cret\nSMTP_TLS=true\n`,
			);
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			await setup(["--compose", "prod"], { ...deps(root, zitadel, logs), runCompose: () => {} });

			expect(zitadel.smtp).toEqual([
				{
					id: "smtp1",
					state: "SMTP_CONFIG_ACTIVE",
					senderAddress: "hello@acme.test",
					senderName: "Acme",
					tls: true,
					host: "smtp.acme.test:587",
					user: "apikey",
					description: "Vern",
				},
			]);
			expect(zitadel.smtpPasswords.get("smtp1")).toBe("s3cret");
			expect(logs).toContain("ZITADEL sends mail through smtp.acme.test:587 as hello@acme.test");
			expect(logs.join("\n")).not.toContain("s3cret");
		});

		test("--compose replaces a Console configuration when SMTP_HOST is set", async () => {
			const root = workspace();
			write(root, "deploy/prod/.env", `${deployEnv}SMTP_HOST=smtp.acme.test:25\nSMTP_FROM_ADDRESS=hello@acme.test\nSMTP_TLS=false\n`);
			const zitadel = fakeZitadel();
			zitadel.smtp.push({ id: "console1", state: "SMTP_CONFIG_ACTIVE", host: "smtp.gmail.com:587", description: "Gmail" });
			await setup(["--compose", "prod"], { ...deps(root, zitadel), runCompose: () => {} });
			expect(zitadel.smtp.find((config) => config.state === "SMTP_CONFIG_ACTIVE")).toMatchObject({ host: "smtp.acme.test:25", description: "Vern" });
		});

		test("--compose says out loud that there is no mail server", async () => {
			const root = workspace();
			write(root, "deploy/prod/.env", deployEnv);
			const zitadel = fakeZitadel();
			const logs: string[] = [];
			await setup(["--compose", "prod"], { ...deps(root, zitadel, logs), runCompose: () => {} });
			expect(zitadel.smtp).toEqual([]);
			expect(logs.some((line) => line.startsWith("ZITADEL has no SMTP server") && line.includes("deploy/prod/.env"))).toBe(true);
		});

		test("--compose stops on a half-filled mail setup before starting anything", async () => {
			const root = workspace();
			write(root, "deploy/prod/.env", `${deployEnv}SMTP_FROM_ADDRESS=hello@acme.test\n`);
			let started = false;
			await expect(
				setup(["--compose", "prod"], { ...deps(root, fakeZitadel()), runCompose: () => (started = true) as never }),
			).rejects.toThrow("SMTP_FROM_ADDRESS set in deploy/prod/.env without SMTP_HOST");
			expect(started).toBe(false);
		});
	});

	test("keeps what already exists when run again", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		await setup([], deps(root, zitadel));
		write(root, "apps/dashboard/.env", readFileSync(resolve(root, "apps/dashboard/.env"), "utf8").replace("generated-secret", "kept-secret"));
		zitadel.calls.length = 0;

		expect(await setup([], deps(root, zitadel))).toBe(0);
		expect(zitadel.projects).toHaveLength(1);
		expect(zitadel.apps).toHaveLength(2);
		expect(zitadel.calls.some((call) => call.path.endsWith("/keys"))).toBe(false);
		expect(zitadel.calls.some((call) => call.method === "POST" && call.path === "/management/v1/projects")).toBe(false);
		expect(parseEnv(resolve(root, "apps/dashboard/.env")).get("SESSION_SECRET")).toBe("kept-secret");
	});

	test("replaces a key that ZITADEL no longer knows", async () => {
		const root = workspace();
		write(root, "services/api/secrets/zitadel-api-key.json", JSON.stringify({ appId: "old", keyId: "gone", key: "PEM" }));
		const zitadel = fakeZitadel();
		await setup([], deps(root, zitadel));
		const key = JSON.parse(readFileSync(resolve(root, "services/api/secrets/zitadel-api-key.json"), "utf8"));
		expect(key.keyId).toBe("k1");
	});

	test("replaces a project ID that ZITADEL no longer knows", async () => {
		const root = workspace();
		write(root, ".env", "ZITADEL_ISSUER=http://localhost:8081\nZITADEL_PROJECT_ID=999\n");
		const zitadel = fakeZitadel();
		await setup([], deps(root, zitadel));
		expect(parseEnv(resolve(root, ".env")).get("ZITADEL_PROJECT_ID")).toBe("100");
	});

	test("prefers ZITADEL_PAT over the stack's token", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		const tokens: string[] = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("Authorization");
			if (authorization) tokens.push(authorization);
			return zitadel.fetcher(input, init);
		}) as typeof fetch;
		await setup([], { ...deps(root, zitadel), fetcher, env: { ZITADEL_PAT: "user-token" } });
		expect(new Set(tokens)).toEqual(new Set(["Bearer user-token"]));
	});

	test("fills in the production settings with --compose", async () => {
		const root = workspace();
		write(
			root,
			"deploy/compose/.env.example",
			"AUTH_DOMAIN=auth.example.com\nAPP_DOMAIN=app.example.com\nAPI_DOMAIN=api.example.com\nACME_EMAIL=admin@example.com\nWEB_APP=dashboard\nAPI_APP=api\nZITADEL_ORG_NAME=Vern\nZITADEL_MASTERKEY=\nZITADEL_ADMIN_PASSWORD=\nPOSTGRES_PASSWORD=\nREDIS_PASSWORD=\nWEB_SESSION_SECRET=\nZITADEL_PROJECT_ID=\nWEB_CLIENT_ID=\n",
		);
		const zitadel = fakeZitadel();
		const composeCalls: string[][] = [];
		const run = () =>
			setup(["--compose", "prod"], {
				...deps(root, zitadel),
				runCompose: (_root, args) => composeCalls.push(args),
				randomSecret: (kind, bytes) => `${kind}-${bytes}`,
			});

		await expect(run()).rejects.toThrow("Set AUTH_DOMAIN");
		expect(existsSync(resolve(root, "deploy/prod/.env"))).toBe(true);

		write(
			root,
			"deploy/prod/.env",
			readFileSync(resolve(root, "deploy/prod/.env"), "utf8")
				.replace("auth.example.com", "auth.acme.test")
				.replace("app.example.com", "app.acme.test")
				.replace("api.example.com", "api.acme.test")
				.replace("admin@example.com", "ops@acme.test"),
		);
		expect(await run()).toBe(0);

		const env = parseEnv(resolve(root, "deploy/prod/.env"));
		expect(env.get("ZITADEL_MASTERKEY")).toBe("hex-16");
		expect(env.get("ZITADEL_ADMIN_PASSWORD")).toBe("password-18");
		expect(env.get("WEB_SESSION_SECRET")).toBe("base64-32");
		expect(env.get("ZITADEL_PROJECT_ID")).toBe("100");
		expect(env.get("WEB_CLIENT_ID")).toBe("client-dashboard");

		const created = zitadel.calls.find((call) => call.path.endsWith("/apps/oidc"));
		expect(created?.body).toMatchObject({ redirectUris: ["https://app.acme.test/auth/callback"], devMode: false });

		const keyFile = resolve(root, "deploy/prod/secrets/api-key.json");
		expect(JSON.parse(readFileSync(keyFile, "utf8")).keyId).toBe("k1");
		expect(statSync(keyFile).mode & 0o777).toBe(0o644);
		expect(statSync(dirname(keyFile)).mode & 0o777).toBe(0o700);

		expect(composeCalls.map((args) => args.slice(args.indexOf("up")).join(" "))).toEqual([
			"up --detach --wait traefik zitadel-api zitadel-login auth-server postgres redis",
			"up --detach --wait --build",
		]);
	});

	test("refuses --compose for an app that does not exist", async () => {
		const root = workspace();
		write(
			root,
			"deploy/prod/.env",
			"AUTH_DOMAIN=auth.acme.test\nAPP_DOMAIN=app.acme.test\nAPI_DOMAIN=api.acme.test\nACME_EMAIL=ops@acme.test\nWEB_APP=shop\nAPI_APP=api\n",
		);
		await expect(setup(["--compose", "prod"], deps(root, fakeZitadel()))).rejects.toThrow("WEB_APP=shop");
	});

	const COMPOSE_EXAMPLE =
		"DEPLOY_ENV=prod\nAUTH_DOMAIN=auth.example.com\nAPP_DOMAIN=app.example.com\nAPI_DOMAIN=api.example.com\nACME_EMAIL=admin@example.com\nWEB_APP=web\nAPI_APP=backend\nZITADEL_PROJECT_ID=\nWEB_CLIENT_ID=\n";
	const composeEnv = (environment: string) =>
		`DEPLOY_ENV=${environment}\nAUTH_DOMAIN=auth.acme.test\nAPP_DOMAIN=app.acme.test\nAPI_DOMAIN=api.acme.test\nACME_EMAIL=ops@acme.test\nWEB_APP=dashboard\nAPI_APP=api\n`;

	test("--compose staging keeps its settings and the API's key in deploy/staging", async () => {
		const root = workspace();
		write(root, "deploy/compose/.env.example", COMPOSE_EXAMPLE);
		const run = () => setup(["--compose", "staging"], { ...deps(root, fakeZitadel()), runCompose: () => {} });
		await expect(run()).rejects.toThrow("Created deploy/staging/.env");
		expect(parseEnv(resolve(root, "deploy/staging/.env")).get("DEPLOY_ENV")).toBe("staging");

		// A file from before DEPLOY_ENV existed gets it, so the Compose file finds secrets/.
		write(root, "deploy/staging/.env", composeEnv("staging").replace("DEPLOY_ENV=staging\n", ""));
		expect(await run()).toBe(0);
		expect(parseEnv(resolve(root, "deploy/staging/.env")).get("DEPLOY_ENV")).toBe("staging");
		expect(existsSync(resolve(root, "deploy/staging/secrets/api-key.json"))).toBe(true);
		expect(existsSync(resolve(root, "deploy/prod"))).toBe(false);
	});

	test("--compose local needs no settings: hostnames under localtest.me, and a local certificate authority", async () => {
		const root = workspace();
		write(root, "deploy/compose/.env.example", COMPOSE_EXAMPLE);
		const composeCalls: string[][] = [];
		const logs: string[] = [];
		const zitadel = fakeZitadel();
		expect(
			await setup(["--compose", "local"], { ...deps(root, zitadel, logs), runCompose: (_root, args) => composeCalls.push(args) }),
		).toBe(0);

		const env = parseEnv(resolve(root, "deploy/local/.env"));
		expect(env.get("DEPLOY_ENV")).toBe("local");
		expect(env.get("AUTH_DOMAIN")).toBe("auth.localtest.me");
		// The only web app and the only API of the project.
		expect(env.get("WEB_APP")).toBe("dashboard");
		expect(env.get("API_APP")).toBe("api");
		for (const file of ["ca.pem", "cert.pem", "key.pem", "traefik-tls.yml"]) {
			expect(existsSync(resolve(root, "deploy/local/certs", file))).toBe(true);
		}
		expect(composeCalls[0]?.filter((arg) => arg.endsWith(".yml"))).toEqual([
			resolve(root, "deploy/compose/docker-compose.yml"),
			resolve(root, "deploy/compose/docker-compose.local.yml"),
		]);
		const created = zitadel.calls.find((call) => call.path.endsWith("/apps/oidc"));
		expect(created?.body).toMatchObject({ redirectUris: ["https://app.localtest.me/auth/callback"] });
	});

	test("--deploy is still --compose prod", async () => {
		const root = workspace();
		write(root, "deploy/prod/.env", composeEnv("prod"));
		expect(await setup(["--deploy"], { ...deps(root, fakeZitadel()), runCompose: () => {} })).toBe(0);
		expect(existsSync(resolve(root, "deploy/prod/secrets/api-key.json"))).toBe(true);
	});

	test("--env runs an environment the way it was set up, and asks when it cannot tell", async () => {
		const root = workspace();
		const run = (environment: string) =>
			setup(["--env", environment], { ...deps(root, fakeZitadel()), runCompose: () => {} });
		await expect(run("staging")).rejects.toThrow(
			"deploy/staging is not set up yet. Start with --compose staging (one server with Docker) or --kubernetes staging.",
		);
		await expect(run("production")).rejects.toThrow("--env takes local, staging, or prod");

		write(root, "deploy/staging/.env", composeEnv("staging"));
		expect(await run("staging")).toBe(0);
		expect(existsSync(resolve(root, "deploy/staging/secrets/api-key.json"))).toBe(true);

		write(root, "deploy/staging/settings.env", "DOMAIN=acme.test\n");
		await expect(run("staging")).rejects.toThrow("Say which one: --compose staging or --kubernetes staging.");
		await expect(setup(["--env", "prod", "--compose", "prod"], deps(root, fakeZitadel()))).rejects.toThrow(
			"Use one of --compose, --env.",
		);
	});

	test("--env runs an environment the way the project chose, before anything is set up there", async () => {
		const root = workspace();
		write(root, "deploy/compose/.env.example", COMPOSE_EXAMPLE);
		write(
			root,
			".vern/config.json",
			JSON.stringify({
				schemaVersion: 1,
				project: { name: "Acme", slug: "acme" },
				upstream: { url: "https://example.test/vern.git", branch: "main", lastSyncedSha: "0".repeat(40) },
				environments: { local: "none", staging: "compose", prod: "kubernetes" },
			}),
		);
		const run = (...args: string[]) => setup(args, { ...deps(root, fakeZitadel()), runCompose: () => {} });
		// No .env or settings.env yet: the choice says Docker Compose.
		await expect(run("--env", "staging")).rejects.toThrow("Created deploy/staging/.env");
		await expect(run("--env", "local")).rejects.toThrow(
			"This project has no local environment (.vern/config.json). Add it with `bun run project:stack -- --local compose`, or `kubernetes`.",
		);
		// The files of the other way are not in the project.
		await expect(run("--compose", "prod")).rejects.toThrow(
			"prod runs on Kubernetes in this project (.vern/config.json), so the files for Docker Compose are not here. Change it with `bun run project:stack -- --prod compose`.",
		);
		await expect(run("--kubernetes", "staging", "--manifests-only")).rejects.toThrow(
			"staging runs with Docker Compose in this project (.vern/config.json), so the files for Kubernetes are not here.",
		);
		await expect(run("--kubernetes", "local")).rejects.toThrow("This project has no local environment");
	});

	test("waits for the issuer to answer before calling it", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		let discoveryCalls = 0;
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/.well-known/openid-configuration") && ++discoveryCalls < 3) {
				return new Response("not yet", { status: 404 });
			}
			return zitadel.fetcher(input, init);
		}) as typeof fetch;
		const logs: string[] = [];
		await setup([], { ...deps(root, zitadel, logs), fetcher, sleep: async () => {} });
		expect(discoveryCalls).toBe(3);
		expect(logs.filter((line) => line.startsWith("Waiting for ZITADEL"))).toHaveLength(1);
	});

	test("gives up on an issuer that never answers", async () => {
		const root = workspace();
		const fetcher = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
		await expect(
			setup([], { ...deps(root, fakeZitadel()), fetcher, sleep: async () => {}, issuerTimeoutMs: 0 }),
		).rejects.toThrow("ZITADEL did not answer");
	});

	test("explains how to get a token when the stack has none", async () => {
		const root = workspace();
		const zitadel = fakeZitadel();
		await expect(setup([], { ...deps(root, zitadel), readStackToken: () => undefined })).rejects.toThrow(
			"No ZITADEL token found",
		);
	});
});

/** What the tests below take from the checkout: the overlays and the auth stack's brand files, as Vern ships them. */
const KUBERNETES_FILES = [
	"deploy/base/kustomization.yaml",
	"deploy/local/kustomization.yaml",
	"deploy/local/settings.env.example",
	"deploy/prod/kustomization.yaml",
	"deploy/prod/settings.env.example",
	"deploy/staging/kustomization.yaml",
	"deploy/staging/settings.env.example",
	"deploy/dev/auth-server/nginx.conf",
	"deploy/dev/auth-server/brand/brand.json",
	"deploy/dev/auth-server/brand/favicon.svg",
];

// A project that runs an environment another way has no overlay for it
// (`bun run project:stack`), so there is nothing here to test.
describe.skipIf(!KUBERNETES_FILES.every((path) => existsSync(resolve(ROOT, path))))("setup --kubernetes", () => {
	function kubeWorkspace(): string {
		const root = workspace();
		for (const path of KUBERNETES_FILES) {
			write(root, path, templateIdentity(readFileSync(resolve(ROOT, path), "utf8")));
		}
		return root;
	}

	/**
	 * These files come from the checkout, which carries the project's own name
	 * once it is renamed. The tests expect the template's, so it is put back.
	 */
	function templateIdentity(text: string): string {
		return text.replace(/^namespace: \S+?(-staging)?$/m, "namespace: vern$1").replace(/^ZITADEL_ORG_NAME=.*$/m, "ZITADEL_ORG_NAME=Vern");
	}

	const generated = (root: string, overlay: string, path: string) =>
		readFileSync(resolve(root, `deploy/${overlay}/generated`, path), "utf8");

	test("--manifests-only lists the apps and writes the overlay's settings and private Secrets", async () => {
		const root = kubeWorkspace();
		const zitadel = fakeZitadel();
		expect(await setup(["--kubernetes", "local", "--manifests-only"], deps(root, zitadel))).toBe(0);
		expect(zitadel.calls).toEqual([]);

		const base = readFileSync(resolve(root, "deploy/base/kustomization.yaml"), "utf8");
		expect(base).toContain("  - identity\n  - ../../services/api/k8s\n  - ../../apps/dashboard/k8s\n");
		const component = generated(root, "local", "kustomization.yaml");
		expect(component).toContain('"ZITADEL_ISSUER=https://auth.localtest.me"');
		expect(component).toContain('"APP_URL=https://dashboard.localtest.me"');
		// The workspace has one API, so the web app calls it on its hostname.
		expect(component).toContain('"API_BASE_URL=https://api.localtest.me"');
		expect(component).toContain("- name: local-tls");
		expect(generated(root, "local", "ingress.yaml")).toContain("host: api.localtest.me");
		expect(generated(root, "local", "brand/favicon.svg")).toContain("<svg");

		const secrets = resolve(root, "deploy/local/generated/secrets");
		expect(parseEnv(resolve(secrets, "zitadel.env")).get("ZITADEL_MASTERKEY")).toBe("generated-secret");
		expect(parseEnv(resolve(secrets, "redis.env")).get("url")).toBe("redis://:generated-secret@redis:6379");
		expect(statSync(resolve(secrets, "zitadel.env")).mode & 0o777).toBe(0o600);
		expect(existsSync(resolve(root, "deploy/local/generated/tls/cert.pem"))).toBe(true);

		// A second run keeps every secret it made.
		await setup(["--kubernetes", "local", "--manifests-only"], { ...deps(root, zitadel), randomSecret: () => "other" });
		expect(parseEnv(resolve(secrets, "zitadel.env")).get("ZITADEL_MASTERKEY")).toBe("generated-secret");
		expect(parseEnv(resolve(secrets, "dashboard.env")).get("SESSION_SECRET")).toBe("generated-secret");
	});

	test("production needs its hostnames and a registry, and runs no database", async () => {
		const root = kubeWorkspace();
		const run = () => setup(["--kubernetes", "prod", "--manifests-only"], deps(root, fakeZitadel()));
		await expect(run()).rejects.toThrow("Created deploy/prod/settings.env");
		const settings = resolve(root, "deploy/prod/settings.env");
		await expect(run()).rejects.toThrow("Set DOMAIN in deploy/prod/settings.env");
		writeFileSync(settings, readFileSync(settings, "utf8").replace("DOMAIN=example.com", "DOMAIN=acme.test"));
		await expect(run()).rejects.toThrow("Set IMAGE_REGISTRY");
		writeFileSync(
			settings,
			readFileSync(settings, "utf8")
				.replace("IMAGE_REGISTRY=ghcr.io/your-org/your-repo", "IMAGE_REGISTRY=ghcr.io/acme/product/")
				.replace("IMAGE_TAG=", "IMAGE_TAG=0123abc"),
		);
		expect(await run()).toBe(0);

		const component = generated(root, "prod", "kustomization.yaml");
		expect(component).toContain("newName: ghcr.io/acme/product/api\n    newTag: \"0123abc\"");
		expect(component).not.toContain("redis");
		expect(component).not.toContain("local-tls");
		const ingress = generated(root, "prod", "ingress.yaml");
		expect(ingress).toContain("cert-manager.io/cluster-issuer: letsencrypt");
		expect(ingress).toContain("secretName: dashboard-tls");
		expect(existsSync(resolve(root, "deploy/prod/generated/secrets/redis.env"))).toBe(false);
	});

	test("staging is production with its own settings, namespace, and Secrets", async () => {
		const root = kubeWorkspace();
		write(
			root,
			"deploy/staging/settings.env",
			"DOMAIN=staging.acme.test\nIMAGE_REGISTRY=ghcr.io/acme/product\nIMAGE_TAG=0123abc\n",
		);
		const kubectl: string[] = [];
		expect(
			await setup(["--env", "staging"], {
				...deps(root, fakeZitadel()),
				runKubectl: (_root, args) => kubectl.push(args.join(" ")),
				readKubeToken: () => "kube-token",
			}),
		).toBe(0);
		expect(kubectl[0]).toBe("apply -k deploy/staging");
		expect(kubectl[1]).toBe("-n vern-staging rollout status deployment/zitadel --timeout=15m");
		const ingress = generated(root, "staging", "ingress.yaml");
		expect(ingress).toContain("host: dashboard.staging.acme.test");
		expect(ingress).toContain("cert-manager.io/cluster-issuer: letsencrypt");
		expect(generated(root, "staging", "kustomization.yaml")).toContain("# Written by `bun run setup -- --kubernetes staging`.");
		expect(existsSync(resolve(root, "deploy/staging/generated/secrets/redis.env"))).toBe(false);
		expect(existsSync(resolve(root, "deploy/prod/generated"))).toBe(false);
	});

	test("applies the overlay, creates the applications and keys in ZITADEL, and applies them", async () => {
		const root = kubeWorkspace();
		const zitadel = fakeZitadel();
		const kubectl: string[] = [];
		const logs: string[] = [];
		expect(
			await setup(["--kubernetes", "local"], {
				...deps(root, zitadel, logs),
				runKubectl: (_root, args) => kubectl.push(args.join(" ")),
				readKubeToken: (_root, namespace) => `token-from-${namespace}`,
			}),
		).toBe(0);

		expect(kubectl).toEqual([
			"apply -k deploy/local",
			"-n vern rollout status deployment/zitadel --timeout=15m",
			"apply -k deploy/local",
			"-n vern rollout status deployment/api --timeout=10m",
			"-n vern rollout status deployment/dashboard --timeout=10m",
		]);
		expect(zitadel.projects).toEqual([{ id: "100", name: "Vern" }]);
		const oidc = zitadel.calls.find((call) => call.path.endsWith("/apps/oidc"));
		expect(oidc?.body).toMatchObject({ redirectUris: ["https://dashboard.localtest.me/auth/callback"], devMode: false });

		const secrets = resolve(root, "deploy/local/generated/secrets");
		expect(parseEnv(resolve(secrets, "dashboard.env")).get("ZITADEL_CLIENT_ID")).toBeTruthy();
		expect(JSON.parse(readFileSync(resolve(secrets, "api-key.json"), "utf8")).keyId).toBeTruthy();
		expect(generated(root, "local", "kustomization.yaml")).toContain('"ZITADEL_PROJECT_ID=100"');
		expect(logs.join("\n")).toContain("Sign in as zitadel-admin@vern.auth.localtest.me");

		// Run again: the same project, application, and key.
		await setup(["--kubernetes", "local"], {
			...deps(root, zitadel),
			runKubectl: () => {},
			readKubeToken: () => "token",
		});
		expect(zitadel.projects).toHaveLength(1);
		expect(zitadel.calls.filter((call) => call.path.endsWith("/apps/oidc"))).toHaveLength(1);
		expect(zitadel.keys).toHaveLength(1);
	});

	test("refuses an app whose hostname is ZITADEL's", async () => {
		const root = kubeWorkspace();
		write(root, "apps/auth/.env.example", "PORT=3002\nAPP_URL=http://localhost:3002\nZITADEL_CLIENT_ID=\n");
		await expect(setup(["--kubernetes", "local", "--manifests-only"], deps(root, fakeZitadel()))).rejects.toThrow(
			"apps/auth: its hostname auth.localtest.me is ZITADEL's",
		);
	});
});
