import { runCommand } from "./lib/cli";
import { ROOT } from "./lib/paths";
import { validateIdentity } from "./project/identity";
import { type Options, renameProject } from "./project/rename";

function parseArgs(argv: string[]): Options | undefined {
	let name = "";
	let slug = "";
	let apply = false;
	let base: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") return undefined;
		if (arg === "--apply") apply = true;
		else if (arg === "--name") name = argv[++i] ?? "";
		else if (arg === "--slug") slug = argv[++i] ?? "";
		else if (arg === "--base") base = argv[++i];
		else throw new Error("Unknown option: " + arg);
	}
	if (!name || !slug) throw new Error("Provide both --name and --slug.");
	validateIdentity(name, slug);
	return { name: name.trim(), slug, apply, base };
}

function help(): void {
	console.log("Usage: bun scripts/rename-project.ts --name <display name> --slug <kebab-case> [--apply] [--base <sha>]\n\nPreview is the default. Add --apply to rewrite the workspace and record its Vern upstream baseline.\nIf the baseline cannot be inferred from Git history or a matching tree, provide --base.");
}

if (import.meta.main)
	runCommand("rename-project", () => {
		const options = parseArgs(process.argv.slice(2));
		if (!options) help();
		else renameProject(ROOT, options);
		return undefined;
	});
