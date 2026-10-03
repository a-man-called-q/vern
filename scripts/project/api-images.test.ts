import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ROOT } from "../lib/paths";
import { API_DOCKERIGNORE, apisBuildingAlone, moveApiImagesToRoot } from "./api-images";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// As the Axum template wrote them before the APIs shared crates.
const OLD_DOCKERFILE = `# syntax=docker/dockerfile:1
# Production image for billing:
#   moon run billing:docker
# or: docker build -t billing services/billing

FROM rust:1.98.1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY . .
ENV CARGO_PROFILE_RELEASE_STRIP=true
RUN --mount=type=cache,target=/usr/local/cargo/registry \\
    --mount=type=cache,target=/src/target \\
    cargo build --release && \\
    cp target/release/billing /usr/local/bin/billing

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /usr/local/bin/billing /usr/local/bin/billing
ENTRYPOINT ["/usr/local/bin/billing"]
`;

const OLD_MOON = `tasks:
  check:
    command: cargo check
    toolchains: system

  docker:
    command: docker build -t billing .
    description: Build this API's production Docker image
    toolchains: system
    options:
      cache: false
`;

const OLD_DOCKERIGNORE = `# Keeps build output, dependencies, and secrets out of the image context.
target
secrets
.env
.env.*
!.env.example
`;

function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "vern-api-images-"));
	roots.push(root);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(resolve(root, path)), { recursive: true });
		writeFileSync(resolve(root, path), content);
	}
	return root;
}

const read = (root: string, path: string) => readFileSync(resolve(root, path), "utf8");

describe("API images", () => {
	test("an API generated before crates/ builds from the repository root", () => {
		const root = project({
			"services/README.md": "",
			"services/billing/Cargo.toml": '[package]\nname = "billing"\n',
			"services/billing/Cargo.lock": "version = 4\n",
			"services/billing/Dockerfile": OLD_DOCKERFILE,
			"services/billing/.dockerignore": OLD_DOCKERIGNORE,
			"services/billing/moon.yml": OLD_MOON,
		});
		expect(apisBuildingAlone(root)).toEqual(["billing"]);

		expect(moveApiImagesToRoot(root)).toEqual({ moved: ["billing"], leftovers: [] });
		const dockerfile = read(root, "services/billing/Dockerfile");
		expect(dockerfile).toContain("#   docker build -f services/billing/Dockerfile -t billing .\n");
		expect(dockerfile).toContain("\nCOPY Cargo.toml Cargo.lock ./\nCOPY crates crates\nCOPY services services\n");
		expect(dockerfile).not.toContain("COPY . .");
		expect(dockerfile).toContain("    cargo build --release -p billing && \\\n    cp target/release/billing");
		expect(read(root, "services/billing/Dockerfile.dockerignore")).toBe(API_DOCKERIGNORE);
		expect(existsSync(resolve(root, "services/billing/.dockerignore"))).toBe(false);
		expect(existsSync(resolve(root, "services/billing/Cargo.lock"))).toBe(false);
		expect(read(root, "services/billing/moon.yml")).toBe(
			OLD_MOON.replace("docker build -t billing .", "docker build -f services/billing/Dockerfile -t billing .") +
				"      # The context is the repository root: see Dockerfile.dockerignore.\n      runFromWorkspaceRoot: true\n",
		);

		// Nothing is left to do.
		expect(apisBuildingAlone(root)).toEqual([]);
		expect(moveApiImagesToRoot(root)).toEqual({ moved: [], leftovers: [] });
	});

	test("a Dockerfile that was changed is left for its owner", () => {
		const root = project({
			"services/billing/Cargo.toml": "",
			"services/billing/Dockerfile": "FROM rust AS build\nCOPY src src\nRUN cargo build\n",
			"services/billing/.dockerignore": "target\n",
			"services/billing/moon.yml": OLD_MOON,
		});
		expect(moveApiImagesToRoot(root)).toEqual({ moved: [], leftovers: ["services/billing/Dockerfile"] });
		expect(existsSync(resolve(root, "services/billing/Dockerfile.dockerignore"))).toBe(false);
		expect(read(root, "services/billing/moon.yml")).toBe(OLD_MOON);
	});

	test("a docker task that was changed is named, and the image still moves", () => {
		const root = project({
			"services/billing/Cargo.toml": "",
			"services/billing/Dockerfile": OLD_DOCKERFILE,
			"services/billing/.dockerignore": "target\nnotes\n",
			"services/billing/moon.yml": "tasks:\n  docker:\n    command: docker buildx build -t billing .\n",
		});
		expect(moveApiImagesToRoot(root)).toEqual({ moved: ["billing"], leftovers: ["services/billing/moon.yml"] });
		// A .dockerignore of the project's own is not the template's to delete.
		expect(read(root, "services/billing/.dockerignore")).toBe("target\nnotes\n");
	});

	test("the Axum template has the files the migration writes", () => {
		expect(readFileSync(resolve(ROOT, ".templates/axum/Dockerfile.dockerignore"), "utf8")).toBe(API_DOCKERIGNORE);
		const dockerfile = readFileSync(resolve(ROOT, ".templates/axum/Dockerfile"), "utf8");
		expect(dockerfile).toContain("\nCOPY Cargo.toml Cargo.lock ./\nCOPY crates crates\nCOPY services services\n");
		expect(dockerfile).toContain("cargo build --release -p {{ name | kebab_case }} && \\\n");
	});
});
