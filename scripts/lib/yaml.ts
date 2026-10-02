/**
 * Writes plain data (objects, arrays, strings, numbers, booleans) as block
 * YAML. Strings that could read as anything else are double-quoted.
 */
export function toYaml(value: unknown, indent = 0): string {
	return `${emit(value, indent).replace(/^\n/, "")}\n`;
}

const PLAIN = /^[A-Za-z_./][A-Za-z0-9_./:-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;

function scalar(value: unknown): string {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "null";
	const text = String(value);
	return PLAIN.test(text) && !RESERVED.test(text) && !text.endsWith(":") ? text : JSON.stringify(text);
}

function isBlock(value: unknown): boolean {
	return (Array.isArray(value) && value.length > 0) || (isObject(value) && Object.keys(value).length > 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emit(value: unknown, indent: number): string {
	const pad = " ".repeat(indent);
	if (Array.isArray(value)) {
		if (value.length === 0) return " []";
		return value
			.map((item) => {
				if (!isBlock(item)) return `\n${pad}- ${scalar(item)}`;
				if (Array.isArray(item)) return `\n${pad}-${emit(item, indent + 2)}`;
				// The first key of an object shares the dash's line.
				const nested = emit(item, indent + 2);
				return `\n${pad}- ${nested.slice(indent + 3)}`;
			})
			.join("");
	}
	if (isObject(value)) {
		const entries = Object.entries(value).filter(([, item]) => item !== undefined);
		if (entries.length === 0) return " {}";
		return entries
			.map(([key, item]) => {
				const name = PLAIN.test(key) ? key : JSON.stringify(key);
				return isBlock(item) || Array.isArray(item) || isObject(item)
					? `\n${pad}${name}:${emit(item, indent + 2)}`
					: `\n${pad}${name}: ${scalar(item)}`;
			})
			.join("");
	}
	return ` ${scalar(value)}`;
}
