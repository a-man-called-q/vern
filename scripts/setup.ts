import { runCommand } from "./lib/cli";
import { setup } from "./setup/setup";

if (import.meta.main) runCommand("setup", () => setup(process.argv.slice(2)));
