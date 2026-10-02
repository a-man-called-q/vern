import { parseArgs } from "node:util";
import { ROOT } from "../lib/paths";
import { ROLES_FILE } from "../zitadel/roles";
import { SEED_FILE } from "../zitadel/seed";
import type { SetupDeps } from "./context";
import { setupDeploy } from "./deploy";
import { setupLocal } from "./local";

const USAGE = `Configure ZITADEL for the generated apps.

Usage: bun run setup [-- options]

  --deploy           Set up the production stack in deploy/ instead of the
                     local one (see deploy/README.md)
  --pat-file <path>  Token of a service user with the IAM Owner role
                     (default: ZITADEL_PAT, then the token the stack created
                     for its vern-setup service account)
  --skip-start       Do not start containers
  --no-seed          Do not create the users of ${SEED_FILE}
  -h, --help         Show this help

Locally, creates the .env files from their examples, starts the auth stack,
and creates the ZITADEL project, an OIDC application for each web app, and an
API application with a key for each Axum API. A web app gets its API_BASE_URL
from API_APP in its .env (the name of an Axum app), or from the only API there
is. It also creates the project roles listed in ${ROLES_FILE}, and, on a local
ZITADEL only, the users and the admin's roles listed in ${SEED_FILE}. With
--deploy, it also generates the missing secrets in deploy/.env and starts the
whole production stack. Safe to run again: existing settings are kept.`;

export async function setup(argv: string[], deps: SetupDeps = {}): Promise<number> {
	const root = deps.root ?? ROOT;
	const log = deps.log ?? console.log;
	const processEnv = deps.env ?? process.env;
	const { values } = parseArgs({
		args: argv,
		options: {
			deploy: { type: "boolean", default: false },
			"pat-file": { type: "string" },
			"skip-start": { type: "boolean", default: false },
			"no-seed": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		log(USAGE);
		return 0;
	}
	return values.deploy
		? setupDeploy(values, root, log, processEnv, deps)
		: setupLocal(values, root, log, processEnv, deps);
}
