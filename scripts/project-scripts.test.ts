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
import {
	type ProjectConfig,
	readConfig,
	replaceIdentity,
	run,
} from "./project-utils";
import { renameProject } from "./rename-project";
import { updateProject } from "./update-project";

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
		'#!/bin/sh\nif [ "$1" = "upgrade" ] && [ "$2" = "--help" ]; then\n  echo \'Upgrade dependency version requirements\'\nfi\nif [ "$1" = "upgrade" ] && [ "$2" = "--manifest-path" ]; then\n  python3 -c \'import pathlib,sys; p=pathlib.Path(sys.argv[1]); s=p.read_text(); p.write_text(s.replace("async-trait = \\"0.1\\"", "async-trait = \\"0.2\\""))\' "$3"\nfi\nexit 0\n',
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
		expect(
			readFileSync(resolve(root, "scripts/check-ports.ts"), "utf8"),
		).toContain("'acme-platform'");
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

	test("refuses to rename a Compose project while its existing volumes are present", () => {
		const root = tempRoot("vern-compose-rename-test-");
		const base = initRepo(root, {
			"README.md": "# Vern\n",
			"apps/auth-server/docker-compose.yml":
				"name: vern-auth\nvolumes:\n  postgres-data:\n",
		});
		git(root, "update-ref", "refs/vern/upstream-main", base);
		const bin = tempRoot("vern-docker-test-");
		write(
			bin,
			"docker",
			'#!/bin/sh\nif [ "$1" = "volume" ]; then echo vern-auth_postgres-data; fi\nexit 0\n',
		);
		chmodSync(resolve(bin, "docker"), 0o755);
		process.env.PATH = bin + ":" + (originalPath ?? "");
		expect(() =>
			renameProject(root, { name: "Acme", slug: "acme", apply: true, base }),
		).toThrow("volumes still use the vern-auth prefix");
		expect(readFileSync(resolve(root, "README.md"), "utf8")).toBe("# Vern\n");
		expect(readConfig(root)).toBeUndefined();
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
			"apps/auth-server/moon.yml": "tasks: {}\n",
			"apps/auth-server/brand.txt": "Product Vern\nVariant baseline\n",
			"apps/auth-server/conflict.txt": "shared line\n",
			"packages/ui/token.txt": "color: violet\n",
			".templates/tanstack/package.json.tera":
				'{\n  "name": "{{ name | kebab_case }}",\n  "dependencies": {\n    "@acme/ui": "workspace:*",\n    "demo": "^1.0.0"\n  }\n}\n',
			".templates/next/package.json.tera":
				'{\n  "name": "{{ name | kebab_case }}",\n  "dependencies": {\n    "@acme/ui": "workspace:*",\n    "demo": "^1.0.0"\n  }\n}\n',
			".templates/axum/Cargo.toml.tera":
				'[package]\nname = "{{ name | kebab_case }}"\nversion = "0.1.0"\n\n[dependencies]\nasync-trait = "0.1"\n',
		});
		git(consumer, "clone", upstream, ".");
		git(consumer, "config", "user.name", "Vern Script Tests");
		git(consumer, "config", "user.email", "vern-tests@example.test");
		write(consumer, "README.md", "Project: Acme\nFeature: one\n");
		write(
			consumer,
			"apps/auth-server/brand.txt",
			"Product Acme\nVariant baseline\n",
		);
		write(consumer, "apps/auth-server/conflict.txt", "local line\n");
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
		write(consumer, "apps/service/moon.yml", "tasks: {}\n");
		write(
			consumer,
			"apps/service/Cargo.toml",
			'[package]\nname = "service"\nversion = "0.1.0"\n\n[dependencies]\nasync-trait = "0.1"\n',
		);
		write(
			consumer,
			"apps/service/src/main.rs",
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
			"apps/auth-server/brand.txt",
			"Product Vern\nVariant updated upstream\n",
		);
		write(upstream, "apps/auth-server/conflict.txt", "upstream line\n");
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
			readFileSync(resolve(consumer, "apps/auth-server/brand.txt"), "utf8"),
		).toBe("Product Acme\nVariant updated upstream\n");
		expect(readFileSync(resolve(consumer, "README.md"), "utf8")).toBe(
			"Project: Acme\nFeature: two\n",
		);
		expect(readFileSync(resolve(consumer, "docs/upstream.md"), "utf8")).toBe(
			"Added by Acme\n",
		);
		expect(
			readFileSync(resolve(consumer, "apps/auth-server/conflict.txt"), "utf8"),
		).toContain("<<<<<<<");
		expect(
			readFileSync(resolve(consumer, "apps/dashboard/src/main.ts"), "utf8"),
		).toBe("export const localSource = true;\n");
		expect(readStateForTest(consumer).phase).toBe("conflicts");

		write(
			consumer,
			"apps/auth-server/conflict.txt",
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
			readFileSync(resolve(consumer, "apps/service/src/main.rs"), "utf8"),
		).toBe('fn main() { println!("custom service source"); }\n');
		expect(
			readFileSync(resolve(consumer, "apps/service/Cargo.toml"), "utf8"),
		).toContain('async-trait = "0.2"');
		const tanstackTemplate = JSON.parse(
			readFileSync(
				resolve(consumer, ".templates/tanstack/package.json.tera"),
				"utf8",
			),
		);
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
		const rustTemplate = readFileSync(
			resolve(consumer, ".templates/axum/Cargo.toml.tera"),
			"utf8",
		);
		expect(rustTemplate).toContain('name = "{{ name | kebab_case }}"');
		expect(rustTemplate).toContain('async-trait = "0.2"');
		expect(readConfig(consumer)?.upstream.lastSyncedSha).toBe(target);
		expect(existsState(consumer)).toBe(false);
	});
});

function readStateForTest(root: string): { phase: string } {
	return JSON.parse(
		readFileSync(resolve(root, ".vern/update-state.json"), "utf8"),
	);
}

function existsState(root: string): boolean {
	return existsSync(resolve(root, ".vern/update-state.json"));
}
