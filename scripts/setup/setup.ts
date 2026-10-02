import { parseArgs } from "node:util";
import { ROOT } from "../lib/paths";
import { ROLES_FILE } from "../zitadel/roles";
import { SEED_FILE } from "../zitadel/seed";
import type { SetupDeps } from "./context";
import { setupCompose } from "./compose";
import { setupKubernetes } from "./kubernetes";
import { setupLocal } from "./local";
import { type Environment, environmentOf, type Method, methodOf } from "./stack";

const USAGE = `Configure ZITADEL for the generated apps.

Usage: bun run setup [-- options]

  --compose <env>    Set up the environment <env> (local, staging, or prod) with
                     the Docker Compose stack of deploy/compose, on this
                     machine (see deploy/compose/README.md)
  --kubernetes <env> Set up the environment <env> with its Kustomize overlay
                     in deploy/<env>, on the cluster kubectl points at (see
                     deploy/base/README.md)
  --env <env>        Set up the environment <env> the way it was set up before
  --manifests-only   With --kubernetes: write the manifests and Secrets only,
                     without the cluster or ZITADEL
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
--compose, it also generates the missing secrets in deploy/<env>/.env and
starts the whole stack. With --kubernetes, it writes the overlay's manifests
for every web app and API, applies them, and creates the same in ZITADEL.
Safe to run again: existing settings are kept.`;

export async function setup(argv: string[], deps: SetupDeps = {}): Promise<number> {
	const root = deps.root ?? ROOT;
	const log = deps.log ?? console.log;
	const processEnv = deps.env ?? process.env;
	const { values } = parseArgs({
		args: argv,
		options: {
			compose: { type: "string" },
			kubernetes: { type: "string" },
			env: { type: "string" },
			// The name --compose prod had before there were environments.
			deploy: { type: "boolean", default: false },
			"manifests-only": { type: "boolean", default: false },
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
	const chosen = [
		values.compose !== undefined && "--compose",
		values.kubernetes !== undefined && "--kubernetes",
		values.env !== undefined && "--env",
		values.deploy && "--deploy",
	].filter(Boolean);
	if (chosen.length > 1) throw new Error(`Use one of ${chosen.join(", ")}.`);
	let method: Method | undefined;
	let environment: Environment | undefined;
	if (values.kubernetes !== undefined) [method, environment] = ["kubernetes", environmentOf("--kubernetes", values.kubernetes)];
	else if (values.compose !== undefined) [method, environment] = ["compose", environmentOf("--compose", values.compose)];
	else if (values.deploy) [method, environment] = ["compose", "prod"];
	else if (values.env !== undefined) {
		environment = environmentOf("--env", values.env);
		method = methodOf(root, environment);
	}
	if (values["manifests-only"] && method !== "kubernetes") throw new Error("--manifests-only goes with --kubernetes");
	if (!method || !environment) return setupLocal(values, root, log, processEnv, deps);
	return method === "kubernetes"
		? setupKubernetes(environment, values, root, log, processEnv, deps)
		: setupCompose(environment, values, root, log, processEnv, deps);
}
