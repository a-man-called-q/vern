import { runCommand } from "./lib/cli";
import { ROOT } from "./lib/paths";
import { chooseEnvironments, describeResult, environmentFlag } from "./project/choose";
import { CONFIG_PATH, readConfig } from "./project/config";
import { type Choice, describeEnvironments, type Environments } from "./project/environments";

const USAGE = `Usage: bun scripts/stack-project.ts --local <how> --staging <how> --prod <how>

Chooses how each environment of the project runs, and makes the project hold
only what that needs.

  --local <how>     The rehearsal of production on this machine:
                    none, compose (Docker Compose), or kubernetes (a kind cluster)
  --staging <how>   none, compose, or kubernetes
  --prod <how>      compose or kubernetes

The choice is saved in ${CONFIG_PATH}. What no environment uses is deleted:
deploy/compose without Docker Compose; deploy/base, the apps' k8s/, and the
workflow that pushes images without Kubernetes; and the overlay in the folder of
an environment that does not run on Kubernetes. Run it again with another
choice and the files come back from Vern. An environment left out keeps its
choice; the first time, name all three. deploy/dev is not a choice: it is the
Docker Compose stacks the apps depend on while you develop.`;

function parseArgs(argv: string[]): Partial<Environments> | undefined {
	const requested: Partial<Environments> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (arg === "--help" || arg === "-h") return undefined;
		const [flag, inline] = arg.split("=", 2) as [string, string | undefined];
		const environment = environmentFlag(flag);
		if (!environment) throw new Error("Unknown option: " + arg);
		const value = inline ?? argv[++i];
		if (!value) throw new Error(`${flag} needs a value.`);
		requested[environment] = value as Choice;
	}
	return requested;
}

if (import.meta.main)
	runCommand("stack-project", () => {
		const argv = process.argv.slice(2);
		const requested = parseArgs(argv);
		if (!requested) {
			console.log(USAGE);
			return undefined;
		}
		if (argv.length === 0) {
			const environments = readConfig(ROOT)?.environments;
			console.log(
				environments
					? `Environments: ${describeEnvironments(environments)}.\n`
					: "This project has not chosen how its environments run, so it holds both ways.\n",
			);
			console.log(USAGE);
			return undefined;
		}
		for (const line of describeResult(chooseEnvironments(ROOT, requested))) console.log(line);
		return undefined;
	});
