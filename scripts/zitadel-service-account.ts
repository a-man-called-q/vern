import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseEnv, readEffectiveEnv } from "./env-files";
import { readConfig } from "./project-utils";
import { AUTH, composeArgs, readStackToken, resolveToken } from "./setup";
import { type ApiOptions, callApi, setEnvValue, ZitadelApiError } from "./zitadel-app";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_ROLE = "ORG_USER_MANAGER";
const DEFAULT_ENV_KEY = "ZITADEL_USER_ADMIN_TOKEN";

type Fetcher = typeof fetch;
type Log = (message: string) => void;

const USAGE = `Create a service account an app can use to manage users, and give the app its token.

Usage: bun run zitadel:service-account -- --app <apps folder> [options]

  --app <name>         Folder under apps/ whose .env receives the token
  --name <user name>   ZITADEL user name (default: <project slug>-user-admin)
  --role <role>        Organization role to grant (default: ${DEFAULT_ROLE}, which
                       manages users and grants them project roles)
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

/** Finds the service user by user name, or creates it. */
export async function ensureServiceUser(
	api: ApiOptions,
	userName: string,
): Promise<{ id: string; created: boolean }> {
	const search = await callApi(api, "POST", "/management/v1/users/_search", {
		queries: [{ userNameQuery: { userName, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	const found = (
		(search.result as { id: string; userName: string; machine?: unknown }[] | undefined) ?? []
	).filter((user) => user.userName === userName);
	if (found.length > 1) throw new Error(`More than one ZITADEL user is named "${userName}"`);
	if (found[0]) {
		if (!found[0].machine) throw new Error(`A user named "${userName}" exists but is not a service user`);
		return { id: found[0].id, created: false };
	}
	const created = await callApi(api, "POST", "/management/v1/users/machine", {
		userName,
		name: userName,
		description: "Manages the users of this project from its apps",
		accessTokenType: "ACCESS_TOKEN_TYPE_BEARER",
	});
	return { id: String(created.userId), created: true };
}

/** Makes sure the user holds `role` in the organization, keeping any other roles. */
export async function ensureOrgRole(
	api: ApiOptions,
	userId: string,
	role: string,
): Promise<"added" | "updated" | "unchanged"> {
	const search = await callApi(api, "POST", "/management/v1/orgs/me/members/_search", {
		queries: [{ userIdQuery: { userId } }],
	});
	const member = ((search.result as { userId: string; roles?: string[] }[] | undefined) ?? []).find(
		(item) => item.userId === userId,
	);
	if (!member) {
		await callApi(api, "POST", "/management/v1/orgs/me/members", { userId, roles: [role] });
		return "added";
	}
	const roles = member.roles ?? [];
	if (roles.includes(role)) return "unchanged";
	await callApi(api, "PUT", `/management/v1/orgs/me/members/${encodeURIComponent(userId)}`, {
		roles: [...roles, role],
	});
	return "updated";
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

export type ServiceAccountDeps = {
	env?: Record<string, string | undefined>;
	root?: string;
	fetcher?: Fetcher;
	log?: Log;
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
	if (!values.app) throw new Error("Pass --app <apps folder>, the app that receives the token");
	const appPath = `apps/${values.app}`;
	if (!existsSync(resolve(root, appPath))) throw new Error(`${appPath} does not exist`);
	const envKey = values["env-key"] ?? DEFAULT_ENV_KEY;
	if (!/^[A-Z][A-Z0-9_]*$/.test(envKey)) throw new Error("--env-key must be an upper-case variable name");
	const role = values.role ?? DEFAULT_ROLE;
	const userName = values.name ?? `${readConfig(root)?.project.slug ?? "vern"}-user-admin`;

	const issuer = values.issuer ?? processEnv.ZITADEL_ISSUER ?? readEffectiveEnv(root, "").get("ZITADEL_ISSUER");
	if (!issuer) throw new Error("ZITADEL_ISSUER is required (set it in .env or pass --issuer)");
	const compose = composeArgs(root, `${AUTH}/.env`, [`${AUTH}/docker-compose.yml`]);
	const token = resolveToken(
		values,
		processEnv,
		() => (deps.readStackToken ?? readStackToken)(root, compose),
		`docker compose --env-file ${AUTH}/.env -f ${AUTH}/docker-compose.yml down -v`,
	);
	const api: ApiOptions = { issuer, token, orgId: values.org, fetcher: deps.fetcher };

	const user = await ensureServiceUser(api, userName);
	log(`${user.created ? "Created" : "Found"} service user "${userName}" (${user.id})`);
	const membership = await ensureOrgRole(api, user.id, role);
	log(
		membership === "unchanged"
			? `"${userName}" already holds ${role} in the organization`
			: `Granted ${role} to "${userName}" in the organization`,
	);

	const envPath = resolve(root, appPath, ".env");
	const examplePath = resolve(root, appPath, ".env.example");
	const current = parseEnv(envPath).get(envKey);
	if (current && (await tokenWorks(api, current, user.id))) {
		log(`${appPath}: keeping the token in ${envKey}`);
		return 0;
	}
	setEnvValue(envPath, examplePath, envKey, await createToken(api, user.id));
	log(`${appPath}: wrote a new token for "${userName}" to ${envKey} in ${appPath}/.env`);
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(`zitadel:service-account: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		},
	);
}
