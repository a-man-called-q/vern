import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { listProjects } from "../lib/projects";
import { run } from "../lib/run";
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
	for (const project of listProjects(root)) {
		const manifest = resolve(root, project.path, "package.json");
		if (!existsSync(manifest)) continue;
		alignRouterWithStart(manifest, [resolve(root, project.path), root]);
	}
}

function updateBunTemplate(
	root: string,
	template: string,
	label: string,
): void {
	const path = resolve(root, ".vern/templates", template, "package.json.tera");
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

const CARGO_UPGRADE = ["--incompatible", "allow", "--pinned", "allow"];

/**
 * The Rust dependencies. The APIs in services/ and the crates in crates/ are
 * one Cargo workspace, so one `cargo upgrade` at the root covers every member
 * and the versions they share ([workspace.dependencies]). The Axum template
 * names its dependencies without versions, so it has nothing to upgrade. A
 * project without the root manifest has each API on its own.
 */
function updateRustDependencies(root: string): void {
	const workspace = resolve(root, "Cargo.toml");
	const manifests = existsSync(workspace)
		? [workspace]
		: listProjects(root)
				.map((project) => resolve(root, project.path, "Cargo.toml"))
				.filter((manifest) => existsSync(manifest));
	for (const manifest of manifests) {
		run("cargo", ["upgrade", "--manifest-path", manifest, ...CARGO_UPGRADE], {
			cwd: root,
		});
		run("cargo", ["update", "--manifest-path", manifest], { cwd: root });
	}
}

export function updateDependencies(root: string): void {
	requireCargoEdit(root);
	run("bun", ["update", "--latest", "--recursive"], { cwd: root });
	alignWorkspaceRouters(root);
	for (const { template, label } of WEB_TEMPLATES)
		updateBunTemplate(root, template, label);

	updateRustDependencies(root);
	if (existsSync(resolve(root, "bun.lock")))
		run("bun", ["install"], { cwd: root });
}

export function validateProject(root: string): void {
	run("bun", ["install", "--frozen-lockfile"], { cwd: root });
	run("moon", ["run", ":check"], { cwd: root });
	run("moon", ["run", ":test"], { cwd: root });
}
