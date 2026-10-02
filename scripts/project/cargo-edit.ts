import { run } from "../lib/run";

/** Whether `cargo upgrade` (from cargo-edit) is installed. */
export function hasCargoEdit(root: string): boolean {
	const result = run("cargo", ["upgrade", "--help"], {
		cwd: root,
		allowFailure: true,
	});
	return (
		result.status === 0 &&
		result.stdout.includes("Upgrade dependency version requirements")
	);
}

export function requireCargoEdit(root: string): void {
	if (!hasCargoEdit(root))
		throw new Error(
			"cargo-edit is required to update Rust dependencies. Install it with: cargo install cargo-edit",
		);
}
