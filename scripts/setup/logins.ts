/** What follows the @ in the organization's login names: `<org-name-slug>.<domain>`. */
export function loginDomain(env: Map<string, string>, domain: string): string {
	const org = (env.get("ZITADEL_ORG_NAME") || "vern").toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return `${org}.${domain}`;
}

/** The login name of the admin ZITADEL created on its first start. */
export function adminLogin(env: Map<string, string>, domain: string): string {
	return `${env.get("ZITADEL_ADMIN_USERNAME") || "zitadel-admin"}@${loginDomain(env, domain)}`;
}
