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
				if (commit.status !== 0)
					report(
						"FAIL",
						"Saved upstream SHA is missing from the local Git object database.",
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
		const packagePaths = new Set([
			"package.json",
			"packages/ui/package.json",
			"apps/storybook/package.json",
		]);
		for (const entry of readdirSync(resolve(ROOT, "apps"), {
			withFileTypes: true,
		})) {
			if (entry.isDirectory())
				packagePaths.add("apps/" + entry.name + "/package.json");
		}
		for (const path of packagePaths) {
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
		const tanstackTemplate = resolve(
			ROOT,
			".templates/tanstack/package.json.tera",
		);
		if (existsSync(tanstackTemplate)) {
			try {
				const rendered = readFileSync(tanstackTemplate, "utf8").replace(
					'"name": "{{ name | kebab_case }}"',
					'"name": "doctor-template"',
				);
				JSON.parse(rendered);
				report(
					"OK",
					"TanStack package template is valid JSON after rendering its name.",
				);
			} catch (error) {
				report(
					"FAIL",
					"TanStack package template is invalid: " +
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
