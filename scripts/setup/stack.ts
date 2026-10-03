import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AUTH_SERVER } from "../lib/projects";
import type { Log, SetupDeps } from "./context";

/** The local ZITADEL, Redis, and Mailpit stack. */
export const AUTH = AUTH_SERVER;
/** Where every environment is described: `deploy/dev` and one folder per environment below. */
export const DEPLOY = "deploy";
/** The Docker Compose stack that runs the whole product on one server. */
export const COMPOSE = `${DEPLOY}/compose`;
/** The Kubernetes manifests every overlay shares. */
export const BASE = `${DEPLOY}/base`;

/**
 * The environments that run the whole product, each in `deploy/<name>`: a
 * rehearsal on this machine, staging, and production. (`deploy/dev` is not one
 * of them: it runs only what the apps depend on, and the apps from source.)
 */
export const ENVIRONMENTS = ["local", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export function environmentOf(flag: string, value: string | undefined): Environment {
	const found = ENVIRONMENTS.find((name) => name === value);
	if (!found) throw new Error(`${flag} takes ${ENVIRONMENTS.join(", ").replace(/, (\w+)$/, ", or $1")}: the environment under ${DEPLOY}/`);
	return found;
}

/** What runs an environment. */
export type Method = "compose" | "kubernetes";

/**
 * How `--env <name>` runs the environment: with what has been set up there
 * before, told by its settings file (`.env` for Compose, `settings.env` for
 * Kubernetes).
 */
export function methodOf(root: string, environment: Environment): Method {
	const dir = `${DEPLOY}/${environment}`;
	const compose = existsSync(resolve(root, dir, ".env"));
	const kubernetes = existsSync(resolve(root, dir, "settings.env"));
	if (compose !== kubernetes) return compose ? "compose" : "kubernetes";
	throw new Error(
		compose
			? `${dir} has both .env (Docker Compose) and settings.env (Kubernetes). Say which one: --compose ${environment} or --kubernetes ${environment}.`
			: `${dir} is not set up yet. Start with --compose ${environment} (one server with Docker) or --kubernetes ${environment}.`,
	);
}
const ADMIN_PAT_PATH = "/zitadel/bootstrap/admin.pat";

export function composeArgs(root: string, envFile: string, files: string[]): string[] {
	return ["compose", "--env-file", resolve(root, envFile), ...files.flatMap((file) => ["-f", resolve(root, file)])];
}

/** The local auth stack's compose arguments, and how to reset it. */
export function authStack(root: string): { compose: string[]; resetHint: string } {
	return {
		compose: composeArgs(root, `${AUTH}/.env`, [`${AUTH}/docker-compose.yml`]),
		resetHint: `docker compose --env-file ${AUTH}/.env -f ${AUTH}/docker-compose.yml down -v`,
	};
}

export function startAuthStack(root: string): void {
	const result = spawnSync("moon", ["run", "auth-server:up"], { cwd: root, stdio: "inherit" });
	if (result.status !== 0) throw new Error("Starting the auth stack failed (moon run auth-server:up).");
}

export function runCompose(root: string, args: string[]): void {
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

/** `--pat-file`, then ZITADEL_PAT, then the token the stack wrote. */
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

/**
 * Waits until the issuer answers through the proxy: routes register a moment
 * after the containers are healthy, and a new server first needs certificates.
 */
export async function waitForIssuer(issuer: string, deps: SetupDeps, log: Log, hint: string): Promise<void> {
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
