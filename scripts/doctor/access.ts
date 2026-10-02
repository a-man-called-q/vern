import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "../lib/env";
import { AUTH_SERVER } from "../lib/projects";
import { errorMessage } from "../lib/errors";
import { ALLOW_REGISTER_KEY, parseAllowRegister } from "../zitadel/login-policy";
import { readProjectRoles, ROLES_FILE } from "../zitadel/roles";
import { readSeedUsers, SEED_FILE } from "../zitadel/seed";
import { readSmtpSettings, SMTP_HOST_KEY } from "../zitadel/smtp";
import type { Report } from "./report";

/** The first of `.env` and `.env.example` in `dir` that exists: what the stack reads, or will once setup copies it. */
function envFileOf(root: string, dir: string): string | undefined {
	return [".env", ".env.example"].map((name) => dir + "/" + name).find((path) => existsSync(resolve(root, path)));
}

/** Roles, seeded users, sign-up, and mail: who gets in, and how they hear about it. */
export function checkAccess(root: string, report: Report): void {
	try {
		const roles = readProjectRoles(root);
		report(
			"OK",
			roles.length > 0
				? ROLES_FILE + " declares " + roles.length + " project role(s)."
				: ROLES_FILE + " declares no project roles.",
		);
		const seed = readSeedUsers(root, roles.map((role) => role.key));
		report(
			"OK",
			seed.users.length > 0 || seed.adminRoles.length > 0 || seed.companies.length > 0
				? SEED_FILE +
						" seeds " +
						seed.users.length +
						" user(s), " +
						seed.companies.length +
						" company(ies), and " +
						seed.adminRoles.length +
						" admin role(s) locally."
				: SEED_FILE + " seeds nothing.",
		);
	} catch (error) {
		report("FAIL", errorMessage(error));
	}

	for (const dir of [AUTH_SERVER, "deploy"]) {
		const file = envFileOf(root, dir);
		if (!file) continue;
		try {
			const allowed = parseAllowRegister(parseEnv(resolve(root, file)).get(ALLOW_REGISTER_KEY), file);
			if (allowed === undefined)
				report("INFO", ALLOW_REGISTER_KEY + " is not set in " + file + "; an existing ZITADEL keeps its setting, a new one starts with sign-up off.");
			else if (allowed)
				report("INFO", ALLOW_REGISTER_KEY + "=true in " + file + ": anyone can create an account from the sign-in page.");
			else report("OK", ALLOW_REGISTER_KEY + "=false in " + file + ": accounts are created by an administrator.");
		} catch (error) {
			report("FAIL", errorMessage(error));
		}
	}

	// A deployment's mail settings: a half-filled set stops `setup --deploy`, and none at all means no mail.
	const file = envFileOf(root, "deploy");
	if (file) {
		try {
			const env = parseEnv(resolve(root, file));
			const smtp = readSmtpSettings(env, file, env.get("ZITADEL_ORG_NAME") || "Vern");
			if (smtp) report("OK", SMTP_HOST_KEY + " in " + file + ": ZITADEL will send mail through " + smtp.host + ".");
			else
				report(
					"INFO",
					SMTP_HOST_KEY + " is not set in " + file + ": a deployment sends no invitations, email verification, or password resets until it is.",
				);
		} catch (error) {
			report("FAIL", errorMessage(error));
		}
	}
}
