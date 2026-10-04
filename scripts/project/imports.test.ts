import { afterEach, describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ROOT } from "../lib/paths";
import { run } from "../lib/run";
import { readConfig } from "./config";
import { listTextFiles } from "./files";
import { rebrandText } from "./identity";
import { comparePackages } from "./imports";

const VERN = { name: "Vern", slug: "vern" };

function renamed(path: string, text: string, slug: string): string {
	return rebrandText(path, text, VERN, { name: "Acme", slug });
}

describe("the imports a rename rewrote", () => {
	test("move to where the new scope sorts", () => {
		const source = [
			'"use client";',
			"",
			'import { IconInnerShadowTop } from "@tabler/icons-react";',
			'import { Button } from "@vern/ui/components/button";',
			'import { Input } from "@vern/ui/components/input";',
			'import type { ReactNode } from "react";',
			'import { NavMain } from "./nav-main";',
			"",
			"export const a = 1;",
			"",
		].join("\n");
		expect(renamed("src/a.tsx", source, "acme")).toBe(
			[
				'"use client";',
				"",
				'import { Button } from "@acme/ui/components/button";',
				'import { Input } from "@acme/ui/components/input";',
				'import { IconInnerShadowTop } from "@tabler/icons-react";',
				'import type { ReactNode } from "react";',
				'import { NavMain } from "./nav-main";',
				"",
				"export const a = 1;",
				"",
			].join("\n"),
		);
		// A scope that sorts where `@vern` did changes nothing but the name.
		expect(renamed("src/a.tsx", source, "zeta")).toBe(
			source.replaceAll("@vern/", "@zeta/"),
		);
	});

	test("stay below `node:` and above packages without a scope, aliases, and paths", () => {
		const source = [
			'import { resolve } from "node:path";',
			'import { z } from "zod";',
			'import { Button } from "@vern/ui/components/button";',
			'import { SITE_NAME } from "@/lib/site";',
			'import { local } from "./local";',
			"",
		].join("\n");
		// Not sorted to begin with: the others stay as they are.
		expect(renamed("src/a.ts", source, "acme")).toBe(
			[
				'import { resolve } from "node:path";',
				'import { Button } from "@acme/ui/components/button";',
				'import { z } from "zod";',
				'import { SITE_NAME } from "@/lib/site";',
				'import { local } from "./local";',
				"",
			].join("\n"),
		);
	});

	test("wrap when the line no longer fits, and join when it fits again", () => {
		const source =
			'import { SidebarInset, SidebarProvider } from "@vern/ui/components/sidebar";\n';
		const wrapped = [
			"import {",
			"\tSidebarInset,",
			"\tSidebarProvider,",
			'} from "@acme-board/ui/components/sidebar";',
			"",
		].join("\n");
		expect(renamed("src/a.tsx", source, "acme-board")).toBe(wrapped);
		expect(
			rebrandText(
				"src/a.tsx",
				wrapped,
				{ name: "Acme", slug: "acme-board" },
				VERN,
			),
		).toBe(source);
		// 80 columns fit, 81 do not.
		const exact = 'import { SidebarInset, SidebarProvider } from "@vern/ui/sidebar-padded-out";\n';
		expect(renamed("src/a.tsx", exact, "acme-boa").split("\n")[0]).toHaveLength(80);
		expect(renamed("src/a.tsx", exact, "acme-boar").split("\n")[0]).toBe("import {");
	});

	test("keep one name on one line, and wrap a default import with names", () => {
		const one =
			'import { AVeryLongNameThatGoesOnAndOn } from "@vern/ui/components/a-long-module-name";\n';
		expect(renamed("src/a.ts", one, "acme-board")).toBe(
			one.replace("@vern/", "@acme-board/"),
		);
		const type = one.replace("import {", "import type {");
		expect(renamed("src/a.ts", type, "acme-board")).toBe(
			type.replace("@vern/", "@acme-board/"),
		);
		expect(
			renamed(
				"src/a.ts",
				'import Sidebar, { AVeryLongNameThatGoesOnAndOn } from "@vern/ui/components/a-module";\n',
				"acme-board",
			),
		).toBe(
			[
				"import Sidebar, {",
				"\tAVeryLongNameThatGoesOnAndOn,",
				'} from "@acme-board/ui/components/a-module";',
				"",
			].join("\n"),
		);
		const namespace =
			'import * as AVeryLongNamespaceNameThatGoesOn from "@vern/ui/components/a-long-module-name";\n';
		expect(renamed("src/a.ts", namespace, "acme-board")).toBe(
			namespace.replace("@vern/", "@acme-board/"),
		);
	});

	test("sort re-exports apart from imports", () => {
		const source = [
			'import { a } from "@tabler/icons-react";',
			'import { b } from "@vern/ui/b";',
			'export { c } from "@tabler/icons-react";',
			'export { d, type E as F } from "@vern/ui/d";',
			"",
		].join("\n");
		expect(renamed("src/index.ts", source, "acme")).toBe(
			[
				'import { b } from "@acme/ui/b";',
				'import { a } from "@tabler/icons-react";',
				'export { d, type E as F } from "@acme/ui/d";',
				'export { c } from "@tabler/icons-react";',
				"",
			].join("\n"),
		);
	});

	test("stay on their side of a Tera tag, a comment, and an import with no `from`", () => {
		const source = [
			"{% if include_demos -%}",
			'import { Link } from "@tanstack/react-router";',
			'import { Button } from "@vern/ui/components/button";',
			"{%- else -%}",
			'import { Button } from "@vern/ui/components/button";',
			'import { SITE_NAME } from "@/lib/site";',
			"{%- endif %}",
			'import "./styles.css";',
			'import { a } from "@tabler/icons-react";',
			"// The shell.",
			'import { b } from "@vern/app-shell/b";',
			"",
		].join("\n");
		expect(renamed("src/routes/index.tsx.tera", source, "acme")).toBe(
			[
				"{% if include_demos -%}",
				'import { Button } from "@acme/ui/components/button";',
				'import { Link } from "@tanstack/react-router";',
				"{%- else -%}",
				'import { Button } from "@acme/ui/components/button";',
				'import { SITE_NAME } from "@/lib/site";',
				"{%- endif %}",
				'import "./styles.css";',
				'import { a } from "@tabler/icons-react";',
				"// The shell.",
				'import { b } from "@acme/app-shell/b";',
				"",
			].join("\n"),
		);
	});

	test("pass a template's block as a whole", () => {
		const source = [
			'import { TanStackDevtools } from "@tanstack/react-devtools";',
			"{%- if include_demos %}",
			'import type { QueryClient } from "@tanstack/react-query";',
			"{%- endif %}",
			"import {",
			"{%- if include_demos %}",
			"\tcreateRootRouteWithContext,",
			"{%- else %}",
			"\tcreateRootRoute,",
			"{%- endif %}",
			"\tHeadContent,",
			'} from "@tanstack/react-router";',
			'import { SiteLayout } from "@vern/app-shell/tanstack/site-layout";',
			"{%- if include_demos %}",
			'import { SiteNav } from "../components/site-nav";',
			"{%- endif %}",
			'import { SITE_NAME } from "../lib/site";',
			"",
			"export const Route = 1;",
			"",
		].join("\n");
		const lines = source.split("\n");
		expect(renamed("src/routes/__root.tsx.tera", source, "acme")).toBe(
			[
				'import { SiteLayout } from "@acme/app-shell/tanstack/site-layout";',
				...lines.slice(0, 12),
				...lines.slice(13),
			].join("\n"),
		);
		// `@tanstack/app-shell` is before `@tanstack/react-devtools` too.
		expect(
			renamed("src/routes/__root.tsx.tera", source, "tanstack").split("\n")[0],
		).toBe('import { SiteLayout } from "@tanstack/app-shell/tanstack/site-layout";');
	});

	test("stay where they are when a block has imports on both sides of them", () => {
		const source = [
			"{%- if include_demos %}",
			'import { a } from "@base-ui/react";',
			'import { b } from "@tanstack/react-query";',
			"{%- endif %}",
			'import { c } from "@vern/ui/c";',
			"",
		].join("\n");
		// `@nova` belongs between the two, which no place outside the block gives.
		expect(renamed("src/a.tsx.tera", source, "nova")).toBe(
			source.replace("@vern/", "@nova/"),
		);
		expect(renamed("src/a.tsx.tera", source, "acme").split("\n")[0]).toBe(
			'import { c } from "@acme/ui/c";',
		);
	});

	test("keep the blank lines of a chunk whose order holds", () => {
		const source = [
			'import { a } from "@tanstack/react-query";',
			"",
			"import {",
			"\tb,",
			"\tc,",
			'} from "@vern/ui/b";',
			"",
			'import { d } from "react";',
			"",
			"const e = 1;",
			"",
		].join("\n");
		expect(renamed("src/a.ts", source, "zeta")).toBe(
			[
				'import { a } from "@tanstack/react-query";',
				"",
				'import { b, c } from "@zeta/ui/b";',
				"",
				'import { d } from "react";',
				"",
				"const e = 1;",
				"",
			].join("\n"),
		);
	});

	test("leave other files, other styles, and other imports as they are", () => {
		const long =
			'import { SidebarInset, SidebarProvider } from "@vern/ui/components/sidebar";\n';
		// Not a source file.
		expect(renamed("README.md", long, "acme-board")).toBe(
			long.replace("@vern/", "@acme-board/"),
		);
		// Single quotes and no semicolons: not formatted by Biome here.
		const other = [
			"import { z } from '@tabler/icons-react'",
			"import { SidebarInset, SidebarProvider } from '@vern/ui/components/sidebar'",
			"",
		].join("\n");
		expect(renamed("src/a.stories.tsx", other, "acme-board")).toBe(
			other.replace("@vern/", "@acme-board/"),
		);
		// A long import of another package is not the rename's to wrap.
		const foreign =
			'import { SidebarInset, SidebarProvider, SidebarTrigger } from "@tabler/icons-react";\nimport { a } from "@vern/ui/a";\n';
		expect(renamed("src/a.ts", foreign, "zeta")).toBe(
			foreign.replace("@vern/", "@zeta/"),
		);
	});

	test("order scopes the way Biome does", () => {
		// As `biome check --write` (2.5.15) left them.
		const sorted = [
			"@a/x",
			"@a-/x",
			"@a--b/x",
			"@a-9/x",
			"@a-b/x",
			"@a1/x",
			"@a1-b/x",
			"@a1b/x",
			"@a9/x",
			"@a9b/x",
			"@a09/x",
			"@a10/x",
			"@a12/x",
			"@ab/a",
			"@ab/a/b",
			"@ab/a.b",
			"@ab/a-b",
			"@ab/a1",
			"@ab/ab",
			"@ab/z",
			"@ab.c/a",
			"@ab_c/a",
			"@ab-c/a",
			"@ab~c/a",
			"@ab1/a",
			"@abc/a",
			"@acme/ui",
			"@acme/ui/components/side",
			"@acme/ui/components/side-bar",
			"@acme/ui/components/sidebar",
			"@acme/ui/x",
			"@acme/ui-kit",
			"@acme.x/ui",
			"@acme_x/ui",
			"@acme-board/ui/x",
			"@acme2/ui",
			"@acme10/ui",
			"@base/app-shell",
			"@base/ui/components/button",
			"@base-ui/react",
			"@tabler/icons-react",
			"@tan/ui",
			"@tanstack/react-query",
			"@tanstack-x/ui",
		];
		expect([...sorted].reverse().sort(comparePackages)).toEqual(sorted);
	});
});

/**
 * Biome itself on the shared packages after a rename. It is installed with
 * the workspace; a copy with no install has nothing to check with.
 */
describe("the shared packages after a rename", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	const packages = existsSync(resolve(ROOT, "packages"))
		? readdirSync(resolve(ROOT, "packages")).filter((name) =>
				existsSync(resolve(ROOT, "packages", name, "biome.json")),
			)
		: [];
	const biome = packages
		.map((name) =>
			resolve(ROOT, "packages", name, "node_modules/@biomejs/biome/bin/biome"),
		)
		.find((path) => existsSync(path));
	const from = readConfig(ROOT)?.project ?? VERN;

	for (const slug of ["a", "acme-board", "tanstack", "zeta-industries-platform"]) {
		test.skipIf(!biome || slug === from.slug)(
			"pass `biome check` as @" + slug,
			() => {
				const root = mkdtempSync(join(tmpdir(), "vern-imports-"));
				roots.push(root);
				for (const name of packages) {
					const folder = resolve(ROOT, "packages", name);
					cpSync(resolve(folder, "biome.json"), resolve(root, name, "biome.json"), {
						recursive: true,
					});
					for (const path of listTextFiles(resolve(folder, "src"))) {
						const file = join("packages", name, "src", path);
						const target = resolve(root, name, "src", path);
						cpSync(resolve(ROOT, file), target, { recursive: true });
						writeFileSync(
							target,
							rebrandText(file, readFileSync(target, "utf8"), from, {
								name: "Acme",
								slug,
							}),
						);
					}
					const result = run(
						process.execPath,
						[biome as string, "check", "--error-on-warnings", "."],
						{ cwd: resolve(root, name), allowFailure: true },
					);
					expect(
						result.status,
						relative(ROOT, folder) + "\n" + result.stdout + result.stderr,
					).toBe(0);
				}
			},
		);
	}
});
