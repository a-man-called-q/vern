import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { appPath as resolveAppPath } from "./lib/apps";
import { runCommand } from "./lib/cli";
import { envFiles, readEffectiveEnv, setEnvValue } from "./lib/env";
import { ROOT } from "./lib/paths";
import { buildOidcConfig, provisionApplication } from "./zitadel/oidc";

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
	fetcher?: typeof fetch;
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

	const appPath = values.app ? resolveAppPath(root, values.app) : "";
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
		setEnvValue(envFiles(root, appPath), "ZITADEL_CLIENT_ID", result.clientId);
		log(`Wrote ZITADEL_CLIENT_ID to ${appPath}/.env`);
	} else if (values.app) {
		log(`Set it in ${appPath}/.env, or rerun with --write-env.`);
	}
	return 0;
}

if (import.meta.main) runCommand("", () => main(process.argv.slice(2)));
