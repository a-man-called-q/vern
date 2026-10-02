import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const UPSTREAM_URL = "https://github.com/a-man-called-q/vern.git";
export const UPSTREAM_BRANCH = "main";
export const CONFIG_PATH = ".vern/config.json";
export const UPDATE_STATE_PATH = ".vern/update-state.json";

export interface ProjectConfig {
	schemaVersion: 1;
	project: { name: string; slug: string };
	upstream: { url: string; branch: string; lastSyncedSha: string };
}

export function readConfig(root: string): ProjectConfig | undefined {
	const path = resolve(root, CONFIG_PATH);
	if (!existsSync(path)) return undefined;
	const value = JSON.parse(readFileSync(path, "utf8")) as ProjectConfig;
	if (
		value.schemaVersion !== 1 ||
		!value.project?.name ||
		!value.project?.slug ||
		!value.upstream?.url ||
		!value.upstream?.branch ||
		!value.upstream?.lastSyncedSha
	) {
		throw new Error(`${CONFIG_PATH} has an unsupported or incomplete format.`);
	}
	return value;
}
