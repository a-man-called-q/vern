import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { errorMessage } from "../lib/errors";
import { AUTH_SERVER, listProjects, PROJECT_ROOTS } from "../lib/projects";
import { stripCargoConditions } from "../project/cargo-template";
import { readConfig } from "../project/config";
import { deployLeftovers, OLD_AUTH_SERVERS, planLayoutMigration } from "../project/layout";
import { renderPackageTemplate } from "../project/package-template";
import { WEB_TEMPLATES } from "../project/templates";
import type { Report } from "./report";

/**
 * Each project sits in the folder for its kind, and no two share a name: the
 * Moon project ID, the ZITADEL application, and the port all key on it.
 */
export function checkLayout(root: string, report: Report): void {
	const projects = listProjects(root).filter((project) => !OLD_AUTH_SERVERS.includes(project.path));
	let problems = 0;
	const migrate = "`bun run project:update -- --migrate`";
	// What a layout from before deploy/dev/ still has in the old places.
	for (const move of planLayoutMigration(root)) {
		problems += 1;
		if (OLD_AUTH_SERVERS.includes(move.from)) {
			report("FAIL", `${move.from} is left from before the auth stack moved to ${AUTH_SERVER}. Run ${migrate}.`);
		} else {
			report("FAIL", `${move.from} belongs in ${dirname(move.to)}/. Move it with ${migrate}.`);
		}
	}
	for (const path of deployLeftovers(root)) {
		problems += 1;
		report("FAIL", `${path} is left from the old deploy/ layout. Carry your changes over to its new place (deploy/README.md), then delete it.`);
	}
	const seen = new Map<string, string>();
	for (const project of projects) {
		const other = seen.get(project.name);
		if (other) {
			problems += 1;
			report("FAIL", `${other} and ${project.path} share a name; rename one of them.`);
		}
		seen.set(project.name, project.path);
	}
	if (problems === 0)
		report(
			"OK",
			`Projects are in ${PROJECT_ROOTS.map((dir) => dir + "/").join(", ")} by kind, with unique names.`,
		);
}

/** The files the workspace needs, its package manifests, and the templates' manifests. */
export function checkWorkspace(root: string, report: Report): void {
	checkLayout(root, report);

	for (const path of [
		".env.example",
		`${AUTH_SERVER}/.env.example`,
		`${AUTH_SERVER}/docker-compose.yml`,
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
			`${AUTH_SERVER}/brand/brand.json`,
		]);
		for (const project of listProjects(root))
			jsonPaths.add(project.path + "/package.json");
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
