import { type ApiOptions, callApi, ZitadelApiError } from "./client";
import { findUser } from "./users";

/** Finds the service user by user name, or creates it. */
export async function ensureServiceUser(
	api: ApiOptions,
	userName: string,
): Promise<{ id: string; created: boolean }> {
	const found = await findUser(api, userName);
	if (found) {
		if (!found.machine) throw new Error(`A user named "${userName}" exists but is not a service user`);
		return { id: found.id, created: false };
	}
	const created = await callApi(api, "POST", "/management/v1/users/machine", {
		userName,
		name: userName,
		description: "Manages the users of this project from its apps",
		accessTokenType: "ACCESS_TOKEN_TYPE_BEARER",
	});
	return { id: String(created.userId), created: true };
}

/** Whether ZITADEL accepts this token as the given user (it could be stale or revoked). */
export async function tokenWorks(api: ApiOptions, token: string, userId: string): Promise<boolean> {
	try {
		const me = await callApi({ ...api, token, orgId: undefined }, "GET", "/auth/v1/users/me");
		return (me.user as { id?: string } | undefined)?.id === userId;
	} catch (error) {
		if (error instanceof ZitadelApiError && [400, 401, 403].includes(error.status)) return false;
		throw error;
	}
}

/** A new personal access token. ZITADEL shows its value only in this response. */
export async function createToken(api: ApiOptions, userId: string): Promise<string> {
	const created = await callApi(api, "POST", `/management/v1/users/${encodeURIComponent(userId)}/pats`, {});
	return String(created.token);
}
