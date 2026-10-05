import { spawnSync } from "node:child_process";
import { ROOT } from "./paths";

export interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

export function run(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		allowFailure?: boolean;
		env?: NodeJS.ProcessEnv;
	} = {},
): CommandResult {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? ROOT,
		env: options.env ?? process.env,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.error) {
		if (options.allowFailure)
			return { status: 127, stdout: "", stderr: result.error.message };
		throw new Error(`${command} could not run: ${result.error.message}`);
	}
	const response = {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
	if (response.status !== 0 && !options.allowFailure) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${response.status}).\n${response.stderr.trim()}`,
		);
	}
	return response;
}

export function git(root: string, ...args: string[]): CommandResult {
	return run("git", args, { cwd: root });
}

export function gitTry(root: string, ...args: string[]): CommandResult {
	return run("git", args, { cwd: root, allowFailure: true });
}
