import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "../lib/env";
import { AUTH_SERVER } from "../lib/projects";
import { COMPOSE, DEPLOY, ENVIRONMENTS } from "../setup/stack";
import type { Report } from "./report";

const VERSION_KEY = "ZITADEL_VERSION";
const LOGIN_IMAGE_KEY = "ZITADEL_LOGIN_IMAGE";

/** `repository` and `tag` of an image reference; the tag is empty when it has none. */
function splitImage(image: string): { repository: string; tag: string } {
	const colon = image.lastIndexOf(":");
	if (colon <= image.lastIndexOf("/")) return { repository: image, tag: "" };
	return { repository: image.slice(0, colon), tag: image.slice(colon + 1) };
}

/**
 * Each `.env` that pins the ZITADEL pair, beside the example it was copied
 * from: the local auth stack, and the environments that run with Docker Compose.
 */
function pinned(root: string): { env: string; example: string }[] {
	return [
		{ env: `${AUTH_SERVER}/.env`, example: `${AUTH_SERVER}/.env.example` },
		...ENVIRONMENTS.map((environment) => ({ env: `${DEPLOY}/${environment}/.env`, example: `${COMPOSE}/.env.example` })),
	].filter(({ env, example }) => existsSync(resolve(root, env)) && existsSync(resolve(root, example)));
}

/**
 * A `.env` is copied from its example once, so a release the example moved to
 * never reaches it. A Login image from another repository is the project's own
 * build and is left alone.
 */
export function checkReleases(root: string, report: Report): void {
	for (const { env, example } of pinned(root)) {
		const mine = parseEnv(resolve(root, env));
		const theirs = parseEnv(resolve(root, example));
		const behind: string[] = [];

		const version = theirs.get(VERSION_KEY);
		if (version && mine.get(VERSION_KEY) !== version) behind.push(`${VERSION_KEY}=${version}`);

		const image = theirs.get(LOGIN_IMAGE_KEY);
		const current = mine.get(LOGIN_IMAGE_KEY);
		if (image && current !== image && (!current || splitImage(current).repository === splitImage(image).repository)) {
			behind.push(`${LOGIN_IMAGE_KEY}=${image}`);
		}

		if (behind.length > 0) {
			report(
				"WARN",
				`${env} runs another ZITADEL release than ${example}. To move to it, set ${behind.join(" and ")} there, then start the stack again.`,
			);
		} else {
			report("OK", `${env} runs the ZITADEL release of ${example}.`);
		}
	}
}
