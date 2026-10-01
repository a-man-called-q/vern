import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ApiOptions, callApi, LOOPBACK_HOSTS } from "./zitadel-app";

/** Where a project lists the users and grants that `bun run setup` seeds locally. */
export const SEED_FILE = "seed-users.json";
/** The variable in apps/auth-server/.env that holds the password of the seeded users. */
export const SEED_PASSWORD_KEY = "ZITADEL_SEED_PASSWORD";

export type SeedUser = { name: string; givenName: string; familyName: string; roles: string[] };
export type SeedUsers = { adminRoles: string[]; users: SeedUser[] };

type Log = (message: string) => void;

const MAX_LENGTH = 200;
// The part of a login name before the @: plain characters that survive a URL and a shell.
const USER_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

function fail(message: string): never {
	throw new Error(`${SEED_FILE}: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function noOtherKeys(source: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) fail(`${label} has unknown ${unknown.length > 1 ? "keys" : "key"}: ${unknown.join(", ")}`);
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length < 1 || value.length > MAX_LENGTH) {
		fail(`${label} must be a string of 1-${MAX_LENGTH} characters`);
	}
	return value;
}

function roleList(value: unknown, label: string, known: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail(`${label} must be an array of role keys`);
	const keys: string[] = [];
	for (const entry of value) {
		const key = text(entry, `a role of ${label}`);
		if (!known.includes(key)) fail(`${label} lists "${key}", which roles.json does not declare`);
		if (keys.includes(key)) fail(`${label} lists "${key}" twice`);
		keys.push(key);
	}
	return keys;
}

/**
 * Reads seed-users.json: `{ "adminRoles": [...], "users": [{ "name", "givenName",
 * "familyName", "roles" }] }`. Every role must be one roles.json declares
 * (`knownRoles`), so a typo stops setup before it calls ZITADEL. A missing file
 * means nothing to seed.
 */
export function readSeedUsers(root: string, knownRoles: string[]): SeedUsers {
	const path = resolve(root, SEED_FILE);
	if (!existsSync(path)) return { adminRoles: [], users: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${SEED_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const file = object(parsed, "the file");
	noOtherKeys(file, ["adminRoles", "users"], "the file");
	const adminRoles = roleList(file.adminRoles, "adminRoles", knownRoles);

	if (file.users !== undefined && !Array.isArray(file.users)) fail("users must be an array");
	const users: SeedUser[] = [];
	for (const entry of (file.users as unknown[] | undefined) ?? []) {
		const source = object(entry, "each user");
		noOtherKeys(source, ["name", "givenName", "familyName", "roles"], "a user");
		const name = text(source.name, "a user name");
		if (!USER_NAME.test(name)) {
			fail(`user name "${name}" must be lowercase letters, digits, and . _ - (it starts the login name before the @)`);
		}
		if (users.some((user) => user.name === name)) fail(`user "${name}" is listed twice`);
		users.push({
			name,
			givenName: text(source.givenName, `the givenName of "${name}"`),
			familyName: text(source.familyName, `the familyName of "${name}"`),
			roles: roleList(source.roles, `the roles of "${name}"`, knownRoles),
		});
	}
	return { adminRoles, users };
}

/** Whether the issuer is this machine, the only place seeded users are allowed. */
export function isLocalIssuer(issuer: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(issuer).hostname);
	} catch {
		return false;
	}
}

type FoundUser = { id: string; userName: string; machine?: unknown };

async function findUser(api: ApiOptions, userName: string): Promise<FoundUser | undefined> {
	const search = await callApi(api, "POST", "/management/v1/users/_search", {
		queries: [{ userNameQuery: { userName, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	const found = ((search.result as FoundUser[] | undefined) ?? []).filter((user) => user.userName === userName);
	if (found.length > 1) throw new Error(`More than one ZITADEL user is named "${userName}"`);
	return found[0];
}

/**
 * Makes sure the user holds at least these roles on the project. Roles the user
 * already has stay, and none is ever removed, so a grant edited in the Console
 * survives.
 */
export async function ensureGrant(
	api: ApiOptions,
	userId: string,
	projectId: string,
	roleKeys: string[],
): Promise<{ added: string[]; roles: string[] }> {
	if (roleKeys.length === 0) return { added: [], roles: [] };
	const search = await callApi(api, "POST", "/management/v1/users/grants/_search", {
		queries: [{ userIdQuery: { userId } }, { projectIdQuery: { projectId } }],
	});
	const grant = ((search.result as { id: string; roleKeys?: string[] }[] | undefined) ?? [])[0];
	if (!grant) {
		await callApi(api, "POST", `/management/v1/users/${encodeURIComponent(userId)}/grants`, { projectId, roleKeys });
		return { added: roleKeys, roles: roleKeys };
	}
	const have = grant.roleKeys ?? [];
	const added = roleKeys.filter((key) => !have.includes(key));
	if (added.length === 0) return { added, roles: have };
	const roles = [...have, ...added];
	await callApi(api, "PUT", `/management/v1/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(grant.id)}`, {
		roleKeys: roles,
	});
	return { added, roles };
}

export type SeedOptions = {
	projectId: string;
	/** Login domain of the organization: what follows the @ in a login name. */
	domain: string;
	/** Login name of the bootstrap admin ZITADEL created. */
	adminName: string;
	/** The password for a user that has to be created; not called when none is. */
	password: () => string;
	log: Log;
};

/**
 * Grants `adminRoles` to the bootstrap admin and creates the listed users with
 * their roles. A user that already exists is left as it is (profile, password,
 * state) and only gets the roles it is missing, so running it again changes
 * nothing.
 */
export async function seedUsers(api: ApiOptions, seed: SeedUsers, options: SeedOptions): Promise<string[]> {
	const { projectId, log } = options;
	if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
		throw new Error("ZITADEL project ID must contain only letters, digits, - and _");
	}

	if (seed.adminRoles.length > 0) {
		const admin = await findUser(api, options.adminName);
		if (!admin) {
			log(`No user ${options.adminName}; not granting ${seed.adminRoles.join(", ")}`);
		} else {
			const grant = await ensureGrant(api, admin.id, projectId, seed.adminRoles);
			if (grant.added.length > 0) log(`Granted ${grant.added.join(", ")} to ${options.adminName}`);
		}
	}

	const logins: string[] = [];
	for (const user of seed.users) {
		const login = `${user.name}@${options.domain}`;
		logins.push(login);
		const found = await findUser(api, login);
		if (found?.machine) throw new Error(`A user named "${login}" exists but is a service user, not a person`);
		let id = found?.id;
		if (!id) {
			const created = await callApi(api, "POST", "/v2/users/human", {
				username: login,
				profile: {
					givenName: user.givenName,
					familyName: user.familyName,
					displayName: `${user.givenName} ${user.familyName}`,
				},
				// The address is not real: it is verified up front so no mail is needed.
				email: { email: login, isVerified: true },
				password: { password: options.password(), changeRequired: false },
			});
			id = String(created.userId);
			log(`Created user ${login}`);
		}
		const grant = await ensureGrant(api, id, projectId, user.roles);
		if (grant.added.length > 0) log(`Granted ${grant.added.join(", ")} to ${login}`);
	}
	return logins;
}
