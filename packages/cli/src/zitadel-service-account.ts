import { parseArgs } from "node:util";
import { projectPath } from "./lib/projects";
import { envFiles, parseEnv, readEffectiveEnv, setEnvValue } from "./lib/env";
import { ROOT } from "./lib/paths";
import { readConfig } from "./project/config";
import { authStack, readStackToken, resolveToken } from "./setup/stack";
import type { ApiOptions } from "./zitadel/client";
import { ensureMemberRole } from "./zitadel/members";
import { createToken, ensureServiceUser, tokenWorks } from "./zitadel/service-users";

const DEFAULT_ROLE = "ORG_USER_MANAGER";
const DEFAULT_ENV_KEY = "ZITADEL_USER_ADMIN_TOKEN";

const USAGE = `Create a service account an app can use to manage users, and give the app its token.

Usage: bun run zitadel:service-account -- --app <name> [options]

  --app <name>         The web app or API whose .env receives the token
  --name <user name>   ZITADEL user name (default: <project slug>-user-admin)
  --role <role>        Organization role to grant (default: ${DEFAULT_ROLE}, which
                       manages users and grants them project roles); "none" grants
                       no organization role
  --instance-role <r>  Also grant this instance role, which reaches every
                       organization. IAM_ORG_MANAGER lets the user create
                       organizations: it is what a service that signs companies
                       up needs, and it also lets the token create projects,
                       roles, and applications in the default organization
  --env-key <key>      Variable to store the token in (default: ${DEFAULT_ENV_KEY})
  --issuer <url>       ZITADEL origin (default: ZITADEL_ISSUER)
  --pat-file <path>    Token of a service user with the IAM Owner role
                       (default: ZITADEL_PAT, then the local stack's own)
  --org <id>           Organization ID, when the token spans several
  -h, --help           Show this help

Run it again at any time: it keeps the user, the membership, and a token that
still works, and only creates what is missing. To rotate the token, remove the
variable from the app's .env and run it again, then delete the old token in the
ZITADEL Console. The token can manage every user of the organization, so keep it
on the server and out of the browser.`;

export type ServiceAccountDeps = {
	env?: Record<string, string | undefined>;
	root?: string;
	fetcher?: typeof fetch;
	log?: (message: string) => void;
	readStackToken?: (root: string, compose: string[]) => string | undefined;
};

export async function main(argv: string[], deps: ServiceAccountDeps = {}): Promise<number> {
	const log = deps.log ?? console.log;
	const processEnv = deps.env ?? process.env;
	const root = deps.root ?? ROOT;
	const { values } = parseArgs({
		args: argv,
		options: {
			app: { type: "string" },
			name: { type: "string" },
			role: { type: "string" },
			"instance-role": { type: "string" },
			"env-key": { type: "string" },
			issuer: { type: "string" },
			"pat-file": { type: "string" },
			org: { type: "string" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		log(USAGE);
		return 0;
	}
	if (!values.app) throw new Error("Pass --app <name>, the app that receives the token");
	const appPath = projectPath(root, values.app);
	const envKey = values["env-key"] ?? DEFAULT_ENV_KEY;
	if (!/^[A-Z][A-Z0-9_]*$/.test(envKey)) throw new Error("--env-key must be an upper-case variable name");
	const role = values.role ?? DEFAULT_ROLE;
	const userName = values.name ?? `${readConfig(root)?.project.slug ?? "vern"}-user-admin`;

	const issuer = values.issuer ?? processEnv.ZITADEL_ISSUER ?? readEffectiveEnv(root, "").get("ZITADEL_ISSUER");
	if (!issuer) throw new Error("ZITADEL_ISSUER is required (set it in .env or pass --issuer)");
	const stack = authStack(root);
	const token = resolveToken(
		values,
		processEnv,
		() => (deps.readStackToken ?? readStackToken)(root, stack.compose),
		stack.resetHint,
	);
	const api: ApiOptions = { issuer, token, orgId: values.org, fetcher: deps.fetcher };

	const user = await ensureServiceUser(api, userName);
	log(`${user.created ? "Created" : "Found"} service user "${userName}" (${user.id})`);
	if (role !== "none") {
		const membership = await ensureMemberRole(api, "org", user.id, role);
		log(
			membership === "unchanged"
				? `"${userName}" already holds ${role} in the organization`
				: `Granted ${role} to "${userName}" in the organization`,
		);
	}
	const instanceRole = values["instance-role"];
	if (instanceRole) {
		const membership = await ensureMemberRole(api, "instance", user.id, instanceRole);
		log(
			membership === "unchanged"
				? `"${userName}" already holds ${instanceRole} in the instance`
				: `Granted ${instanceRole} to "${userName}" in the instance`,
		);
		log(`"${userName}" reaches every organization of the instance: use its token only to act for the caller's own.`);
	}

	const files = envFiles(root, appPath);
	const current = parseEnv(files.env).get(envKey);
	if (current && (await tokenWorks(api, current, user.id))) {
		log(`${appPath}: keeping the token in ${envKey}`);
		return 0;
	}
	setEnvValue(files, envKey, await createToken(api, user.id));
	log(`${appPath}: wrote a new token for "${userName}" to ${envKey} in ${appPath}/.env`);
	return 0;
}
