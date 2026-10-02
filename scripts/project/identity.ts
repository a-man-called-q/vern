import { fitLogoText, isLogoSvg } from "./logo";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function replaceIdentity(
	text: string,
	from: { name: string; slug: string },
	to: { name: string; slug: string },
): string {
	if (from.name === to.name && from.slug === to.slug) return text;
	const urls: string[] = [];
	const configPaths: string[] = [];
	// URLs and container images name published upstream resources, such as the
	// Vern Login image, that keep their names after a rename.
	const protectedText = text
		.replace(/(?:https?:\/\/|\bghcr\.io\/)[^\s"'`<>]+/g, (url) => {
			const marker = `__VERN_PRESERVED_URL_${urls.length}__`;
			urls.push(url);
			return marker;
		})
		.replace(/\.vern(?=\/|$)/g, () => {
			const marker = `__VERN_CONFIG_PATH_${configPaths.length}__`;
			configPaths.push(".vern");
			return marker;
		});
	// One pass over the original text: a replacement is never scanned again, so a
	// new identity that contains the old one (a project called "testing-vern-aja")
	// is not substituted a second time. Alternatives are tried in this order.
	const upperSlug = from.slug.toUpperCase();
	const tokens = new RegExp(
		[
			escapeRegExp(`@${from.slug}/`),
			escapeRegExp(`${from.slug}-auth`),
			escapeRegExp(`--${from.slug}-`),
			`\\b${escapeRegExp(from.name)}\\b`,
			`\\b${escapeRegExp(upperSlug)}\\b`,
			`\\b${escapeRegExp(from.slug)}\\b`,
		].join("|"),
		"g",
	);
	let output = protectedText.replace(tokens, (match) => {
		if (match === `@${from.slug}/`) return `@${to.slug}/`;
		if (match === `${from.slug}-auth`) return `${to.slug}-auth`;
		if (match === `--${from.slug}-`) return `--${to.slug}-`;
		if (match === from.name) return to.name;
		if (match === upperSlug) return to.slug.toUpperCase();
		return to.slug;
	});
	output = output.replace(
		/__VERN_PRESERVED_URL_(\d+)__/g,
		(_match, index: string) => urls[Number(index)],
	);
	output = output.replace(
		/__VERN_CONFIG_PATH_(\d+)__/g,
		(_match, index: string) => configPaths[Number(index)],
	);
	return output;
}

/** `replaceIdentity` plus the fixes that depend on the file (the logo's text fit). */
export function rebrandText(
	path: string,
	text: string,
	from: { name: string; slug: string },
	to: { name: string; slug: string },
): string {
	const replaced = replaceIdentity(text, from, to);
	return isLogoSvg(path) ? fitLogoText(replaced) : replaced;
}

export function validateIdentity(name: string, slug: string): void {
	if (!name.trim()) throw new Error("--name must not be empty.");
	if (!/^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u.test(name.trim())) {
		throw new Error(
			"--name may contain letters, numbers, spaces, periods, and hyphens.",
		);
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new Error(
			"--slug must be lowercase kebab-case (for example, acme-platform).",
		);
	}
}
