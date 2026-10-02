import { runCommand } from "./lib/cli";
import { ROOT } from "./lib/paths";
import { type Options, updateProject } from "./project/update";

function parseArgs(argv: string[]): Options | undefined {
	let apply = false;
	let continueUpdate = false;
	let migrate = false;
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") return undefined;
		if (arg === "--apply") apply = true;
		else if (arg === "--continue") continueUpdate = true;
		else if (arg === "--migrate") migrate = true;
		else throw new Error("Unknown option: " + arg);
	}
	if ([apply, continueUpdate, migrate].filter(Boolean).length > 1)
		throw new Error("Use one of --apply, --continue, or --migrate.");
	return { apply, continueUpdate, migrate };
}

function help(): void {
	console.log(
		"Usage: bun scripts/update-project.ts [--apply | --continue | --migrate]\n\nDefault: fetch Vern main and preview changed files.\n--apply: create a review branch, merge upstream changes, upgrade dependencies, and validate.\n--continue: resume a pending update after resolving file conflicts or a failed dependency/validation step.\n--migrate: only move the APIs to services/, the Compose stacks to deploy/dev/, and a deployment's settings to its environment under deploy/ (for a project made before that layout).",
	);
}

if (import.meta.main)
	runCommand("update-project", () => {
		const options = parseArgs(process.argv.slice(2));
		if (!options) help();
		else updateProject(ROOT, options);
		return undefined;
	});
