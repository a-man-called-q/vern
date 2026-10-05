import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CLI_BIN, CLI_PACKAGE, COMMANDS } from "./lib/commands";
import { ROOT } from "./lib/paths";

// bin.ts and the commands it runs sit at the top of src/, and the code they
// run lives in groups that depend one way:
//
//   commands → setup | project | doctor → zitadel → lib
//
// project, setup, and doctor may use each other only in this order: setup uses
// project (for the project's identity), and doctor checks both.
const ALLOWED: Record<string, string[]> = {
	lib: ["lib"],
	zitadel: ["zitadel", "lib"],
	project: ["project", "lib"],
	setup: ["setup", "project", "zitadel", "lib"],
	doctor: ["doctor", "setup", "project", "zitadel", "lib"],
};

const SCRIPTS = import.meta.dir;

function modules(dir = SCRIPTS): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : modules(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

function group(path: string): string {
	const parts = relative(SCRIPTS, path).split("/");
	return parts.length === 1 ? "commands" : (parts[0] as string);
}

function imports(path: string): string[] {
	const source = readFileSync(path, "utf8");
	return [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"(\.{1,2}\/[^"]+)"/gms)].map((match) => {
		const target = resolve(dirname(path), match[1] as string);
		return target.endsWith(".ts") ? target : `${target}.ts`;
	});
}

const code = modules().filter((path) => !path.endsWith(".test.ts"));

describe("the structure of src/", () => {
	test("every module belongs to a known group", () => {
		for (const path of code) {
			const name = group(path);
			expect(name === "commands" || name in ALLOWED, relative(SCRIPTS, path)).toBe(true);
		}
	});

	test("groups only import the groups below them, and never a command", () => {
		const wrong: string[] = [];
		for (const path of code) {
			const from = group(path);
			if (from === "commands") continue;
			for (const target of imports(path)) {
				const to = group(target);
				if (!ALLOWED[from]?.includes(to)) wrong.push(`${relative(SCRIPTS, path)} → ${relative(SCRIPTS, target)}`);
			}
		}
		expect(wrong).toEqual([]);
	});

	test("no module imports itself through others", () => {
		const graph = new Map(code.map((path) => [path, imports(path)]));
		const cycles: string[] = [];
		const done = new Set<string>();
		const visit = (path: string, trail: string[]): void => {
			if (trail.includes(path)) {
				cycles.push([...trail.slice(trail.indexOf(path)), path].map((item) => relative(SCRIPTS, item)).join(" → "));
				return;
			}
			if (done.has(path)) return;
			for (const target of graph.get(path) ?? []) visit(target, [...trail, path]);
			done.add(path);
		};
		for (const path of code) visit(path, []);
		expect(cycles).toEqual([]);
	});
});

describe("the package", () => {
	const manifest = JSON.parse(readFileSync(resolve(SCRIPTS, "../package.json"), "utf8")) as {
		name: string;
		version: string;
		bin: Record<string, string>;
	};
	const project = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
		scripts: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	test("is published under the names a rename keeps", () => {
		expect(manifest.name).toBe(CLI_PACKAGE);
		expect(Object.keys(manifest.bin)).toEqual([CLI_BIN]);
	});

	// In Vern's own repository Bun links this folder for the range the root asks
	// for; a project gets the same range from npm.
	test("has the version the root package.json asks for", () => {
		const range = project.devDependencies?.[CLI_PACKAGE];
		expect(range).toBeDefined();
		expect(Bun.semver.satisfies(manifest.version, range as string)).toBe(true);
	});

	test("has a script in the root package.json for every command but the one Moon runs", () => {
		for (const name of COMMANDS) {
			if (name === "check-ports") continue;
			expect(project.scripts[name], name).toMatch(new RegExp(`^(?:${CLI_BIN}|bunx ${CLI_PACKAGE}@latest) ${name}$`));
		}
	});
});
