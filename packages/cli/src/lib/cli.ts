import { errorMessage } from "./errors";

/**
 * Runs a command's `main` and turns its result into the exit code: the number it
 * returns, or 1 with the message (after `prefix`) when it throws.
 */
export function runCommand(
	prefix: string,
	main: () => number | undefined | Promise<number | undefined>,
): void {
	Promise.resolve()
		.then(main)
		.then(
			(code) => {
				if (code !== undefined) process.exitCode = code;
			},
			(error: unknown) => {
				console.error((prefix ? `${prefix}: ` : "") + errorMessage(error));
				process.exitCode = 1;
			},
		);
}
