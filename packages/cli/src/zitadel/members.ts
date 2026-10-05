import { type ApiOptions, callApi } from "./client";

/** Where a membership applies: one organization (the one `api` acts in), or the whole instance. */
export type MemberScope = "org" | "instance";

const MEMBERS_PATH: Record<MemberScope, string> = {
	org: "/management/v1/orgs/me/members",
	instance: "/admin/v1/members",
};

/** Makes sure the user holds `role` in the scope, keeping any other roles. */
export async function ensureMemberRole(
	api: ApiOptions,
	scope: MemberScope,
	userId: string,
	role: string,
): Promise<"added" | "updated" | "unchanged"> {
	const base = MEMBERS_PATH[scope];
	const search = await callApi(api, "POST", `${base}/_search`, {
		queries: [{ userIdQuery: { userId } }],
	});
	const member = ((search.result as { userId: string; roles?: string[] }[] | undefined) ?? []).find(
		(item) => item.userId === userId,
	);
	if (!member) {
		await callApi(api, "POST", base, { userId, roles: [role] });
		return "added";
	}
	const roles = member.roles ?? [];
	if (roles.includes(role)) return "unchanged";
	await callApi(api, "PUT", `${base}/${encodeURIComponent(userId)}`, { roles: [...roles, role] });
	return "updated";
}
