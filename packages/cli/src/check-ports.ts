import { describePortErrors, checkPorts, PORTS_OK } from "./doctor/ports";
import { ROOT } from "./lib/paths";

export function checkPortsCommand(): number {
	const errors = checkPorts(ROOT);
	if (errors.length > 0) {
		console.error(describePortErrors(errors));
		return 1;
	}
	console.log(PORTS_OK);
	return 0;
}
