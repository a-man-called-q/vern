import { runCommand } from "./lib/cli";
import { ROOT } from "./lib/paths";
import { type Options, updateProject } from "./project/update";

function parseArgs(argv: string[]): Options | undefined {
	let apply = false;
	let continueUpdate = false;
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") return undefined;
		if (arg === "--apply") apply = true;
		else if (arg === "--continue") continueUpdate = true;
		else throw new Error("Unknown option: " + arg);
	}
	if (apply && continueUpdate)
		throw new Error("Use either --apply or --continue.");
	return { apply, continueUpdate };
}

function help(): void {
	console.log(
		"Usage: bun scripts/update-project.ts [--apply | --continue]\n\nDefault: fetch Vern main and preview changed files.\n--apply: create a review branch, merge upstream changes, upgrade dependencies, and validate.\n--continue: resume a pending update after resolving file conflicts or a failed dependency/validation step.",
	);
}

if (import.meta.main)
	runCommand("update-project", () => {
		const options = parseArgs(process.argv.slice(2));
		if (!options) help();
		else updateProject(ROOT, options);
		return undefined;
	});
