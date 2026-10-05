import { runDoctor } from "./doctor/doctor";
import { ROOT } from "./lib/paths";

export function doctorCommand(): number {
	return runDoctor(ROOT) > 0 ? 1 : 0;
}
