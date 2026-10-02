import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
	demoDependencies,
	formatPackageTemplate,
	renderPackageTemplate,
} from "./package-template";
import { ROOT } from "../lib/paths";
import { run } from "../lib/run";

const TEMPLATE =
	'{\n  "name": "{{ name | kebab_case }}",\n  "dependencies": {\n{% if include_demos %}    "chart": "^1.0.0",\n    "faker": "^2.0.0",\n{% endif %}    "@acme/ui": "workspace:*",\n    "react": "^19.0.0"\n  },\n  "devDependencies": {\n    "typescript": "^6.0.0"\n  }\n}\n';

describe("package template", () => {
	test("renders with and without the demo dependencies", () => {
		const withDemos = JSON.parse(renderPackageTemplate(TEMPLATE, true));
		expect(Object.keys(withDemos.dependencies)).toEqual([
			"chart",
			"faker",
			"@acme/ui",
			"react",
		]);
		const withoutDemos = JSON.parse(renderPackageTemplate(TEMPLATE, false));
		expect(Object.keys(withoutDemos.dependencies)).toEqual([
			"@acme/ui",
			"react",
		]);
		expect(withoutDemos.devDependencies).toEqual(withDemos.devDependencies);
	});

	test("lists the demo dependencies", () => {
		expect(demoDependencies(TEMPLATE)).toEqual(["chart", "faker"]);
		expect(demoDependencies(renderPackageTemplate(TEMPLATE, true))).toEqual([]);
	});

	test("writes a manifest back with the demo dependencies in their block", () => {
		const manifest = JSON.parse(renderPackageTemplate(TEMPLATE, true));
		expect(formatPackageTemplate(manifest, ["chart", "faker"])).toBe(TEMPLATE);
		// Wherever an upgrade left them, they move to the top of the section.
		manifest.dependencies = {
			"@acme/ui": "workspace:*",
			chart: "^1.0.0",
			react: "^19.0.0",
			faker: "^2.0.0",
		};
		expect(formatPackageTemplate(manifest, ["chart", "faker"])).toBe(TEMPLATE);
		expect(formatPackageTemplate(manifest, [])).toBe(
			JSON.stringify(manifest, null, 2) + "\n",
		);
	});

	test("refuses a section in which every entry is demo-only", () => {
		expect(() =>
			formatPackageTemplate({ dependencies: { chart: "^1.0.0" } }, ["chart"]),
		).toThrow("needs one that stays");
	});
});

// Packages that no generated file names, with what uses each. `@types/*`
// packages are not listed: none of them is ever imported.
const NOT_IMPORTED: Record<string, string> = {
	"@biomejs/biome": "the biome command",
	"@tanstack/router-cli": "the tsr command",
	"babel-plugin-react-compiler": "Next.js, for reactCompiler",
	"react-dom": "the framework",
	tailwindcss: "the stylesheet in packages/ui",
	typescript: "the tsc command",
};

const output = mkdtempSync(
	join(realpathSync(tmpdir()), "vern-template-dependencies-"),
);

afterAll(() => {
	rmSync(output, { recursive: true, force: true });
});

function generate(template: string, includeDemos: boolean): string {
	const app = join(output, template + (includeDemos ? "-demos" : "-plain"));
	run("moon", [
		"generate",
		template,
		"--defaults",
		"--to",
		relative(realpathSync(ROOT), app),
		"--",
		"--name",
		"web",
		"--port",
		"3000",
		...(includeDemos ? [] : ["--no-include_demos"]),
	]);
	return app;
}

/** Every generated file that can name a package, except the manifest and the docs. */
function readSources(app: string): Array<{ path: string; text: string }> {
	const sources: Array<{ path: string; text: string }> = [];
	for (const path of readdirSync(app, { recursive: true }) as string[]) {
		if (path === "package.json" || path.endsWith(".md")) continue;
		try {
			sources.push({ path, text: readFileSync(join(app, path), "utf8") });
		} catch {
			// A directory.
		}
	}
	return sources;
}

function importedPackages(
	sources: Array<{ path: string; text: string }>,
): string[] {
	const packages = new Set<string>();
	for (const { path, text } of sources) {
		if (!/\.(ts|tsx|mts|mjs|js)$/.test(path)) continue;
		for (const match of text.matchAll(
			/(?:\bfrom|\bimport|\bimport\(|\brequire\()\s*["']([^"']+)["']/g,
		)) {
			const specifier = match[1] ?? "";
			if (/^(\.|#\/|@\/|node:|bun:|bun$)/.test(specifier)) continue;
			const parts = specifier.split("/");
			packages.add(
				specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0],
			);
		}
	}
	return [...packages].sort();
}

describe("web template dependencies", () => {
	for (const template of ["tanstack", "next"]) {
		for (const includeDemos of [true, false]) {
			const label =
				template + (includeDemos ? " with demos" : " without demos");

			test(label + ": lists what it imports, and nothing else", () => {
				const app = generate(template, includeDemos);
				const manifestText = readFileSync(join(app, "package.json"), "utf8");
				// The scripts render the template the way `moon generate` does.
				expect(manifestText).toBe(
					renderPackageTemplate(
						readFileSync(
							resolve(ROOT, ".templates", template, "package.json.tera"),
							"utf8",
						),
						includeDemos,
					).replace("{{ name | kebab_case }}", "web"),
				);
				const manifest = JSON.parse(manifestText) as {
					dependencies: Record<string, string>;
					devDependencies: Record<string, string>;
				};
				const listed = [
					...Object.keys(manifest.dependencies),
					...Object.keys(manifest.devDependencies),
				];
				const sources = readSources(app);

				const unused = listed.filter((name) => {
					if (name in NOT_IMPORTED || name.startsWith("@types/")) return false;
					const mention = new RegExp(
						"[\"']" +
							name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
							"(/[^\"']*)?[\"']",
					);
					return !sources.some(({ text }) => mention.test(text));
				});
				expect(unused).toEqual([]);

				const unlisted = importedPackages(sources).filter(
					(name) => !listed.includes(name),
				);
				expect(unlisted).toEqual([]);
			});
		}
	}

	test("the updater's format leaves the templates as they are", () => {
		for (const template of ["tanstack", "next"]) {
			const text = readFileSync(
				resolve(ROOT, ".templates", template, "package.json.tera"),
				"utf8",
			);
			expect(demoDependencies(text).length).toBeGreaterThan(0);
			expect(
				formatPackageTemplate(
					JSON.parse(renderPackageTemplate(text, true)),
					demoDependencies(text),
				),
			).toBe(text);
		}
	});
});
