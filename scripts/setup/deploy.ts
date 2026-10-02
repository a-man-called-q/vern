import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { findApps } from "../lib/projects";
import { envFiles, parseEnv, setEnvValue } from "../lib/env";
import { ALLOW_REGISTER_KEY, parseAllowRegister } from "../zitadel/login-policy";
import { readSmtpSettings } from "../zitadel/smtp";
import type { Log, SetupDeps } from "./context";
import { adminLogin } from "./logins";
import { randomSecret } from "./secrets";
import { composeArgs, DEPLOY, readStackToken, resolveToken, runCompose } from "./stack";
import { applySelfRegistration, applySmtp, connect, ensureApiKey, ensureProjectWithRoles, ensureWebApplication } from "./steps";

const DEPLOY_IDENTITY_SERVICES = ["traefik", "zitadel-api", "zitadel-login", "auth-server", "postgres", "redis"];

/**
 * The production flow: the missing secrets in deploy/.env, the identity
 * services, then ZITADEL's project, the web app's application and the API's
 * key, and finally the whole stack.
 */
export async function setupDeploy(
	values: { "pat-file"?: string; "skip-start"?: boolean },
	root: string,
	log: Log,
	processEnv: Record<string, string | undefined>,
	deps: SetupDeps,
): Promise<number> {
	const files = envFiles(root, DEPLOY);
	if (!existsSync(files.env)) {
		copyFileSync(files.example, files.env);
		throw new Error(
			`Created ${DEPLOY}/.env. Set AUTH_DOMAIN, APP_DOMAIN, API_DOMAIN, ACME_EMAIL, WEB_APP, and API_APP in it, then run this again.`,
		);
	}
	const set = (key: string, value: string) => setEnvValue(files, key, value);
	let env = parseEnv(files.env);
	for (const key of ["AUTH_DOMAIN", "APP_DOMAIN", "API_DOMAIN", "ACME_EMAIL"]) {
		const value = env.get(key);
		if (!value || value.endsWith("example.com")) throw new Error(`Set ${key} in ${DEPLOY}/.env`);
	}
	const apps = findApps(root);
	const web = apps.find((app) => app.kind === "web" && app.name === env.get("WEB_APP"));
	const apiApp = apps.find((app) => app.kind === "api" && app.name === env.get("API_APP"));
	if (!web) throw new Error(`WEB_APP=${env.get("WEB_APP") ?? ""} does not name a generated web app under apps/`);
	if (!apiApp) throw new Error(`API_APP=${env.get("API_APP") ?? ""} does not name a generated Axum API under services/`);

	const secret = deps.randomSecret ?? randomSecret;
	const generated: [string, () => string][] = [
		["ZITADEL_MASTERKEY", () => secret("hex", 16)],
		["ZITADEL_ADMIN_PASSWORD", () => secret("password", 18)],
		["POSTGRES_PASSWORD", () => secret("hex", 24)],
		["REDIS_PASSWORD", () => secret("hex", 24)],
		["WEB_SESSION_SECRET", () => secret("base64", 32)],
	];
	for (const [key, make] of generated) {
		if (env.get(key)) continue;
		set(key, make());
		log(`Generated ${key} in ${DEPLOY}/.env`);
	}
	env = parseEnv(files.env);
	const envFile = `${DEPLOY}/.env`;
	const allowRegister = parseAllowRegister(env.get(ALLOW_REGISTER_KEY), envFile);
	// A half-filled mail setup stops here, before a container starts.
	const smtp = readSmtpSettings(env, envFile, env.get("ZITADEL_ORG_NAME") || "Vern");

	// COMPOSE_FILE adds overrides, such as deploy/docker-compose.local.yml.
	const composeFiles = processEnv.COMPOSE_FILE?.split(":").filter(Boolean) ?? [`${DEPLOY}/docker-compose.yml`];
	const compose = composeArgs(root, envFile, composeFiles);
	const run = deps.runCompose ?? runCompose;
	if (!values["skip-start"]) run(root, [...compose, "up", "--detach", "--wait", ...DEPLOY_IDENTITY_SERVICES]);

	const authDomain = env.get("AUTH_DOMAIN") as string;
	const api = await connect(
		{
			token: () =>
				resolveToken(
					values,
					processEnv,
					() => (deps.readStackToken ?? readStackToken)(root, compose),
					`docker compose --env-file ${envFile} -f ${DEPLOY}/docker-compose.yml down -v`,
				),
			issuer: () => `https://${authDomain}`,
			waitHint: `Check that DNS for ${authDomain} points at this server and that ports 80 and 443 are open, so Let's Encrypt can issue its certificate.`,
		},
		deps,
		log,
	);

	await applySelfRegistration(api, allowRegister, envFile, log);
	await applySmtp(api, smtp, { local: false, mailpitUrl: "", envFile }, log);

	const project = await ensureProjectWithRoles(
		root,
		api,
		env.get("ZITADEL_PROJECT_ID"),
		env.get("ZITADEL_ORG_NAME") || "Vern",
		log,
	);
	if (project.changed) set("ZITADEL_PROJECT_ID", project.id);

	const appUrl = `https://${env.get("APP_DOMAIN")}`;
	set("WEB_CLIENT_ID", await ensureWebApplication(api, project.id, web, appUrl, log));

	// The directory keeps other users out; the API container reads the file as a non-root user.
	const keyFile = resolve(root, DEPLOY, "secrets/api-key.json");
	await ensureApiKey(api, project.id, apiApp, keyFile, { file: 0o644, dir: 0o700 }, root, log);

	if (!values["skip-start"]) run(root, [...compose, "up", "--detach", "--wait", "--build"]);

	log(`\nDone. The app runs at ${appUrl} and the ZITADEL Console at https://${authDomain}/ui/console/.`);
	log(`Sign in as ${adminLogin(env, authDomain)} with ZITADEL_ADMIN_PASSWORD from ${envFile}; ZITADEL asks for a new password on the first sign-in.`);
	return 0;
}
