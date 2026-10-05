import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { App } from "../lib/projects";
import { isUnset } from "../lib/env";
import { createApiKey, keyIsKnown } from "../zitadel/api-keys";
import type { ApiOptions } from "../zitadel/client";
import { ALLOW_REGISTER_KEY, ensureSelfRegistration } from "../zitadel/login-policy";
import { buildOidcConfig, provisionApplication } from "../zitadel/oidc";
import { ensureProject } from "../zitadel/projects";
import { ensureProjectRoles, readProjectRoles } from "../zitadel/roles";
import { ensureSmtp, type SmtpSettings } from "../zitadel/smtp";
import type { Log, SetupDeps } from "./context";
import { waitForIssuer } from "./stack";

// The steps both flows take, in this order: connect, configure the instance,
// the project and its roles, then a key for each API and an application for
// each web app. Each keeps what is already right, so setup can run again.

/** Resolves the token, then waits until ZITADEL answers at the issuer. */
export async function connect(
	options: { token: () => string; issuer: () => string; waitHint: string },
	deps: SetupDeps,
	log: Log,
): Promise<ApiOptions> {
	const token = options.token();
	const issuer = options.issuer();
	await waitForIssuer(issuer, deps, log, options.waitHint);
	return { issuer, token, fetcher: deps.fetcher };
}

/**
 * Makes ZITADEL's sign-up page match ZITADEL_ALLOW_REGISTER. Without a value
 * nothing changes, but an open sign-up page is said out loud: the Console is
 * the only other place it shows, and nobody opens that.
 */
export async function applySelfRegistration(
	api: ApiOptions,
	wanted: boolean | undefined,
	envFile: string,
	log: Log,
): Promise<void> {
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
 * deployment it is the SMTP_* of its settings file, and without them nothing is
 * changed but the missing mail server is said out loud, because invitations and
 * password resets silently never arrive.
 */
export async function applySmtp(
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

/**
 * Keeps the project `current` names (unless it is still the example's
 * placeholder), or finds or creates it by name, and
 * creates the roles declared in roles.json on it. `changed` says the caller has
 * a new project ID to store.
 */
export async function ensureProjectWithRoles(
	root: string,
	api: ApiOptions,
	current: string | undefined,
	name: string,
	log: Log,
): Promise<{ id: string; changed: boolean }> {
	const project = await ensureProject(api, isUnset(current) ? undefined : current, name);
	if (project.action === "kept") log(`Using ZITADEL project ${project.id}`);
	else log(`${project.action === "created" ? "Created" : "Found"} ZITADEL project "${name}" (${project.id})`);

	const roles = readProjectRoles(root);
	if (roles.length > 0) {
		const { created, existing } = await ensureProjectRoles(api, project.id, roles);
		if (created.length > 0) log(`Created ZITADEL project roles: ${created.join(", ")}`);
		if (existing.length > 0) log(`Project roles already there: ${existing.join(", ")}`);
	}
	return { id: project.id, changed: project.action !== "kept" };
}

/**
 * Keeps the API's key file while ZITADEL still knows the key, or writes a new
 * key there. `modes` are the permissions of the file and, when given, its folder.
 */
export async function ensureApiKey(
	api: ApiOptions,
	projectId: string,
	app: App,
	keyFile: string,
	modes: { file: number; dir?: number },
	root: string,
	log: Log,
): Promise<void> {
	if (existsSync(keyFile) && (await keyIsKnown(api, projectId, keyFile))) {
		log(`${app.path}: keeping the key in ${relative(root, keyFile)}`);
		return;
	}
	const key = await createApiKey(api, projectId, app.name);
	mkdirSync(dirname(keyFile), { recursive: true, ...(modes.dir === undefined ? {} : { mode: modes.dir }) });
	if (modes.dir !== undefined) chmodSync(dirname(keyFile), modes.dir);
	writeFileSync(keyFile, key, { mode: modes.file });
	chmodSync(keyFile, modes.file);
	log(`${app.path}: created a key for API application "${app.name}" in ${relative(root, keyFile)}`);
}

/** Creates the web app's OIDC application or brings it in line; returns its client ID. */
export async function ensureWebApplication(
	api: ApiOptions,
	projectId: string,
	app: App,
	appUrl: string,
	log: Log,
): Promise<string> {
	const result = await provisionApplication({
		...api,
		projectId,
		name: app.name,
		config: buildOidcConfig({ appUrl }),
	});
	log(`${app.path}: ${result.action} OIDC application "${app.name}" for ${appUrl}`);
	return result.clientId;
}
