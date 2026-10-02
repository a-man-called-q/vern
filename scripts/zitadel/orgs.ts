import { type ApiOptions, callApi, ZitadelApiError } from "./client";
import { assertPerson, findUser } from "./users";

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

/**
 * The organization with this name, if there is one. Names are unique in an
 * instance, and ZITADEL compares them without regard to case: "ACME" is taken
 * when "Acme" exists.
 */
export async function findOrg(api: ApiOptions, name: string): Promise<Org | undefined> {
	const wanted = name.toLowerCase();
	const found = (await searchOrgs(api, { nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE" } })).filter(
		(org) => org.name.toLowerCase() === wanted,
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
	let created: Record<string, unknown>;
	try {
		created = await callApi(api, "POST", "/v2/organizations", { name });
	} catch (error) {
		// The domain, `<name as letters, digits and hyphens>.<instance domain>`, has to be free too.
		if (error instanceof ZitadelApiError && error.status === 409) {
			throw new Error(
				`ZITADEL refused the organization "${name}": its name, or the domain made from it, belongs to another organization`,
			);
		}
		throw error;
	}
	const id = String(created.organizationId);
	// The search reads a projection that can trail the write by a moment.
	for (let attempt = 0; attempt < 20; attempt++) {
		const [org] = await searchOrgs(api, { idQuery: { id } });
		if (org?.primaryDomain) return { org, created: true };
		await sleep(100);
	}
	throw new Error(`ZITADEL created organization "${name}" (${id}) but did not list it`);
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
	const found = await findUser({ ...api, orgId }, user.login);
	assertPerson(found, user.login);
	if (found) return { id: found.id, created: false };
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
