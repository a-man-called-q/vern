import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "./env";

/** Where `moon generate` writes every project. */
export const APPS_DIR = "apps";

export type App = { name: string; path: string; kind: "web" | "api" };

/** Generated apps, recognized by the variables in their `.env.example`. */
export function findApps(root: string): App[] {
	const apps: App[] = [];
	const dir = resolve(root, APPS_DIR);
	if (!existsSync(dir)) return apps;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const example = parseEnv(resolve(dir, entry.name, ".env.example"));
		const path = `${APPS_DIR}/${entry.name}`;
		if (example.has("ZITADEL_CLIENT_ID")) apps.push({ name: entry.name, path, kind: "web" });
		else if (example.has("ZITADEL_API_KEY_FILE")) apps.push({ name: entry.name, path, kind: "api" });
	}
	return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** The folder of the app named `name` (`--app <name>`), which must exist. */
export function appPath(root: string, name: string): string {
	const path = `${APPS_DIR}/${name}`;
	if (!existsSync(resolve(root, path))) throw new Error(`${path} does not exist`);
	return path;
}
