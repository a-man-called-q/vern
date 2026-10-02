import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkPorts, describePortErrors } from "./ports";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "vern-ports-"));
	roots.push(root);
	for (const [path, content] of Object.entries({
		".env.example": "ZITADEL_ISSUER=http://localhost:8081\nREDIS_URL=redis://localhost:6379\n",
		"deploy/dev/auth-server/.env.example": "AUTH_HTTP_PORT=8081\nREDIS_PORT=6379\n",
		...files,
	})) {
		mkdirSync(dirname(resolve(root, path)), { recursive: true });
		writeFileSync(resolve(root, path), content);
	}
	return root;
}

describe("checkPorts", () => {
	test("accepts apps on their own ports", () => {
		const root = workspace({
			"apps/web/moon.yml": "",
			"apps/web/.env.example": "PORT=3000\nAPP_URL=http://localhost:3000\n",
			"services/api/moon.yml": "",
			"services/api/.env.example": "PORT=4000\n",
		});
		expect(checkPorts(root)).toEqual([]);
	});

	test("finds two projects on one port, and the auth stack's ports", () => {
		const root = workspace({
			"apps/web/moon.yml": "",
			"apps/web/.env.example": "PORT=3000\n",
			"apps/admin/moon.yml": "",
			"apps/admin/.env": "PORT=3000\n",
			"services/api/moon.yml": "",
			"services/api/.env.example": "PORT=8081\n",
		});
		expect(checkPorts(root)).toEqual([
			"Port 8081 is assigned to multiple projects: auth-server (ZITADEL), api (8081).",
			"Port 3000 is assigned to multiple projects: admin (3000), web (3000).",
		]);
	});

	test("finds a missing or invalid PORT and a URL on another port", () => {
		const root = workspace({
			".env": "ZITADEL_ISSUER=http://localhost:9999\n",
			"apps/web/moon.yml": "",
			"apps/web/.env.example": "PORT=3000\nAPP_URL=http://localhost:3001\n",
			"services/api/moon.yml": "",
			"services/api/.env.example": "PORT=80\n",
			"services/worker/moon.yml": "",
			// A folder without moon.yml is not a project.
			"apps/notes/.env.example": "PORT=3000\n",
		});
		expect(checkPorts(root)).toEqual([
			"ZITADEL_ISSUER uses port 9999, but ZITADEL exposes port 8081.",
			'api (80) has invalid PORT "80"; use an integer from 1024 to 65535.',
			"web APP_URL uses port 3001, but PORT is 3000.",
			"worker (missing PORT) does not define a port.",
		]);
	});

	test("describes the errors the way the command prints them", () => {
		expect(describePortErrors(["One.", "Two."])).toBe(
			"Local port configuration has errors:\n- One.\n- Two.\nSet distinct ports in the root or per-project .env files, then run moon run workspace:check-ports.",
		);
	});
});
