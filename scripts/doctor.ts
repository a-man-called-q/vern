import { runDoctor } from "./doctor/doctor";
import { runCommand } from "./lib/cli";
import { ROOT } from "./lib/paths";

if (import.meta.main) runCommand("", () => (runDoctor(ROOT) > 0 ? 1 : 0));
