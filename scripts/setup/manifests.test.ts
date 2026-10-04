import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkKubernetes } from "../doctor/kubernetes";
import { ROOT } from "../lib/paths";
import { componentKustomization, dbInitPatch, ingressManifest, type KubeApp, type KubeSettings, storageBucketJob } from "./manifests";

const settings: KubeSettings = {
	overlay: "local",
	domain: "localtest.me",
	authHost: "auth.localtest.me",
	ingressClass: "traefik",
	clusterIssuer: "letsencrypt",
	imageRegistry: "",
	imageTag: "latest",
	orgName: "Vern",
	adminUsername: "zitadel-admin",
};

const app = (name: string, kind: KubeApp["kind"], extra: Partial<KubeApp> = {}): KubeApp => ({
	name,
	path: `${kind === "web" ? "apps" : "services"}/${name}`,
	kind,
	host: kind === "worker" ? "" : `${name}.localtest.me`,
	database: false,
	events: false,
	secretEnv: false,
	apiUrls: [],
	...extra,
});

const parse = (text: string) => Bun.YAML.parse(text) as Record<string, unknown>;

describe("Kubernetes manifests", () => {
	test("local runs the stacks the project has, with their Secrets and the API's database setup", () => {
		const component = parse(
			componentKustomization({
				settings,
				apps: [app("web", "web", { apiUrls: [["API_BASE_URL", "https://api.localtest.me"]] }), app("api", "api", { database: true })],
				backing: { data: true, bus: false, storage: { bucket: "media" } },
				projectId: "100",
				brandFiles: ["brand.json"],
			}),
		) as { resources: string[]; secretGenerator: { name: string }[]; patches: { path: string }[]; configMapGenerator: { name: string; literals?: string[] }[] };
		expect(component.resources).toEqual(["ingress.yaml", "../backing/data", "../backing/storage", "storage-bucket.yaml"]);
		expect(component.secretGenerator.map((item) => item.name)).toEqual([
			"zitadel",
			"web",
			"api-key",
			"zitadel-db",
			"zitadel-database",
			"redis",
			"data",
			"api-database",
			"storage",
			"local-tls",
		]);
		expect(component.patches).toEqual([{ path: "patches/api-db-init.yaml", target: { kind: "Deployment", name: "api" } }]);
		expect(component.configMapGenerator.find((item) => item.name === "web")?.literals).toEqual([
			"APP_URL=https://web.localtest.me",
			"API_BASE_URL=https://api.localtest.me",
		]);
		const patch = parse(dbInitPatch({ name: "api", kind: "api" })) as unknown as { path: string }[];
		expect(patch.map((op) => op.path)).toEqual(["/spec/template/spec/initContainers", "/spec/template/spec/volumes/-"]);
		expect((parse(storageBucketJob("media")) as { kind: string }).kind).toBe("Job");
	});

	test("a worker gets its image, database, and bus, and no key, settings, or hostname", () => {
		const input = {
			settings,
			apps: [app("api", "api"), app("ingest", "worker", { database: true, events: true })],
			backing: { data: true, bus: true },
			projectId: "100",
			brandFiles: [],
		};
		const component = parse(componentKustomization(input)) as {
			images: { name: string }[];
			secretGenerator: { name: string }[];
			configMapGenerator: { name: string }[];
			patches: { path: string }[];
		};
		expect(component.images.map((image) => image.name)).toEqual(["api", "ingest"]);
		const secrets = component.secretGenerator.map((item) => item.name);
		expect(secrets).toContain("ingest-database");
		expect(secrets).toContain("bus");
		expect(secrets).not.toContain("ingest-key");
		expect(secrets).not.toContain("ingest");
		expect(component.configMapGenerator.map((item) => item.name)).toContain("ingest-db-init");
		expect(component.patches).toEqual([{ path: "patches/ingest-db-init.yaml", target: { kind: "Deployment", name: "ingest" } }]);
		// A worker's Deployment has no volumes yet, so the patch brings the list.
		const patch = parse(dbInitPatch({ name: "ingest", kind: "worker" })) as unknown as { path: string; value: unknown }[];
		expect(patch.map((op) => op.path)).toEqual(["/spec/template/spec/initContainers", "/spec/template/spec/volumes"]);
		expect(patch[1]?.value).toEqual([{ name: "db-init", configMap: { name: "ingest-db-init" } }]);

		const ingress = ingressManifest(input);
		expect(ingress).toContain("host: api.localtest.me");
		expect(ingress).not.toContain("ingest");
	});

	test("ZITADEL's catch-all route comes after the sign-in pages", () => {
		const documents = ingressManifest({ settings, apps: [], backing: { data: false, bus: false }, projectId: "", brandFiles: [] })
			.split(/^---$/m)
			.map((part) => part.trim())
			.filter((part) => part && !part.split("\n").every((line) => line.startsWith("#")))
			.map((part) => parse(part) as { metadata: { name: string; annotations?: Record<string, string> } });
		expect(documents.map((document) => document.metadata.name)).toEqual(["auth-pages", "zitadel-api"]);
		expect(documents[1]?.metadata.annotations?.["traefik.ingress.kubernetes.io/router.priority"]).toBe("1");
	});

	// A project whose local environment does not run on Kubernetes has no deploy/local/backing.
	test.skipIf(!existsSync(resolve(ROOT, "deploy/local/backing")))("run the images the Compose stacks run", () => {
		const image = (path: string) => readFileSync(resolve(ROOT, path), "utf8").match(/image: (\S+)/)?.[1];
		for (const [manifest, template] of [
			["deploy/local/backing/zitadel-db/postgres.yaml", ".vern/templates/postgres/docker-compose.yml"],
			["deploy/local/backing/data/postgres.yaml", ".vern/templates/postgres/docker-compose.yml"],
			["deploy/local/backing/bus/nats.yaml", ".vern/templates/bus/docker-compose.yml"],
			["deploy/local/backing/storage/seaweedfs.yaml", ".vern/templates/storage/docker-compose.yml"],
		]) {
			expect(image(manifest as string), manifest).toBe(image(template as string));
		}
		const reports: string[] = [];
		checkKubernetes(ROOT, (level, message) => reports.push(`${level} ${message}`));
		expect(reports.filter((line) => line.startsWith("FAIL"))).toEqual([]);
	});
});
