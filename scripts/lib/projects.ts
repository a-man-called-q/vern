import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "./env";

/**
 * The three folders `moon generate` writes to, one per kind of project: web
 * apps (and Storybook), Axum APIs, and the Compose stacks they run on while
 * developing (the auth stack, PostgreSQL, the bus, storage). A project is a
 * folder directly under one of them. A name is unique across all three: the
 * Moon project ID, the ZITADEL application, and the port all key on it.
 */
export const PROJECT_ROOTS = ["apps", "services", "deploy/dev"] as const;
export type ProjectRoot = (typeof PROJECT_ROOTS)[number];

/** Where the Compose stacks of the development environment live. */
export const DEV_STACKS: ProjectRoot = "deploy/dev";

/** The local ZITADEL, Redis, and Mailpit stack. */
export const AUTH_SERVER = `${DEV_STACKS}/auth-server`;

export type Project = { name: string; path: string; root: ProjectRoot };

/** Every folder under the three roots, in name order. */
export function listProjects(root: string): Project[] {
	const projects: Project[] = [];
	for (const projectRoot of PROJECT_ROOTS) {
		const dir = resolve(root, projectRoot);
		if (!existsSync(dir)) continue;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			projects.push({
				name: entry.name,
				path: `${projectRoot}/${entry.name}`,
				root: projectRoot,
			});
		}
	}
	return projects.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/**
 * The root a project's folder belongs in, from what it holds: a Cargo crate is
 * an API, a Bun package a web app, and a folder with only a Compose file a stack.
 */
export function rootFor(root: string, path: string): ProjectRoot | undefined {
	const has = (file: string) => existsSync(resolve(root, path, file));
	if (has("Cargo.toml")) return "services";
	if (has("package.json")) return "apps";
	if (has("docker-compose.yml")) return DEV_STACKS;
	return undefined;
}

/** The folder of the project named `name` (`--app <name>`), wherever it is. */
export function projectPath(root: string, name: string): string {
	const found = listProjects(root).filter((project) => project.name === name);
	if (found.length === 0) {
		throw new Error(`No project is named ${name} (looked in ${PROJECT_ROOTS.map((dir) => `${dir}/`).join(", ")})`);
	}
	if (found.length > 1) throw new Error(`More than one project is named ${name}: ${found.map((project) => project.path).join(", ")}`);
	return (found[0] as Project).path;
}

export type App = { name: string; path: string; kind: "web" | "api" };

/** Generated apps, recognized by the variables in their `.env.example`. */
export function findApps(root: string): App[] {
	const apps: App[] = [];
	for (const project of listProjects(root)) {
		const example = parseEnv(resolve(root, project.path, ".env.example"));
		if (example.has("ZITADEL_CLIENT_ID")) apps.push({ name: project.name, path: project.path, kind: "web" });
		else if (example.has("ZITADEL_API_KEY_FILE")) apps.push({ name: project.name, path: project.path, kind: "api" });
	}
	return apps;
}
