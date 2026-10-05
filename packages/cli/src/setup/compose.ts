import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type App, findApps } from "../lib/projects";
import { type EnvFiles, parseEnv, setEnvValue } from "../lib/env";
import { ALLOW_REGISTER_KEY, parseAllowRegister } from "../zitadel/login-policy";
import { readSmtpSettings } from "../zitadel/smtp";
import type { Log, SetupDeps } from "./context";
import { adminLogin } from "./logins";
import { randomSecret } from "./secrets";
import { ensureLocalCertificates, trustingFetch } from "./local-ca";
import { COMPOSE, composeArgs, DEPLOY, type Environment, readStackToken, resolveToken, runCompose } from "./stack";
import { applySelfRegistration, applySmtp, connect, ensureApiKey, ensureProjectWithRoles, ensureWebApplication } from "./steps";

const DEPLOY_IDENTITY_SERVICES = ["traefik", "zitadel-api", "zitadel-login", "auth-server", "postgres", "redis"];

/** Where the local rehearsal's certificates are, mounted by docker-compose.local.yml. */
const LOCAL_CERTS = `${DEPLOY}/local/certs`;
const LOCAL_DOMAIN = "localtest.me";

/**
 * The environment's `.env`, started from deploy/compose/.env.example. The
 * rehearsal on this machine gets hostnames under localtest.me, which resolve
 * to 127.0.0.1, and the only web app and API when there is one of each.
 */
function createEnvFile(files: EnvFiles, environment: Environment, apps: App[]): void {
	let text = readFileSync(files.example, "utf8").replace(/^DEPLOY_ENV=.*$/m, `DEPLOY_ENV=${environment}`);
	if (environment === "local") {
		text = text.replaceAll("example.com", LOCAL_DOMAIN);
		for (const [key, kind] of [["WEB_APP", "web"], ["API_APP", "api"]] as const) {
			const found = apps.filter((app) => app.kind === kind);
			if (found.length === 1) text = text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${found[0]?.name}`);
		}
	}
	writeFileSync(files.env, text);
}

/** The local authority and its certificate, and the Traefik file that serves it. */
function ensureLocalTls(root: string, env: Map<string, string>, log: Log): void {
	const dir = resolve(root, LOCAL_CERTS);
	const names = ["AUTH_DOMAIN", "APP_DOMAIN", "API_DOMAIN"].map((key) => env.get(key) as string);
	if (!ensureLocalCertificates(dir, names, { shared: true })) return;
	writeFileSync(
		resolve(dir, "traefik-tls.yml"),
		"tls:\n  stores:\n    default:\n      defaultCertificate:\n        certFile: /local/cert.pem\n        keyFile: /local/key.pem\n",
	);
	log(`Created a local certificate authority in ${LOCAL_CERTS} (import ca.pem in a browser to trust it)`);
}

/**
 * The Docker Compose flow for one environment: the missing secrets in
 * deploy/<environment>/.env, the identity services, then ZITADEL's project,
 * the web app's application and the API's key, and finally the whole stack of
 * deploy/compose.
 */
export async function setupCompose(
	environment: Environment,
	values: { "pat-file"?: string; "skip-start"?: boolean },
	root: string,
	log: Log,
	processEnv: Record<string, string | undefined>,
	deps: SetupDeps,
): Promise<number> {
	const dir = `${DEPLOY}/${environment}`;
	const envFile = `${dir}/.env`;
	const files: EnvFiles = { env: resolve(root, envFile), example: resolve(root, COMPOSE, ".env.example") };
	const apps = findApps(root);
	if (!existsSync(files.env)) {
		mkdirSync(resolve(root, dir), { recursive: true });
		createEnvFile(files, environment, apps);
		if (environment !== "local") {
			throw new Error(
				`Created ${envFile}. Set AUTH_DOMAIN, APP_DOMAIN, API_DOMAIN, ACME_EMAIL, WEB_APP, and API_APP in it, then run this again.`,
			);
		}
		log(`Created ${envFile} with hostnames under ${LOCAL_DOMAIN}`);
	}
	const set = (key: string, value: string) => setEnvValue(files, key, value);
	let env = parseEnv(files.env);
	// The Compose file finds the environment's secrets/ by this.
	if (env.get("DEPLOY_ENV") !== environment) set("DEPLOY_ENV", environment);
	for (const key of ["AUTH_DOMAIN", "APP_DOMAIN", "API_DOMAIN", "ACME_EMAIL"]) {
		const value = env.get(key);
		if (!value || value.endsWith("example.com")) throw new Error(`Set ${key} in ${envFile}`);
	}
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
		log(`Generated ${key} in ${envFile}`);
	}
	env = parseEnv(files.env);
	const allowRegister = parseAllowRegister(env.get(ALLOW_REGISTER_KEY), envFile);
	// A half-filled mail setup stops here, before a container starts.
	const smtp = readSmtpSettings(env, envFile, env.get("ZITADEL_ORG_NAME") || "Vern");

	// The rehearsal swaps Let's Encrypt for a local authority; COMPOSE_FILE names other overrides.
	const local = environment === "local";
	const composeFiles = processEnv.COMPOSE_FILE?.split(":").filter(Boolean) ?? [
		`${COMPOSE}/docker-compose.yml`,
		...(local ? [`${COMPOSE}/docker-compose.local.yml`] : []),
	];
	const compose = composeArgs(root, envFile, composeFiles);
	const shown = `docker compose --env-file ${envFile} ${composeFiles.map((file) => `-f ${file}`).join(" ")}`;
	if (local) ensureLocalTls(root, env, log);
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
					`${shown} down -v`,
				),
			issuer: () => `https://${authDomain}`,
			waitHint: `Check that DNS for ${authDomain} points at this server and that ports 80 and 443 are open, so Let's Encrypt can issue its certificate.`,
		},
		{
			...deps,
			fetcher: deps.fetcher ?? (local ? trustingFetch(resolve(root, LOCAL_CERTS, "ca.pem")) : undefined),
		},
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
	const keyFile = resolve(root, dir, "secrets/api-key.json");
	await ensureApiKey(api, project.id, apiApp, keyFile, { file: 0o644, dir: 0o700 }, root, log);

	if (!values["skip-start"]) run(root, [...compose, "up", "--detach", "--wait", "--build"]);

	log(`\nDone. The app runs at ${appUrl} and the ZITADEL Console at https://${authDomain}/ui/console/.`);
	log(`Sign in as ${adminLogin(env, authDomain)} with ZITADEL_ADMIN_PASSWORD from ${envFile}; ZITADEL asks for a new password on the first sign-in.`);
	return 0;
}
