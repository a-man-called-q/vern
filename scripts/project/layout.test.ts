import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkLayout } from "../doctor/workspace";
import { run } from "../lib/run";
import { migrateLayout, planLayoutMigration } from "./layout";
import { updateProject } from "./update";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
	mkdirSync(dirname(resolve(root, path)), { recursive: true });
	writeFileSync(resolve(root, path), content);
}

function git(root: string, ...args: string[]): string {
	return run("git", ["-c", "user.name=Vern Tests", "-c", "user.email=tests@example.test", ...args], { cwd: root }).stdout;
}

const OLD_UP_SH = `#!/bin/sh
# Starts PostgreSQL, then applies every apps/*/db/init.sql.
for file in ../*/db/init.sql; do
  echo "data: applying \${file#../}"
done
`;

const DEPLOY = `services:
  web:
    build:
      dockerfile: apps/\${WEB_APP:?Set WEB_APP in deploy/.env}/Dockerfile
  login:
    volumes:
      - ../apps/auth-server/brand:/brand:ro
  api:
    build:
      context: ../apps/\${API_APP:?Set API_APP in deploy/.env}
  billing:
    build:
      context: ../apps/api
`;

/**
 * A project from before the layout change, just after an update brought the
 * auth stack to infra/: its own API and data project are still in apps/, and
 * apps/auth-server keeps the local .env and a brand file changed locally.
 */
function oldProject(): string {
	const root = mkdtempSync(join(tmpdir(), "vern-layout-"));
	roots.push(root);
	git(root, "init", "-q", "-b", "main");
	write(root, ".gitignore", ".env\nsecrets\n");
	write(root, "apps/web/package.json", "{}\n");
	write(root, "apps/web/moon.yml", "tasks: {}\n");
	write(root, "apps/storybook/package.json", "{}\n");
	write(root, "apps/api/Cargo.toml", '[package]\nname = "api"\n');
	write(root, "apps/api/moon.yml", "tasks: {}\n");
	write(root, "apps/api/Dockerfile", "# or: docker build -t api apps/api\nFROM scratch\n");
	write(root, "apps/data/docker-compose.yml", "# The data, apart from apps/auth-server.\nservices: {}\n");
	write(root, "apps/data/moon.yml", "tasks: {}\n");
	write(root, "apps/data/up.sh", OLD_UP_SH);
	write(root, "apps/auth-server/brand/logo.svg", "<svg>ours</svg>\n");
	write(root, "infra/auth-server/docker-compose.yml", "services: {}\n");
	write(root, "infra/auth-server/brand/logo.svg", "<svg>upstream</svg>\n");
	write(root, "deploy/docker-compose.yml", DEPLOY);
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "old layout");
	// What Git does not track: local settings and keys.
	write(root, "apps/api/.env", "PORT=4000\n");
	write(root, "apps/api/secrets/zitadel-api-key.json", "{}\n");
	write(root, "apps/auth-server/.env", "ZITADEL_VERSION=v4\n");
	return root;
}

const read = (root: string, path: string) => readFileSync(resolve(root, path), "utf8");

describe("layout migration", () => {
	test("plans to move everything under apps/ that is not a web app", () => {
		expect(planLayoutMigration(oldProject())).toEqual([
			{ from: "apps/api", to: "services/api" },
			{ from: "apps/auth-server", to: "infra/auth-server" },
			{ from: "apps/data", to: "infra/data" },
		]);
	});

	test("moves the API and the data project with their local files, and fixes the paths in them", () => {
		const root = oldProject();
		const { moves, leftovers } = migrateLayout(root);

		expect(moves).toEqual([
			{ from: "apps/api", to: "services/api" },
			{ from: "apps/data", to: "infra/data" },
		]);
		expect(existsSync(resolve(root, "apps/api"))).toBe(false);
		expect(read(root, "services/api/.env")).toBe("PORT=4000\n");
		expect(existsSync(resolve(root, "services/api/secrets/zitadel-api-key.json"))).toBe(true);
		expect(read(root, "services/api/Dockerfile")).toContain("docker build -t api services/api\n");
		expect(read(root, "infra/data/up.sh")).toBe(`#!/bin/sh
# Starts PostgreSQL, then applies every services/*/db/init.sql.
for file in ../../services/*/db/init.sql; do
  echo "data: applying \${file#../../}"
done
`);
		expect(read(root, "infra/data/docker-compose.yml")).toContain("apart from infra/auth-server.");
		// Git sees moves, not a deletion and a new file.
		expect(git(root, "status", "--porcelain")).toContain("R  apps/api/Cargo.toml -> services/api/Cargo.toml");

		const deploy = read(root, "deploy/docker-compose.yml");
		expect(deploy).toContain("dockerfile: apps/${WEB_APP:?Set WEB_APP in deploy/.env}/Dockerfile");
		expect(deploy).toContain("- ../infra/auth-server/brand:/brand:ro");
		expect(deploy).toContain("context: ../services/${API_APP:?Set API_APP in deploy/.env}");
		expect(deploy).toContain("context: ../services/api\n");

		// The local .env joins the auth stack; the changed brand file stays for the user.
		expect(read(root, "infra/auth-server/.env")).toBe("ZITADEL_VERSION=v4\n");
		expect(read(root, "infra/auth-server/brand/logo.svg")).toBe("<svg>upstream</svg>\n");
		expect(leftovers).toEqual(["apps/auth-server/brand/logo.svg"]);
		expect(existsSync(resolve(root, "apps/auth-server/.env"))).toBe(false);
	});

	test("moves the whole auth stack when infra/ has none yet, and changes nothing the second time", () => {
		const root = oldProject();
		rmSync(resolve(root, "infra"), { recursive: true });
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "no infra yet");

		expect(migrateLayout(root).moves.map((move) => move.to)).toEqual(["services/api", "infra/auth-server", "infra/data"]);
		expect(read(root, "infra/auth-server/.env")).toBe("ZITADEL_VERSION=v4\n");
		expect(read(root, "infra/auth-server/brand/logo.svg")).toBe("<svg>ours</svg>\n");
		expect(planLayoutMigration(root)).toEqual([]);

		const status = git(root, "status", "--porcelain");
		expect(migrateLayout(root)).toEqual({ moves: [], leftovers: [] });
		expect(git(root, "status", "--porcelain")).toBe(status);
	});

	test("refuses to move onto a project of the same name", () => {
		const root = oldProject();
		write(root, "services/api/Cargo.toml", "");
		expect(() => migrateLayout(root)).toThrow("Cannot move apps/api to services/api: services/api exists.");
	});

	test("doctor sends a project from before the change to --migrate", () => {
		const reports: string[] = [];
		checkLayout(oldProject(), (level, message) => reports.push(`${level} ${message}`));
		expect(reports).toContain("FAIL apps/api belongs in services/. Move it with `bun run project:update -- --migrate`.");
		expect(reports).toContain("FAIL apps/data belongs in infra/. Move it with `bun run project:update -- --migrate`.");
		expect(reports).toContain(
			"FAIL apps/auth-server is left from before the auth stack moved to infra/auth-server. Run `bun run project:update -- --migrate`.",
		);
		expect(reports.some((line) => line.includes("share a name"))).toBe(false);
	});

	test("project:update -- --migrate wants a clean tree, then moves", () => {
		const root = oldProject();
		const options = { apply: false, continueUpdate: false, migrate: true };
		write(root, "apps/web/package.json", '{"name":"web"}\n');
		expect(() => updateProject(root, options)).toThrow("Working tree must be clean");
		git(root, "checkout", "--", "apps/web/package.json");
		updateProject(root, options);
		expect(existsSync(resolve(root, "services/api/Cargo.toml"))).toBe(true);
	});
});
