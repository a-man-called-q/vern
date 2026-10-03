import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkReleases } from "./releases";
import type { Level } from "./report";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const EXAMPLE = "ZITADEL_VERSION=v4.19.3\nZITADEL_LOGIN_IMAGE=ghcr.io/acme/login:v4.19.3-new\n";

function findings(files: Record<string, string>): [Level, string][] {
	const root = mkdtempSync(join(tmpdir(), "vern-releases-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(resolve(root, path)), { recursive: true });
		writeFileSync(resolve(root, path), content);
	}
	const found: [Level, string][] = [];
	checkReleases(root, (level, message) => found.push([level, message]));
	return found;
}

describe("checkReleases", () => {
	test("says nothing before any stack has a .env", () => {
		expect(findings({ "deploy/dev/auth-server/.env.example": EXAMPLE, "deploy/compose/.env.example": EXAMPLE })).toEqual([]);
	});

	test("accepts a .env on the release of its example", () => {
		expect(
			findings({
				"deploy/dev/auth-server/.env.example": EXAMPLE,
				"deploy/dev/auth-server/.env": EXAMPLE,
			}),
		).toEqual([["OK", "deploy/dev/auth-server/.env runs the ZITADEL release of deploy/dev/auth-server/.env.example."]]);
	});

	test("names the lines a .env copied from an older example has to take", () => {
		expect(
			findings({
				"deploy/dev/auth-server/.env.example": EXAMPLE,
				"deploy/dev/auth-server/.env": "ZITADEL_VERSION=v4.19.3\nZITADEL_LOGIN_IMAGE=ghcr.io/acme/login:v4.19.3-old\n",
				"deploy/compose/.env.example": EXAMPLE,
				"deploy/prod/.env": "ZITADEL_VERSION=v4.18.0\nZITADEL_LOGIN_IMAGE=ghcr.io/acme/login:v4.18.0-old\n",
				// Kubernetes pins the pair in deploy/base, which has its own check.
				"deploy/staging/settings.env": "DOMAIN=example.com\n",
			}),
		).toEqual([
			[
				"WARN",
				"deploy/dev/auth-server/.env runs another ZITADEL release than deploy/dev/auth-server/.env.example. To move to it, set ZITADEL_LOGIN_IMAGE=ghcr.io/acme/login:v4.19.3-new there, then start the stack again.",
			],
			[
				"WARN",
				"deploy/prod/.env runs another ZITADEL release than deploy/compose/.env.example. To move to it, set ZITADEL_VERSION=v4.19.3 and ZITADEL_LOGIN_IMAGE=ghcr.io/acme/login:v4.19.3-new there, then start the stack again.",
			],
		]);
	});

	test("leaves a Login image the project builds itself alone", () => {
		expect(
			findings({
				"deploy/dev/auth-server/.env.example": EXAMPLE,
				"deploy/dev/auth-server/.env": "ZITADEL_VERSION=v4.19.3\nZITADEL_LOGIN_IMAGE=acme-login:local\n",
				"deploy/compose/.env.example": EXAMPLE,
				"deploy/local/.env": "ZITADEL_VERSION=v4.19.3\nZITADEL_LOGIN_IMAGE=localhost:5000/acme/login\n",
			}).map(([level]) => level),
		).toEqual(["OK", "OK"]);
	});
});
