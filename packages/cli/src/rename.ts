import { CLI_PACKAGE } from "./lib/commands";
import { ROOT } from "./lib/paths";
import { CLI_SOURCE } from "./project/files";
import { validateIdentity } from "./project/identity";
import { type Options, renameProject } from "./project/rename";

function parseArgs(argv: string[]): Options | undefined {
	let name = "";
	let slug = "";
	let apply = false;
	let base: string | undefined;
	let keepCli = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") return undefined;
		if (arg === "--apply") apply = true;
		else if (arg === "--name") name = argv[++i] ?? "";
		else if (arg === "--slug") slug = argv[++i] ?? "";
		else if (arg === "--base") base = argv[++i];
		else if (arg === "--keep-cli") keepCli = true;
		else throw new Error("Unknown option: " + arg);
	}
	if (!name || !slug) throw new Error("Provide both --name and --slug.");
	validateIdentity(name, slug);
	return { name: name.trim(), slug, apply, base, keepCli };
}

const USAGE = `Usage: bun run project:rename -- --name <display name> --slug <kebab-case> [--apply] [--base <sha>]

Preview is the default. Add --apply to rewrite the workspace and record its Vern upstream baseline.
If the baseline cannot be inferred from Git history or a matching tree, provide --base.
The source of the CLI (${CLI_SOURCE}) leaves with the rename: a project installs ${CLI_PACKAGE} from npm.
--keep-cli keeps it, to try a rename in a checkout of Vern itself.`;

export function renameCommand(argv: string[]): undefined {
	const options = parseArgs(argv);
	if (!options) console.log(USAGE);
	else renameProject(ROOT, options);
	return undefined;
}
