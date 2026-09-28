import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function parseEnv(path: string): Map<string, string> {
	const values = new Map<string, string>();
	if (!existsSync(path)) return values;

	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match) continue;

		let value = match[2];
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		values.set(match[1], value);
	}

	return values;
}

function mergeEnv(...sources: Map<string, string>[]): Map<string, string> {
	return new Map(sources.flatMap((source) => [...source.entries()]));
}

function readEffectiveEnv(projectPath: string): Map<string, string> {
	const rootSources = [
		parseEnv(resolve(root, ".env.example")),
		parseEnv(resolve(root, ".env")),
	];
	if (!projectPath) return mergeEnv(...rootSources);
	return mergeEnv(
		...rootSources,
		parseEnv(resolve(root, projectPath, ".env.example")),
		parseEnv(resolve(root, projectPath, ".env")),
	);
}

function addPort(label: string, raw: string | undefined): void {
	if (!raw) {
		errors.push(`${label} does not define a port.`);
		return;
	}

	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		errors.push(`${label} has invalid PORT ${JSON.stringify(raw)}; use an integer from 1024 to 65535.`);
		return;
	}

	const owners = ports.get(port) ?? [];
	owners.push(label);
	ports.set(port, owners);
}

const ports = new Map<number, string[]>();
const errors: string[] = [];
const rootEnv = readEffectiveEnv("");

const authEnv = readEffectiveEnv("apps/auth-server");
const authPort = authEnv.get("AUTH_HTTP_PORT") ?? "8081";
const redisPort = authEnv.get("REDIS_PORT") ?? "6379";
addPort("auth-server (ZITADEL)", authPort);
addPort("auth-server (Redis)", redisPort);
addPort("storybook", "6006");

const redisUrl = rootEnv.get("REDIS_URL");
if (redisUrl) {
	try {
		const url = new URL(redisUrl);
		if (url.port && url.port !== redisPort) {
			errors.push(`REDIS_URL uses port ${url.port}, but Redis exposes port ${redisPort}.`);
		}
	} catch {
		errors.push(`REDIS_URL is not a valid URL: ${JSON.stringify(redisUrl)}.`);
	}
}

const issuer = rootEnv.get("ZITADEL_ISSUER");
if (issuer) {
	try {
		const url = new URL(issuer);
		const issuerPort = url.port || (url.protocol === "https:" ? "443" : "80");
		if (issuerPort !== authPort) {
			errors.push(`ZITADEL_ISSUER uses port ${issuerPort}, but ZITADEL exposes port ${authPort}.`);
		}
	} catch {
		errors.push(`ZITADEL_ISSUER is not a valid URL: ${JSON.stringify(issuer)}.`);
	}
}

for (const entry of readdirSync(resolve(root, "apps"), { withFileTypes: true })) {
	if (!entry.isDirectory() || ["auth-server", "storybook"].includes(entry.name)) continue;
	const projectPath = resolve(root, "apps", entry.name);
	if (!existsSync(resolve(projectPath, "moon.yml"))) continue;

	const appEnv = readEffectiveEnv(`apps/${entry.name}`);
	const appPort = appEnv.get("PORT");
	addPort(`${entry.name} (${appPort ?? "missing PORT"})`, appPort);

	const appUrl = appEnv.get("APP_URL");
	if (appUrl) {
		try {
			const url = new URL(appUrl);
			const appUrlPort = url.port || (url.protocol === "https:" ? "443" : "80");
			if (appUrlPort !== appPort) {
				errors.push(`${entry.name} APP_URL uses port ${appUrlPort}, but PORT is ${appPort}.`);
			}
		} catch {
			errors.push(`${entry.name} APP_URL is not a valid URL: ${JSON.stringify(appUrl)}.`);
		}
	}
}

for (const [port, owners] of ports) {
	if (owners.length > 1) errors.push(`Port ${port} is assigned to multiple projects: ${owners.join(", ")}.`);
}

if (errors.length > 0) {
	console.error("Local port configuration has errors:");
	for (const error of errors) console.error(`- ${error}`);
	console.error("Set distinct ports in the root or per-project .env files, then run moon run workspace:check-ports.");
	process.exitCode = 1;
} else {
	console.log("Local service ports are valid and unique.");
}
