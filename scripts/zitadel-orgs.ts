import { type ApiOptions, callApi } from "./zitadel-app";

/**
 * One company is one ZITADEL organization. These helpers make the organization,
 * give it roles on the project (a project grant), create its users, and give
 * them those roles. Every one looks first and only creates what is missing, so a
 * run that stopped half way can be run again. The `tenants` service makes the same
 * calls, in the same order, when a company signs up.
 */

export type Org = { id: string; name: string; primaryDomain: string };

type SearchedOrg = { id: string; name: string; primaryDomain?: string };

function toOrg(org: SearchedOrg): Org {
	return { id: org.id, name: org.name, primaryDomain: org.primaryDomain ?? "" };
}

async function searchOrgs(api: ApiOptions, query: Record<string, unknown>): Promise<Org[]> {
	const search = await callApi(api, "POST", "/v2/organizations/_search", { queries: [query] });
	return ((search.result as SearchedOrg[] | undefined) ?? []).map(toOrg);
}

/** The organization with this name, if there is one. Names are unique in an instance. */
export async function findOrg(api: ApiOptions, name: string): Promise<Org | undefined> {
	const found = (await searchOrgs(api, { nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } })).filter(
		(org) => org.name === name,
	);
	if (found.length > 1) throw new Error(`More than one ZITADEL organization is named "${name}"`);
	return found[0];
}

/**
 * Finds the organization, or creates it. The new organization has no users:
 * nobody is its ZITADEL administrator, and the caller's own permissions are what
 * manage it.
 */
export async function ensureOrg(
	api: ApiOptions,
	name: string,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ org: Org; created: boolean }> {
	const existing = await findOrg(api, name);
	if (existing) return { org: existing, created: false };
	const created = await callApi(api, "POST", "/v2/organizations", { name });
	const id = String(created.organizationId);
	// The search reads a projection that can trail the write by a moment.
	for (let attempt = 0; attempt < 20; attempt++) {
		const [org] = await searchOrgs(api, { idQuery: { id } });
		if (org?.primaryDomain) return { org, created: true };
		await sleep(100);
	}
	throw new Error(`ZITADEL created organization "${name}" (${id}) but did not list it`);
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
	const have = grant.grantedRoleKeys ?? [];
	const added = roleKeys.filter((key) => !have.includes(key));
	if (added.length === 0) return { id: grant.grantId, added, roles: have };
	const roles = [...have, ...added];
	await callApi(api, "PUT", `${base}/${encodeURIComponent(grant.grantId)}`, { roleKeys: roles });
	return { id: grant.grantId, added, roles };
}

export type CompanyUser = {
	/** The login name: also the user name. */
	login: string;
	givenName: string;
	familyName: string;
	/** Local seeding only: the user gets this password and a verified address. Asked only when the user has to be created. */
	password: () => string;
};

/** Finds the user in the organization by login name, or creates it. */
export async function ensureCompanyUser(
	api: ApiOptions,
	orgId: string,
	user: CompanyUser,
): Promise<{ id: string; created: boolean }> {
	const inOrg = { ...api, orgId };
	const search = await callApi(inOrg, "POST", "/management/v1/users/_search", {
		queries: [{ userNameQuery: { userName: user.login, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	const found = ((search.result as { id: string; userName: string; machine?: unknown }[] | undefined) ?? []).filter(
		(item) => item.userName === user.login,
	);
	if (found.length > 1) throw new Error(`More than one ZITADEL user is named "${user.login}"`);
	if (found[0]) {
		if (found[0].machine) throw new Error(`A user named "${user.login}" exists but is a service user, not a person`);
		return { id: found[0].id, created: false };
	}
	const created = await callApi(api, "POST", "/v2/users/human", {
		organization: { orgId },
		username: user.login,
		profile: {
			givenName: user.givenName,
			familyName: user.familyName,
			displayName: `${user.givenName} ${user.familyName}`,
		},
		// The address is not real: it is verified up front so no mail is needed.
		email: { email: user.login, isVerified: true },
		password: { password: user.password(), changeRequired: false },
	});
	return { id: String(created.userId), created: true };
}

/**
 * Makes sure the user holds at least these roles through the organization's
 * project grant. Roles the user already has stay.
 */
export async function ensureCompanyUserGrant(
	api: ApiOptions,
	orgId: string,
	userId: string,
	projectId: string,
	projectGrantId: string,
	roleKeys: string[],
): Promise<{ added: string[]; roles: string[] }> {
	if (roleKeys.length === 0) return { added: [], roles: [] };
	// The call acts inside the company's organization, where the user lives.
	const inOrg = { ...api, orgId };
	const search = await callApi(inOrg, "POST", "/management/v1/users/grants/_search", {
		queries: [{ userIdQuery: { userId } }, { projectIdQuery: { projectId } }],
	});
	const grant = (
		(search.result as { id: string; roleKeys?: string[]; projectGrantId?: string }[] | undefined) ?? []
	).find((item) => !item.projectGrantId || item.projectGrantId === projectGrantId);
	if (!grant) {
		await callApi(inOrg, "POST", `/management/v1/users/${encodeURIComponent(userId)}/grants`, {
			projectId,
			projectGrantId,
			roleKeys,
		});
		return { added: roleKeys, roles: roleKeys };
	}
	const have = grant.roleKeys ?? [];
	const added = roleKeys.filter((key) => !have.includes(key));
	if (added.length === 0) return { added, roles: have };
	const roles = [...have, ...added];
	await callApi(inOrg, "PUT", `/management/v1/users/${encodeURIComponent(userId)}/grants/${encodeURIComponent(grant.id)}`, {
		roleKeys: roles,
	});
	return { added, roles };
}
