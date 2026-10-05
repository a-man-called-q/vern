import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../project/config";
import { describeEnvironments, ENVIRONMENTS, type Environments, keyFiles, METHOD_LABELS } from "../project/environments";
import type { Report } from "./report";

/** The command that makes the project hold what `environments` needs, and nothing else. */
function stackCommand(environments: Environments): string {
	return `bun run project:stack -- ${ENVIRONMENTS.map((environment) => `--${environment} ${environments[environment]}`).join(" ")}`;
}

/**
 * The project holds what the way each environment runs needs, and not the
 * rest. A project that has not chosen keeps both ways, and is not checked.
 */
export function checkEnvironments(root: string, report: Report): void {
	let environments: Environments | undefined;
	try {
		environments = readConfig(root)?.environments;
	} catch {
		// checkIdentity reports a config that cannot be read.
		return;
	}
	if (!environments) return;
	const has = (path: string) => existsSync(resolve(root, path));
	const files = keyFiles(environments);
	const missing = files.filter(({ file, used }) => used && !has(file)).map(({ file }) => file);
	const unused = files
		.filter(({ file, used }) => !used && has(file))
		.map(({ file, method, environment }) =>
			environment ? `${file} (${environment} does not run on Kubernetes)` : `${file} (no environment uses ${METHOD_LABELS[method]})`,
		);
	const summary = describeEnvironments(environments);
	if (missing.length > 0) {
		report("FAIL", `The environments (${summary}) need ${missing.join(", ")}. \`${stackCommand(environments)}\` brings Vern's files back.`);
	}
	if (unused.length > 0) {
		report("WARN", `The project holds ${unused.join(", ")}. \`${stackCommand(environments)}\` removes what the environments (${summary}) do not use.`);
	}
	if (missing.length === 0 && unused.length === 0) report("OK", `Environments: ${summary}; the project holds what they need.`);
}
