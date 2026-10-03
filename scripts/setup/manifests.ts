import type { AppKind } from "../lib/projects";
import { toYaml } from "../lib/yaml";
import type { Environment } from "./stack";

// What `bun run setup -- --kubernetes` writes: the list of apps in
// deploy/base, and an overlay's `generated/` Component with everything
// that depends on this project and this cluster (hostnames, images, settings,
// and the Secrets read from files next to it). Pure functions of the input, so
// a test can check the YAML.

/** The overlay of an environment: `local` runs everything in the cluster, the others keep the databases outside. */
export type Overlay = Environment;

export type KubeSettings = {
	overlay: Overlay;
	/** Hostnames are `auth.<domain>` and `<app>.<domain>`. */
	domain: string;
	authHost: string;
	ingressClass: string;
	/** staging and prod: the cert-manager ClusterIssuer of the hostnames' certificates. */
	clusterIssuer: string;
	/** staging and prod: images are `<imageRegistry>/<app>:<imageTag>`. */
	imageRegistry: string;
	imageTag: string;
	orgName: string;
	adminUsername: string;
	allowRegister?: boolean;
};

export type KubeApp = {
	name: string;
	path: string;
	kind: AppKind;
	/** Web app and API: its hostname. A worker has none. */
	host: string;
	/** API and worker: it has a database (DATABASE_URL), in the data project locally. */
	database: boolean;
	/** API and worker: it uses the bus (NATS_URL). */
	events: boolean;
	/** API: a `secrets/<name>.env` with its own settings, such as ZITADEL_ORG_ADMIN_TOKEN. */
	secretEnv: boolean;
	/** Web app: API_BASE_URL and the other API URLs it calls. */
	apiUrls: [key: string, url: string][];
};

/** The stacks under deploy/dev/ that the local overlay runs in the cluster. */
export type Backing = { data: boolean; bus: boolean; storage?: { bucket: string } };

export type ComponentInput = {
	settings: KubeSettings;
	apps: KubeApp[];
	backing: Backing;
	projectId: string;
	/** The files of deploy/dev/auth-server/brand, copied to `generated/brand/`. */
	brandFiles: string[];
};

const HEADER = (overlay: Overlay) =>
	`# Written by \`bun run setup -- --kubernetes ${overlay}\`. Do not edit it: change\n# the project or settings.env and run that again.\n`;

/** deploy/base/kustomization.yaml: the identity stack, then every app. */
export function baseKustomization(apps: { path: string }[]): string {
	return (
		"# Written by `bun run setup -- --kubernetes`: the identity stack, then every web\n" +
		"# app, API, and worker of the project. Run it again after generating one.\n" +
		toYaml({
			apiVersion: "kustomize.config.k8s.io/v1beta1",
			kind: "Kustomization",
			resources: ["identity", ...apps.map((app) => `../../${app.path}/k8s`)],
		})
	);
}

function issuerUrl(settings: KubeSettings): string {
	return `https://${settings.authHost}`;
}

function images(input: ComponentInput) {
	const { settings } = input;
	return input.apps.map((app) =>
		settings.overlay === "local"
			? // `moon run <app>:docker` builds `<app>:latest`, which the cluster has loaded.
				{ name: app.name, newTag: "latest" }
			: { name: app.name, newName: `${settings.imageRegistry}/${app.name}`, newTag: settings.imageTag },
	);
}

function zitadelLiterals(settings: KubeSettings): string[] {
	const login = `https://${settings.authHost}/ui/v2/login`;
	return [
		`ZITADEL_EXTERNALDOMAIN=${settings.authHost}`,
		`ZITADEL_FIRSTINSTANCE_INSTANCENAME=${settings.orgName}`,
		`ZITADEL_FIRSTINSTANCE_ORG_NAME=${settings.orgName}`,
		`ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=${settings.adminUsername}`,
		`ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_BASEURI=${login}/`,
		`ZITADEL_OIDC_DEFAULTLOGINURLV2=${login}/login?authRequest=`,
		`ZITADEL_OIDC_DEFAULTLOGOUTURLV2=${login}/logout?post_logout_redirect=`,
		`ZITADEL_SAML_DEFAULTLOGINURLV2=${login}/login?samlRequest=`,
		// Applies only when ZITADEL creates its database; setup brings a running
		// instance in line.
		`ZITADEL_DEFAULTINSTANCE_LOGINPOLICY_ALLOWREGISTER=${settings.allowRegister ?? false}`,
	];
}

export function componentKustomization(input: ComponentInput): string {
	const { settings, apps, backing } = input;
	const local = settings.overlay === "local";
	const webApps = apps.filter((app) => app.kind === "web");
	const apis = apps.filter((app) => app.kind === "api");
	// An API or a worker with a database of its own.
	const databaseApps = apps.filter((app) => app.database);

	const resources = ["ingress.yaml"];
	if (local) {
		if (backing.data) resources.push("../backing/data");
		if (backing.bus) resources.push("../backing/bus");
		if (backing.storage) resources.push("../backing/storage", "storage-bucket.yaml");
	}

	const configMapGenerator: Record<string, unknown>[] = [
		{ name: "identity", literals: [`ZITADEL_ISSUER=${issuerUrl(settings)}`, `ZITADEL_PROJECT_ID=${input.projectId}`] },
		{ name: "zitadel", literals: zitadelLiterals(settings) },
		{ name: "zitadel-login", literals: [`CUSTOM_REQUEST_HEADERS=Host:${settings.authHost},X-Forwarded-Proto:https`] },
		{ name: "brand", files: input.brandFiles.map((file) => `brand/${file}`) },
		{ name: "auth-pages-nginx", files: ["nginx.conf"] },
		...webApps.map((app) => ({
			name: app.name,
			literals: [`APP_URL=https://${app.host}`, ...app.apiUrls.map(([key, url]) => `${key}=${url}`)],
		})),
	];
	if (local) {
		configMapGenerator.push({ name: "local-ca", files: ["ca.pem=tls/ca.pem"] });
		for (const app of databaseApps) configMapGenerator.push({ name: `${app.name}-db-init`, files: [`init.sql=db-init/${app.name}.sql`] });
	}

	const secretGenerator: Record<string, unknown>[] = [
		{ name: "zitadel", envs: ["secrets/zitadel.env"] },
		...webApps.map((app) => ({ name: app.name, envs: [`secrets/${app.name}.env`] })),
		...apis.map((app) => ({ name: `${app.name}-key`, files: [`zitadel-api-key.json=secrets/${app.name}-key.json`] })),
		...apis.filter((app) => app.secretEnv).map((app) => ({ name: app.name, envs: [`secrets/${app.name}.env`] })),
	];
	if (local) {
		// What staging and prod keep outside the cluster; see deploy/base/README.md.
		secretGenerator.push(
			{ name: "zitadel-db", envs: ["secrets/zitadel-db.env"] },
			{ name: "zitadel-database", envs: ["secrets/zitadel-database.env"] },
			{ name: "redis", envs: ["secrets/redis.env"] },
		);
		if (backing.data) secretGenerator.push({ name: "data", envs: ["secrets/data.env"] });
		for (const app of databaseApps)
			secretGenerator.push({ name: `${app.name}-database`, envs: [`secrets/${app.name}-database.env`] });
		if (backing.bus) secretGenerator.push({ name: "bus", envs: ["secrets/bus.env"] });
		if (backing.storage) secretGenerator.push({ name: "storage", files: ["s3.json=secrets/storage-s3.json"] });
		secretGenerator.push({
			name: "local-tls",
			type: "kubernetes.io/tls",
			files: ["tls.crt=tls/cert.pem", "tls.key=tls/key.pem"],
		});
	}

	const patches = local
		? databaseApps.map((app) => ({ path: `patches/${app.name}-db-init.yaml`, target: { kind: "Deployment", name: app.name } }))
		: [];

	return (
		HEADER(settings.overlay) +
		toYaml({
			apiVersion: "kustomize.config.k8s.io/v1alpha1",
			kind: "Component",
			resources,
			images: images(input),
			configMapGenerator,
			secretGenerator,
			patches: patches.length > 0 ? patches : undefined,
		})
	);
}

function tlsSecret(settings: KubeSettings, name: string): string {
	return settings.overlay === "local" ? "local-tls" : `${name}-tls`;
}

function ingress(
	settings: KubeSettings,
	name: string,
	host: string,
	paths: { path: string; pathType: "Prefix" | "Exact"; service: string; port: string }[],
	options: { tlsName: string; issue: boolean; annotations?: Record<string, string> },
) {
	const annotations: Record<string, string> = { ...options.annotations };
	if (settings.overlay !== "local" && options.issue) annotations["cert-manager.io/cluster-issuer"] = settings.clusterIssuer;
	return {
		apiVersion: "networking.k8s.io/v1",
		kind: "Ingress",
		metadata: {
			name,
			...(Object.keys(annotations).length > 0 ? { annotations } : {}),
		},
		spec: {
			ingressClassName: settings.ingressClass,
			tls: [{ hosts: [host], secretName: tlsSecret(settings, options.tlsName) }],
			rules: [
				{
					host,
					http: {
						paths: paths.map((entry) => ({
							path: entry.path,
							pathType: entry.pathType,
							backend: { service: { name: entry.service, port: { name: entry.port } } },
						})),
					},
				},
			],
		},
	};
}

/** One hostname per web app and per API, and ZITADEL's on `authHost`. A worker gets none. */
export function ingressManifest(input: ComponentInput): string {
	const { settings } = input;
	const pages = (path: string, pathType: "Prefix" | "Exact") => ({ path, pathType, service: "auth-pages", port: "http" });
	const documents = [
		// The sign-in pages and the brand files; the certificate is requested here.
		ingress(
			settings,
			"auth-pages",
			settings.authHost,
			[pages("/ui/v2/login", "Prefix"), pages("/brand", "Prefix"), pages("/", "Exact"), pages("/favicon.svg", "Exact")],
			{ tlsName: "auth", issue: true },
		),
		// Everything else on the hostname is ZITADEL itself, over h2c. Traefik
		// reads that from the zitadel-api Service; ingress-nginx from here.
		// Traefik ranks the longer rule first, so this one is put last.
		ingress(settings, "zitadel-api", settings.authHost, [{ path: "/", pathType: "Prefix", service: "zitadel-api", port: "http" }], {
			tlsName: "auth",
			issue: false,
			annotations: {
				"nginx.ingress.kubernetes.io/backend-protocol": "GRPC",
				"traefik.ingress.kubernetes.io/router.priority": "1",
			},
		}),
		...input.apps
			.filter((app) => app.kind !== "worker")
			.map((app) =>
				ingress(settings, app.name, app.host, [{ path: "/", pathType: "Prefix", service: app.name, port: "http" }], {
					tlsName: app.name,
					issue: true,
				}),
			),
	];
	return HEADER(settings.overlay) + documents.map((document) => `---\n${toYaml(document)}`).join("");
}

/**
 * local: the API or worker applies its db/init.sql to the data project's
 * PostgreSQL before it starts. The file only creates what is missing.
 */
export function dbInitPatch(app: { name: string; kind: AppKind }): string {
	const volume = { name: "db-init", configMap: { name: `${app.name}-db-init` } };
	return (
		HEADER("local") +
		toYaml([
			{
				op: "add",
				path: "/spec/template/spec/initContainers",
				value: [
					{
						name: "db-init",
						image: "postgres:17.10-alpine",
						command: ["sh", "-c", 'until pg_isready -d "$DATA_URL"; do sleep 2; done; psql "$DATA_URL" -v ON_ERROR_STOP=1 --quiet -f /db-init/init.sql'],
						env: [{ name: "DATA_URL", valueFrom: { secretKeyRef: { name: "data", key: "url" } } }],
						volumeMounts: [{ name: "db-init", mountPath: "/db-init", readOnly: true }],
					},
				],
			},
			// An API has the volume of its key already; a worker has none to add to.
			app.kind === "worker"
				? { op: "add", path: "/spec/template/spec/volumes", value: [volume] }
				: { op: "add", path: "/spec/template/spec/volumes/-", value: volume },
		])
	);
}

/** local: creates the bucket of deploy/dev/storage, as its up.sh does. */
export function storageBucketJob(bucket: string): string {
	return (
		HEADER("local") +
		toYaml({
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name: "storage-bucket" },
			spec: {
				// Gone after a minute, so the next apply runs it again; it is safe to repeat.
				ttlSecondsAfterFinished: 60,
				backoffLimit: 20,
				template: {
					spec: {
						restartPolicy: "OnFailure",
						containers: [
							{
								name: "create-bucket",
								image: "curlimages/curl:8.16.0",
								command: [
									"sh",
									"-c",
									`status=$(curl -s -o /dev/null -w '%{http_code}' --aws-sigv4 aws:amz:us-east-1:s3 --user local-access-key:local-secret-key -X PUT http://storage:8333/${bucket}); case "$status" in 200|409) echo "bucket ${bucket} is ready";; *) echo "HTTP $status"; exit 1;; esac`,
								],
							},
						],
					},
				},
			},
		})
	);
}
