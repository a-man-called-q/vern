import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readEffectiveEnv } from "../lib/env";
import { AUTH_SERVER, listProjects } from "../lib/projects";

/**
 * What is wrong with the local ports: a project without a valid PORT, two
 * projects on one port, or a URL that points at a different port than the
 * service it names. Empty when everything is fine.
 */
export function checkPorts(root: string): string[] {
	const ports = new Map<number, string[]>();
	const errors: string[] = [];

	const addPort = (label: string, raw: string | undefined): void => {
		if (!raw) {
			errors.push(`${label} does not define a port.`);
			return;
		}

		const port = Number(raw);
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			errors.push(`${label} has invalid PORT ${JSON.stringify(raw)}; use an integer from 1024 to 65535.`);
			return;
		}

		const owners = ports.get(port) ?? [];
		owners.push(label);
		ports.set(port, owners);
	};

	const rootEnv = readEffectiveEnv(root, "");
	const authEnv = readEffectiveEnv(root, AUTH_SERVER);
	const authPort = authEnv.get("AUTH_HTTP_PORT") ?? "8081";
	const redisPort = authEnv.get("REDIS_PORT") ?? "6379";
	addPort("auth-server (ZITADEL)", authPort);
	addPort("auth-server (Redis)", redisPort);
	addPort("auth-server (Mailpit)", authEnv.get("MAIL_UI_PORT") ?? "8025");
	addPort("storybook", "6006");

	const redisUrl = rootEnv.get("REDIS_URL");
	if (redisUrl) {
		try {
			const url = new URL(redisUrl);
			if (url.port && url.port !== redisPort) {
				errors.push(`REDIS_URL uses port ${url.port}, but Redis exposes port ${redisPort}.`);
			}
		} catch {
			errors.push(`REDIS_URL is not a valid URL: ${JSON.stringify(redisUrl)}.`);
		}
	}

	const issuer = rootEnv.get("ZITADEL_ISSUER");
	if (issuer) {
		try {
			const url = new URL(issuer);
			const issuerPort = url.port || (url.protocol === "https:" ? "443" : "80");
			if (issuerPort !== authPort) {
				errors.push(`ZITADEL_ISSUER uses port ${issuerPort}, but ZITADEL exposes port ${authPort}.`);
			}
		} catch {
			errors.push(`ZITADEL_ISSUER is not a valid URL: ${JSON.stringify(issuer)}.`);
		}
	}

	for (const entry of listProjects(root)) {
		if (["auth-server", "storybook"].includes(entry.name)) continue;
		if (!existsSync(resolve(root, entry.path, "moon.yml"))) continue;

		const appEnv = readEffectiveEnv(root, entry.path);
		const appPort = appEnv.get("PORT");
		addPort(`${entry.name} (${appPort ?? "missing PORT"})`, appPort);

		const appUrl = appEnv.get("APP_URL");
		if (appUrl) {
			try {
				const url = new URL(appUrl);
				const appUrlPort = url.port || (url.protocol === "https:" ? "443" : "80");
				if (appUrlPort !== appPort) {
					errors.push(`${entry.name} APP_URL uses port ${appUrlPort}, but PORT is ${appPort}.`);
				}
			} catch {
				errors.push(`${entry.name} APP_URL is not a valid URL: ${JSON.stringify(appUrl)}.`);
			}
		}
	}

	for (const [port, owners] of ports) {
		if (owners.length > 1) errors.push(`Port ${port} is assigned to multiple projects: ${owners.join(", ")}.`);
	}
	return errors;
}

export const PORTS_OK = "Local service ports are valid and unique.";

/** The errors as the port check prints them. */
export function describePortErrors(errors: string[]): string {
	return [
		"Local port configuration has errors:",
		...errors.map((error) => `- ${error}`),
		"Set distinct ports in the root or per-project .env files, then run moon run workspace:check-ports.",
	].join("\n");
}
