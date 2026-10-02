import type { App } from "../lib/apps";
import { envFiles, parseEnv, setEnvValue } from "../lib/env";
import { readConfig } from "../project/config";
import type { ApiOptions } from "../zitadel/client";
import { ensureMemberRole } from "../zitadel/members";
import { createToken, ensureServiceUser, tokenWorks } from "../zitadel/service-users";
import type { Log } from "./context";

/** The variable an API declares when it creates organizations, such as the service that signs companies up. */
export const ORG_ADMIN_TOKEN_KEY = "ZITADEL_ORG_ADMIN_TOKEN";
/** What creating organizations takes: no organization role reaches that far. */
const ORG_ADMIN_ROLE = "IAM_ORG_MANAGER";

/** Whether the API asks for an org-admin token in its `.env.example`. */
export function wantsOrgAdmin(root: string, app: App): boolean {
	return parseEnv(envFiles(root, app.path).example).has(ORG_ADMIN_TOKEN_KEY);
}

/**
 * Gives an API that declares ZITADEL_ORG_ADMIN_TOKEN a service user that may
 * create organizations, and its token. The token is broader than the API's own key
 * (it can also create projects, roles, and applications in the default
 * organization): README explains it, and `bun run zitadel:service-account` does
 * the same by hand against a production ZITADEL.
 */
export async function provisionOrgAdmin(api: ApiOptions, root: string, app: App, log: Log): Promise<void> {
	const userName = `${readConfig(root)?.project.slug ?? "vern"}-${app.name}-orgs`;
	const user = await ensureServiceUser(api, userName);
	await ensureMemberRole(api, "instance", user.id, ORG_ADMIN_ROLE);
	const files = envFiles(root, app.path);
	const current = parseEnv(files.env).get(ORG_ADMIN_TOKEN_KEY);
	if (current && (await tokenWorks(api, current, user.id))) {
		log(`${app.path}: keeping the token in ${ORG_ADMIN_TOKEN_KEY}`);
		return;
	}
	setEnvValue(files, ORG_ADMIN_TOKEN_KEY, await createToken(api, user.id));
	log(`${app.path}: wrote a token for service user "${userName}" (${ORG_ADMIN_ROLE}) to ${ORG_ADMIN_TOKEN_KEY} in ${app.path}/.env`);
}
