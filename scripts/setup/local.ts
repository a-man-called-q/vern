import { copyFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { findApps } from "../lib/projects";
import { envFiles, isUnset, parseEnv, readEffectiveEnv, setEnvValue } from "../lib/env";
import type { ApiOptions } from "../zitadel/client";
import { ALLOW_REGISTER_KEY, parseAllowRegister } from "../zitadel/login-policy";
import { readProjectRoles } from "../zitadel/roles";
import { isLocalIssuer, readSeedUsers, SEED_FILE, SEED_PASSWORD_KEY, type SeedUsers, seedUsers } from "../zitadel/seed";
import { chooseApiUrl, chooseNamedApiUrls } from "./api-urls";
import type { Log, SecretKind, SetupDeps } from "./context";
import { adminLogin, loginDomain } from "./logins";
import { provisionOrgAdmin, wantsOrgAdmin } from "./org-admin";
import { randomSecret } from "./secrets";
import { AUTH, authStack, readStackToken, resolveToken, startAuthStack } from "./stack";
import { applySelfRegistration, applySmtp, connect, ensureApiKey, ensureProjectWithRoles, ensureWebApplication } from "./steps";

function copyIfMissing(root: string, dir: string, log: Log): void {
	const { env, example } = envFiles(root, dir);
	if (existsSync(env) || !existsSync(example)) return;
	copyFileSync(example, env);
	log(`Created ${relative(root, env)} from .env.example`);
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
	secret: (kind: SecretKind, bytes: number) => string,
	log: Log,
): Promise<void> {
	if (seed.adminRoles.length === 0 && seed.users.length === 0 && seed.companies.length === 0) return;
	if (!isLocalIssuer(api.issuer)) {
		log(`Not seeding ${SEED_FILE}: ZITADEL_ISSUER (${api.issuer}) is not on this machine. Grant roles and create users in the Console.`);
		return;
	}
	const domain = authEnv.get("ZITADEL_DOMAIN") || "localhost";
	const files = envFiles(root, AUTH);
	// Only a user that has to be created needs it, so an existing one is never
	// followed by a password that does not match.
	const password = () => {
		const current = parseEnv(files.env).get(SEED_PASSWORD_KEY);
		if (!isUnset(current)) return current as string;
		const generated = secret("password", 18);
		setEnvValue(files, SEED_PASSWORD_KEY, generated);
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

/**
 * The local flow: the .env files from their examples, the auth stack, then
 * ZITADEL's project, a key per API and an application per web app, and the
 * seeded users.
 */
export async function setupLocal(
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

	const stack = authStack(root);
	const rootEnv = readEffectiveEnv(root, "");
	const api = await connect(
		{
			token: () =>
				resolveToken(values, processEnv, () => (deps.readStackToken ?? readStackToken)(root, stack.compose), stack.resetHint),
			issuer: () => {
				const issuer = rootEnv.get("ZITADEL_ISSUER");
				if (!issuer) throw new Error("ZITADEL_ISSUER is not set in .env");
				return issuer;
			},
			waitHint: "Check ZITADEL_ISSUER in .env and the auth stack (moon run auth-server:dev).",
		},
		deps,
		log,
	);
	const secret = deps.randomSecret ?? randomSecret;
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
		{ local: true, mailpitUrl: `http://localhost:${authEnv.get("MAIL_UI_PORT") || "8025"}`, envFile: authEnvFile },
		log,
	);
	const project = await ensureProjectWithRoles(
		root,
		api,
		rootEnv.get("ZITADEL_PROJECT_ID"),
		authEnv.get("ZITADEL_ORG_NAME") || "Vern",
		log,
	);
	const projectId = project.id;
	if (project.changed) {
		setEnvValue(envFiles(root, ""), "ZITADEL_PROJECT_ID", projectId);
		log("Wrote ZITADEL_PROJECT_ID to .env");
	}

	const apiUrls = new Map<string, string>();
	for (const app of apps.filter((item) => item.kind === "api")) {
		const files = envFiles(root, app.path);
		// The API reads its own .env, whose example carries placeholders for these.
		setEnvValue(files, "ZITADEL_ISSUER", api.issuer);
		setEnvValue(files, "ZITADEL_PROJECT_ID", projectId);
		const appEnv = readEffectiveEnv(root, app.path);
		const keyFile = resolve(root, app.path, appEnv.get("ZITADEL_API_KEY_FILE") || "./secrets/zitadel-api-key.json");
		await ensureApiKey(api, projectId, app, keyFile, { file: 0o600 }, root, log);
		if (wantsOrgAdmin(root, app)) await provisionOrgAdmin(api, root, app, log);
		const port = appEnv.get("PORT");
		if (port) apiUrls.set(app.name, `http://localhost:${port}`);
	}

	for (const app of apps.filter((item) => item.kind === "web")) {
		const files = envFiles(root, app.path);
		const appEnv = readEffectiveEnv(root, app.path);
		if (!appEnv.get("SESSION_SECRET")) setEnvValue(files, "SESSION_SECRET", secret("base64", 32));
		const apiUrl = chooseApiUrl(app, appEnv, apiUrls);
		if (apiUrl.url) setEnvValue(files, "API_BASE_URL", apiUrl.url);
		if (apiUrl.message) log(apiUrl.message);
		for (const [key, url] of chooseNamedApiUrls(app, appEnv, apiUrls)) setEnvValue(files, key, url);
		const appUrl = appEnv.get("APP_URL");
		if (!appUrl) throw new Error(`${app.path}: APP_URL is not set`);
		setEnvValue(files, "ZITADEL_CLIENT_ID", await ensureWebApplication(api, projectId, app, appUrl, log));
	}

	await seedLocal(seed, root, api, projectId, authEnv, secret, log);

	if (apps.length === 0) {
		log("No generated apps yet. Generate one (moon generate tanstack -- --name dashboard --port 3000) and run this again.");
	} else {
		log("\nDone. Start everything with: moon run :dev");
	}
	log(`Sign in as ${adminLogin(authEnv, localDomain)} with the password from ${AUTH}/.env.`);
	return 0;
}
