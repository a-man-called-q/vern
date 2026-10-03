import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// An API's image used to build from the API's own folder. The APIs are now
// members of the Cargo workspace at the root and build with the crates in
// crates/, so the image builds from the repository root, and the files it may
// see are listed in a Dockerfile.dockerignore beside the Dockerfile. This
// brings an API generated before that over: `deploy/compose` builds every API
// from the root.

const SERVICES = "services";

/** What the Axum template writes beside the Dockerfile. */
export const API_DOCKERIGNORE = `# The build context of this image is the repository root, so that the API is
# built with the crates it shares (crates/) and the workspace's Cargo.lock. Only
# the Rust sources enter it; build output, settings, and secrets never do.
*
!Cargo.toml
!Cargo.lock
!crates
!services
**/target
**/secrets
**/.env
**/.env.*
`;

/** The `.dockerignore` an API had when its own folder was the context. */
const OLD_DOCKERIGNORE = `# Keeps build output, dependencies, and secrets out of the image context.
target
secrets
.env
.env.*
!.env.example
`;

const COPY_WORKSPACE = `# The Cargo workspace: its manifest and lockfile, the shared crates, and the APIs
# (Cargo reads the manifest of every member, though it builds only this one).
# Dockerfile.dockerignore keeps everything else out of the context. Cargo.lock
# pins every dependency; commit it after the first build of a new API, which
# adds the API to it.
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY services services
`;

/** The APIs whose image still builds from their own folder, by name. */
export function apisBuildingAlone(root: string): string[] {
	const dir = resolve(root, SERVICES);
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				existsSync(resolve(dir, entry.name, "Cargo.toml")) &&
				existsSync(resolve(dir, entry.name, "Dockerfile")) &&
				!existsSync(resolve(dir, entry.name, "Dockerfile.dockerignore")),
		)
		.map((entry) => entry.name)
		.sort();
}

/** The Dockerfile building from the root, or undefined when it is not the template's any more. */
function rootDockerfile(dockerfile: string, name: string): string | undefined {
	const build = /cargo build --release && \\\n/;
	if (!dockerfile.includes("\nCOPY . .\n") || !build.test(dockerfile)) return undefined;
	return dockerfile
		.replace(
			`# or: docker build -t ${name} ${SERVICES}/${name}\n`,
			`# or, from the repository root:\n#   docker build -f ${SERVICES}/${name}/Dockerfile -t ${name} .\n`,
		)
		.replace("\nCOPY . .\n", `\n${COPY_WORKSPACE}`)
		.replace(build, `cargo build --release -p ${name} && \\\n`);
}

/** The `docker` task building from the root, or undefined when it is not the template's any more. */
function rootDockerTask(moon: string, name: string): string | undefined {
	const command = `    command: docker build -t ${name} .\n`;
	const task = new RegExp(`(  docker:\\n${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:    .*\\n)*?    options:\\n      cache: false\\n)`);
	if (!task.test(moon)) return undefined;
	return moon.replace(task, (block) =>
		block.replace(command, `    command: docker build -f ${SERVICES}/${name}/Dockerfile -t ${name} .\n`) +
		"      # The context is the repository root: see Dockerfile.dockerignore.\n      runFromWorkspaceRoot: true\n",
	);
}

export type ApiImageMigration = {
	/** The APIs whose image now builds from the root. */
	moved: string[];
	/** Files changed since they were generated: bring them over by hand. */
	leftovers: string[];
};

/**
 * Makes every API's image build from the repository root: its Dockerfile, its
 * `docker` task, and the list of what the context holds. Its own Cargo.lock
 * goes, since the workspace has one. Running it again changes nothing.
 */
export function moveApiImagesToRoot(root: string): ApiImageMigration {
	const moved: string[] = [];
	const leftovers: string[] = [];
	for (const name of apisBuildingAlone(root)) {
		const folder = resolve(root, SERVICES, name);
		const dockerfilePath = resolve(folder, "Dockerfile");
		const dockerfile = rootDockerfile(readFileSync(dockerfilePath, "utf8"), name);
		if (!dockerfile) {
			leftovers.push(`${SERVICES}/${name}/Dockerfile`);
			continue;
		}
		writeFileSync(dockerfilePath, dockerfile);
		writeFileSync(resolve(folder, "Dockerfile.dockerignore"), API_DOCKERIGNORE);

		const ignorePath = resolve(folder, ".dockerignore");
		if (existsSync(ignorePath) && readFileSync(ignorePath, "utf8") === OLD_DOCKERIGNORE) rmSync(ignorePath);
		rmSync(resolve(folder, "Cargo.lock"), { force: true });

		const moonPath = resolve(folder, "moon.yml");
		const moon = existsSync(moonPath) ? rootDockerTask(readFileSync(moonPath, "utf8"), name) : undefined;
		if (moon) writeFileSync(moonPath, moon);
		else leftovers.push(`${SERVICES}/${name}/moon.yml`);
		moved.push(name);
	}
	return { moved, leftovers };
}
