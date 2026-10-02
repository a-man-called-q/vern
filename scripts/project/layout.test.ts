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

const INFRA_UP_SH = `#!/bin/sh
# Starts PostgreSQL, then applies every services/*/db/init.sql.
for file in ../../services/*/db/init.sql; do
  echo "data: applying \${file#../../}"
done
`;

/**
 * A project from the flat apps/, just after an update brought the auth stack
 * to deploy/dev/: its own API and data project are still in apps/, and
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
	write(root, "apps/data/README.md", "Applies `apps/*/db/init.sql` each time.\n");
	write(root, "apps/auth-server/brand/logo.svg", "<svg>ours</svg>\n");
	write(root, "deploy/dev/auth-server/docker-compose.yml", "services: {}\n");
	write(root, "deploy/dev/auth-server/brand/logo.svg", "<svg>upstream</svg>\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "old layout");
	// What Git does not track: local settings and keys.
	write(root, "apps/api/.env", "PORT=4000\n");
	write(root, "apps/api/secrets/zitadel-api-key.json", "{}\n");
	write(root, "apps/auth-server/.env", "ZITADEL_VERSION=v4\n");
	return root;
}

/**
 * A project with its stacks in infra/, just after an update by its old updater:
 * deploy/dev/auth-server, deploy/compose, and deploy/base came from upstream,
 * while the data project, the auth stack's local files, and the settings of
 * its deployments are where they were.
 */
function infraProject(authDomain = "auth.acme.test"): string {
	const root = mkdtempSync(join(tmpdir(), "vern-layout-"));
	roots.push(root);
	git(root, "init", "-q", "-b", "main");
	write(root, ".gitignore", ".env\nsecrets\nsettings.env\ngenerated\n.local\n");
	write(root, "apps/web/package.json", "{}\n");
	write(root, "services/api/Cargo.toml", '[package]\nname = "api"\n');
	write(root, "infra/data/docker-compose.yml", "# The data, apart from infra/auth-server.\nservices: {}\n");
	write(root, "infra/data/moon.yml", "tasks: {}\n");
	write(root, "infra/data/up.sh", INFRA_UP_SH);
	write(root, "infra/auth-server/brand/logo.svg", "<svg>ours</svg>\n");
	write(root, "deploy/dev/auth-server/docker-compose.yml", "services: {}\n");
	write(root, "deploy/dev/auth-server/brand/logo.svg", "<svg>upstream</svg>\n");
	write(root, "deploy/compose/docker-compose.yml", "services: {}\n");
	write(root, "deploy/base/kustomization.yaml", "resources:\n  - identity\n");
	write(root, "deploy/prod/kustomization.yaml", "namespace: vern\n");
	write(root, "deploy/docker-compose.yml", "services:\n  billing: {}\n");
	write(root, "deploy/k8s/base/kustomization.yaml", "resources:\n  - identity\n  - ../../../services/api/k8s\n");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "infra layout");
	write(root, "infra/data/.env", "PORT=5433\n");
	write(root, "infra/auth-server/.env", "ZITADEL_VERSION=v4\n");
	write(root, "deploy/.env", `AUTH_DOMAIN=${authDomain}\n`);
	write(root, "deploy/secrets/api-key.json", "{}\n");
	write(root, "deploy/.local/ca.pem", "ca\n");
	write(root, "deploy/k8s/overlays/production/settings.env", "DOMAIN=acme.test\n");
	write(root, "deploy/k8s/overlays/production/generated/secrets/zitadel.env", "ZITADEL_MASTERKEY=key\n");
	return root;
}

const read = (root: string, path: string) => readFileSync(resolve(root, path), "utf8");

const NEW_UP_SH = `#!/bin/sh
# Starts PostgreSQL, then applies every services/*/db/init.sql.
for file in ../../../services/*/db/init.sql; do
  echo "data: applying \${file#../../../}"
done
`;

describe("layout migration", () => {
	test("plans to move everything under apps/ that is not a web app", () => {
		expect(planLayoutMigration(oldProject())).toEqual([
			{ from: "apps/api", to: "services/api" },
			{ from: "apps/auth-server", to: "deploy/dev/auth-server" },
			{ from: "apps/data", to: "deploy/dev/data" },
		]);
	});

	test("moves the API and the data project with their local files, and fixes the paths in them", () => {
		const root = oldProject();
		const { moves, leftovers } = migrateLayout(root);

		expect(moves).toEqual([
			{ from: "apps/api", to: "services/api" },
			{ from: "apps/data", to: "deploy/dev/data" },
		]);
		expect(existsSync(resolve(root, "apps/api"))).toBe(false);
		expect(read(root, "services/api/.env")).toBe("PORT=4000\n");
		expect(existsSync(resolve(root, "services/api/secrets/zitadel-api-key.json"))).toBe(true);
		expect(read(root, "services/api/Dockerfile")).toContain("docker build -t api services/api\n");
		expect(read(root, "deploy/dev/data/up.sh")).toBe(NEW_UP_SH);
		expect(read(root, "deploy/dev/data/docker-compose.yml")).toContain("apart from deploy/dev/auth-server.");
		expect(read(root, "deploy/dev/data/README.md")).toBe("Applies `services/*/db/init.sql` each time.\n");
		// Git sees moves, not a deletion and a new file.
		expect(git(root, "status", "--porcelain")).toContain("R  apps/api/Cargo.toml -> services/api/Cargo.toml");

		// The local .env joins the auth stack; the changed brand file stays for the user.
		expect(read(root, "deploy/dev/auth-server/.env")).toBe("ZITADEL_VERSION=v4\n");
		expect(read(root, "deploy/dev/auth-server/brand/logo.svg")).toBe("<svg>upstream</svg>\n");
		expect(leftovers).toEqual(["apps/auth-server/brand/logo.svg"]);
		expect(existsSync(resolve(root, "apps/auth-server/.env"))).toBe(false);
	});

	test("moves the whole auth stack when deploy/dev/ has none yet, and changes nothing the second time", () => {
		const root = oldProject();
		rmSync(resolve(root, "deploy"), { recursive: true });
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "no deploy/dev yet");

		expect(migrateLayout(root).moves.map((move) => move.to)).toEqual([
			"services/api",
			"deploy/dev/auth-server",
			"deploy/dev/data",
		]);
		expect(read(root, "deploy/dev/auth-server/.env")).toBe("ZITADEL_VERSION=v4\n");
		expect(read(root, "deploy/dev/auth-server/brand/logo.svg")).toBe("<svg>ours</svg>\n");
		expect(planLayoutMigration(root)).toEqual([]);

		const status = git(root, "status", "--porcelain");
		expect(migrateLayout(root)).toEqual({ moves: [], leftovers: [] });
		expect(git(root, "status", "--porcelain")).toBe(status);
	});

	test("moves the stacks of infra/ to deploy/dev/, one level deeper", () => {
		const root = infraProject();
		const { moves, leftovers } = migrateLayout(root);

		expect(moves.slice(0, 1)).toEqual([{ from: "infra/data", to: "deploy/dev/data" }]);
		expect(read(root, "deploy/dev/data/up.sh")).toBe(NEW_UP_SH);
		expect(read(root, "deploy/dev/data/.env")).toBe("PORT=5433\n");
		expect(read(root, "deploy/dev/data/docker-compose.yml")).toContain("apart from deploy/dev/auth-server.");
		expect(git(root, "status", "--porcelain")).toContain("R  infra/data/moon.yml -> deploy/dev/data/moon.yml");

		expect(read(root, "deploy/dev/auth-server/.env")).toBe("ZITADEL_VERSION=v4\n");
		expect(read(root, "deploy/dev/auth-server/brand/logo.svg")).toBe("<svg>upstream</svg>\n");
		// What the project changed itself stays for its owner to carry over.
		expect(leftovers).toEqual(["deploy/docker-compose.yml", "infra/auth-server/brand/logo.svg"]);
	});

	test("moves a deployment's settings and Secrets to its environment", () => {
		const root = infraProject();
		const { moves } = migrateLayout(root);

		expect(moves.slice(1)).toEqual([
			{ from: "deploy/.env", to: "deploy/prod/.env" },
			{ from: "deploy/secrets", to: "deploy/prod/secrets" },
			{ from: "deploy/.local", to: "deploy/local/certs" },
			{ from: "deploy/k8s/overlays/production/settings.env", to: "deploy/prod/settings.env" },
			{ from: "deploy/k8s/overlays/production/generated", to: "deploy/prod/generated" },
		]);
		// The Compose file finds deploy/prod/secrets by DEPLOY_ENV.
		expect(read(root, "deploy/prod/.env")).toBe("AUTH_DOMAIN=auth.acme.test\nDEPLOY_ENV=prod\n");
		expect(read(root, "deploy/prod/secrets/api-key.json")).toBe("{}\n");
		expect(read(root, "deploy/prod/settings.env")).toBe("DOMAIN=acme.test\n");
		expect(read(root, "deploy/prod/generated/secrets/zitadel.env")).toBe("ZITADEL_MASTERKEY=key\n");
		// The list of apps `setup` wrote goes; setup writes deploy/base's.
		expect(existsSync(resolve(root, "deploy/k8s"))).toBe(false);
		expect(existsSync(resolve(root, "infra/data"))).toBe(false);

		const status = git(root, "status", "--porcelain");
		expect(migrateLayout(root).moves).toEqual([]);
		expect(git(root, "status", "--porcelain")).toBe(status);
	});

	test("a deploy/.env with localtest.me hostnames was the rehearsal on this machine", () => {
		const root = infraProject("auth.localtest.me");
		migrateLayout(root);
		expect(read(root, "deploy/local/.env")).toBe("AUTH_DOMAIN=auth.localtest.me\nDEPLOY_ENV=local\n");
		expect(existsSync(resolve(root, "deploy/local/secrets/api-key.json"))).toBe(true);
		expect(existsSync(resolve(root, "deploy/prod/.env"))).toBe(false);
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
		expect(reports).toContain("FAIL apps/data belongs in deploy/dev/. Move it with `bun run project:update -- --migrate`.");
		expect(reports).toContain(
			"FAIL apps/auth-server is left from before the auth stack moved to deploy/dev/auth-server. Run `bun run project:update -- --migrate`.",
		);
		expect(reports.some((line) => line.includes("share a name"))).toBe(false);
	});

	test("doctor names what a project with infra/ still has to move, and what it has to carry over", () => {
		const root = infraProject();
		const reports: string[] = [];
		checkLayout(root, (level, message) => reports.push(`${level} ${message}`));
		expect(reports).toContain("FAIL infra/data belongs in deploy/dev/. Move it with `bun run project:update -- --migrate`.");
		expect(reports).toContain("FAIL deploy/.env belongs in deploy/prod/. Move it with `bun run project:update -- --migrate`.");
		// Only what --migrate leaves behind is for the owner to carry over.
		expect(reports.filter((line) => line.includes("is left from the old deploy/ layout"))).toEqual([
			"FAIL deploy/docker-compose.yml is left from the old deploy/ layout. Carry your changes over to its new place (deploy/README.md), then delete it.",
		]);
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
