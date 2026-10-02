import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage } from "../lib/errors";
import { type ApiOptions, assertProjectId, callApi, ZitadelApiError } from "./client";

/** Where a project declares the roles its APIs check with `require_role`. */
export const ROLES_FILE = "roles.json";

export type ProjectRole = { key: string; displayName: string; group?: string };

// A key ends up in tokens and in code, so keep it to plain identifier characters.
const ROLE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const MAX_LENGTH = 200;

function text(value: unknown, label: string, required: boolean): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.length < 1 || value.length > MAX_LENGTH) {
		throw new Error(`${ROLES_FILE}: ${label} must be a string of 1-${MAX_LENGTH} characters`);
	}
	return value;
}

/**
 * Reads roles.json: an array of role keys, or of `{ key, displayName?, group? }`
 * objects (the display name defaults to the key). A missing file means no roles.
 */
export function readProjectRoles(root: string): ProjectRole[] {
	const path = resolve(root, ROLES_FILE);
	if (!existsSync(path)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${ROLES_FILE} is not valid JSON: ${errorMessage(error)}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`${ROLES_FILE} must be an array of role keys or { "key", "displayName", "group" } objects`);
	}

	const roles: ProjectRole[] = [];
	for (const entry of parsed) {
		const source = typeof entry === "string" ? { key: entry } : (entry as Record<string, unknown> | null);
		if (!source || typeof source !== "object" || Array.isArray(source)) {
			throw new Error(`${ROLES_FILE}: each role must be a string or an object with a "key"`);
		}
		const key = text(source.key, "a role key", true) as string;
		if (!ROLE_KEY.test(key)) {
			throw new Error(`${ROLES_FILE}: role key "${key}" may only contain letters, digits, and _ . : -`);
		}
		if (roles.some((role) => role.key === key)) throw new Error(`${ROLES_FILE}: role "${key}" is listed twice`);
		const group = text(source.group, `the group of "${key}"`, false);
		roles.push({
			key,
			displayName: text(source.displayName, `the display name of "${key}"`, false) ?? key,
			...(group ? { group } : {}),
		});
	}
	return roles;
}

/**
 * Creates the roles a project is missing. Roles that exist are left alone, so a
 * display name edited in the Console survives, and no role is ever deleted.
 */
export async function ensureProjectRoles(
	api: ApiOptions,
	projectId: string,
	roles: ProjectRole[],
): Promise<{ created: string[]; existing: string[] }> {
	assertProjectId(projectId);
	const created: string[] = [];
	const existing: string[] = [];
	for (const role of roles) {
		try {
			await callApi(api, "POST", `/management/v1/projects/${projectId}/roles`, {
				roleKey: role.key,
				displayName: role.displayName,
				...(role.group ? { group: role.group } : {}),
			});
			created.push(role.key);
		} catch (error) {
			if (!(error instanceof ZitadelApiError) || error.status !== 409) throw error;
			existing.push(role.key);
		}
	}
	return { created, existing };
}
