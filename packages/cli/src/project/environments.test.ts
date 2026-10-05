import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkEnvironments } from "../doctor/environments";
import { run } from "../lib/run";
import { chooseEnvironments, describeResult } from "./choose";
import { CONFIG_PATH, type ProjectConfig, readConfig } from "./config";
import { type Environments, isUsed, purposeOf } from "./environments";
import { mergeUpstreamFiles } from "./merge";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
	mkdirSync(dirname(resolve(root, path)), { recursive: true });
	writeFileSync(resolve(root, path), contents);
}

/** What Vern ships for the two ways, and a file every project keeps. */
const VERN: Record<string, string> = {
	".gitignore": "**/.env\ndeploy/*/settings.env\ndeploy/*/generated/\ndeploy/*/secrets/\n",
	"README.md": "# Vern\n",
	"deploy/README.md": "How the product is run.\n",
	"deploy/compose/docker-compose.yml": "name: vern\n",
	"deploy/compose/.env.example": "DEPLOY_ENV=prod\n",
	"deploy/base/identity/kustomization.yaml": "resources: []\n",
	"deploy/base/kustomization.yaml": "resources: [identity]\n",
	"deploy/local/kustomization.yaml": "namespace: vern\n",
	"deploy/local/local-cluster.sh": "#!/bin/sh\necho vern\n",
	"deploy/staging/kustomization.yaml": "namespace: vern-staging\n",
	"deploy/prod/kustomization.yaml": "namespace: vern\n",
	"deploy/dev/auth-server/docker-compose.yml": "name: vern-auth\n",
	".templates/axum/k8s/deployment.yaml.tera": "kind: Deployment\n",
	".templates/axum/src/main.rs": "fn main() {}\n",
	".github/workflows/images.yml": "name: Images\n",
	".github/workflows/templates.yml": "name: Templates\n",
};

/** A repository with Vern's files, as upstream has them. */
function upstream(): { root: string; sha: string } {
	const root = mkdtempSync(join(tmpdir(), "vern-stack-upstream-"));
	roots.push(root);
	git(root, "init", "-b", "main");
	for (const [path, contents] of Object.entries(VERN)) write(root, path, contents);
	run("chmod", ["+x", resolve(root, "deploy/local/local-cluster.sh")]);
	git(root, "add", "-A");
	git(root, "commit", "-m", "vern");
	return { root, sha: git(root, "rev-parse", "HEAD") };
}

/**
 * A project made from that upstream the way create-vern makes one: renamed to
 * Acme, with one commit and none of Vern's history, and an app generated in it.
 */
function project(source: { root: string; sha: string }, environments?: Environments): string {
	const root = mkdtempSync(join(tmpdir(), "vern-stack-project-"));
	roots.push(root);
	git(root, "init", "-b", "main");
	for (const [path, contents] of Object.entries(VERN)) write(root, path, contents.replaceAll("vern", "acme").replaceAll("Vern", "Acme"));
	write(root, "services/api/k8s/deployment.yaml", "kind: Deployment\n");
	write(root, "services/api/src/main.rs", "fn main() {}\n");
	const config: ProjectConfig = {
		schemaVersion: 1,
		project: { name: "Acme", slug: "acme" },
		upstream: { url: source.root, branch: "main", lastSyncedSha: source.sha },
		...(environments ? { environments } : {}),
	};
	write(root, CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
	git(root, "add", "-A");
	git(root, "commit", "-m", "acme");
	return root;
}

const has = (root: string, path: string) => existsSync(resolve(root, path));

describe("what a way of running an environment owns", () => {
	test("tells Docker Compose, Kubernetes, and one environment's overlay apart", () => {
		expect(purposeOf("deploy/compose/docker-compose.yml")).toEqual({ method: "compose" });
		expect(purposeOf("deploy/base/identity/zitadel.yaml")).toEqual({ method: "kubernetes" });
		expect(purposeOf(".templates/axum/k8s/deployment.yaml.tera")).toEqual({ method: "kubernetes" });
		expect(purposeOf(".vern/templates/web-base/k8s/service.yaml.tera")).toEqual({ method: "kubernetes" });
		expect(purposeOf("services/api/k8s/deployment.yaml")).toEqual({ method: "kubernetes" });
		expect(purposeOf(".github/workflows/images.yml")).toEqual({ method: "kubernetes" });
		expect(purposeOf("deploy/staging/kustomization.yaml")).toEqual({ method: "kubernetes", environment: "staging" });
		// Every project keeps these, and what `setup` writes is never Vern's.
		for (const path of [
			"deploy/README.md",
			"deploy/dev/auth-server/docker-compose.yml",
			"deploy/smoke/tests/sign-in.spec.ts",
			".templates/axum/src/main.rs",
			".github/workflows/templates.yml",
			"deploy/prod/.env",
			"deploy/prod/secrets/zitadel-api-key.json",
			"deploy/prod/settings.env",
			"deploy/prod/generated/kustomization.yaml",
		]) {
			expect(purposeOf(path), path).toBeUndefined();
		}
	});

	test("a path is kept when some environment runs that way", () => {
		const environments: Environments = { local: "none", staging: "kubernetes", prod: "compose" };
		expect(isUsed("deploy/compose/docker-compose.yml", environments)).toBe(true);
		expect(isUsed("deploy/base/kustomization.yaml", environments)).toBe(true);
		expect(isUsed("deploy/staging/kustomization.yaml", environments)).toBe(true);
		expect(isUsed("deploy/prod/kustomization.yaml", environments)).toBe(false);
		expect(isUsed("deploy/local/kind.yaml", environments)).toBe(false);
		expect(isUsed("deploy/base/kustomization.yaml", { local: "none", staging: "none", prod: "compose" })).toBe(false);
		// A project that has not chosen keeps both ways.
		expect(isUsed("deploy/local/kind.yaml", undefined)).toBe(true);
	});
});

describe("project:stack", () => {
	test("keeps only Docker Compose, and what setup wrote", () => {
		const root = project(upstream());
		write(root, "deploy/prod/settings.env", "DOMAIN=acme.test\n");
		write(root, "deploy/prod/generated/secrets/zitadel.env", "ZITADEL_MASTERKEY=secret\n");
		const result = chooseEnvironments(root, { local: "none", staging: "none", prod: "compose" });

		for (const path of [
			"deploy/base",
			"deploy/local",
			"deploy/staging",
			"deploy/prod/kustomization.yaml",
			".templates/axum/k8s",
			"services/api/k8s",
			".github/workflows/images.yml",
		]) {
			expect(has(root, path), path).toBe(false);
		}
		for (const path of [
			"deploy/compose/docker-compose.yml",
			"deploy/dev/auth-server/docker-compose.yml",
			".templates/axum/src/main.rs",
			"services/api/src/main.rs",
			".github/workflows/templates.yml",
			// Git ignores them, and they hold a key that cannot be recreated.
			"deploy/prod/settings.env",
			"deploy/prod/generated/secrets/zitadel.env",
		]) {
			expect(has(root, path), path).toBe(true);
		}
		expect(readConfig(root)?.environments).toEqual({ local: "none", staging: "none", prod: "compose" });
		expect(result.leftovers).toEqual(["deploy/prod/settings.env", "deploy/prod/generated"]);
		const lines = describeResult(result);
		expect(lines[0]).toBe(`Environments: local: none, staging: none, prod: Docker Compose (saved in ${CONFIG_PATH}).`);
		expect(lines).toContain("  deploy/base (2 files)");
		expect(lines).toContain("  services/api/k8s (1 file)");
		expect(lines).toContain("  bun run setup -- --env prod   # Docker Compose");
	});

	test("keeps only Kubernetes for the environments that run on it", () => {
		const root = project(upstream());
		chooseEnvironments(root, { local: "kubernetes", staging: "none", prod: "kubernetes" });
		expect(has(root, "deploy/compose")).toBe(false);
		expect(has(root, "deploy/staging")).toBe(false);
		for (const path of ["deploy/base/identity/kustomization.yaml", "deploy/local/kustomization.yaml", "deploy/prod/kustomization.yaml", "services/api/k8s/deployment.yaml", ".github/workflows/images.yml"]) {
			expect(has(root, path), path).toBe(true);
		}
	});

	test("asks for every environment the first time, and never runs without production", () => {
		const root = project(upstream());
		expect(() => chooseEnvironments(root, { prod: "compose" })).toThrow("Say how local runs: --local none|compose|kubernetes");
		expect(() => chooseEnvironments(root, { local: "none", staging: "none", prod: "none" })).toThrow("--prod takes compose, or kubernetes.");
		expect(has(root, "deploy/base/kustomization.yaml")).toBe(true);
		// Later, an environment left out keeps its choice.
		chooseEnvironments(root, { local: "none", staging: "compose", prod: "compose" });
		expect(chooseEnvironments(root, { staging: "none" }).environments).toEqual({ local: "none", staging: "none", prod: "compose" });
	});

	test("refuses to delete a file with changes that are not committed", () => {
		const root = project(upstream());
		write(root, "deploy/base/kustomization.yaml", "resources: [identity, mine]\n");
		write(root, "apps/web/k8s/deployment.yaml", "kind: Deployment\n");
		expect(() => chooseEnvironments(root, { local: "none", staging: "none", prod: "compose" })).toThrow(
			"Commit or discard them first:\n  apps/web/k8s/deployment.yaml\n  deploy/base/kustomization.yaml",
		);
		expect(has(root, "deploy/local/kustomization.yaml")).toBe(true);
		expect(readConfig(root)?.environments).toBeUndefined();
	});

	test("is not for the Vern template itself", () => {
		const { root } = upstream();
		expect(() => chooseEnvironments(root, { local: "none", staging: "none", prod: "compose" })).toThrow("this is not a project yet");
	});

	test("brings Vern's files back, renamed, when a way is chosen again", () => {
		const source = upstream();
		const root = project(source);
		chooseEnvironments(root, { local: "none", staging: "none", prod: "compose" });
		git(root, "add", "-A");
		git(root, "commit", "-m", "compose only");
		// The project has one commit of its own and none of Vern's history.
		expect(run("git", ["cat-file", "-e", `${source.sha}^{commit}`], { cwd: root, allowFailure: true }).status).not.toBe(0);

		const result = chooseEnvironments(root, { local: "kubernetes", prod: "kubernetes" });
		expect(result.environments).toEqual({ local: "kubernetes", staging: "none", prod: "kubernetes" });
		expect(result.restored).toEqual([
			".github/workflows/images.yml",
			".templates/axum/k8s/deployment.yaml.tera",
			"deploy/base/identity/kustomization.yaml",
			"deploy/base/kustomization.yaml",
			"deploy/local/kustomization.yaml",
			"deploy/local/local-cluster.sh",
			"deploy/prod/kustomization.yaml",
		]);
		expect(readFileSync(resolve(root, "deploy/prod/kustomization.yaml"), "utf8")).toBe("namespace: acme\n");
		expect(statSync(resolve(root, "deploy/local/local-cluster.sh")).mode & 0o111).not.toBe(0);
		expect(has(root, "deploy/staging")).toBe(false);
		expect(has(root, "deploy/compose")).toBe(false);
		expect(describeResult(result)).toContain("  deploy/local (2 files)");
	});

	test("brings back what a chosen way is missing, when run again with the same choice", () => {
		const root = project(upstream(), { local: "none", staging: "none", prod: "compose" });
		rmSync(resolve(root, "deploy/compose"), { recursive: true });
		git(root, "add", "-A");
		git(root, "commit", "-m", "lost");
		expect(chooseEnvironments(root, {}).restored).toEqual(["deploy/compose/.env.example", "deploy/compose/docker-compose.yml"]);
		expect(readFileSync(resolve(root, "deploy/compose/docker-compose.yml"), "utf8")).toBe("name: acme\n");
	});
});

describe("project:update with a choice", () => {
	test("leaves out upstream's files of a way the project does not use", () => {
		const source = upstream();
		const root = project(source);
		chooseEnvironments(root, { local: "none", staging: "none", prod: "compose" });
		write(source.root, "deploy/base/identity/zitadel.yaml", "kind: Deployment\n");
		write(source.root, "deploy/prod/namespace.yaml", "kind: Namespace\n");
		write(source.root, "deploy/compose/docker-compose.yml", "name: vern\nservices: {}\n");
		git(source.root, "add", "-A");
		git(source.root, "commit", "-m", "more");
		const next = git(source.root, "rev-parse", "HEAD");
		git(root, "fetch", "--no-tags", source.root, "+refs/heads/main:refs/vern/upstream-main");

		const merged = mergeUpstreamFiles(root, readConfig(root) as ProjectConfig, source.sha, next);
		expect(merged).toEqual({ updated: ["deploy/compose/docker-compose.yml"], conflicts: [] });
		expect(readFileSync(resolve(root, "deploy/compose/docker-compose.yml"), "utf8")).toBe("name: acme\nservices: {}\n");
		expect(has(root, "deploy/base")).toBe(false);
		expect(has(root, "deploy/prod/namespace.yaml")).toBe(false);
	});
});

describe("doctor and the environments", () => {
	const findings = (root: string) => {
		const found: string[] = [];
		checkEnvironments(root, (level, message) => found.push(`${level} ${message}`));
		return found;
	};

	test("says nothing for a project that has not chosen", () => {
		expect(findings(project(upstream()))).toEqual([]);
	});

	test("accepts a project that holds what its environments need", () => {
		const root = project(upstream());
		chooseEnvironments(root, { local: "none", staging: "none", prod: "compose" });
		expect(findings(root)).toEqual(["OK Environments: local: none, staging: none, prod: Docker Compose; the project holds what they need."]);
	});

	test("names what is missing, what is left over, and the command for both", () => {
		const root = project(upstream(), { local: "none", staging: "none", prod: "kubernetes" });
		rmSync(resolve(root, "deploy/base"), { recursive: true });
		expect(findings(root)).toEqual([
			"FAIL The environments (local: none, staging: none, prod: Kubernetes) need deploy/base/identity/kustomization.yaml. `bun run project:stack -- --local none --staging none --prod kubernetes` brings Vern's files back.",
			"WARN The project holds deploy/compose/docker-compose.yml (no environment uses Docker Compose), deploy/local/kustomization.yaml (local does not run on Kubernetes), deploy/staging/kustomization.yaml (staging does not run on Kubernetes). `bun run project:stack -- --local none --staging none --prod kubernetes` removes what the environments (local: none, staging: none, prod: Kubernetes) do not use.",
		]);
	});
});
