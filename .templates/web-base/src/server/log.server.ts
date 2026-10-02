const MAX_LENGTH = 200;

/** Makes a value safe for one log line: no control characters, bounded length. */
export function sanitizeForLog(value: unknown): string {
	const text = String(value ?? "");
	let clean = "";
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;
		clean += code < 32 || code === 127 ? " " : character;
	}
	return clean.length > MAX_LENGTH ? `${clean.slice(0, MAX_LENGTH)}...` : clean;
}

/**
 * Describes an error using only stable, non-secret fields. It never includes
 * `cause`, request or response bodies, tokens, or cookies.
 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return sanitizeForLog(error);

	const fields = error as Error & Record<string, unknown>;
	const details = ["code", "error", "error_description", "status"]
		.filter((key) => fields[key] !== undefined)
		.map((key) => `${key}=${sanitizeForLog(fields[key])}`);
	const summary = `${error.name}: ${sanitizeForLog(error.message)}`;
	return details.length > 0 ? `${summary} (${details.join(", ")})` : summary;
}

/** An authentication step failed. Logged so production issues can be traced. */
export function logAuthFailure(step: string, error: unknown) {
	console.error(`[auth] ${step} failed: ${describeError(error)}`);
}

/** A step degraded or was refused, but the request itself carried on. */
export function logAuthWarning(step: string, error: unknown) {
	console.warn(`[auth] ${step}: ${describeError(error)}`);
}
