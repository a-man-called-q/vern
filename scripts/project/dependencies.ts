import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../lib/run";
import {
	cargoConditions,
	restoreCargoConditions,
	stripCargoConditions,
} from "./cargo-template";
import { requireCargoEdit } from "./cargo-edit";
import {
	demoDependencies,
	formatPackageTemplate,
	renderPackageTemplate,
} from "./package-template";
import { WEB_TEMPLATES } from "./templates";

const START_PACKAGE = "@tanstack/react-start";
const ROUTER_PACKAGE = "@tanstack/react-router";

/**
 * `bun update --latest` bumps every @tanstack package on its own, but
 * @tanstack/react-start depends on one exact @tanstack/react-router. A second
 * router copy breaks route context at runtime, so the app's direct dependency
 * follows the version react-start uses. `searchRoots` are folders whose
 * node_modules hold the installed react-start. Returns whether it rewrote the file.
 */
export function alignRouterWithStart(
	manifestPath: string,
	searchRoots: string[],
): boolean {
	const text = readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(text) as {
		dependencies?: Record<string, string>;
	};
	const current = manifest.dependencies?.[ROUTER_PACKAGE];
	if (!current || !manifest.dependencies?.[START_PACKAGE]) return false;
	for (const searchRoot of searchRoots) {
		const installed = resolve(
			searchRoot,
			"node_modules",
			START_PACKAGE,
			"package.json",
		);
		if (!existsSync(installed)) continue;
		const wanted = (
			JSON.parse(readFileSync(installed, "utf8")) as {
				dependencies?: Record<string, string>;
			}
		).dependencies?.[ROUTER_PACKAGE];
		if (!wanted || wanted === current) return false;
		writeFileSync(
			manifestPath,
			text.replace(
				`"${ROUTER_PACKAGE}": "${current}"`,
				`"${ROUTER_PACKAGE}": "${wanted}"`,
			),
		);
		return true;
	}
	return false;
}

function alignWorkspaceRouters(root: string): void {
	const apps = resolve(root, "apps");
	if (!existsSync(apps)) return;
	for (const entry of readdirSync(apps, { withFileTypes: true })) {
		const manifest = resolve(apps, entry.name, "package.json");
		if (!entry.isDirectory() || !existsSync(manifest)) continue;
		alignRouterWithStart(manifest, [resolve(apps, entry.name), root]);
	}
}

function updateBunTemplate(
	root: string,
	template: string,
	label: string,
): void {
	const path = resolve(root, ".templates", template, "package.json.tera");
	if (!existsSync(path)) return;
	const tempRoot = mkTemp("vern-" + template + "-template-");
	try {
		const original = readFileSync(path, "utf8");
		const renderedName = "vern-template-" + template;
		// Every dependency is upgraded, the demo-only ones included: they go
		// back inside their block when the template is written.
		const withDemos = renderPackageTemplate(original, true);
		const rendered = withDemos.replace(
			'"name": "{{ name | kebab_case }}"',
			'"name": "' + renderedName + '"',
		);
		if (rendered === withDemos)
			throw new Error(
				"Could not render the " + label + " package name placeholder.",
			);
		const manifest = JSON.parse(rendered) as Record<string, unknown>;
		const workspaceDependencies: Record<string, Record<string, string>> = {};
		for (const section of ["dependencies", "devDependencies"]) {
			const values = manifest[section] as Record<string, string> | undefined;
			if (!values) continue;
			for (const [name, version] of Object.entries(values)) {
				if (version.startsWith("workspace:")) {
					let sectionDependencies = workspaceDependencies[section];
					if (!sectionDependencies) {
						sectionDependencies = {};
						workspaceDependencies[section] = sectionDependencies;
					}
					sectionDependencies[name] = version;
					delete values[name];
				}
			}
		}
		writeFileSync(
			resolve(tempRoot, "package.json"),
			JSON.stringify(manifest, null, 2) + "\n",
		);
		run("bun", ["update", "--latest"], { cwd: tempRoot });
		alignRouterWithStart(resolve(tempRoot, "package.json"), [tempRoot]);
		const updated = JSON.parse(
			readFileSync(resolve(tempRoot, "package.json"), "utf8"),
		) as Record<string, unknown>;
		updated.name = "{{ name | kebab_case }}";
		for (const [section, entries] of Object.entries(workspaceDependencies)) {
			const sectionDependencies = updated[section] as
				| Record<string, string>
				| undefined;
			updated[section] = { ...sectionDependencies, ...entries };
		}
		writeFileSync(
			path,
			formatPackageTemplate(updated, demoDependencies(original)),
		);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function mkTemp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function updateRustTemplate(root: string): void {
	const path = resolve(root, ".templates/axum/Cargo.toml.tera");
	if (!existsSync(path)) return;
	const tempRoot = mkTemp("vern-rust-template-");
	try {
		const original = readFileSync(path, "utf8");
		const named = original.replace(
			'"{{ name | kebab_case }}"',
			'"vern-template-axum"',
		);
		if (named === original)
			throw new Error("Could not render the Axum Cargo name placeholder.");
		writeFileSync(resolve(tempRoot, "Cargo.toml"), stripCargoConditions(named));
		mkdirSync(resolve(tempRoot, "src"), { recursive: true });
		writeFileSync(resolve(tempRoot, "src/main.rs"), "fn main() {}\n");
		run(
			"cargo",
			[
				"upgrade",
				"--manifest-path",
				resolve(tempRoot, "Cargo.toml"),
				"--incompatible",
				"allow",
				"--pinned",
				"allow",
			],
			{ cwd: tempRoot },
		);
		const updated = readFileSync(
			resolve(tempRoot, "Cargo.toml"),
			"utf8",
		).replace('"vern-template-axum"', '"{{ name | kebab_case }}"');
		writeFileSync(
			path,
			restoreCargoConditions(updated, cargoConditions(original)),
		);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

export function updateDependencies(root: string): void {
	requireCargoEdit(root);
	run("bun", ["update", "--latest", "--recursive"], { cwd: root });
	alignWorkspaceRouters(root);
	for (const { template, label } of WEB_TEMPLATES)
		updateBunTemplate(root, template, label);

	const apps = resolve(root, "apps");
	if (existsSync(apps)) {
		for (const entry of readdirSync(apps, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const manifest = resolve(apps, entry.name, "Cargo.toml");
			if (!existsSync(manifest)) continue;
			run(
				"cargo",
				[
					"upgrade",
					"--manifest-path",
					manifest,
					"--incompatible",
					"allow",
					"--pinned",
					"allow",
				],
				{ cwd: root },
			);
			run("cargo", ["update", "--manifest-path", manifest], { cwd: root });
		}
	}
	updateRustTemplate(root);
	if (existsSync(resolve(root, "bun.lock")))
		run("bun", ["install"], { cwd: root });
}

export function validateProject(root: string): void {
	run("bun", ["install", "--frozen-lockfile"], { cwd: root });
	run("moon", ["run", ":check"], { cwd: root });
	run("moon", ["run", ":test"], { cwd: root });
}
