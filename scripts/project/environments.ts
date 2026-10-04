// How each environment of the project runs, and which of Vern's files that
// choice needs. A project holds only what it uses: one that runs nothing with
// Docker Compose has no deploy/compose, and one without Kubernetes has no
// deploy/base, no overlays, and no k8s/ in its apps. `project:stack` records
// the choice and removes the rest (choose.ts); `project:update` leaves out the
// upstream files of what the project does not use (merge.ts).

/**
 * The environments that run the whole product, each in `deploy/<name>`: a
 * rehearsal on this machine, staging, and production. (`deploy/dev` is not one
 * of them: it runs only what the apps depend on, and the apps from source.)
 */
export const ENVIRONMENTS = ["local", "staging", "prod"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** What runs an environment. */
export const METHODS = ["compose", "kubernetes"] as const;
export type Method = (typeof METHODS)[number];

/** An environment's choice: one of the two ways, or `none` when the project has no such environment. */
export type Choice = Method | "none";
export type Environments = Record<Environment, Choice>;

export const METHOD_LABELS: Record<Method, string> = { compose: "Docker Compose", kubernetes: "Kubernetes" };

/** The choices an environment can take: production always runs. */
export function choicesFor(environment: Environment): Choice[] {
	return environment === "prod" ? [...METHODS] : ["none", ...METHODS];
}

/** The `environments` of .vern/config.json, checked; undefined when the project has not chosen. */
export function parseEnvironments(value: unknown, source: string): Environments | undefined {
	if (value === undefined) return undefined;
	const given = (value ?? {}) as Record<string, unknown>;
	for (const environment of ENVIRONMENTS) {
		if (!choicesFor(environment).includes(given[environment] as Choice)) {
			throw new Error(`${source}: environments.${environment} must be ${choicesFor(environment).join(", ").replace(/, (\w+)$/, ", or $1")}.`);
		}
	}
	return { local: given.local, staging: given.staging, prod: given.prod } as Environments;
}

export function usesMethod(environments: Environments, method: Method): boolean {
	return ENVIRONMENTS.some((environment) => environments[environment] === method);
}

/** `local: Kubernetes, staging: none, prod: Kubernetes` */
export function describeEnvironments(environments: Environments): string {
	return ENVIRONMENTS.map((environment) => {
		const choice = environments[environment];
		return `${environment}: ${choice === "none" ? "none" : METHOD_LABELS[choice]}`;
	}).join(", ");
}

/** The `k8s/` of a template, wherever the templates are, and of an app generated from one. */
const TEMPLATE_MANIFESTS = /^(?:\.templates|\.vern\/templates)\/[^/]+\/k8s\//;
const APP_MANIFESTS = /^(?:apps|services)\/[^/]+\/k8s\//;
/** The workflow that pushes the images a cluster pulls; Docker Compose builds them on the server. */
export const IMAGES_WORKFLOW = ".github/workflows/images.yml";

/**
 * What `bun run setup` writes into an environment's folder, which Git ignores:
 * its settings and secrets. They are never Vern's to remove.
 */
export const SETUP_OUTPUT: Record<Method, string[]> = {
	compose: [".env", "secrets", "certs"],
	kubernetes: ["settings.env", "generated"],
};

export function isSetupOutput(path: string): boolean {
	const match = path.match(/^deploy\/[^/]+\/([^/]+)/);
	return Boolean(match && Object.values(SETUP_OUTPUT).flat().includes(match[1] as string));
}

/**
 * The way to run an environment that a path belongs to, and the one
 * environment it is for when it is not shared. Undefined for a path every
 * project keeps.
 */
export function purposeOf(path: string): { method: Method; environment?: Environment } | undefined {
	if (isSetupOutput(path)) return undefined;
	if (path.startsWith("deploy/compose/")) return { method: "compose" };
	if (path.startsWith("deploy/base/") || path === IMAGES_WORKFLOW || TEMPLATE_MANIFESTS.test(path) || APP_MANIFESTS.test(path)) {
		return { method: "kubernetes" };
	}
	// An environment's own folder holds its Kustomize overlay; with Docker
	// Compose it holds only what `setup` writes there.
	const environment = ENVIRONMENTS.find((name) => path.startsWith(`deploy/${name}/`));
	return environment ? { method: "kubernetes", environment } : undefined;
}

type Purpose = NonNullable<ReturnType<typeof purposeOf>>;

/** The file that stands for everything with one purpose: the one `setup` cannot run that way without. */
export function keyFileOf(purpose: Purpose): string {
	if (purpose.environment) return `deploy/${purpose.environment}/kustomization.yaml`;
	return purpose.method === "compose" ? "deploy/compose/docker-compose.yml" : "deploy/base/identity/kustomization.yaml";
}

/** The key file of each purpose the environments have, in the order of deploy/README.md. */
export function keyFiles(environments: Environments): { file: string; used: boolean; method: Method; environment?: Environment }[] {
	const purposes: Purpose[] = [
		{ method: "compose" },
		{ method: "kubernetes" },
		...ENVIRONMENTS.map((environment) => ({ method: "kubernetes" as const, environment })),
	];
	return purposes.map((purpose) => ({ ...purpose, file: keyFileOf(purpose), used: isUsed(keyFileOf(purpose), environments) }));
}

/** Whether the project keeps `path`, given how its environments run. A project that has not chosen keeps everything. */
export function isUsed(path: string, environments: Environments | undefined): boolean {
	if (!environments) return true;
	const purpose = purposeOf(path);
	if (!purpose) return true;
	return purpose.environment ? environments[purpose.environment] === purpose.method : usesMethod(environments, purpose.method);
}
