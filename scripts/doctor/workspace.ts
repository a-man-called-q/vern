import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage } from "../lib/errors";
import { stripCargoConditions } from "../project/cargo-template";
import { readConfig } from "../project/config";
import { renderPackageTemplate } from "../project/package-template";
import { WEB_TEMPLATES } from "../project/templates";
import type { Report } from "./report";

/** The files the workspace needs, its package manifests, and the templates' manifests. */
export function checkWorkspace(root: string, report: Report): void {
	for (const path of [
		".env.example",
		"apps/auth-server/.env.example",
		"apps/auth-server/docker-compose.yml",
	]) {
		if (existsSync(resolve(root, path))) report("OK", path + " exists.");
		else report("FAIL", path + " is missing.");
	}

	try {
		const rootPackage = JSON.parse(
			readFileSync(resolve(root, "package.json"), "utf8"),
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
		for (const entry of readdirSync(resolve(root, "apps"), {
			withFileTypes: true,
		})) {
			if (entry.isDirectory())
				jsonPaths.add("apps/" + entry.name + "/package.json");
		}
		for (const path of jsonPaths) {
			const absolute = resolve(root, path);
			if (!existsSync(absolute)) continue;
			try {
				JSON.parse(readFileSync(absolute, "utf8"));
				report("OK", path + " is valid JSON.");
			} catch (error) {
				report("FAIL", path + " is invalid JSON: " + errorMessage(error));
			}
		}
		for (const { template, label } of WEB_TEMPLATES) {
			const templatePackage = resolve(
				root,
				".templates",
				template,
				"package.json.tera",
			);
			if (!existsSync(templatePackage)) continue;
			try {
				const named = readFileSync(templatePackage, "utf8").replace(
					'"name": "{{ name | kebab_case }}"',
					'"name": "doctor-template"',
				);
				// Both ways `moon generate` can render it: with the demo-only
				// dependencies and without them.
				for (const includeDemos of [true, false])
					JSON.parse(renderPackageTemplate(named, includeDemos));
				report(
					"OK",
					label +
						" package template is valid JSON with and without its demo dependencies.",
				);
			} catch (error) {
				report(
					"FAIL",
					label + " package template is invalid: " + errorMessage(error),
				);
			}
		}
		const cargoTemplate = resolve(root, ".templates/axum/Cargo.toml.tera");
		if (existsSync(cargoTemplate)) {
			try {
				stripCargoConditions(readFileSync(cargoTemplate, "utf8"));
				report(
					"OK",
					"Axum Cargo template marks only whole dependency lines as conditional.",
				);
			} catch (error) {
				report("FAIL", errorMessage(error));
			}
		}
		const config = readConfig(root);
		if (config) {
			const uiPackage = JSON.parse(
				readFileSync(resolve(root, "packages/ui/package.json"), "utf8"),
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
		report("FAIL", "Cannot read package.json: " + errorMessage(error));
	}
}
