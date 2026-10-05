// The web templates list the dependencies only their demos import inside one
// `{% if include_demos %}` block, first in its section so that the last entry,
// which has no comma, always stays. `moon generate` renders the block; a script
// cannot parse the file as JSON until it has done the same.
const DEMO_OPEN = "{% if include_demos %}";
const DEMO_CLOSE = "{% endif %}";
const DEMO_BLOCK =
	/\{% if include_demos %\}((?: +"[^"\n]+": "[^"\n]*",\n)+)\{% endif %\}/g;

/** The template as `moon generate` writes it, apart from the name placeholder. */
export function renderPackageTemplate(
	template: string,
	includeDemos: boolean,
): string {
	return template.replace(DEMO_BLOCK, includeDemos ? "$1" : "");
}

/** The names of the dependencies inside the template's demo blocks. */
export function demoDependencies(template: string): string[] {
	const names: string[] = [];
	for (const block of template.matchAll(DEMO_BLOCK)) {
		for (const entry of (block[1] ?? "").matchAll(/"([^"\n]+)": /g)) {
			if (entry[1]) names.push(entry[1]);
		}
	}
	return names;
}

/**
 * Serializes a manifest as a template again: the `demoOnly` dependencies move
 * to the top of their section, inside the block.
 */
export function formatPackageTemplate(
	manifest: Record<string, unknown>,
	demoOnly: string[],
): string {
	const ordered: Record<string, unknown> = { ...manifest };
	const counts: Record<string, number> = {};
	for (const section of ["dependencies", "devDependencies"]) {
		const entries = manifest[section] as Record<string, string> | undefined;
		if (!entries) continue;
		const names = Object.keys(entries);
		const demo = names.filter((name) => demoOnly.includes(name));
		if (demo.length === 0) continue;
		if (demo.length === names.length)
			throw new Error(
				"Every entry of " +
					section +
					" is demo-only; the package template needs one that stays.",
			);
		counts[section] = demo.length;
		ordered[section] = Object.fromEntries(
			[...demo, ...names.filter((name) => !demo.includes(name))].map(
				(name) => [name, entries[name]],
			),
		);
	}
	let text = JSON.stringify(ordered, null, 2) + "\n";
	for (const [section, count] of Object.entries(counts)) {
		const block = new RegExp(
			'(\\n  "' + section + '": \\{\\n)((?: +"[^"\\n]+": "[^"\\n]*",\\n){' + count + "})",
		);
		text = text.replace(block, "$1" + DEMO_OPEN + "$2" + DEMO_CLOSE);
	}
	return text;
}
