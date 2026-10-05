import { run } from "../lib/run";
import { hasCargoEdit } from "../project/cargo-edit";
import type { Report } from "./report";

function checkCommand(root: string, command: string, args: string[], label: string, report: Report): void {
	const result = run(command, args, { cwd: root, allowFailure: true });
	if (result.status !== 0) {
		report("FAIL", label + " is unavailable. " + result.stderr.trim());
		return;
	}
	report("OK", label + ": " + result.stdout.trim().split(/\r?\n/)[0]);
}

/** The tools the workspace runs on. */
export function checkTools(root: string, report: Report): void {
	checkCommand(root, "bun", ["--version"], "Bun", report);
	checkCommand(root, "moon", ["--version"], "Moon", report);
	checkCommand(root, "cargo", ["--version"], "Cargo", report);
	checkCommand(root, "docker", ["compose", "version", "--short"], "Docker Compose", report);
	if (hasCargoEdit(root)) {
		report("OK", "cargo-edit is ready for Rust dependency upgrades.");
	} else {
		report(
			"WARN",
			"Install cargo-edit with `cargo install cargo-edit` before upgrading Rust dependencies.",
		);
	}
}
