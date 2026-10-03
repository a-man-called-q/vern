// The Axum template names its dependencies and leaves their versions to the
// Cargo workspace at the repository root: `axum = { workspace = true }`. A
// dependency only some services need has its line wrapped in a Tera condition:
// `{% if database %}sqlx = { workspace = true }\n{% endif %}`, or
// `{% if not worker %}axum = { workspace = true }\n{% endif %}`.

const CONDITIONAL_LINE =
	/\{% if (?:not )?\w+ %\}[A-Za-z0-9_-]+ = [^\n]*\n\{% endif %\}/g;
const SECTION_HEADER = /^\[([^\]]+)\]\s*$/;
const DEPENDENCY_LINE = /^([A-Za-z0-9_-]+) = (.*)$/;

/**
 * The template with every condition taken as true, which is TOML. Fails on a
 * Tera marker that is not one conditional dependency line, rather than handing
 * Cargo a file it cannot read.
 */
export function stripCargoConditions(template: string): string {
	const stripped = template.replace(CONDITIONAL_LINE, (block) =>
		block.replace(/^\{% if (?:not )?\w+ %\}/, "").replace(/\{% endif %\}$/, ""),
	);
	const leftover = stripped.split("\n").find((line) => line.includes("{%"));
	if (leftover !== undefined)
		throw new Error(
			"The Axum Cargo template has a Tera marker that is not one conditional dependency line: " +
				leftover,
		);
	return stripped;
}

/** One dependency of the template: where it is listed, and what follows its `=`. */
export type TemplateDependency = { section: string; name: string; value: string };

/** Every dependency the template lists, conditional or not. */
export function templateDependencies(template: string): TemplateDependency[] {
	const dependencies: TemplateDependency[] = [];
	let section = "";
	for (const line of stripCargoConditions(template).split("\n")) {
		const header = SECTION_HEADER.exec(line);
		if (header?.[1]) {
			section = header[1];
			continue;
		}
		if (!section.endsWith("dependencies")) continue;
		const dependency = DEPENDENCY_LINE.exec(line);
		if (dependency?.[1])
			dependencies.push({ section, name: dependency[1], value: dependency[2] ?? "" });
	}
	return dependencies;
}

/**
 * What is wrong with the template's dependencies, given the root Cargo.toml: one
 * that carries a version of its own, or one the workspace does not have. A
 * generated API would then not build, or would fall behind the others.
 */
export function checkTemplateDependencies(
	template: string,
	workspaceManifest: string,
): string[] {
	const workspace = (
		Bun.TOML.parse(workspaceManifest) as {
			workspace?: { dependencies?: Record<string, unknown> };
		}
	).workspace?.dependencies;
	const errors: string[] = [];
	for (const { name, value } of templateDependencies(template)) {
		if (!/^\{[^}]*\bworkspace = true\b[^}]*\}$/.test(value.trim()))
			errors.push(
				"The Axum Cargo template gives " +
					name +
					" a version of its own; write `" +
					name +
					" = { workspace = true }` and keep the version in the root Cargo.toml.",
			);
		else if (!workspace || !(name in workspace))
			errors.push(
				"The Axum Cargo template uses " +
					name +
					", which [workspace.dependencies] of the root Cargo.toml does not have.",
			);
	}
	return errors;
}
