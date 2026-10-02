import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findApps, listProjects, projectPath, rootFor } from "./projects";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "vern-projects-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(resolve(root, path)), { recursive: true });
		writeFileSync(resolve(root, path), content);
	}
	return root;
}

describe("projects", () => {
	const files = {
		"apps/web/package.json": "{}",
		"apps/web/.env.example": "PORT=3000\nZITADEL_CLIENT_ID=\n",
		"services/api/Cargo.toml": "",
		"services/api/.env.example": "PORT=4000\nZITADEL_API_KEY_FILE=./secrets/key.json\n",
		"infra/auth-server/docker-compose.yml": "",
		"infra/data/docker-compose.yml": "",
	};

	test("lists every folder of the three roots by name", () => {
		expect(listProjects(workspace(files))).toEqual([
			{ name: "api", path: "services/api", root: "services" },
			{ name: "auth-server", path: "infra/auth-server", root: "infra" },
			{ name: "data", path: "infra/data", root: "infra" },
			{ name: "web", path: "apps/web", root: "apps" },
		]);
	});

	test("finds a project by name, wherever it is", () => {
		const root = workspace(files);
		expect(projectPath(root, "api")).toBe("services/api");
		expect(projectPath(root, "web")).toBe("apps/web");
		expect(() => projectPath(root, "billing")).toThrow("No project is named billing");
		const twice = workspace({ ...files, "apps/api/package.json": "{}" });
		expect(() => projectPath(twice, "api")).toThrow("More than one project is named api: apps/api, services/api");
	});

	test("tells the root a folder belongs in from what it holds", () => {
		const root = workspace({ ...files, "apps/empty/README.md": "" });
		expect(rootFor(root, "services/api")).toBe("services");
		expect(rootFor(root, "apps/web")).toBe("apps");
		expect(rootFor(root, "infra/data")).toBe("infra");
		expect(rootFor(root, "apps/empty")).toBeUndefined();
	});

	test("finds the web apps and the APIs by their .env.example", () => {
		expect(findApps(workspace(files))).toEqual([
			{ name: "api", path: "services/api", kind: "api" },
			{ name: "web", path: "apps/web", kind: "web" },
		]);
	});
});
