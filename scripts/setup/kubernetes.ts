import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { type EnvFiles, parseEnv, readEffectiveEnv, setEnvValue } from "../lib/env";
import { AUTH_SERVER, type App, DEV_STACKS, findApps } from "../lib/projects";
import { run } from "../lib/run";
import { ALLOW_REGISTER_KEY, parseAllowRegister } from "../zitadel/login-policy";
import { readSmtpSettings } from "../zitadel/smtp";
import { chooseApiUrl, chooseNamedApiUrls } from "./api-urls";
import type { Log, SecretKind, SetupDeps } from "./context";
import { adminLogin } from "./logins";
import {
	type Backing,
	baseKustomization,
	componentKustomization,
	dbInitPatch,
	ingressManifest,
	type KubeApp,
	type KubeSettings,
	type Overlay,
	storageBucketJob,
} from "./manifests";
import { provisionOrgAdmin, wantsOrgAdmin } from "./org-admin";
import { randomSecret } from "./secrets";
import { ensureLocalCertificates, trustingFetch } from "./local-ca";
import { BASE, DEPLOY, resolveToken } from "./stack";
import { applySelfRegistration, applySmtp, connect, ensureApiKey, ensureProjectWithRoles, ensureWebApplication } from "./steps";

type KubeValues = {
	"pat-file"?: string;
	"skip-start"?: boolean;
	"manifests-only"?: boolean;
};

export function runKubectl(root: string, args: string[]): void {
	const result = spawnSync("kubectl", args, { cwd: root, stdio: "inherit" });
	if (result.status !== 0) throw new Error(`kubectl ${args.join(" ")} failed.`);
}

/** The token ZITADEL wrote for the vern-setup service account, read through the Login App's container. */
export function readKubeToken(root: string, namespace: string): string | undefined {
	const result = spawnSync(
		"kubectl",
		["-n", namespace, "exec", "deployment/zitadel", "-c", "login", "--", "cat", "/zitadel/bootstrap/admin.pat"],
		{ cwd: root, encoding: "utf8" },
	);
	return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function writePrivate(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, content, { mode: 0o600 });
	chmodSync(path, 0o600);
}

/** Sets `key` in a generated env file, creating it private. */
function setSecret(path: string, key: string, value: string): void {
	if (!existsSync(path)) writePrivate(path, "");
	setEnvValue({ env: path, example: "" } satisfies EnvFiles, key, value);
}

function readSettings(
	root: string,
	overlay: Overlay,
	processEnv: Record<string, string | undefined>,
): { settings: KubeSettings; env: Map<string, string>; file: string } {
	const dir = `${DEPLOY}/${overlay}`;
	const file = `${dir}/settings.env`;
	if (!existsSync(resolve(root, file))) {
		copyFileSync(resolve(root, dir, "settings.env.example"), resolve(root, file));
		if (overlay !== "local") {
			throw new Error(`Created ${file}. Set DOMAIN and IMAGE_REGISTRY in it, then run this again.`);
		}
	}
	const env = parseEnv(resolve(root, file));
	const domain = env.get("DOMAIN")?.trim() ?? "";
	if (!domain || domain.endsWith("example.com")) throw new Error(`Set DOMAIN in ${file}`);
	const imageRegistry = (env.get("IMAGE_REGISTRY") ?? "").trim().replace(/\/+$/, "");
	if (overlay !== "local" && (!imageRegistry || imageRegistry.includes("your-org"))) {
		throw new Error(`Set IMAGE_REGISTRY in ${file}: the images are <IMAGE_REGISTRY>/<app>:<IMAGE_TAG>`);
	}
	// The workflow that pushes the images tags them with the commit.
	const imageTag =
		env.get("IMAGE_TAG")?.trim() ||
		processEnv.IMAGE_TAG?.trim() ||
		run("git", ["rev-parse", "HEAD"], { cwd: root, allowFailure: true }).stdout.trim() ||
		"latest";
	return {
		file,
		env,
		settings: {
			overlay,
			domain,
			authHost: env.get("AUTH_HOST")?.trim() || `auth.${domain}`,
			ingressClass: env.get("INGRESS_CLASS")?.trim() || "traefik",
			clusterIssuer: env.get("CLUSTER_ISSUER")?.trim() || "letsencrypt",
			imageRegistry,
			imageTag,
			orgName: env.get("ZITADEL_ORG_NAME") || "Vern",
			adminUsername: env.get("ZITADEL_ADMIN_USERNAME") || "zitadel-admin",
			allowRegister: parseAllowRegister(env.get(ALLOW_REGISTER_KEY), file),
		},
	};
}

/** The stacks under deploy/dev/ that the local overlay runs: the names `moon generate` docs use. */
function readBacking(root: string): Backing {
	const has = (name: string) => existsSync(resolve(root, DEV_STACKS, name, "docker-compose.yml"));
	let storage: Backing["storage"];
	if (has("storage")) {
		const up = readFileSync(resolve(root, DEV_STACKS, "storage/up.sh"), "utf8");
		const bucket = up.match(/-X PUT "http:\/\/127\.0\.0\.1:\$\{port\}\/([^"/]+)"/)?.[1];
		if (!bucket) throw new Error(`Cannot find the bucket name in ${DEV_STACKS}/storage/up.sh`);
		storage = { bucket };
	}
	return { data: has("data"), bus: has("bus"), storage };
}

/** Each app's hostname (a worker has none), and what it needs from the cluster. */
function describeApps(root: string, apps: App[], settings: KubeSettings, log: Log): KubeApp[] {
	const host = (app: App) => (app.kind === "worker" ? "" : `${app.name}.${settings.domain}`);
	const apiUrls = new Map(apps.filter((app) => app.kind === "api").map((app) => [app.name, `https://${host(app)}`]));
	return apps.map((app) => {
		if (host(app) === settings.authHost) throw new Error(`${app.path}: its hostname ${host(app)} is ZITADEL's`);
		const example = parseEnv(resolve(root, app.path, ".env.example"));
		const kubeApp: KubeApp = {
			...app,
			host: host(app),
			database: app.kind !== "web" && example.has("DATABASE_URL"),
			events: app.kind !== "web" && example.has("NATS_URL"),
			secretEnv: app.kind === "api" && wantsOrgAdmin(root, app),
			apiUrls: [],
		};
		if (app.kind === "web") {
			// The URL in .env is for running it locally; here the API is on its hostname.
			const appEnv = readEffectiveEnv(root, app.path);
			appEnv.delete("API_BASE_URL");
			const chosen = chooseApiUrl(app, appEnv, apiUrls);
			if (chosen.message) log(chosen.message);
			if (chosen.url) kubeApp.apiUrls.push(["API_BASE_URL", chosen.url]);
			for (const [key, url] of chooseNamedApiUrls(app, new Map([...appEnv].filter(([key]) => key === "API_APPS")), apiUrls)) {
				kubeApp.apiUrls.push([key, url]);
			}
		}
		return kubeApp;
	});
}

/** The URL of an API's database in the local cluster: its local one, on the data project's Service. */
function clusterDatabaseUrl(root: string, app: KubeApp): string {
	const local = parseEnv(resolve(root, app.path, ".env.example")).get("DATABASE_URL") ?? "";
	const url = local.replace(/@[^/@]+\//, "@data:5432/");
	if (url === local) throw new Error(`${app.path}: DATABASE_URL in .env.example has no host to replace`);
	return url;
}

/** Creates what is missing in `generated/secrets/`, and keeps what is there. */
function ensureSecrets(
	root: string,
	dir: string,
	settings: KubeSettings,
	apps: KubeApp[],
	backing: Backing,
	secret: (kind: SecretKind, bytes: number) => string,
	log: Log,
): void {
	const secrets = resolve(root, dir, "generated/secrets");
	const keep = (file: string, key: string, make: () => string) => {
		const path = join(secrets, file);
		if (parseEnv(path).get(key)) return parseEnv(path).get(key) as string;
		const value = make();
		setSecret(path, key, value);
		log(`Generated ${key} in ${dir}/generated/secrets/${file}`);
		return value;
	};
	keep("zitadel.env", "ZITADEL_MASTERKEY", () => secret("hex", 16));
	keep("zitadel.env", "ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD", () => secret("password", 18));
	for (const app of apps) {
		if (app.kind === "web") {
			keep(`${app.name}.env`, "SESSION_SECRET", () => secret("base64", 32));
			if (!parseEnv(join(secrets, `${app.name}.env`)).has("ZITADEL_CLIENT_ID")) setSecret(join(secrets, `${app.name}.env`), "ZITADEL_CLIENT_ID", "");
		} else if (app.kind === "api") {
			// Until setup creates the key, the API stops at startup with a clear error.
			if (!existsSync(join(secrets, `${app.name}-key.json`))) writePrivate(join(secrets, `${app.name}-key.json`), "{}\n");
			if (app.secretEnv && !existsSync(join(secrets, `${app.name}.env`))) writePrivate(join(secrets, `${app.name}.env`), "");
		}
	}
	if (settings.overlay !== "local") return;
	const zitadelDb = keep("zitadel-db.env", "password", () => secret("hex", 24));
	setSecret(join(secrets, "zitadel-database.env"), "dsn", `postgresql://zitadel:${zitadelDb}@zitadel-db:5432/zitadel?sslmode=disable`);
	const redis = keep("redis.env", "password", () => secret("hex", 24));
	setSecret(join(secrets, "redis.env"), "url", `redis://:${redis}@redis:6379`);
	if (backing.data) {
		const data = keep("data.env", "password", () => secret("hex", 24));
		setSecret(join(secrets, "data.env"), "url", `postgresql://postgres:${data}@data:5432/postgres`);
	}
	for (const app of apps.filter((item) => item.database)) {
		setSecret(join(secrets, `${app.name}-database.env`), "url", clusterDatabaseUrl(root, app));
	}
	if (backing.bus) setSecret(join(secrets, "bus.env"), "url", "nats://bus:4222");
	if (backing.storage) {
		writePrivate(join(secrets, "storage-s3.json"), readFileSync(resolve(root, DEV_STACKS, "storage/s3.json"), "utf8"));
	}
}

/** A local certificate authority and one certificate for every hostname under DOMAIN. */
function ensureOverlayCertificates(root: string, dir: string, settings: KubeSettings, log: Log): void {
	const names = [settings.domain, `*.${settings.domain}`, settings.authHost];
	if (!ensureLocalCertificates(resolve(root, dir, "generated/tls"), names)) return;
	log(`Created a local certificate authority in ${dir}/generated/tls (import ca.pem in a browser to trust it)`);
}

/** Writes deploy/base/kustomization.yaml and the overlay's `generated/`. */
function writeManifests(
	root: string,
	dir: string,
	settings: KubeSettings,
	apps: KubeApp[],
	backing: Backing,
	projectId: string,
): void {
	writeFileSync(resolve(root, BASE, "kustomization.yaml"), baseKustomization(apps));
	const generated = resolve(root, dir, "generated");
	mkdirSync(join(generated, "brand"), { recursive: true });
	const brandFiles = readdirSync(resolve(root, AUTH_SERVER, "brand")).sort();
	for (const file of brandFiles) copyFileSync(resolve(root, AUTH_SERVER, "brand", file), join(generated, "brand", file));
	copyFileSync(resolve(root, AUTH_SERVER, "nginx.conf"), join(generated, "nginx.conf"));
	const input = { settings, apps, backing, projectId, brandFiles };
	writeFileSync(join(generated, "kustomization.yaml"), componentKustomization(input));
	writeFileSync(join(generated, "ingress.yaml"), ingressManifest(input));
	writeFileSync(join(generated, "state.env"), `ZITADEL_PROJECT_ID=${projectId}\n`);
	if (settings.overlay !== "local") return;
	for (const app of apps.filter((item) => item.database)) {
		mkdirSync(join(generated, "db-init"), { recursive: true });
		copyFileSync(resolve(root, app.path, "db/init.sql"), join(generated, "db-init", `${app.name}.sql`));
		mkdirSync(join(generated, "patches"), { recursive: true });
		writeFileSync(join(generated, "patches", `${app.name}-db-init.yaml`), dbInitPatch(app));
	}
	if (backing.storage) writeFileSync(join(generated, "storage-bucket.yaml"), storageBucketJob(backing.storage.bucket));
}

/**
 * Writes `k8s/` for an app generated before the templates had it: the app's
 * template is generated to a temporary folder, and only its `k8s/` is kept.
 */
export function generateAppManifests(root: string, app: KubeApp): void {
	const temp = mkdtempSync(join(realpathSync(tmpdir()), "vern-k8s-"));
	try {
		const flags = [
			...(app.database ? ["--database"] : []),
			...(app.events ? ["--events"] : []),
			...(app.kind === "worker" ? ["--worker"] : []),
		];
		run(
			"moon",
			[
				"generate",
				app.kind === "web" ? "tanstack" : "axum",
				"--defaults",
				"--to",
				relative(realpathSync(root), join(temp, app.name)),
				"--",
				"--name",
				app.name,
				"--port",
				"3000",
				...flags,
			],
			{ cwd: root },
		);
		cpSync(join(temp, app.name, "k8s"), resolve(root, app.path, "k8s"), { recursive: true });
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

/** The namespace the overlay's kustomization.yaml puts everything in. */
function readNamespace(root: string, dir: string): string {
	const match = readFileSync(resolve(root, dir, "kustomization.yaml"), "utf8").match(/^namespace:\s*(\S+)/m);
	if (!match?.[1]) throw new Error(`${dir}/kustomization.yaml sets no namespace`);
	return match[1];
}

/**
 * The Kubernetes flow: settings, Secrets, and manifests for the overlay in
 * deploy/<environment>; then the cluster, ZITADEL's project, an application per web app
 * and a key per API (a worker gets neither); then the manifests again with what
 * ZITADEL created.
 */
export async function setupKubernetes(
	overlay: Overlay,
	values: KubeValues,
	root: string,
	log: Log,
	processEnv: Record<string, string | undefined>,
	deps: SetupDeps,
): Promise<number> {
	const dir = `${DEPLOY}/${overlay}`;
	const { settings, env, file } = readSettings(root, overlay, processEnv);
	// A half-filled mail setup stops here, before anything reaches the cluster.
	const smtp = readSmtpSettings(env, file, settings.orgName);
	const apps = describeApps(root, findApps(root), settings, log);
	const backing = readBacking(root);
	if (apps.some((app) => app.database) && !backing.data && overlay === "local") {
		throw new Error("A service has a database, but there is no data project: moon generate postgres -- --name data --port 5433");
	}
	if (apps.some((app) => app.events) && !backing.bus && overlay === "local") {
		throw new Error("A service uses the bus, but there is no bus project: moon generate bus -- --name bus --port 4222");
	}
	for (const app of apps.filter((item) => !existsSync(resolve(root, item.path, "k8s/kustomization.yaml")))) {
		(deps.generateAppManifests ?? generateAppManifests)(root, app);
		log(`${app.path}: added k8s/ from its template (the app was generated before it had one)`);
	}
	const secret = deps.randomSecret ?? randomSecret;
	ensureSecrets(root, dir, settings, apps, backing, secret, log);
	if (overlay === "local") ensureOverlayCertificates(root, dir, settings, log);
	const statePath = resolve(root, dir, "generated/state.env");
	let projectId = parseEnv(statePath).get("ZITADEL_PROJECT_ID") ?? "";
	writeManifests(root, dir, settings, apps, backing, projectId);
	log(`Wrote ${BASE}/kustomization.yaml and ${dir}/generated/`);
	if (values["manifests-only"]) return 0;

	const kubectl = deps.runKubectl ?? runKubectl;
	const namespace = readNamespace(root, dir);
	if (!values["skip-start"]) {
		kubectl(root, ["apply", "-k", dir]);
		kubectl(root, ["-n", namespace, "rollout", "status", "deployment/zitadel", "--timeout=15m"]);
	}
	const issuer = `https://${settings.authHost}`;
	const api = await connect(
		{
			token: () =>
				resolveToken(
					values,
					processEnv,
					() => (deps.readKubeToken ?? readKubeToken)(root, namespace),
					`kubectl -n ${namespace} delete deployment/zitadel pvc/zitadel-bootstrap, and ZITADEL's database`,
				),
			issuer: () => issuer,
			waitHint: `Check that ${settings.authHost} resolves to the cluster's ingress and that its certificate is ready.`,
		},
		{
			...deps,
			fetcher: deps.fetcher ?? (overlay === "local" ? trustingFetch(resolve(root, dir, "generated/tls/ca.pem")) : undefined),
		},
		log,
	);
	await applySelfRegistration(api, settings.allowRegister, file, log);
	await applySmtp(api, smtp, { local: false, mailpitUrl: "", envFile: file }, log);
	const project = await ensureProjectWithRoles(root, api, projectId || undefined, settings.orgName, log);
	projectId = project.id;

	const secrets = resolve(root, dir, "generated/secrets");
	for (const app of apps) {
		if (app.kind === "web") {
			const clientId = await ensureWebApplication(api, projectId, app, `https://${app.host}`, log);
			setSecret(join(secrets, `${app.name}.env`), "ZITADEL_CLIENT_ID", clientId);
		} else if (app.kind === "api") {
			await ensureApiKey(api, projectId, app, join(secrets, `${app.name}-key.json`), { file: 0o600, dir: 0o700 }, root, log);
			if (app.secretEnv) {
				const target = join(secrets, `${app.name}.env`);
				await provisionOrgAdmin(api, root, app, log, { env: target, example: "" });
			}
		}
	}
	writeManifests(root, dir, settings, apps, backing, projectId);

	if (!values["skip-start"]) {
		kubectl(root, ["apply", "-k", dir]);
		for (const app of apps) kubectl(root, ["-n", namespace, "rollout", "status", `deployment/${app.name}`, "--timeout=10m"]);
	}
	const first = apps.find((app) => app.kind === "web");
	log(`\nDone.${first ? ` ${first.name} runs at https://${first.host}, and` : ""} the ZITADEL Console is at ${issuer}/ui/console/.`);
	log(
		`Sign in as ${adminLogin(env, settings.authHost)} with ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD from ${dir}/generated/secrets/zitadel.env; ZITADEL asks for a new password on the first sign-in.`,
	);
	return 0;
}
