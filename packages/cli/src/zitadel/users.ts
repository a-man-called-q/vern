import { type ApiOptions, callApi, onlyNamed } from "./client";

export type FoundUser = { id: string; userName: string; machine?: unknown };

/** The user with exactly this user name, in the organization `api` acts in. */
export async function findUser(api: ApiOptions, userName: string): Promise<FoundUser | undefined> {
	const search = await callApi(api, "POST", "/management/v1/users/_search", {
		queries: [{ userNameQuery: { userName, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	return onlyNamed(search.result as FoundUser[] | undefined, userName, (user) => user.userName, "ZITADEL user");
}

/** A person, not a service user: what a seeded or company user has to be. */
export function assertPerson(user: FoundUser | undefined, login: string): void {
	if (user?.machine) throw new Error(`A user named "${login}" exists but is a service user, not a person`);
}
