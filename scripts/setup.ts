import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseEnv, readEffectiveEnv } from "./env-files";
import {
	type ApiOptions,
	buildOidcConfig,
	callApi,
	provisionApplication,
	setEnvValue,
	ZitadelApiError,
} from "./zitadel-app";
import { ALLOW_REGISTER_KEY, ensureSelfRegistration, parseAllowRegister } from "./zitadel-login-policy";
import { ensureProjectRoles, readProjectRoles, ROLES_FILE } from "./zitadel-roles";
import { isLocalIssuer, readSeedUsers, SEED_FILE, SEED_PASSWORD_KEY, type SeedUsers, seedUsers } from "./zitadel-seed";
import { ensureSmtp, readSmtpSettings, type SmtpSettings } from "./zitadel-smtp";

const ROOT = resolve(import.meta.dir, "..");
export const AUTH = "apps/auth-server";
const DEPLOY = "deploy";
const ADMIN_PAT_PATH = "/zitadel/bootstrap/admin.pat";
const DEPLOY_IDENTITY_SERVICES = ["traefik", "zitadel-api", "zitadel-login", "auth-server", "postgres", "redis"];

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

type App = { name: string; path: string; kind: "web" | "api" };
type Log = (message: string) => void;

export type SetupDeps = {
	root?: string;
	env?: Record<string, string | undefined>;
	fetcher?: typeof fetch;
	log?: Log;
	startAuthStack?: (root: string) => void;
	runCompose?: (root: string, args: string[]) => void;
	readStackToken?: (root: string, compose: string[]) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
	issuerTimeoutMs?: number;
	randomSecret?: (kind: "hex" | "base64" | "password", bytes: number) => string;
};

function isUnset(value: string | undefined): boolean {
	return !value || value.startsWith("replace-with-");
}

function copyIfMissing(root: string, dir: string, log: Log): void {
	const env = resolve(root, dir, ".env");
	const example = resolve(root, dir, ".env.example");
	if (existsSync(env) || !existsSync(example)) return;
	copyFileSync(example, env);
	log(`Created ${relative(root, env)} from .env.example`);
}

function randomSecret(kind: "hex" | "base64" | "password", bytes: number): string {
	const value = randomBytes(bytes);
	if (kind === "hex") return value.toString("hex");
	if (kind === "base64") return value.toString("base64");
	// ZITADEL's default password policy wants upper and lower case, a digit, and a symbol.
	return `${value.toString("base64url")}Aa1!`;
}

/** Generated apps, recognized by the variables in their `.env.example`. */
export function findApps(root: string): App[] {
	const apps: App[] = [];
	const dir = resolve(root, "apps");
	if (!existsSync(dir)) return apps;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const example = parseEnv(resolve(dir, entry.name, ".env.example"));
		const path = `apps/${entry.name}`;
		if (example.has("ZITADEL_CLIENT_ID")) apps.push({ name: entry.name, path, kind: "web" });
		else if (example.has("ZITADEL_API_KEY_FILE")) apps.push({ name: entry.name, path, kind: "api" });
	}
	return apps.sort((a, b) => a.name.localeCompare(b.name));
}

export function composeArgs(root: string, envFile: string, files: string[]): string[] {
	return ["compose", "--env-file", resolve(root, envFile), ...files.flatMap((file) => ["-f", resolve(root, file)])];
}

function startAuthStack(root: string): void {
	const result = spawnSync("moon", ["run", "auth-server:dev"], { cwd: root, stdio: "inherit" });
	if (result.status !== 0) throw new Error("Starting the auth stack failed (moon run auth-server:dev).");
}

function runCompose(root: string, args: string[]): void {
	const result = spawnSync("docker", args, { cwd: root, stdio: "inherit" });
	if (result.status !== 0) throw new Error(`docker ${args.slice(-4).join(" ")} failed.`);
}

/** Reads the token ZITADEL wrote for the vern-setup service account on its first start. */
export function readStackToken(root: string, compose: string[]): string | undefined {
	const dir = mkdtempSync(join(tmpdir(), "vern-setup-"));
	try {
		const target = join(dir, "admin.pat");
		const result = spawnSync("docker", [...compose, "cp", `zitadel-api:${ADMIN_PAT_PATH}`, target], {
			cwd: root,
			encoding: "utf8",
		});
		if (result.status !== 0 || !existsSync(target)) return undefined;
		return readFileSync(target, "utf8").trim() || undefined;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Waits until the issuer answers through the proxy: routes register a moment
 * after the containers are healthy, and a new server first needs certificates.
 */
async function waitForIssuer(
	issuer: string,
	deps: SetupDeps,
	log: Log,
	hint: string,
): Promise<void> {
	const url = new URL("/.well-known/openid-configuration", issuer);
	const fetcher = deps.fetcher ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const deadline = Date.now() + (deps.issuerTimeoutMs ?? 300_000);
	let waiting = false;
	for (;;) {
		try {
			if ((await fetcher(url, { redirect: "error" })).ok) return;
		} catch {
			// Not reachable yet.
		}
		if (Date.now() > deadline) throw new Error(`ZITADEL did not answer at ${url.href}. ${hint}`);
		if (!waiting) {
			log(`Waiting for ZITADEL at ${url.origin} ...`);
			waiting = true;
		}
		await sleep(2000);
	}
}

async function findOrCreateProject(api: ApiOptions, name: string): Promise<{ id: string; created: boolean }> {
	const search = await callApi(api, "POST", "/management/v1/projects/_search", {
		queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	const found = ((search.result as { id: string; name: string }[] | undefined) ?? []).filter(
		(project) => project.name === name,
	);
	if (found.length > 1) throw new Error(`More than one ZITADEL project is named "${name}"`);
	if (found[0]) return { id: found[0].id, created: false };
	const created = await callApi(api, "POST", "/management/v1/projects", { name });
	return { id: String(created.id), created: true };
}

async function projectExists(api: ApiOptions, id: string): Promise<boolean> {
	try {
		await callApi(api, "GET", `/management/v1/projects/${encodeURIComponent(id)}`);
		return true;
	} catch (error) {
		if (error instanceof ZitadelApiError && (error.status === 404 || error.status === 400)) return false;
		throw error;
	}
}

/** Keeps a working project ID, or finds or creates the project by name. */
async function ensureProject(
	api: ApiOptions,
	current: string | undefined,
	name: string,
	log: Log,
): Promise<{ id: string; changed: boolean }> {
	if (!isUnset(current) && (await projectExists(api, current!))) {
		log(`Using ZITADEL project ${current}`);
		return { id: current!, changed: false };
	}
	const project = await findOrCreateProject(api, name);
	log(`${project.created ? "Created" : "Found"} ZITADEL project "${name}" (${project.id})`);
	return { id: project.id, changed: true };
}

/** Creates the roles declared in roles.json on the project. */
async function ensureRoles(root: string, api: ApiOptions, projectId: string, log: Log): Promise<void> {
	const roles = readProjectRoles(root);
	if (roles.length === 0) return;
	const { created, existing } = await ensureProjectRoles(api, projectId, roles);
	if (created.length > 0) log(`Created ZITADEL project roles: ${created.join(", ")}`);
	if (existing.length > 0) log(`Project roles already there: ${existing.join(", ")}`);
}

/**
 * Makes ZITADEL's sign-up page match ZITADEL_ALLOW_REGISTER. Without a value
 * nothing changes, but an open sign-up page is said out loud: the Console is
 * the only other place it shows, and nobody opens that.
 */
async function applySelfRegistration(api: ApiOptions, wanted: boolean | undefined, envFile: string, log: Log): Promise<void> {
	const { allowed, changed } = await ensureSelfRegistration(api, wanted);
	if (changed) {
		log(`Turned self-registration ${allowed ? "on" : "off"} in ZITADEL (${ALLOW_REGISTER_KEY}=${allowed} in ${envFile})`);
		// The Login App keeps ZITADEL's settings for 15 minutes (API_CACHE_CONFIG).
		log("The sign-in pages follow within 15 minutes; restart the zitadel-login container to apply it now.");
	} else if (wanted !== undefined) {
		log(`Self-registration is ${allowed ? "on" : "off"} (${ALLOW_REGISTER_KEY}=${allowed} in ${envFile})`);
	} else if (allowed) {
		log(
			`Anyone can create an account from the sign-in page. Set ${ALLOW_REGISTER_KEY}=false in ${envFile} and run this again to close it, or =true to keep it open and silence this.`,
		);
	}
}

/**
 * Points ZITADEL's outgoing mail at `wanted` and says where mail goes. Locally
 * that is Mailpit, and a mail setup someone made in the Console stays; in a
 * deployment it is the SMTP_* of deploy/.env, and without them nothing is
 * changed but the missing mail server is said out loud, because invitations and
 * password resets silently never arrive.
 */
async function applySmtp(
	api: ApiOptions,
	wanted: SmtpSettings | undefined,
	options: { local: boolean; mailpitUrl: string; envFile: string },
	log: Log,
): Promise<void> {
	const result = await ensureSmtp(api, wanted, { replaceOthers: !options.local });
	if (result.action === "none") {
		log(
			`ZITADEL has no SMTP server, so invitations, email verification, and password resets are not sent. Set SMTP_HOST and SMTP_FROM_ADDRESS (and SMTP_USER and SMTP_PASSWORD) in ${options.envFile} and run this again.`,
		);
	} else if (result.action === "kept") {
		log(`ZITADEL sends mail through ${result.host}, set up in the Console; leaving it as it is.`);
	} else if (options.local) {
		log(`ZITADEL sends mail to Mailpit; read it at ${options.mailpitUrl}`);
	} else {
		log(`ZITADEL sends mail through ${result.host} as ${wanted?.senderAddress}`);
	}
}

/** Whether ZITADEL still has the key in this file, e.g. after a database reset. */
async function keyIsKnown(api: ApiOptions, projectId: string, keyFile: string): Promise<boolean> {
	let key: { appId?: string; keyId?: string };
	try {
		key = JSON.parse(readFileSync(keyFile, "utf8"));
	} catch {
		return false;
	}
	if (!key.appId || !key.keyId) return false;
	try {
		await callApi(api, "GET", `/management/v1/projects/${projectId}/apps/${key.appId}/keys/${key.keyId}`);
		return true;
	} catch (error) {
		if (error instanceof ZitadelApiError && (error.status === 404 || error.status === 400)) return false;
		throw error;
	}
}

/** Creates the API application if needed and a new JSON key for it. */
async function createApiKey(api: ApiOptions, projectId: string, name: string): Promise<string> {
	const base = `/management/v1/projects/${projectId}/apps`;
	const search = await callApi(api, "POST", `${base}/_search`, {
		queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
	});
	const found = (
		(search.result as { id: string; name: string; apiConfig?: unknown }[] | undefined) ?? []
	).filter((app) => app.name === name);
	if (found.length > 1) throw new Error(`More than one application is named "${name}"`);
	let appId = found[0]?.id;
	if (found[0] && !found[0].apiConfig) {
		throw new Error(`An application named "${name}" exists but is not an API application`);
	}
	if (!appId) {
		const created = await callApi(api, "POST", `${base}/api`, {
			name,
			authMethodType: "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
		});
		appId = String(created.appId);
	}
	const key = await callApi(api, "POST", `${base}/${appId}/keys`, { type: "KEY_TYPE_JSON" });
	return Buffer.from(String(key.keyDetails), "base64").toString("utf8");
}

export function resolveToken(
	values: { "pat-file"?: string },
	processEnv: Record<string, string | undefined>,
	fromStack: () => string | undefined,
	resetHint: string,
): string {
	const token =
		(values["pat-file"] ? readFileSync(resolve(values["pat-file"]), "utf8").trim() : undefined) ||
		processEnv.ZITADEL_PAT?.trim() ||
		fromStack();
	if (!token) {
		throw new Error(
			`No ZITADEL token found. The stack writes one for the vern-setup service account only when it creates its database, so a database from before that needs either a reset (${resetHint}, then run this again) or a token of a service user with the IAM Owner role in ZITADEL_PAT.`,
		);
	}
	return token;
}

/** What follows the @ in the organization's login names: `<org-name-slug>.<domain>`. */
function loginDomain(env: Map<string, string>, domain: string): string {
	const org = (env.get("ZITADEL_ORG_NAME") || "vern").toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return `${org}.${domain}`;
}

function adminLogin(env: Map<string, string>, domain: string): string {
	return `${env.get("ZITADEL_ADMIN_USERNAME") || "zitadel-admin"}@${loginDomain(env, domain)}`;
}

/**
 * The API a web app talks to. `API_BASE_URL` set by hand wins; then the Axum app
 * named by `API_APP`; with no name, the workspace's only API. Several APIs and no
 * name leave it empty, and say so instead of leaving the app quietly unwired.
 */
function chooseApiUrl(
	app: App,
	appEnv: Map<string, string>,
	apiUrls: Map<string, string>,
): { url?: string; message?: string } {
	if (appEnv.get("API_BASE_URL")) return {};
	const names = [...apiUrls.keys()].sort();
	const wanted = appEnv.get("API_APP");
	if (wanted) {
		const url = apiUrls.get(wanted);
		if (url) return { url };
		throw new Error(
			`${app.path}: API_APP=${wanted} does not name an Axum API with a PORT under apps/` +
				(names.length > 0 ? ` (found: ${names.join(", ")})` : ""),
		);
	}
	if (names.length === 1) return { url: apiUrls.get(names[0]) };
	if (names.length > 1) {
		return {
			message: `${app.path}: API_BASE_URL is not set (${names.length} APIs found: ${names.join(", ")}). Set API_APP=<api> in ${app.path}/.env and run this again.`,
		};
	}
	return {};
}

/**
 * Creates the users of seed-users.json and grants the admin's roles. Only a
 * ZITADEL on this machine gets them: the users share one password, so they must
 * never reach a server others can sign in to.
 */
async function seedLocal(
	seed: SeedUsers,
	root: string,
	api: ApiOptions,
	projectId: string,
	authEnv: Map<string, string>,
	secret: (kind: "hex" | "base64" | "password", bytes: number) => string,
	log: Log,
): Promise<void> {
	if (seed.adminRoles.length === 0 && seed.users.length === 0 && seed.companies.length === 0) return;
	if (!isLocalIssuer(api.issuer)) {
		log(`Not seeding ${SEED_FILE}: ZITADEL_ISSUER (${api.issuer}) is not on this machine. Grant roles and create users in the Console.`);
		return;
	}
	const domain = authEnv.get("ZITADEL_DOMAIN") || "localhost";
	const env = resolve(root, AUTH, ".env");
	const example = resolve(root, AUTH, ".env.example");
	// Only a user that has to be created needs it, so an existing one is never
	// followed by a password that does not match.
	const password = () => {
		const current = parseEnv(env).get(SEED_PASSWORD_KEY);
		if (!isUnset(current)) return current!;
		const generated = secret("password", 18);
		setEnvValue(env, example, SEED_PASSWORD_KEY, generated);
		log(`Generated ${SEED_PASSWORD_KEY} in ${AUTH}/.env`);
		return generated;
	};
	const logins = await seedUsers(api, seed, {
		projectId,
		domain: loginDomain(authEnv, domain),
		adminName: adminLogin(authEnv, domain),
		password,
		log,
	});
	if (logins.length > 0) log(`Seeded users: ${logins.join(", ")} (password: ${SEED_PASSWORD_KEY} in ${AUTH}/.env)`);
}

async function setupLocal(
	values: { "pat-file"?: string; "skip-start"?: boolean; "no-seed"?: boolean },
	root: string,
	log: Log,
	processEnv: Record<string, string | undefined>,
	deps: SetupDeps,
): Promise<number> {
	// A mistake in the file stops setup before a container starts.
	const seed = values["no-seed"]
		? { adminRoles: [], users: [], companies: [] }
		: readSeedUsers(root, readProjectRoles(root).map((role) => role.key));
	const apps = findApps(root);
	for (const dir of ["", AUTH, ...apps.map((app) => app.path)]) copyIfMissing(root, dir, log);
	const authEnvFile = `${AUTH}/.env`;
	const allowRegister = parseAllowRegister(parseEnv(resolve(root, authEnvFile)).get(ALLOW_REGISTER_KEY), authEnvFile);

	if (!values["skip-start"]) (deps.startAuthStack ?? startAuthStack)(root);

	const compose = composeArgs(root, `${AUTH}/.env`, [`${AUTH}/docker-compose.yml`]);
	const token = resolveToken(
		values,
		processEnv,
		() => (deps.readStackToken ?? readStackToken)(root, compose),
		`docker compose --env-file ${AUTH}/.env -f ${AUTH}/docker-compose.yml down -v`,
	);

	const rootEnv = readEffectiveEnv(root, "");
	const issuer = rootEnv.get("ZITADEL_ISSUER");
	if (!issuer) throw new Error("ZITADEL_ISSUER is not set in .env");
	const api: ApiOptions = { issuer, token, fetcher: deps.fetcher };
	const secret = deps.randomSecret ?? randomSecret;
	await waitForIssuer(issuer, deps, log, "Check ZITADEL_ISSUER in .env and the auth stack (moon run auth-server:dev).");
	await applySelfRegistration(api, allowRegister, authEnvFile, log);

	const authEnv = readEffectiveEnv(root, AUTH);
	const localDomain = authEnv.get("ZITADEL_DOMAIN") || "localhost";
	await applySmtp(
		api,
		{
			// The Mailpit container of the auth stack, reached by its name on the stack's network.
			host: "mailpit:1025",
			senderAddress: `no-reply@${loginDomain(authEnv, localDomain)}`,
			senderName: authEnv.get("ZITADEL_ORG_NAME") || "Vern",
			tls: false,
		},
		{ local: true, mailpitUrl: `http://localhost:${authEnv.get("MAIL_UI_PORT") || "8025"}`, envFile: `${AUTH}/.env` },
		log,
	);
	const project = await ensureProject(api, rootEnv.get("ZITADEL_PROJECT_ID"), authEnv.get("ZITADEL_ORG_NAME") || "Vern", log);
	const projectId = project.id;
	if (project.changed) {
		setEnvValue(resolve(root, ".env"), resolve(root, ".env.example"), "ZITADEL_PROJECT_ID", projectId);
		log("Wrote ZITADEL_PROJECT_ID to .env");
	}
	await ensureRoles(root, api, projectId, log);

	const apiUrls = new Map<string, string>();
	for (const app of apps.filter((item) => item.kind === "api")) {
		const env = resolve(root, app.path, ".env");
		const example = resolve(root, app.path, ".env.example");
		// The API reads its own .env, whose example carries placeholders for these.
		setEnvValue(env, example, "ZITADEL_ISSUER", issuer);
		setEnvValue(env, example, "ZITADEL_PROJECT_ID", projectId);
		const appEnv = readEffectiveEnv(root, app.path);
		const keyFile = resolve(root, app.path, appEnv.get("ZITADEL_API_KEY_FILE") || "./secrets/zitadel-api-key.json");
		if (existsSync(keyFile) && (await keyIsKnown(api, projectId, keyFile))) {
			log(`${app.path}: keeping the key in ${relative(root, keyFile)}`);
		} else {
			const key = await createApiKey(api, projectId, app.name);
			mkdirSync(dirname(keyFile), { recursive: true });
			writeFileSync(keyFile, key, { mode: 0o600 });
			chmodSync(keyFile, 0o600);
			log(`${app.path}: created a key for API application "${app.name}" in ${relative(root, keyFile)}`);
		}
		const port = appEnv.get("PORT");
		if (port) apiUrls.set(app.name, `http://localhost:${port}`);
	}

	for (const app of apps.filter((item) => item.kind === "web")) {
		const env = resolve(root, app.path, ".env");
		const example = resolve(root, app.path, ".env.example");
		const appEnv = readEffectiveEnv(root, app.path);
		if (!appEnv.get("SESSION_SECRET")) setEnvValue(env, example, "SESSION_SECRET", secret("base64", 32));
		const apiUrl = chooseApiUrl(app, appEnv, apiUrls);
		if (apiUrl.url) setEnvValue(env, example, "API_BASE_URL", apiUrl.url);
		if (apiUrl.message) log(apiUrl.message);
		const appUrl = appEnv.get("APP_URL");
		if (!appUrl) throw new Error(`${app.path}: APP_URL is not set`);
		const result = await provisionApplication({
			...api,
			projectId,
			name: app.name,
			config: buildOidcConfig({ appUrl }),
		});
		setEnvValue(env, example, "ZITADEL_CLIENT_ID", result.clientId);
		log(`${app.path}: ${result.action} OIDC application "${app.name}" for ${appUrl}`);
	}

	await seedLocal(seed, root, api, projectId, authEnv, secret, log);

	if (apps.length === 0) {
		log("No generated apps yet. Generate one (moon generate tanstack -- --name dashboard --port 3000) and run this again.");
	} else {
		log("\nDone. Start everything with: moon run :dev");
	}
	log(`Sign in as ${adminLogin(authEnv, authEnv.get("ZITADEL_DOMAIN") || "localhost")} with the password from ${AUTH}/.env.`);
	return 0;
}

async function setupDeploy(
	values: { "pat-file"?: string; "skip-start"?: boolean },
	root: string,
	log: Log,
	processEnv: Record<string, string | undefined>,
	deps: SetupDeps,
): Promise<number> {
	const envPath = resolve(root, DEPLOY, ".env");
	const examplePath = resolve(root, DEPLOY, ".env.example");
	if (!existsSync(envPath)) {
		copyFileSync(examplePath, envPath);
		throw new Error(
			`Created ${DEPLOY}/.env. Set AUTH_DOMAIN, APP_DOMAIN, API_DOMAIN, ACME_EMAIL, WEB_APP, and API_APP in it, then run this again.`,
		);
	}
	const set = (key: string, value: string) => setEnvValue(envPath, examplePath, key, value);
	let env = parseEnv(envPath);
	for (const key of ["AUTH_DOMAIN", "APP_DOMAIN", "API_DOMAIN", "ACME_EMAIL"]) {
		const value = env.get(key);
		if (!value || value.endsWith("example.com")) throw new Error(`Set ${key} in ${DEPLOY}/.env`);
	}
	const apps = findApps(root);
	const web = apps.find((app) => app.kind === "web" && app.name === env.get("WEB_APP"));
	const apiApp = apps.find((app) => app.kind === "api" && app.name === env.get("API_APP"));
	if (!web) throw new Error(`WEB_APP=${env.get("WEB_APP") ?? ""} does not name a generated web app under apps/`);
	if (!apiApp) throw new Error(`API_APP=${env.get("API_APP") ?? ""} does not name a generated Axum API under apps/`);

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
	env = parseEnv(envPath);
	const allowRegister = parseAllowRegister(env.get(ALLOW_REGISTER_KEY), `${DEPLOY}/.env`);
	// A half-filled mail setup stops here, before a container starts.
	const smtp = readSmtpSettings(env, `${DEPLOY}/.env`, env.get("ZITADEL_ORG_NAME") || "Vern");

	// COMPOSE_FILE adds overrides, such as deploy/docker-compose.local.yml.
	const files = processEnv.COMPOSE_FILE?.split(":").filter(Boolean) ?? [`${DEPLOY}/docker-compose.yml`];
	const compose = composeArgs(root, `${DEPLOY}/.env`, files);
	const run = deps.runCompose ?? runCompose;
	if (!values["skip-start"]) run(root, [...compose, "up", "--detach", "--wait", ...DEPLOY_IDENTITY_SERVICES]);

	const authDomain = env.get("AUTH_DOMAIN")!;
	const token = resolveToken(
		values,
		processEnv,
		() => (deps.readStackToken ?? readStackToken)(root, compose),
		`docker compose --env-file ${DEPLOY}/.env -f ${DEPLOY}/docker-compose.yml down -v`,
	);
	const api: ApiOptions = { issuer: `https://${authDomain}`, token, fetcher: deps.fetcher };
	await waitForIssuer(
		api.issuer,
		deps,
		log,
		`Check that DNS for ${authDomain} points at this server and that ports 80 and 443 are open, so Let's Encrypt can issue its certificate.`,
	);

	await applySelfRegistration(api, allowRegister, `${DEPLOY}/.env`, log);
	await applySmtp(api, smtp, { local: false, mailpitUrl: "", envFile: `${DEPLOY}/.env` }, log);

	const project = await ensureProject(api, env.get("ZITADEL_PROJECT_ID"), env.get("ZITADEL_ORG_NAME") || "Vern", log);
	if (project.changed) set("ZITADEL_PROJECT_ID", project.id);
	await ensureRoles(root, api, project.id, log);

	const appUrl = `https://${env.get("APP_DOMAIN")}`;
	const result = await provisionApplication({
		...api,
		projectId: project.id,
		name: web.name,
		config: buildOidcConfig({ appUrl }),
	});
	set("WEB_CLIENT_ID", result.clientId);
	log(`${web.path}: ${result.action} OIDC application "${web.name}" for ${appUrl}`);

	const keyFile = resolve(root, DEPLOY, "secrets/api-key.json");
	if (existsSync(keyFile) && (await keyIsKnown(api, project.id, keyFile))) {
		log(`${apiApp.path}: keeping the key in ${relative(root, keyFile)}`);
	} else {
		const key = await createApiKey(api, project.id, apiApp.name);
		mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
		chmodSync(dirname(keyFile), 0o700);
		// The directory keeps other users out; the API container reads the file as a non-root user.
		writeFileSync(keyFile, key, { mode: 0o644 });
		chmodSync(keyFile, 0o644);
		log(`${apiApp.path}: created a key for API application "${apiApp.name}" in ${relative(root, keyFile)}`);
	}

	if (!values["skip-start"]) run(root, [...compose, "up", "--detach", "--wait", "--build"]);

	log(`\nDone. The app runs at ${appUrl} and the ZITADEL Console at https://${authDomain}/ui/console/.`);
	log(`Sign in as ${adminLogin(env, authDomain)} with ZITADEL_ADMIN_PASSWORD from ${DEPLOY}/.env; ZITADEL asks for a new password on the first sign-in.`);
	return 0;
}

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

if (import.meta.main) {
	setup(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(`setup: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		},
	);
}
