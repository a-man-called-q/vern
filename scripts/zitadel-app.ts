import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { readEffectiveEnv } from "./env-files";

const ROOT = resolve(import.meta.dir, "..");
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// ZITADEL rejects an update that changes nothing with this error id.
const NO_CHANGES_ID = "COMMAND-1m88i";

export type OidcAppConfig = ReturnType<typeof buildOidcConfig>;

export type ProvisionResult = {
	action: "created" | "updated" | "unchanged";
	appId: string;
	clientId: string;
};

type Fetcher = typeof fetch;

/**
 * The application settings the Vern app templates depend on: Authorization
 * Code with PKCE (no client secret), refresh tokens, and the two callback URLs.
 * Development Mode is what lets ZITADEL accept `http://` redirect URIs, so it
 * follows the app URL and can only be on for localhost.
 */
export function buildOidcConfig(options: {
	appUrl: string;
	profileInIdToken?: boolean;
}) {
	const url = new URL(options.appUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("APP_URL must be an http(s) origin without a path");
	}
	if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
		throw new Error("APP_URL must use HTTPS unless it points at localhost");
	}

	return {
		redirectUris: [`${url.origin}/auth/callback`],
		postLogoutRedirectUris: [`${url.origin}/auth/logout/callback`],
		responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
		grantTypes: [
			"OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
			"OIDC_GRANT_TYPE_REFRESH_TOKEN",
		],
		appType: "OIDC_APP_TYPE_WEB",
		authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
		devMode: url.protocol === "http:",
		accessTokenType: "OIDC_TOKEN_TYPE_BEARER",
		accessTokenRoleAssertion: false,
		idTokenRoleAssertion: false,
		idTokenUserinfoAssertion: options.profileInIdToken ?? false,
		clockSkew: "0s",
		additionalOrigins: [] as string[],
	};
}

export class ZitadelApiError extends Error {
	constructor(
		method: string,
		path: string,
		readonly status: number,
		readonly detail: string,
	) {
		super(`ZITADEL ${method} ${path} failed: HTTP ${status} ${detail}`.trim());
		this.name = "ZitadelApiError";
	}
}

function errorDetail(payload: unknown): string {
	if (payload && typeof payload === "object") {
		const message = (payload as Record<string, unknown>).message;
		if (typeof message === "string") return message.slice(0, 300);
	}
	return "";
}

export type ApiOptions = {
	issuer: string;
	token: string;
	orgId?: string;
	fetcher?: Fetcher;
};

export async function callApi(
	options: ApiOptions,
	method: "GET" | "POST" | "PUT",
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const fetcher = options.fetcher ?? fetch;
	const response = await fetcher(new URL(path, new URL(options.issuer).origin), {
		method,
		redirect: "error",
		headers: {
			Authorization: `Bearer ${options.token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
			...(options.orgId ? { "x-zitadel-orgid": options.orgId } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	const text = await response.text();
	let payload: unknown = {};
	try {
		payload = text ? JSON.parse(text) : {};
	} catch {
		// A non-JSON error body still fails below with just the status code.
	}
	if (!response.ok) {
		throw new ZitadelApiError(method, path, response.status, errorDetail(payload));
	}
	return payload as Record<string, unknown>;
}

/**
 * Creates the application, or brings an existing one of the same name back to
 * the configuration above. Safe to run repeatedly.
 */
export async function provisionApplication(options: {
	issuer: string;
	projectId: string;
	name: string;
	config: OidcAppConfig;
	token: string;
	orgId?: string;
	fetcher?: Fetcher;
}): Promise<ProvisionResult> {
	if (!/^[A-Za-z0-9_-]+$/.test(options.projectId)) {
		throw new Error("ZITADEL project ID must contain only letters, digits, - and _");
	}
	if (options.name.length < 1 || options.name.length > 200) {
		throw new Error("Application name must be 1-200 characters");
	}

	const base = `/management/v1/projects/${options.projectId}/apps`;
	const search = await callApi(options, "POST", `${base}/_search`, {
		queries: [
			{
				nameQuery: { name: options.name, method: "TEXT_QUERY_METHOD_EQUALS" },
			},
		],
	});
	const found = (
		(search.result as
			| { id: string; name: string; oidcConfig?: { clientId?: string } }[]
			| undefined) ?? []
	).filter((app) => app.name === options.name);

	if (found.length > 1) {
		throw new Error(`More than one application is named "${options.name}"`);
	}

	const existing = found[0];
	if (!existing) {
		const created = await callApi(options, "POST", `${base}/oidc`, {
			name: options.name,
			version: "OIDC_VERSION_1_0",
			...options.config,
		});
		return {
			action: "created",
			appId: String(created.appId),
			clientId: String(created.clientId),
		};
	}

	if (!existing.oidcConfig?.clientId) {
		throw new Error(
			`An application named "${options.name}" exists but is not an OIDC application`,
		);
	}

	try {
		await callApi(options, "PUT", `${base}/${existing.id}/oidc_config`, options.config);
	} catch (error) {
		if (
			error instanceof ZitadelApiError &&
			(error.detail.includes(NO_CHANGES_ID) || /no changes/i.test(error.detail))
		) {
			return {
				action: "unchanged",
				appId: existing.id,
				clientId: existing.oidcConfig.clientId,
			};
		}
		throw error;
	}
	return {
		action: "updated",
		appId: existing.id,
		clientId: existing.oidcConfig.clientId,
	};
}

/** Sets one variable in a `.env` file, starting from `.env.example` if it is missing. */
export function setEnvValue(
	envPath: string,
	examplePath: string,
	key: string,
	value: string,
): void {
	const source = existsSync(envPath)
		? readFileSync(envPath, "utf8")
		: existsSync(examplePath)
			? readFileSync(examplePath, "utf8")
			: "";
	const line = `${key}=${value}`;
	const pattern = new RegExp(`^${key}=.*$`, "m");
	const next = pattern.test(source)
		? source.replace(pattern, () => line)
		: `${source}${source === "" || source.endsWith("\n") ? "" : "\n"}${line}\n`;
	writeFileSync(envPath, next);
}

/** Sets ZITADEL_CLIENT_ID in an app's `.env`, starting from `.env.example`. */
export function writeClientId(
	envPath: string,
	examplePath: string,
	clientId: string,
): void {
	setEnvValue(envPath, examplePath, "ZITADEL_CLIENT_ID", clientId);
}

const USAGE = `Create or update the ZITADEL application for a generated app.

Usage: bun run zitadel:app -- --app <apps folder> [options]

  --app <name>           Folder under apps/ (reads its .env and .env.example)
  --name <text>          ZITADEL application name (default: the folder name)
  --issuer <url>         ZITADEL origin (default: ZITADEL_ISSUER)
  --project <id>         ZITADEL project ID (default: ZITADEL_PROJECT_ID)
  --app-url <url>        Public origin of the app (default: APP_URL)
  --pat-file <path>      File holding a service user's personal access token
  --org <id>             Organization ID, when the token spans several
  --profile-in-id-token  Also include profile claims in the ID token
  --write-env            Store ZITADEL_CLIENT_ID in apps/<name>/.env
  --dry-run              Print the configuration and exit without calling ZITADEL

The token is read from ZITADEL_PAT or --pat-file. Give the service user the
Project Owner role on the project. The application's OIDC settings are managed
by this command: changes made in the Console are reset on the next run.`;

type CliDeps = {
	env?: Record<string, string | undefined>;
	root?: string;
	fetcher?: Fetcher;
	log?: (message: string) => void;
};

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
	const log = deps.log ?? console.log;
	const processEnv = deps.env ?? process.env;
	const root = deps.root ?? ROOT;

	const { values } = parseArgs({
		args: argv,
		options: {
			app: { type: "string" },
			name: { type: "string" },
			issuer: { type: "string" },
			project: { type: "string" },
			"app-url": { type: "string" },
			"pat-file": { type: "string" },
			org: { type: "string" },
			"profile-in-id-token": { type: "boolean", default: false },
			"write-env": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		log(USAGE);
		return 0;
	}
	if (!values.app && !values.name) {
		throw new Error("Pass --app <apps folder> (or --name with --app-url)");
	}
	if (values["write-env"] && !values.app) {
		throw new Error("--write-env needs --app");
	}

	const appPath = values.app ? `apps/${values.app}` : "";
	if (values.app && !existsSync(resolve(root, appPath))) {
		throw new Error(`${appPath} does not exist`);
	}
	const fileEnv = readEffectiveEnv(root, appPath);
	const setting = (flag: string | undefined, key: string) =>
		flag ?? processEnv[key] ?? fileEnv.get(key);
	const required = (value: string | undefined, label: string) => {
		if (!value) throw new Error(`${label} is required`);
		return value;
	};

	const issuer = required(setting(values.issuer, "ZITADEL_ISSUER"), "ZITADEL_ISSUER");
	const projectId = required(setting(values.project, "ZITADEL_PROJECT_ID"), "ZITADEL_PROJECT_ID");
	const appUrl = required(setting(values["app-url"], "APP_URL"), "APP_URL");
	const name = values.name ?? values.app ?? "";
	const config = buildOidcConfig({
		appUrl,
		profileInIdToken: values["profile-in-id-token"],
	});

	if (values["dry-run"]) {
		log(JSON.stringify({ issuer, projectId, name, config }, null, 2));
		return 0;
	}

	const token = values["pat-file"]
		? readFileSync(resolve(values["pat-file"]), "utf8").trim()
		: processEnv.ZITADEL_PAT?.trim();
	if (!token) {
		throw new Error("Set ZITADEL_PAT or pass --pat-file with a service user token");
	}

	const result = await provisionApplication({
		issuer,
		projectId,
		name,
		config,
		token,
		orgId: values.org,
		fetcher: deps.fetcher,
	});
	log(`${result.action[0].toUpperCase()}${result.action.slice(1)} ZITADEL application "${name}" (${result.appId}) in project ${projectId}.`);
	log(`ZITADEL_CLIENT_ID=${result.clientId}`);

	if (values["write-env"]) {
		writeClientId(
			resolve(root, appPath, ".env"),
			resolve(root, appPath, ".env.example"),
			result.clientId,
		);
		log(`Wrote ZITADEL_CLIENT_ID to ${appPath}/.env`);
	} else if (values.app) {
		log(`Set it in ${appPath}/.env, or rerun with --write-env.`);
	}
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		},
	);
}
