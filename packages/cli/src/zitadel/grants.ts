import { type ApiOptions, callApi } from "./client";

/**
 * The roles to hold after adding `wanted` to `have`: every role kept, the new
 * ones last. Nothing is ever taken away, so a change made in the Console stays.
 */
export function addRoleKeys(have: string[], wanted: string[]): { added: string[]; roles: string[] } {
	const added = wanted.filter((key) => !have.includes(key));
	return { added, roles: [...have, ...added] };
}

type UserGrant = { id: string; roleKeys?: string[]; projectGrantId?: string };

/** Creates the grant, or adds the missing roles to the one `pick` finds. */
async function ensureUserGrantIn(
	api: ApiOptions,
	userId: string,
	projectId: string,
	roleKeys: string[],
	options: { projectGrantId?: string; pick: (grants: UserGrant[]) => UserGrant | undefined },
): Promise<{ added: string[]; roles: string[] }> {
	if (roleKeys.length === 0) return { added: [], roles: [] };
	const search = await callApi(api, "POST", "/management/v1/users/grants/_search", {
		queries: [{ userIdQuery: { userId } }, { projectIdQuery: { projectId } }],
	});
	const grant = options.pick((search.result as UserGrant[] | undefined) ?? []);
	if (!grant) {
		await callApi(api, "POST", `/management/v1/users/${encodeURIComponent(userId)}/grants`, {
			projectId,
			...(options.projectGrantId ? { projectGrantId: options.projectGrantId } : {}),
			roleKeys,
		});
		return { added: roleKeys, roles: roleKeys };
	}
	const next = addRoleKeys(grant.roleKeys ?? [], roleKeys);
	if (next.added.length === 0) return next;
	await callApi(api, "PUT", `/management/v1/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(grant.id)}`, {
		roleKeys: next.roles,
	});
	return next;
}

/**
 * Makes sure the user holds at least these roles on the project. Roles the user
 * already has stay, and none is ever removed, so a grant edited in the Console
 * survives.
 */
export function ensureGrant(
	api: ApiOptions,
	userId: string,
	projectId: string,
	roleKeys: string[],
): Promise<{ added: string[]; roles: string[] }> {
	return ensureUserGrantIn(api, userId, projectId, roleKeys, { pick: (grants) => grants[0] });
}

/**
 * Makes sure the organization may use at least these roles of the project: the
 * project grant. Roles it already has stay, and none is removed.
 */
export async function ensureProjectGrant(
	api: ApiOptions,
	projectId: string,
	orgId: string,
	roleKeys: string[],
): Promise<{ id: string; added: string[]; roles: string[] }> {
	const base = `/management/v1/projects/${encodeURIComponent(projectId)}/grants`;
	const search = await callApi(api, "POST", `${base}/_search`, { query: { limit: 1000 } });
	const grant = (
		(search.result as { grantId: string; grantedOrgId: string; grantedRoleKeys?: string[] }[] | undefined) ?? []
	).find((item) => item.grantedOrgId === orgId);
	if (!grant) {
		const created = await callApi(api, "POST", base, { grantedOrgId: orgId, roleKeys });
		return { id: String(created.grantId), added: roleKeys, roles: roleKeys };
	}
	const next = addRoleKeys(grant.grantedRoleKeys ?? [], roleKeys);
	if (next.added.length === 0) return { id: grant.grantId, ...next };
	await callApi(api, "PUT", `${base}/${encodeURIComponent(grant.grantId)}`, { roleKeys: next.roles });
	return { id: grant.grantId, ...next };
}

/**
 * Makes sure the user holds at least these roles through the organization's
 * project grant. Roles the user already has stay.
 */
export function ensureCompanyUserGrant(
	api: ApiOptions,
	orgId: string,
	userId: string,
	projectId: string,
	projectGrantId: string,
	roleKeys: string[],
): Promise<{ added: string[]; roles: string[] }> {
	// The call acts inside the company's organization, where the user lives.
	return ensureUserGrantIn({ ...api, orgId }, userId, projectId, roleKeys, {
		projectGrantId,
		pick: (grants) => grants.find((item) => !item.projectGrantId || item.projectGrantId === projectGrantId),
	});
}
