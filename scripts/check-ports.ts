import { describePortErrors, checkPorts, PORTS_OK } from "./doctor/ports";
import { runCommand } from "./lib/cli";
import { ROOT } from "./lib/paths";

if (import.meta.main)
	runCommand("", () => {
		const errors = checkPorts(ROOT);
		if (errors.length > 0) {
			console.error(describePortErrors(errors));
			return 1;
		}
		console.log(PORTS_OK);
		return 0;
	});
