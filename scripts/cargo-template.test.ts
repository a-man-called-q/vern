import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	cargoConditions,
	restoreCargoConditions,
	stripCargoConditions,
} from "./cargo-template";
import { ROOT } from "./project-utils";

const TEMPLATE =
	'[package]\nname = "{{ name | kebab_case }}"\n\n[dependencies]\n{% if events %}async-nats = "0.50"\n{% endif %}{% if database %}chrono = "0.4"\n{% endif %}serde = "1"\n{% if database %}uuid = { version = "1", features = ["v7"] }\n{% endif %}\n[dev-dependencies]\n{% if database %}chrono = "0.4"\n{% endif %}tower = "0.5"\n';

describe("cargo template", () => {
	test("lists each conditional dependency with its flag and section", () => {
		expect(cargoConditions(TEMPLATE)).toEqual([
			{ flag: "events", section: "dependencies", name: "async-nats" },
			{ flag: "database", section: "dependencies", name: "chrono" },
			{ flag: "database", section: "dependencies", name: "uuid" },
			{ flag: "database", section: "dev-dependencies", name: "chrono" },
		]);
	});

	test("strips every marker and puts each back around its own dependency", () => {
		const stripped = stripCargoConditions(TEMPLATE);
		expect(stripped).not.toContain("{%");
		expect(stripped).toContain('async-nats = "0.50"\nchrono = "0.4"\nserde');
		expect(restoreCargoConditions(stripped, cargoConditions(TEMPLATE))).toBe(
			TEMPLATE,
		);
	});

	test("follows a dependency whose line the upgrade rewrote", () => {
		const upgraded = stripCargoConditions(TEMPLATE)
			.replace('async-nats = "0.50"', 'async-nats = "0.51"')
			.replace('uuid = { version = "1"', 'uuid = { version = "2"');
		const restored = restoreCargoConditions(
			upgraded,
			cargoConditions(TEMPLATE),
		);
		expect(restored).toContain(
			'{% if events %}async-nats = "0.51"\n{% endif %}{% if database %}chrono',
		);
		expect(restored).toContain(
			'{% if database %}uuid = { version = "2", features = ["v7"] }\n{% endif %}\n[dev-dependencies]',
		);
	});

	test("refuses a marker that is not one conditional dependency line", () => {
		expect(() =>
			stripCargoConditions(
				'[dependencies]\n{% if database %}\nsqlx = "0.8"\n{% endif %}\n',
			),
		).toThrow("not one conditional dependency line");
	});

	test("refuses to drop a condition whose dependency is gone", () => {
		expect(() =>
			restoreCargoConditions('[dependencies]\nserde = "1"\n', [
				{ flag: "database", section: "dependencies", name: "sqlx" },
			]),
		).toThrow("no sqlx line in [dependencies]");
	});

	test("round-trips the Axum template", () => {
		const template = readFileSync(
			resolve(ROOT, ".templates/axum/Cargo.toml.tera"),
			"utf8",
		);
		const conditions = cargoConditions(template);
		// Every marker in the template belongs to one of these lines.
		expect(conditions.length).toBe(template.split("{% if ").length - 1);
		expect(
			restoreCargoConditions(stripCargoConditions(template), conditions),
		).toBe(template);
	});
});
