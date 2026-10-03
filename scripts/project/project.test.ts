import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256 } from "../lib/files";
import { ROOT } from "../lib/paths";
import { run } from "../lib/run";
import { type ProjectConfig, readConfig } from "./config";
import { alignRouterWithStart } from "./dependencies";
import { rebrandText, replaceIdentity } from "./identity";
import { fitLogoText } from "./logo";
import { renderPackageTemplate } from "./package-template";
import { renameProject } from "./rename";
import { settleConflicts } from "./merge";
import { updateProject } from "./update";

const tempRoots: string[] = [];
const originalPath = process.env.PATH;

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(root);
	return root;
}

function git(root: string, ...args: string[]): string {
	return run("git", args, {
		cwd: root,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Vern Script Tests",
			GIT_AUTHOR_EMAIL: "vern-tests@example.test",
			GIT_COMMITTER_NAME: "Vern Script Tests",
			GIT_COMMITTER_EMAIL: "vern-tests@example.test",
		},
	}).stdout.trim();
}

function write(root: string, path: string, contents: string): void {
	const absolute = resolve(root, path);
	mkdirSync(resolve(absolute, ".."), { recursive: true });
	writeFileSync(absolute, contents);
}

function commitAll(root: string, message: string): string {
	git(root, "add", "-A");
	git(root, "commit", "-m", message);
	return git(root, "rev-parse", "HEAD");
}

function initRepo(root: string, files: Record<string, string>): string {
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "Vern Script Tests");
	git(root, "config", "user.email", "vern-tests@example.test");
	for (const [path, contents] of Object.entries(files))
		write(root, path, contents);
	return commitAll(root, "initial template");
}

function installFakeCommands(): void {
	const bin = tempRoot("vern-fake-bin-");
	mkdirSync(bin, { recursive: true });
	write(
		bin,
		"cargo",
		'#!/bin/sh\nif [ "$1" = "upgrade" ] && [ "$2" = "--help" ]; then\n  echo \'Upgrade dependency version requirements\'\nfi\nif [ "$1" = "upgrade" ] && [ "$2" = "--manifest-path" ]; then\n  if grep -q \'{%\' "$3"; then echo "Tera markers are not TOML" >&2; exit 1; fi\n  python3 -c \'import pathlib,sys; p=pathlib.Path(sys.argv[1]); s=p.read_text(); p.write_text(s.replace("async-trait = \\"0.1\\"", "async-trait = \\"0.2\\"").replace("sqlx = \\"0.8\\"", "sqlx = \\"0.9\\"").replace("async-nats = \\"0.50\\"", "async-nats = \\"0.51\\"").replace("uuid = \\"1\\"", "uuid = \\"2\\""))\' "$3"\nfi\nexit 0\n',
	);
	write(
		bin,
		"bun",
		'#!/bin/sh\nif [ "$1" = "update" ] && [ "$2" = "--latest" ] && [ "$3" = "--recursive" ] && [ -f apps/dashboard/package.json ]; then\n  python3 -c \'import json; p="apps/dashboard/package.json"; d=json.load(open(p)); d["dependencies"]["demo"]="^2.0.0"; json.dump(d,open(p,"w"))\'\nfi\nif [ "$1" = "update" ] && [ "$2" = "--latest" ] && [ -f package.json ] && [ "$3" != "--recursive" ]; then\n  python3 -c \'import json; p="package.json"; d=json.load(open(p)); d["dependencies"]["demo"]="^3.0.0"; json.dump(d,open(p,"w"))\'\nfi\nexit 0\n',
	);
	write(bin, "moon", "#!/bin/sh\nexit 0\n");
	for (const command of ["cargo", "bun", "moon"])
		chmodSync(resolve(bin, command), 0o755);
	process.env.PATH = bin + ":" + (originalPath ?? "");
}

/**
 * Puts a fake `docker` first on PATH. `docker volume ls` prints `volume`, and
 * `docker ps -aq` prints `container`; every call is appended to the returned log.
 */
function installFakeDocker(volume: string, container = ""): string {
	const bin = tempRoot("vern-docker-test-");
	const log = resolve(bin, "docker.log");
	write(
		bin,
		"docker",
		'#!/bin/sh\necho "$@" >> "' +
			log +
			'"\nif [ "$1" = "volume" ]; then echo "' +
			volume +
			'"; fi\nif [ "$1" = "ps" ]; then echo "' +
			container +
			'"; fi\nexit 0\n',
	);
	chmodSync(resolve(bin, "docker"), 0o755);
	process.env.PATH = bin + ":" + (originalPath ?? "");
	return log;
}

afterEach(() => {
	process.env.PATH = originalPath;
	process.exitCode = 0;
	for (const root of tempRoots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("rename-project", () => {
	test("previews, renames textual brand references, preserves environment and upstream URL, and is repeatable", () => {
		const root = tempRoot("vern-rename-test-");
		const base = initRepo(root, {
			".gitignore": ".env\n.vern/update-state.json\n",
			".env.example": "ZITADEL_ORG_NAME=Vern\n",
			"README.md":
				"# Vern\n\nUse @vern/ui and --vern-primary in vern-auth.\nConfig: .vern/config.json\nhttps://github.com/a-man-called-q/vern.git\n",
			"package.json": '{"name":"vern","private":true}\n',
			"packages/ui/package.json": '{"name":"@vern/ui"}\n',
			"apps/demo/src/index.ts": "console.log('Vern');\n",
			"scripts/check-ports.ts": "const label = 'vern';\n",
		});
		git(root, "update-ref", "refs/vern/upstream-main", base);
		write(root, ".env", "LOCAL_SECRET=keep-this\n");

		const preview = renameProject(root, {
			name: "Acme Platform",
			slug: "acme-platform",
			apply: false,
			base,
		});
		expect(preview).toContain("README.md");
		expect(readFileSync(resolve(root, "README.md"), "utf8")).toContain(
			"# Vern",
		);
		expect(readConfig(root)).toBeUndefined();

		renameProject(root, {
			name: "Acme Platform",
			slug: "acme-platform",
			apply: true,
			base,
		});
		const readme = readFileSync(resolve(root, "README.md"), "utf8");
		expect(readme).toContain("# Acme Platform");
		expect(readme).toContain("@acme-platform/ui");
		expect(readme).toContain("--acme-platform-primary");
		expect(readme).toContain("in acme-platform-auth");
		expect(readme).toContain(".vern/config.json");
		expect(readme).toContain("https://github.com/a-man-called-q/vern.git");
		expect(
			JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name,
		).toBe("acme-platform");
		expect(
			JSON.parse(
				readFileSync(resolve(root, "packages/ui/package.json"), "utf8"),
			).name,
		).toBe("@acme-platform/ui");
		expect(readFileSync(resolve(root, ".env"), "utf8")).toBe(
			"LOCAL_SECRET=keep-this\n",
		);
		expect(readFileSync(resolve(root, ".gitignore"), "utf8")).toContain(
			".vern/update-state.json",
		);
		// Scripts are Vern's tooling: a rename leaves them as they are.
		expect(
			readFileSync(resolve(root, "scripts/check-ports.ts"), "utf8"),
		).toBe("const label = 'vern';\n");
		expect(readConfig(root)).toEqual({
			schemaVersion: 1,
			project: { name: "Acme Platform", slug: "acme-platform" },
			upstream: {
				url: "https://github.com/a-man-called-q/vern.git",
				branch: "main",
				lastSyncedSha: base,
			},
		});
		expect(
			renameProject(root, {
				name: "Acme Platform",
				slug: "acme-platform",
				apply: true,
			}),
		).toEqual([]);
	});

	test("a second rename keeps how the environments run", () => {
		const root = tempRoot("vern-rename-environments-");
		const sha = initRepo(root, { "README.md": "# Vern\n" });
		git(root, "update-ref", "refs/vern/upstream-main", sha);
		renameProject(root, { name: "Acme", slug: "acme", apply: true, base: sha });
		const config = readConfig(root) as ProjectConfig;
		write(root, ".vern/config.json", JSON.stringify({ ...config, environments: { local: "none", staging: "none", prod: "compose" } }));
		commitAll(root, "acme");
		renameProject(root, { name: "Acme Board", slug: "acme-board", apply: true });
		expect(readConfig(root)).toMatchObject({
			project: { name: "Acme Board", slug: "acme-board" },
			upstream: { lastSyncedSha: sha },
			environments: { local: "none", staging: "none", prod: "compose" },
		});
	});

	test("refuses to rename a Compose project while its existing volumes are present", () => {
		const root = tempRoot("vern-compose-rename-test-");
		const base = initRepo(root, {
			".gitignore": ".env\n",
			"README.md": "# Vern\n",
			"deploy/dev/auth-server/docker-compose.yml":
				"name: vern-auth\nvolumes:\n  postgres-data:\n",
		});
		git(root, "update-ref", "refs/vern/upstream-main", base);
		// The checkout has started its stack: it has an .env, so the volumes are its own.
		write(root, "deploy/dev/auth-server/.env", "ZITADEL_VERSION=v1\n");
		installFakeDocker("vern-auth_postgres-data");
		expect(() =>
			renameProject(root, { name: "Acme", slug: "acme", apply: true, base }),
		).toThrow("volumes still use the vern-auth prefix");
		expect(readFileSync(resolve(root, "README.md"), "utf8")).toBe("# Vern\n");
		expect(readConfig(root)).toBeUndefined();
	});

	test("renames a fresh copy even when another checkout's volumes and containers exist", () => {
		const root = tempRoot("vern-fresh-copy-rename-test-");
		const base = initRepo(root, {
			"README.md": "# Vern\n",
			"deploy/dev/auth-server/docker-compose.yml":
				"name: vern-auth\nvolumes:\n  postgres-data:\n",
		});
		git(root, "update-ref", "refs/vern/upstream-main", base);
		// No deploy/dev/auth-server/.env: this copy never started anything. The fake Docker
		// reports another checkout's volume and a running container, and logs any call.
		const log = installFakeDocker("vern-auth_postgres-data", "abc123");
		renameProject(root, { name: "Acme", slug: "acme", apply: true, base });
		expect(readFileSync(resolve(root, "README.md"), "utf8")).toBe(
			"# Acme\n",
		);
		expect(readConfig(root)?.project).toEqual({ name: "Acme", slug: "acme" });
		expect(existsSync(log)).toBe(false);
	});

	test("still refuses a running Compose project in a checkout that has an .env", () => {
		const root = tempRoot("vern-running-rename-test-");
		const base = initRepo(root, {
			".gitignore": ".env\n",
			"README.md": "# Vern\n",
			"deploy/dev/auth-server/docker-compose.yml": "name: vern-auth\n",
		});
		git(root, "update-ref", "refs/vern/upstream-main", base);
		write(root, "deploy/dev/auth-server/.env", "ZITADEL_VERSION=v1\n");
		installFakeDocker("", "abc123");
		expect(() =>
			renameProject(root, { name: "Acme", slug: "acme", apply: true, base }),
		).toThrow("Docker Compose project vern-auth is running");
	});

	test("rebrands case-aware tokens without changing URLs", () => {
		expect(
			replaceIdentity(
				"Vern VERN vern @vern/ui vern-auth --vern-primary https://example.com/vern",
				{ name: "Vern", slug: "vern" },
				{ name: "Acme", slug: "acme" },
			),
		).toBe(
			"Acme ACME acme @acme/ui acme-auth --acme-primary https://example.com/vern",
		);
	});

	test("does not substitute twice when the new identity contains the old one", () => {
		expect(
			replaceIdentity(
				"Vern VERN vern @vern/ui vern-auth --vern-primary https://example.com/vern .vern/config.json",
				{ name: "Vern", slug: "vern" },
				{ name: "Testing Vern Aja", slug: "testing-vern-aja" },
			),
		).toBe(
			"Testing Vern Aja TESTING-VERN-AJA testing-vern-aja @testing-vern-aja/ui testing-vern-aja-auth --testing-vern-aja-primary https://example.com/vern .vern/config.json",
		);
	});

	test("renames to a name that contains vern without corrupting the project", () => {
		const root = tempRoot("vern-contains-vern-rename-test-");
		const base = initRepo(root, {
			"README.md": "# Vern\n\nUse @vern/ui in vern-auth.\n",
			"package.json": '{"name":"vern","private":true}\n',
			"packages/ui/package.json": '{"name":"@vern/ui"}\n',
			"deploy/dev/auth-server/docker-compose.yml":
				"name: vern-auth\nnetworks:\n  auth:\n    name: ${AUTH_NETWORK_NAME:-vern-auth}\n",
		});
		git(root, "update-ref", "refs/vern/upstream-main", base);
		renameProject(root, {
			name: "Testing Vern Aja",
			slug: "testing-vern-aja",
			apply: true,
			base,
		});
		expect(readFileSync(resolve(root, "README.md"), "utf8")).toBe(
			"# Testing Vern Aja\n\nUse @testing-vern-aja/ui in testing-vern-aja-auth.\n",
		);
		expect(
			JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).name,
		).toBe("testing-vern-aja");
		expect(
			JSON.parse(readFileSync(resolve(root, "packages/ui/package.json"), "utf8"))
				.name,
		).toBe("@testing-vern-aja/ui");
		const compose = readFileSync(
			resolve(root, "deploy/dev/auth-server/docker-compose.yml"),
			"utf8",
		);
		expect(compose).toContain("name: testing-vern-aja-auth\n");
		expect(compose).toContain("${AUTH_NETWORK_NAME:-testing-vern-aja-auth}");
		expect(compose).not.toContain("testing-testing");
		// Renaming again to the same identity changes nothing.
		expect(
			renameProject(root, {
				name: "Testing Vern Aja",
				slug: "testing-vern-aja",
				apply: true,
			}),
		).toEqual([]);
	});

	describe("logo text", () => {
		const logoPath = "deploy/dev/auth-server/brand/logo-light.svg";
		const shipped = readFileSync(resolve(ROOT, logoPath), "utf8");
		// The template's logo, written out here: the shipped one carries the
		// project's own name once the project is renamed.
		const logo =
			'<svg xmlns="http://www.w3.org/2000/svg" width="250" height="64" viewBox="0 0 250 64">\n' +
			'  <text x="78" y="43" fill="#172033" font-family="Inter,Arial,sans-serif" font-size="38" font-weight="700" letter-spacing="-1.2">vern</text>\n' +
			"</svg>\n";
		const vern = { name: "Vern", slug: "vern" };
		const textTag = (svg: string) => svg.match(/<text\b[^>]*>[^<]*<\/text>/)?.[0];

		test("leaves the shipped logo untouched", () => {
			expect(fitLogoText(shipped)).toBe(shipped);
			expect(fitLogoText(logo)).toBe(logo);
		});

		test("keeps the size for a name that fits", () => {
			const renamed = rebrandText(logoPath, logo, vern, { name: "Acme", slug: "acme" });
			expect(textTag(renamed)).toContain('font-size="38"');
			expect(textTag(renamed)).not.toContain("textLength");
		});

		test("shrinks and pins a long name inside the box", () => {
			const renamed = rebrandText(logoPath, logo, vern, {
				name: "Testing Vern Aja",
				slug: "testing-vern-aja",
			});
			const tag = textTag(renamed) ?? "";
			expect(tag).toContain(">testing-vern-aja</text>");
			expect(tag).toContain('textLength="166"');
			expect(tag).toContain('lengthAdjust="spacingAndGlyphs"');
			expect(Number(tag.match(/font-size="([\d.]+)"/)?.[1])).toBeLessThan(38);
		});

		test("restores the size when renamed back to a short name", () => {
			const long = { name: "Testing Vern Aja", slug: "testing-vern-aja" };
			const longLogo = rebrandText(logoPath, logo, vern, long);
			const shortLogo = rebrandText(logoPath, longLogo, long, { name: "Q", slug: "q" });
			expect(textTag(shortLogo)).toBe(textTag(logo)?.replace(">vern<", ">q<"));
		});

		test("only touches the logos of the login shell", () => {
			const other = rebrandText("apps/web/logo.svg", logo, vern, {
				name: "Testing Vern Aja",
				slug: "testing-vern-aja",
			});
			expect(textTag(other)).not.toContain("textLength");
		});
	});

	test("keeps container image references", () => {
		expect(
			replaceIdentity(
				"ZITADEL_LOGIN_IMAGE=ghcr.io/a-man-called-q/vern-zitadel-login:v4.19.3-abc\nVern login",
				{ name: "Vern", slug: "vern" },
				{ name: "Acme", slug: "acme" },
			),
		).toBe(
			"ZITADEL_LOGIN_IMAGE=ghcr.io/a-man-called-q/vern-zitadel-login:v4.19.3-abc\nAcme login",
		);
	});
});

describe("update-project", () => {
	test("merges upstream files, stops on conflicts, then continues while preserving generated source", () => {
		const upstream = tempRoot("vern-upstream-test-");
		const consumer = tempRoot("vern-consumer-test-");
		const base = initRepo(upstream, {
			".gitignore": ".vern/update-state.json\n",
			"README.md": "Project: Vern\nFeature: one\n",
			"deploy/dev/auth-server/moon.yml": "tasks: {}\n",
			"deploy/dev/auth-server/brand.txt": "Product Vern\nVariant baseline\n",
			"deploy/dev/auth-server/conflict.txt": "shared line\n",
			"packages/ui/token.txt": "color: violet\n",
			".templates/tanstack/package.json.tera":
				'{\n  "name": "{{ name | kebab_case }}",\n  "dependencies": {\n{% if include_demos %}    "chart": "^1.0.0",\n{% endif %}    "@acme/ui": "workspace:*",\n    "demo": "^1.0.0"\n  }\n}\n',
			".templates/next/package.json.tera":
				'{\n  "name": "{{ name | kebab_case }}",\n  "dependencies": {\n    "@acme/ui": "workspace:*",\n    "demo": "^1.0.0"\n  }\n}\n',
			"Cargo.toml":
				'[workspace]\nmembers = ["crates/*", "services/*"]\n\n[workspace.dependencies]\nasync-trait = "0.1"\nsqlx = "0.8"\n',
			".templates/axum/Cargo.toml.tera":
				'[package]\nname = "{{ name | kebab_case }}"\nversion.workspace = true\n\n[dependencies]\nasync-trait = { workspace = true }\n{% if database %}sqlx = { workspace = true }\n{% endif %}',
		});
		git(consumer, "clone", upstream, ".");
		git(consumer, "config", "user.name", "Vern Script Tests");
		git(consumer, "config", "user.email", "vern-tests@example.test");
		write(consumer, "README.md", "Project: Acme\nFeature: one\n");
		write(
			consumer,
			"deploy/dev/auth-server/brand.txt",
			"Product Acme\nVariant baseline\n",
		);
		write(consumer, "deploy/dev/auth-server/conflict.txt", "local line\n");
		write(consumer, "apps/dashboard/moon.yml", "tasks: {}\n");
		write(
			consumer,
			"apps/dashboard/src/main.ts",
			"export const localSource = true;\n",
		);
		write(
			consumer,
			"apps/dashboard/package.json",
			'{"name":"dashboard","dependencies":{"demo":"^1.0.0"}}\n',
		);
		write(consumer, "services/service/moon.yml", "tasks: {}\n");
		write(
			consumer,
			"services/service/Cargo.toml",
			'[package]\nname = "service"\nversion.workspace = true\n\n[dependencies]\nasync-trait = { workspace = true }\n',
		);
		write(
			consumer,
			"services/service/src/main.rs",
			'fn main() { println!("custom service source"); }\n',
		);
		write(
			consumer,
			".vern/config.json",
			JSON.stringify(
				{
					schemaVersion: 1,
					project: { name: "Acme", slug: "acme" },
					upstream: { url: upstream, branch: "main", lastSyncedSha: base },
				} satisfies ProjectConfig,
				null,
				2,
			) + "\n",
		);
		commitAll(consumer, "local project setup");

		write(upstream, "README.md", "Project: Vern\nFeature: two\n");
		write(
			upstream,
			"deploy/dev/auth-server/brand.txt",
			"Product Vern\nVariant updated upstream\n",
		);
		write(upstream, "deploy/dev/auth-server/conflict.txt", "upstream line\n");
		write(upstream, "docs/upstream.md", "Added by Vern\n");
		const target = commitAll(upstream, "update template");
		installFakeCommands();
		const initialStatus = git(consumer, "status", "--porcelain");
		updateProject(consumer, { apply: false, continueUpdate: false });
		expect(git(consumer, "status", "--porcelain")).toBe(initialStatus);
		expect(git(consumer, "branch", "--show-current")).toBe("main");

		updateProject(consumer, { apply: true, continueUpdate: false });
		expect(git(consumer, "branch", "--show-current")).toBe(
			"vern/update-" + target.slice(0, 8),
		);
		expect(
			readFileSync(resolve(consumer, "deploy/dev/auth-server/brand.txt"), "utf8"),
		).toBe("Product Acme\nVariant updated upstream\n");
		expect(readFileSync(resolve(consumer, "README.md"), "utf8")).toBe(
			"Project: Acme\nFeature: two\n",
		);
		expect(readFileSync(resolve(consumer, "docs/upstream.md"), "utf8")).toBe(
			"Added by Acme\n",
		);
		expect(
			readFileSync(resolve(consumer, "deploy/dev/auth-server/conflict.txt"), "utf8"),
		).toContain("<<<<<<<");
		expect(
			readFileSync(resolve(consumer, "apps/dashboard/src/main.ts"), "utf8"),
		).toBe("export const localSource = true;\n");
		expect(readStateForTest(consumer).phase).toBe("conflicts");

		write(
			consumer,
			"deploy/dev/auth-server/conflict.txt",
			"manually resolved line\n",
		);
		updateProject(consumer, { apply: false, continueUpdate: true });
		expect(
			readFileSync(resolve(consumer, "apps/dashboard/src/main.ts"), "utf8"),
		).toBe("export const localSource = true;\n");
		expect(
			JSON.parse(
				readFileSync(resolve(consumer, "apps/dashboard/package.json"), "utf8"),
			).dependencies.demo,
		).toBe("^2.0.0");
		expect(
			readFileSync(resolve(consumer, "services/service/src/main.rs"), "utf8"),
		).toBe('fn main() { println!("custom service source"); }\n');
		// One upgrade of the Cargo workspace covers the APIs and the crates: the
		// versions are in the root manifest, and the API's own names them.
		expect(readFileSync(resolve(consumer, "Cargo.toml"), "utf8")).toContain(
			'async-trait = "0.2"\nsqlx = "0.9"\n',
		);
		expect(
			readFileSync(resolve(consumer, "services/service/Cargo.toml"), "utf8"),
		).toContain("async-trait = { workspace = true }");
		const tanstackTemplateText = readFileSync(
			resolve(consumer, ".templates/tanstack/package.json.tera"),
			"utf8",
		);
		// The demo-only dependency keeps its conditional block.
		expect(tanstackTemplateText).toContain(
			'{% if include_demos %}    "chart": "^1.0.0",\n{% endif %}    "demo": "^3.0.0",',
		);
		const tanstackTemplate = JSON.parse(
			renderPackageTemplate(tanstackTemplateText, false),
		);
		expect(tanstackTemplate.dependencies.chart).toBeUndefined();
		expect(tanstackTemplate.name).toBe("{{ name | kebab_case }}");
		expect(tanstackTemplate.dependencies["@acme/ui"]).toBe("workspace:*");
		expect(tanstackTemplate.dependencies.demo).toBe("^3.0.0");
		const nextTemplate = JSON.parse(
			readFileSync(
				resolve(consumer, ".templates/next/package.json.tera"),
				"utf8",
			),
		);
		expect(nextTemplate.name).toBe("{{ name | kebab_case }}");
		expect(nextTemplate.dependencies["@acme/ui"]).toBe("workspace:*");
		expect(nextTemplate.dependencies.demo).toBe("^3.0.0");
		// The Axum template has no versions to upgrade.
		expect(
			readFileSync(
				resolve(consumer, ".templates/axum/Cargo.toml.tera"),
				"utf8",
			),
		).toBe(
			'[package]\nname = "{{ name | kebab_case }}"\nversion.workspace = true\n\n[dependencies]\nasync-trait = { workspace = true }\n{% if database %}sqlx = { workspace = true }\n{% endif %}',
		);
		expect(readConfig(consumer)?.upstream.lastSyncedSha).toBe(target);
		expect(existsState(consumer)).toBe(false);
	});
});

describe("update-project and scripts", () => {
	/** A consumer whose scripts an older rename rebranded, and an upstream that changed them. */
	function renamedConsumer() {
		const upstream = tempRoot("vern-upstream-scripts-");
		const consumer = tempRoot("vern-consumer-scripts-");
		const base = initRepo(upstream, {
			"README.md": "Project: Vern\n",
			"scripts/setup.ts": 'const fallback = "Vern";\nexport const steps = 1;\n',
			"scripts/zitadel-smtp.ts": 'const DESCRIPTION = "Vern";\n',
			"scripts/custom.ts": 'const name = "Vern";\n',
		});
		git(consumer, "clone", upstream, ".");
		git(consumer, "config", "user.name", "Vern Script Tests");
		git(consumer, "config", "user.email", "vern-tests@example.test");
		// What an older rename wrote: every script rebranded.
		write(consumer, "README.md", "Project: Acme\n");
		write(consumer, "scripts/setup.ts", 'const fallback = "Acme";\nexport const steps = 1;\n');
		write(consumer, "scripts/zitadel-smtp.ts", 'const DESCRIPTION = "Acme";\n');
		// A script the project changed itself.
		write(consumer, "scripts/custom.ts", 'const name = "Acme";\nconst mine = true;\n');
		write(
			consumer,
			".vern/config.json",
			JSON.stringify(
				{
					schemaVersion: 1,
					project: { name: "Acme", slug: "acme" },
					upstream: { url: upstream, branch: "main", lastSyncedSha: base },
				} satisfies ProjectConfig,
				null,
				2,
			) + "\n",
		);
		commitAll(consumer, "renamed by an older rename");

		write(upstream, "scripts/setup.ts", 'const fallback = "Vern";\nexport const steps = 2;\n');
		rmSync(resolve(upstream, "scripts/zitadel-smtp.ts"));
		write(upstream, "scripts/custom.ts", 'const name = "Vern";\nconst theirs = true;\n');
		const target = commitAll(upstream, "move the scripts");
		return { upstream, consumer, base, target };
	}

	test("takes upstream's scripts over copies a rename only rebranded", () => {
		const { consumer } = renamedConsumer();
		installFakeCommands();
		updateProject(consumer, { apply: true, continueUpdate: false });
		expect(readFileSync(resolve(consumer, "scripts/setup.ts"), "utf8")).toBe(
			'const fallback = "Vern";\nexport const steps = 2;\n',
		);
		expect(existsSync(resolve(consumer, "scripts/zitadel-smtp.ts"))).toBe(false);
		// A real local change still meets upstream's in a conflict.
		expect(readFileSync(resolve(consumer, "scripts/custom.ts"), "utf8")).toContain("<<<<<<<");
		expect(readStateForTest(consumer).phase).toBe("conflicts");
	});

	test("settles the conflicts an older updater left on such copies", () => {
		const { consumer, base, target } = renamedConsumer();
		git(consumer, "fetch", "origin", "main");
		// What an older updater left: markers in one script, the other kept.
		const markers = "<<<<<<< ours\nconst fallback = \"Acme\";\n=======\nconst fallback = \"Vern\";\n>>>>>>> theirs\n";
		write(consumer, "scripts/setup.ts", markers);
		const smtp = readFileSync(resolve(consumer, "scripts/zitadel-smtp.ts"));
		const conflicts = [
			{ path: "scripts/setup.ts", initialHash: sha256(markers) },
			{ path: "scripts/zitadel-smtp.ts", initialHash: sha256(smtp) },
			{ path: "README.md", initialHash: "changed-by-the-user" },
		];
		const config = readConfig(consumer) as ProjectConfig;
		const { remaining, settled } = settleConflicts(consumer, config, base, target, conflicts);
		expect(settled).toEqual(["scripts/setup.ts", "scripts/zitadel-smtp.ts"]);
		expect(remaining.map((conflict) => conflict.path)).toEqual(["README.md"]);
		expect(readFileSync(resolve(consumer, "scripts/setup.ts"), "utf8")).toBe(
			'const fallback = "Vern";\nexport const steps = 2;\n',
		);
		expect(existsSync(resolve(consumer, "scripts/zitadel-smtp.ts"))).toBe(false);
	});
});

describe("update-project and a merge that goes wrong", () => {
	/** An upstream with `files`, and a project cloned from it and renamed to Acme. */
	function clonedConsumer(files: Record<string, string>) {
		const upstream = tempRoot("vern-upstream-merge-");
		const consumer = tempRoot("vern-consumer-merge-");
		const base = initRepo(upstream, { ".gitignore": ".vern/update-state.json\n", ...files });
		git(consumer, "clone", upstream, ".");
		git(consumer, "config", "user.name", "Vern Script Tests");
		git(consumer, "config", "user.email", "vern-tests@example.test");
		write(
			consumer,
			".vern/config.json",
			JSON.stringify(
				{
					schemaVersion: 1,
					project: { name: "Acme", slug: "acme" },
					upstream: { url: upstream, branch: "main", lastSyncedSha: base },
				} satisfies ProjectConfig,
				null,
				2,
			) + "\n",
		);
		return { upstream, consumer };
	}

	test("lists a file that conflicts in two places as one conflict", () => {
		const lines = (first: string, last: string) =>
			[first, "two", "three", "four", "five", "six", "seven", "eight", last].join("\n") + "\n";
		const { upstream, consumer } = clonedConsumer({ "workflow.yml": lines("one", "nine") });
		write(consumer, "workflow.yml", lines("local one", "local nine"));
		commitAll(consumer, "local changes");
		write(upstream, "workflow.yml", lines("upstream one", "upstream nine"));
		commitAll(upstream, "update template");
		installFakeCommands();

		updateProject(consumer, { apply: true, continueUpdate: false });
		const merged = readFileSync(resolve(consumer, "workflow.yml"), "utf8");
		expect(merged.match(/^<<<<<<< /gm)).toHaveLength(2);
		const state = readStateForTest(consumer);
		expect(state.phase).toBe("conflicts");
		expect(state.conflicts.map((conflict) => conflict.path)).toEqual(["workflow.yml"]);
		expect(() => updateProject(consumer, { apply: false, continueUpdate: true })).toThrow(
			"Resolve these conflicts, then rerun --continue: workflow.yml",
		);

		write(consumer, "workflow.yml", lines("resolved one", "resolved nine"));
		updateProject(consumer, { apply: false, continueUpdate: true });
		expect(existsState(consumer)).toBe(false);
	});

	test("undoes the review branch when the merge fails", () => {
		const { upstream, consumer } = clonedConsumer({ "README.md": "Project: Vern\n" });
		// Upstream adds a file where the project has a folder: it cannot be written.
		write(consumer, "docs/guide.md/note.txt", "local\n");
		const head = commitAll(consumer, "local changes");
		write(upstream, "added.txt", "written before the failure\n");
		write(upstream, "docs/guide.md", "Added by Vern\n");
		const target = commitAll(upstream, "update template");
		installFakeCommands();

		expect(() => updateProject(consumer, { apply: true, continueUpdate: false })).toThrow(
			"The update was undone: the project is back on main as it was.",
		);
		expect(git(consumer, "branch", "--show-current")).toBe("main");
		expect(git(consumer, "rev-parse", "HEAD")).toBe(head);
		expect(git(consumer, "status", "--porcelain")).toBe("");
		expect(git(consumer, "branch", "--list", "vern/update-" + target.slice(0, 8))).toBe("");
		expect(existsSync(resolve(consumer, "added.txt"))).toBe(false);
		expect(existsState(consumer)).toBe(false);
	});
});

function readStateForTest(root: string): { phase: string; conflicts: { path: string }[] } {
	return JSON.parse(
		readFileSync(resolve(root, ".vern/update-state.json"), "utf8"),
	);
}

function existsState(root: string): boolean {
	return existsSync(resolve(root, ".vern/update-state.json"));
}

describe("alignRouterWithStart", () => {
	function app(start: string | undefined, router: string) {
		const root = tempRoot("vern-router-align-test-");
		const dependencies: Record<string, string> = {
			"@tanstack/react-router": router,
			react: "^19.0.0",
		};
		if (start) dependencies["@tanstack/react-start"] = start;
		write(
			root,
			"package.json",
			`${JSON.stringify({ name: "web", dependencies }, null, 2)}\n`,
		);
		return root;
	}

	function installStart(root: string, router: string) {
		write(
			root,
			"node_modules/@tanstack/react-start/package.json",
			JSON.stringify({
				name: "@tanstack/react-start",
				dependencies: { "@tanstack/react-router": router },
			}),
		);
	}

	const routerOf = (root: string) =>
		JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
			.dependencies["@tanstack/react-router"];

	test("sets the router to the exact version react-start uses", () => {
		const root = app("1.2.0", "1.9.0");
		installStart(root, "1.1.5");
		expect(alignRouterWithStart(resolve(root, "package.json"), [root])).toBe(true);
		expect(routerOf(root)).toBe("1.1.5");
		expect(readFileSync(resolve(root, "package.json"), "utf8")).toContain(
			'    "react": "^19.0.0"',
		);
	});

	test("changes nothing when they already agree", () => {
		const root = app("1.2.0", "1.1.5");
		installStart(root, "1.1.5");
		expect(alignRouterWithStart(resolve(root, "package.json"), [root])).toBe(false);
	});

	test("finds react-start in a later search root", () => {
		const root = app("1.2.0", "1.9.0");
		const workspace = tempRoot("vern-router-align-root-");
		installStart(workspace, "1.1.5");
		expect(
			alignRouterWithStart(resolve(root, "package.json"), [root, workspace]),
		).toBe(true);
		expect(routerOf(root)).toBe("1.1.5");
	});

	test("leaves apps without react-start or without an install alone", () => {
		const plain = app(undefined, "1.9.0");
		installStart(plain, "1.1.5");
		expect(alignRouterWithStart(resolve(plain, "package.json"), [plain])).toBe(false);
		const notInstalled = app("1.2.0", "1.9.0");
		expect(
			alignRouterWithStart(resolve(notInstalled, "package.json"), [notInstalled]),
		).toBe(false);
		expect(routerOf(notInstalled)).toBe("1.9.0");
	});
});
