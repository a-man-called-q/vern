import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The commands sit at the top of scripts/ (the installer and package.json call
// them by path) and the code they run lives in groups that depend one way:
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

describe("scripts/ structure", () => {
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
