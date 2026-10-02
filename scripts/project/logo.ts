/** Brand logos carry the project name as SVG text, in a fixed 250 wide box. */
export function isLogoSvg(path: string): boolean {
	return /^apps\/auth-server\/brand\/logo-[^/]+\.svg$/.test(path);
}

const LOGO_FONT_SIZE = 38;
const LOGO_LETTER_SPACING = -1.2;
// Room right of the mark in the 250 wide viewBox (text starts at x=78).
const LOGO_TEXT_ROOM = 166;
const LOGO_MIN_FONT_SIZE = 14;
// Average advance of a bold lowercase glyph at LOGO_FONT_SIZE, letter spacing included.
const LOGO_GLYPH_ADVANCE = 20.8;

function setAttribute(attributes: string, name: string, value?: string): string {
	const pattern = new RegExp(`\\s${name}="[^"]*"`);
	if (value === undefined) return attributes.replace(pattern, "");
	if (pattern.test(attributes)) return attributes.replace(pattern, ` ${name}="${value}"`);
	return `${attributes} ${name}="${value}"`;
}

/**
 * Makes the logo's name fit the box whatever its length. Names that fit keep the
 * shipped size; longer ones shrink, and `textLength` pins the result inside the
 * box even when the font's real widths differ from the estimate. It always starts
 * from the base size, so renaming again (or to a short name) restores the look.
 */
export function fitLogoText(svg: string): string {
	return svg.replace(
		/<text\b([^>]*)>([^<]*)<\/text>/,
		(_match, attributes: string, label: string) => {
			let fitted = attributes;
			const natural = label.length * LOGO_GLYPH_ADVANCE;
			if (natural <= LOGO_TEXT_ROOM) {
				fitted = setAttribute(fitted, "font-size", String(LOGO_FONT_SIZE));
				fitted = setAttribute(fitted, "letter-spacing", String(LOGO_LETTER_SPACING));
				fitted = setAttribute(fitted, "textLength");
				fitted = setAttribute(fitted, "lengthAdjust");
			} else {
				const scale = LOGO_TEXT_ROOM / natural;
				const size = Math.max(
					LOGO_MIN_FONT_SIZE,
					Math.floor(LOGO_FONT_SIZE * scale * 10) / 10,
				);
				const spacing = Math.round(LOGO_LETTER_SPACING * (size / LOGO_FONT_SIZE) * 100) / 100;
				fitted = setAttribute(fitted, "font-size", String(size));
				fitted = setAttribute(fitted, "letter-spacing", String(spacing));
				fitted = setAttribute(fitted, "textLength", String(LOGO_TEXT_ROOM));
				fitted = setAttribute(fitted, "lengthAdjust", "spacingAndGlyphs");
			}
			return `<text${fitted}>${label}</text>`;
		},
	);
}
