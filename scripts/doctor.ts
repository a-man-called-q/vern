import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CONFIG_PATH,
	gitTry,
	ROOT,
	readConfig,
	run,
	UPDATE_STATE_PATH,
	UPSTREAM_URL,
} from "./project-utils";
import { readProjectRoles, ROLES_FILE } from "./zitadel-roles";

type Level = "OK" | "INFO" | "WARN" | "FAIL";
const results: Array<{ level: Level; message: string }> = [];

function report(level: Level, message: string): void {
	results.push({ level, message });
	console.log("[" + level + "] " + message);
}

function checkCommand(command: string, args: string[], label: string): void {
	const result = run(command, args, { cwd: ROOT, allowFailure: true });
	if (result.status !== 0) {
		report("FAIL", label + " is unavailable. " + result.stderr.trim());
		return;
	}
	report("OK", label + ": " + result.stdout.trim().split(/\r?\n/)[0]);
}

function isVernTemplateRepository(): boolean {
	const packagePath = resolve(ROOT, "package.json");
	if (!existsSync(packagePath)) return false;
	try {
		const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
			name?: string;
		};
		const origin = gitTry(ROOT, "remote", "get-url", "origin");
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

function main(): void {
	checkCommand("bun", ["--version"], "Bun");
	checkCommand("moon", ["--version"], "Moon");
	checkCommand("cargo", ["--version"], "Cargo");
	checkCommand("docker", ["compose", "version", "--short"], "Docker Compose");
	const cargoEdit = run("cargo", ["upgrade", "--help"], {
		cwd: ROOT,
		allowFailure: true,
	});
	if (
		cargoEdit.status === 0 &&
		cargoEdit.stdout.includes("Upgrade dependency version requirements")
	) {
		report("OK", "cargo-edit is ready for Rust dependency upgrades.");
	} else {
		report(
			"WARN",
			"Install cargo-edit with `cargo install cargo-edit` before upgrading Rust dependencies.",
		);
	}

	const configPath = resolve(ROOT, CONFIG_PATH);
	if (!existsSync(configPath)) {
		if (isVernTemplateRepository()) {
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
			const config = readConfig(ROOT);
			if (!config) report("FAIL", CONFIG_PATH + " could not be read.");
			else {
				const commit = gitTry(
					ROOT,
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
			report("FAIL", error instanceof Error ? error.message : String(error));
		}
	}

	if (existsSync(resolve(ROOT, UPDATE_STATE_PATH))) {
		report(
			"WARN",
			"An upstream update is pending; resolve it with update-project.ts --continue.",
		);
	}

	try {
		const roles = readProjectRoles(ROOT);
		report(
			"OK",
			roles.length > 0
				? ROLES_FILE + " declares " + roles.length + " project role(s)."
				: ROLES_FILE + " declares no project roles.",
		);
	} catch (error) {
		report("FAIL", error instanceof Error ? error.message : String(error));
	}

	for (const path of [
		".env.example",
		"apps/auth-server/.env.example",
		"apps/auth-server/docker-compose.yml",
	]) {
		if (existsSync(resolve(ROOT, path))) report("OK", path + " exists.");
		else report("FAIL", path + " is missing.");
	}

	try {
		const rootPackage = JSON.parse(
			readFileSync(resolve(ROOT, "package.json"), "utf8"),
		) as {
			workspaces?: string[];
			name?: string;
		};
		if (
			!rootPackage.name ||
			!rootPackage.workspaces?.includes("apps/*") ||
			!rootPackage.workspaces.includes("packages/*")
		) {
			report("FAIL", "Root package workspace configuration is invalid.");
		} else {
			report("OK", "Root package workspaces are configured.");
		}
		const jsonPaths = new Set([
			"package.json",
			"packages/ui/package.json",
			"apps/storybook/package.json",
			// The Login App falls back to its default brand when this is invalid.
			"apps/auth-server/brand/brand.json",
		]);
		for (const entry of readdirSync(resolve(ROOT, "apps"), {
			withFileTypes: true,
		})) {
			if (entry.isDirectory())
				jsonPaths.add("apps/" + entry.name + "/package.json");
		}
		for (const path of jsonPaths) {
			const absolute = resolve(ROOT, path);
			if (!existsSync(absolute)) continue;
			try {
				JSON.parse(readFileSync(absolute, "utf8"));
				report("OK", path + " is valid JSON.");
			} catch (error) {
				report(
					"FAIL",
					path +
						" is invalid JSON: " +
						(error instanceof Error ? error.message : String(error)),
				);
			}
		}
		for (const [template, label] of [
			["tanstack", "TanStack"],
			["next", "Next.js"],
		] as const) {
			const templatePackage = resolve(
				ROOT,
				".templates",
				template,
				"package.json.tera",
			);
			if (!existsSync(templatePackage)) continue;
			try {
				const rendered = readFileSync(templatePackage, "utf8").replace(
					'"name": "{{ name | kebab_case }}"',
					'"name": "doctor-template"',
				);
				JSON.parse(rendered);
				report(
					"OK",
					label + " package template is valid JSON after rendering its name.",
				);
			} catch (error) {
				report(
					"FAIL",
					label +
						" package template is invalid: " +
						(error instanceof Error ? error.message : String(error)),
				);
			}
		}
		const config = readConfig(ROOT);
		if (config) {
			const uiPackage = JSON.parse(
				readFileSync(resolve(ROOT, "packages/ui/package.json"), "utf8"),
			) as { name?: string };
			if (rootPackage.name !== config.project.slug) {
				report(
					"FAIL",
					"Root package name does not match the configured project slug.",
				);
			}
			if (uiPackage.name !== "@" + config.project.slug + "/ui") {
				report(
					"FAIL",
					"Shared UI package scope does not match the configured project slug.",
				);
			}
		}
	} catch (error) {
		report(
			"FAIL",
			"Cannot read package.json: " +
				(error instanceof Error ? error.message : String(error)),
		);
	}

	const portCheck = run("bun", ["scripts/check-ports.ts"], {
		cwd: ROOT,
		allowFailure: true,
	});
	if (portCheck.status === 0) report("OK", portCheck.stdout.trim());
	else report("FAIL", portCheck.stderr.trim() || portCheck.stdout.trim());

	const failures = results.filter((item) => item.level === "FAIL").length;
	const warnings = results.filter((item) => item.level === "WARN").length;
	console.log(
		"\nDoctor finished: " +
			failures +
			" failure(s), " +
			warnings +
			" warning(s).",
	);
	if (failures > 0) process.exitCode = 1;
}

if (import.meta.main) main();
