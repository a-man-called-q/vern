import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	checkTemplateDependencies,
	stripCargoConditions,
	templateDependencies,
} from "./cargo-template";
import { ROOT } from "../lib/paths";

const TEMPLATE =
	'[package]\nname = "{{ name | kebab_case }}"\nversion.workspace = true\n\n[dependencies]\naxum = { workspace = true }\n{% if database %}sqlx = { workspace = true }\n{% endif %}{% if events %}svc-events = { workspace = true }\n{% endif %}tokio = { workspace = true }\n\n[dev-dependencies]\nsvc-auth = { workspace = true, features = ["testing"] }\n';

const WORKSPACE =
	'[workspace]\nmembers = ["crates/*", "services/*"]\n\n[workspace.dependencies]\nsvc-auth = { path = "crates/svc-auth" }\nsvc-events = { path = "crates/svc-events" }\naxum = "0.8"\nsqlx = { version = "0.8", features = ["postgres"] }\ntokio = "1"\n';

describe("cargo template", () => {
	test("strips every marker, which leaves TOML", () => {
		const stripped = stripCargoConditions(TEMPLATE);
		expect(stripped).not.toContain("{%");
		expect(stripped).toContain(
			"axum = { workspace = true }\nsqlx = { workspace = true }\nsvc-events",
		);
	});

	test("refuses a marker that is not one conditional dependency line", () => {
		expect(() =>
			stripCargoConditions(
				"[dependencies]\n{% if database %}\nsqlx = { workspace = true }\n{% endif %}\n",
			),
		).toThrow("not one conditional dependency line");
	});

	test("lists every dependency, conditional or not, with its section", () => {
		expect(
			templateDependencies(TEMPLATE).map(
				({ section, name }) => section + ": " + name,
			),
		).toEqual([
			"dependencies: axum",
			"dependencies: sqlx",
			"dependencies: svc-events",
			"dependencies: tokio",
			"dev-dependencies: svc-auth",
		]);
	});

	test("accepts a template whose dependencies the workspace has", () => {
		expect(checkTemplateDependencies(TEMPLATE, WORKSPACE)).toEqual([]);
	});

	test("finds a dependency with its own version, and one the workspace lacks", () => {
		const template = TEMPLATE.replace(
			"tokio = { workspace = true }",
			'tokio = "1"\nuuid = { workspace = true }',
		);
		expect(checkTemplateDependencies(template, WORKSPACE)).toEqual([
			"The Axum Cargo template gives tokio a version of its own; write `tokio = { workspace = true }` and keep the version in the root Cargo.toml.",
			"The Axum Cargo template uses uuid, which [workspace.dependencies] of the root Cargo.toml does not have.",
		]);
	});

	test("the Axum template builds on the root workspace", () => {
		const template = readFileSync(
			resolve(ROOT, ".vern/templates/axum/Cargo.toml.tera"),
			"utf8",
		);
		const workspace = readFileSync(resolve(ROOT, "Cargo.toml"), "utf8");
		expect(checkTemplateDependencies(template, workspace)).toEqual([]);
		// With every condition on, it is the manifest of a workspace member.
		const manifest = Bun.TOML.parse(
			stripCargoConditions(template).replace(
				'"{{ name | kebab_case }}"',
				'"api"',
			),
		) as { package?: { name?: string }; lints?: { workspace?: boolean } };
		expect(manifest.package?.name).toBe("api");
		expect(manifest.lints?.workspace).toBe(true);
	});
});
