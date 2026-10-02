// The Axum template marks a dependency that only some APIs need by wrapping its
// line in a Tera condition: `{% if database %}sqlx = ...\n{% endif %}`. Cargo
// cannot read the markers, so they come off for `cargo upgrade` and go back
// around the same dependencies afterwards. The conditions are read from the
// template itself; there is no hand-kept list to fall behind it.

/** One dependency line that the template wraps in `{% if <flag> %}`. */
export type CargoCondition = { flag: string; section: string; name: string };

const CONDITIONAL_LINE =
	/\{% if (\w+) %\}([A-Za-z0-9_-]+) = [^\n]*\n\{% endif %\}/g;
const SECTION_HEADER = /^\[([^\]]+)\]\s*$/;

/** The conditional dependency lines of the template, in order. */
export function cargoConditions(template: string): CargoCondition[] {
	const conditions: CargoCondition[] = [];
	for (const match of template.matchAll(CONDITIONAL_LINE)) {
		const before = template.slice(0, match.index).split("\n");
		let section = "";
		for (const line of before) {
			const header = SECTION_HEADER.exec(line);
			if (header?.[1]) section = header[1];
		}
		if (match[1] && match[2])
			conditions.push({ flag: match[1], section, name: match[2] });
	}
	return conditions;
}

/**
 * The template with every condition taken as true, which is TOML. Fails on a
 * Tera marker that is not one conditional dependency line, rather than handing
 * Cargo a file it cannot read.
 */
export function stripCargoConditions(template: string): string {
	const stripped = template.replace(CONDITIONAL_LINE, (block) =>
		block.replace(/^\{% if \w+ %\}/, "").replace(/\{% endif %\}$/, ""),
	);
	const leftover = stripped.split("\n").find((line) => line.includes("{%"));
	if (leftover !== undefined)
		throw new Error(
			"The Axum Cargo template has a Tera marker that is not one conditional dependency line: " +
				leftover,
		);
	return stripped;
}

/** Puts each condition back around its dependency in an upgraded manifest. */
export function restoreCargoConditions(
	manifest: string,
	conditions: CargoCondition[],
): string {
	const lines = manifest.split("\n");
	const opens = lines.map(() => "");
	const closes = lines.map(() => "");
	for (const condition of conditions) {
		let section = "";
		const index = lines.findIndex((line) => {
			const header = SECTION_HEADER.exec(line);
			if (header?.[1]) {
				section = header[1];
				return false;
			}
			return (
				section === condition.section && line.startsWith(condition.name + " = ")
			);
		});
		if (index === -1 || index + 1 >= lines.length)
			throw new Error(
				"The upgraded Axum Cargo manifest has no " +
					condition.name +
					" line in [" +
					condition.section +
					"] to put its {% if " +
					condition.flag +
					" %} back around.",
			);
		opens[index] += "{% if " + condition.flag + " %}";
		closes[index + 1] += "{% endif %}";
	}
	// An `{% endif %}` closes the line before it, so it comes ahead of an
	// `{% if %}` that opens the line it sits on.
	return lines
		.map((line, index) => (closes[index] ?? "") + (opens[index] ?? "") + line)
		.join("\n");
}
