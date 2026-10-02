import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage } from "../lib/errors";
import { gitTry } from "../lib/run";
import {
	CONFIG_PATH,
	readConfig,
	UPDATE_STATE_PATH,
	UPSTREAM_URL,
} from "../project/config";
import type { Report } from "./report";

function isVernTemplateRepository(root: string): boolean {
	const packagePath = resolve(root, "package.json");
	if (!existsSync(packagePath)) return false;
	try {
		const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
			name?: string;
		};
		const origin = gitTry(root, "remote", "get-url", "origin");
		const normalize = (url: string): string =>
			url
				.trim()
				.replace(/^git@github\.com:/i, "https://github.com/")
				.replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
				.replace(/\.git$/i, "")
				.replace(/\/+$/, "")
				.toLowerCase();
		return (
			manifest.name === "vern" &&
			origin.status === 0 &&
			normalize(origin.stdout) === normalize(UPSTREAM_URL)
		);
	} catch {
		return false;
	}
}

/** The project's identity and upstream, which rename and update depend on. */
export function checkIdentity(root: string, report: Report): void {
	const configPath = resolve(root, CONFIG_PATH);
	if (!existsSync(configPath)) {
		if (isVernTemplateRepository(root)) {
			report(
				"INFO",
				"This is the Vern template repository; " +
					CONFIG_PATH +
					" is created for projects initialized from it.",
			);
		} else {
			report(
				"WARN",
				CONFIG_PATH +
					" is missing; run rename-project.ts before using update-project.ts.",
			);
		}
	} else {
		try {
			const config = readConfig(root);
			if (!config) report("FAIL", CONFIG_PATH + " could not be read.");
			else {
				const commit = gitTry(
					root,
					"cat-file",
					"-e",
					config.upstream.lastSyncedSha + "^{commit}",
				);
				// A new project starts with one commit and Vern's history arrives with
				// the first update, which fetches it before it needs the base.
				if (commit.status !== 0)
					report(
						"WARN",
						"The saved upstream SHA is not in the local Git history yet (a new project starts with one commit); `bun run project:update` fetches it.",
					);
				else report("OK", "Project identity and upstream SHA are configured.");
			}
		} catch (error) {
			report("FAIL", errorMessage(error));
		}
	}

	if (existsSync(resolve(root, UPDATE_STATE_PATH))) {
		report(
			"WARN",
			"An upstream update is pending; resolve it with update-project.ts --continue.",
		);
	}
}
