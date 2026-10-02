import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "../lib/env";
import { AUTH_SERVER, findApps } from "../lib/projects";
import type { Report } from "./report";

const IDENTITY = "deploy/k8s/base/identity/kustomization.yaml";
const BASE = "deploy/k8s/base/kustomization.yaml";

/** `newName:newTag` of each image the kustomization pins, by name. */
function pinnedImages(text: string): Map<string, string> {
	const images = new Map<string, string>();
	for (const match of text.matchAll(/- name: (\S+)\n\s+newName: (\S+)\n\s+newTag: (\S+)/g)) {
		images.set(match[1] as string, `${match[2]}:${match[3]}`);
	}
	return images;
}

/** deploy/k8s runs the ZITADEL the auth stack runs, and lists every app once the project uses it. */
export function checkKubernetes(root: string, report: Report): void {
	if (!existsSync(resolve(root, IDENTITY))) return;
	const example = parseEnv(resolve(root, AUTH_SERVER, ".env.example"));
	const images = pinnedImages(readFileSync(resolve(root, IDENTITY), "utf8"));
	const wanted = new Map([
		["zitadel", `ghcr.io/zitadel/zitadel:${example.get("ZITADEL_VERSION")}`],
		["zitadel-login", example.get("ZITADEL_LOGIN_IMAGE") ?? ""],
	]);
	const drift = [...wanted].filter(([name, image]) => images.get(name) !== image);
	if (drift.length > 0) {
		report(
			"FAIL",
			`${IDENTITY} pins ${drift.map(([name]) => `${name} as ${images.get(name) ?? "nothing"}`).join(" and ")}, but ${AUTH_SERVER}/.env.example has ${drift.map(([, image]) => image).join(" and ")}. Change them together.`,
		);
	} else {
		report("OK", `${IDENTITY} runs the ZITADEL release of ${AUTH_SERVER}/.env.example.`);
	}

	// Only a project that has run `setup --kubernetes` keeps the list up to date.
	const overlays = resolve(root, "deploy/k8s/overlays");
	const used = existsSync(overlays) && readdirSync(overlays).some((overlay) => existsSync(resolve(overlays, overlay, "generated")));
	if (!used || !existsSync(resolve(root, BASE))) return;
	const listed = readFileSync(resolve(root, BASE), "utf8");
	const missing = findApps(root)
		.filter((app) => existsSync(resolve(root, app.path, "k8s")))
		.filter((app) => !listed.includes(`../../../${app.path}/k8s`));
	if (missing.length > 0) {
		report(
			"WARN",
			`${BASE} does not list ${missing.map((app) => app.path).join(", ")}. Run \`bun run setup -- --kubernetes <overlay>\` (with --manifests-only to only write it).`,
		);
	} else {
		report("OK", `${BASE} lists every web app and API.`);
	}
}
