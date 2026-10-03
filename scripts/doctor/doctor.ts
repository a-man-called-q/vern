import { errorMessage } from "../lib/errors";
import { checkAccess } from "./access";
import { checkEnvironments } from "./environments";
import { checkIdentity } from "./identity";
import { checkKubernetes } from "./kubernetes";
import { checkPorts, describePortErrors, PORTS_OK } from "./ports";
import type { Level } from "./report";
import { checkTools } from "./tools";
import { checkWorkspace } from "./workspace";

/**
 * Runs every check against the workspace at `root`, printing each finding as it
 * comes, and returns how many failed.
 */
export function runDoctor(root: string, log: (message: string) => void = console.log): number {
	const counts: Record<Level, number> = { OK: 0, INFO: 0, WARN: 0, FAIL: 0 };
	const report = (level: Level, message: string): void => {
		counts[level] += 1;
		log("[" + level + "] " + message);
	};

	checkTools(root, report);
	checkIdentity(root, report);
	checkAccess(root, report);
	checkWorkspace(root, report);
	checkKubernetes(root, report);
	checkEnvironments(root, report);

	try {
		const portErrors = checkPorts(root);
		if (portErrors.length === 0) report("OK", PORTS_OK);
		else report("FAIL", describePortErrors(portErrors));
	} catch (error) {
		report("FAIL", errorMessage(error));
	}

	log(
		"\nDoctor finished: " +
			counts.FAIL +
			" failure(s), " +
			counts.WARN +
			" warning(s).",
	);
	return counts.FAIL;
}
