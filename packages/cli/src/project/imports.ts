/**
 * A rename changes the length of `@<slug>/…` and where it sorts, and Biome
 * checks both in the packages and in every generated web app: an import that
 * no longer fits in a line has to wrap, one that fits again has to join, and
 * `organizeImports` wants the statement among its neighbours in a new place.
 * Biome is not installed when a new project is renamed and cannot read the
 * `.tera` templates, so the rename does this part of its work itself, for the
 * statements it rewrote and nothing else.
 *
 * Only statements written the way Biome formats them here are touched (double
 * quotes, a semicolon, tabs); a file in another style is left as it is.
 */

const LINE_WIDTH = 80;

const SOURCE_FILE = /\.[cm]?[jt]sx?(?:\.tera|\.raw)?$/;

export function isSourceFile(path: string): boolean {
	return SOURCE_FILE.test(path);
}

interface Statement {
	keyword: string;
	/** Its first line in the file. */
	start: number;
	lines: string[];
	source: string;
	/** One of the project's own packages, which the rename has just renamed. */
	scoped: boolean;
}

type IsRenamed = (line: number, source: string) => boolean;

/**
 * A template's `{% if %}` … `{% endif %}` around some statements: `tags` are
 * its lines, and `branches` what is between each two of them.
 */
interface Block {
	tags: string[];
	branches: Item[][];
}

type Item = Statement | Block;

/** Statements that Biome sorts as one, in a template with the blocks among them. */
interface Chunk {
	start: number;
	/** The line after the last one. */
	end: number;
	items: Item[];
}

type Token =
	| { kind: "statement"; index: number; statement: Statement }
	| { kind: "if" | "else" | "endif"; index: number; line: string };

const TERA = /\{[{%#]/;
const TAG = /^\{%-? *(if|elif|else|endif)\b[^%]*%\}$/;
const ONE_LINE = /^(import|export) .* from "([^"]+)";$/;
const OPENING = /^(import|export) [^"']*\{$/;
const SPECIFIER = /^\t[\w$ ]+,?$/;
const CLOSING = /^\} from "([^"]+)";$/;
const NAMED =
	/^(import|export)( type)?( [\w$]+,)? \{([^{}]*)\} from "([^"]+)";$/;

function readStatement(
	lines: string[],
	index: number,
	isRenamed: IsRenamed,
): Statement | undefined {
	const line = lines[index] as string;
	let source: string | undefined;
	let length = 1;
	if (OPENING.test(line)) {
		// A template may choose between names with a tag inside the braces.
		let last = index + 1;
		while (SPECIFIER.test(lines[last] ?? "") || TAG.test(lines[last] ?? ""))
			last += 1;
		source = lines[last]?.match(CLOSING)?.[1];
		length = last - index + 1;
	} else if (!TERA.test(line)) source = line.match(ONE_LINE)?.[2];
	if (!source) return undefined;
	return {
		keyword: line.slice(0, 6),
		start: index,
		lines: lines.slice(index, index + length),
		source,
		scoped: isRenamed(index + length - 1, source),
	};
}

/**
 * The statements of a file in runs, with the template tags between them.
 * Blank lines stay inside a run; any other line ends it: code, a comment, an
 * import with no `from`, a re-export after imports.
 */
function findRuns(lines: string[], isRenamed: IsRenamed): Token[][] {
	const runs: Token[][] = [];
	let run: Token[] | undefined;
	let keyword: string | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] as string;
		if (line === "" && run) continue;
		const tag = line.match(TAG)?.[1];
		const statement = tag ? undefined : readStatement(lines, index, isRenamed);
		if (!tag && !statement) {
			run = undefined;
			continue;
		}
		if (!run || (statement && keyword && statement.keyword !== keyword)) {
			run = [];
			keyword = undefined;
			runs.push(run);
		}
		if (statement) {
			keyword = statement.keyword;
			run.push({ kind: "statement", index, statement });
			index += statement.lines.length - 1;
		} else {
			const kind = tag === "if" || tag === "endif" ? tag : "else";
			run.push({ kind, index, line });
		}
	}
	return runs;
}

/**
 * A run cut where a tag has no partner inside it (a block that opens above
 * the imports, or closes below them), so that every piece has whole blocks.
 */
function splitAtLooseTags(run: Token[]): Token[][] {
	const loose = new Set<Token>();
	const open: Token[][] = [];
	for (const token of run) {
		if (token.kind === "statement") continue;
		const block = open.at(-1);
		if (token.kind === "if") open.push([token]);
		else if (!block) loose.add(token);
		else if (token.kind === "else") block.push(token);
		else open.pop();
	}
	for (const token of open.flat()) loose.add(token);
	const pieces: Token[][] = [[]];
	for (const token of run) {
		if (loose.has(token)) pieces.push([]);
		else (pieces.at(-1) as Token[]).push(token);
	}
	return pieces;
}

function findChunks(lines: string[], isRenamed: IsRenamed): Chunk[] {
	const chunks: Chunk[] = [];
	for (const piece of findRuns(lines, isRenamed).flatMap(splitAtLooseTags)) {
		const last = piece.at(-1);
		if (!last) continue;
		const items: Item[] = [];
		const stack: Array<{ block: Block; parent: Item[] }> = [];
		let current = items;
		for (const token of piece) {
			if (token.kind === "statement") current.push(token.statement);
			else if (token.kind === "if") {
				const block: Block = { tags: [token.line], branches: [[]] };
				current.push(block);
				stack.push({ block, parent: current });
				current = block.branches[0] as Item[];
			} else {
				const { block, parent } = stack.at(-1) as (typeof stack)[number];
				block.tags.push(token.line);
				if (token.kind === "else") {
					current = [];
					block.branches.push(current);
				} else {
					stack.pop();
					current = parent;
				}
			}
		}
		chunks.push({
			start: (piece[0] as Token).index,
			end:
				last.kind === "statement"
					? last.index + last.statement.lines.length
					: last.index + 1,
			items,
		});
	}
	return chunks;
}

function isBlock(item: Item): item is Block {
	return "branches" in item;
}

function statementsOf(items: Item[]): Statement[] {
	return items.flatMap((item) =>
		isBlock(item) ? item.branches.flatMap(statementsOf) : [item],
	);
}

/**
 * One line when the statement fits, one name per line when it does not. A
 * statement with a single name and no default import stays on one line
 * whatever its length, as do those with no braces.
 */
function fit(statement: Statement): string[] {
	if (!statement.scoped) return statement.lines;
	const match = statement.lines.join("\n").match(NAMED);
	if (!match) return statement.lines;
	const [, keyword, type = "", fallback = "", list, source] = match;
	const names = (list as string)
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (names.length === 0) return statement.lines;
	const head = keyword + type + fallback + " {";
	const tail = '} from "' + source + '";';
	const oneLine = head + " " + names.join(", ") + " " + tail;
	if ((names.length === 1 && !fallback) || oneLine.length <= LINE_WIDTH)
		return [oneLine];
	return [head, ...names.map((name) => "\t" + name + ","), tail];
}

/** Biome's order inside a name: punctuation, then numbers, then letters. */
function rank(token: string): number {
	if (/\d/.test(token)) return 4;
	if (/[a-z]/i.test(token)) return 5;
	return [".", "_", "-", "~"].indexOf(token);
}

function compareSegments(left: string, right: string): number {
	const a = left.match(/\d+|\D/g) ?? [];
	const b = right.match(/\d+|\D/g) ?? [];
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const x = a[index] as string;
		const y = b[index] as string;
		if (x === y) continue;
		const order =
			rank(x) - rank(y) ||
			(rank(x) === 4 && (Number(x) - Number(y) || x.length - y.length)) ||
			x.toLowerCase().localeCompare(y.toLowerCase(), "en") ||
			(x < y ? -1 : 1);
		if (order !== 0) return order;
	}
	return a.length - b.length;
}

/** Two scoped packages, a folder at a time: `@acme/ui` is before `@acme-x/ui`. */
export function comparePackages(left: string, right: string): number {
	const a = left.split("/");
	const b = right.split("/");
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const order = compareSegments(a[index] as string, b[index] as string);
		if (order !== 0) return order;
	}
	return a.length - b.length;
}

/**
 * Whether a `@<slug>/…` import goes above `other`. Biome puts `node:` and the
 * like first, then packages (scoped ones before the rest), then aliases such
 * as `@/…`, then paths.
 */
function sortsBefore(scoped: string, other: string): boolean {
	if (/^[a-z][a-z\d+.-]*:/i.test(other)) return false;
	if (!/^@[^/]/.test(other)) return true;
	return comparePackages(scoped, other) < 0;
}

/**
 * The project's own imports keep their order among themselves, and so do the
 * others: only where the first group sits among the second changes. A block
 * is passed as a whole, since whichever branch is rendered the import has to
 * be on the same side of it; one it would belong inside leaves the order as
 * it is.
 */
function sort(items: Item[]): Item[] {
	const isScoped = (item: Item): item is Statement =>
		!isBlock(item) && item.scoped;
	const scoped = items.filter(isScoped);
	const sorted: Item[] = [];
	let next = 0;
	for (const other of items) {
		if (isScoped(other)) continue;
		const inside = statementsOf([other]);
		while (next < scoped.length) {
			const source = (scoped[next] as Statement).source;
			const below = inside.filter((statement) =>
				sortsBefore(source, statement.source),
			).length;
			if (below === 0 && inside.length > 0) break;
			if (below < inside.length) return items;
			sorted.push(scoped[next++] as Statement);
		}
		sorted.push(
			isBlock(other)
				? { tags: other.tags, branches: other.branches.map(sort) }
				: other,
		);
	}
	return [...sorted, ...scoped.slice(next)];
}

function render(items: Item[]): string[] {
	return items.flatMap((item) =>
		isBlock(item)
			? item.tags.flatMap((tag, index) => [
					tag,
					...render(item.branches[index] ?? []),
				])
			: fit(item),
	);
}

/**
 * `after`, the text a rename made of `before`, with the imports it moved to
 * `scope` (`@acme/`) wrapped and placed as Biome would have them. An import
 * that was in that scope already (a project named after a package scope it
 * uses) is not the rename's, and stays.
 */
export function fitImports(
	before: string,
	after: string,
	scope: string,
): string {
	if (before === after) return after;
	// A rename changes no line count, so a line has the same number in both.
	const original = before.split("\n");
	const lines = after.split("\n");
	const isRenamed: IsRenamed = (line, source) =>
		source.startsWith(scope) && lines[line] !== original[line];
	// From the last chunk to the first, so the line numbers above stay right.
	for (const chunk of findChunks(lines, isRenamed).reverse()) {
		const statements = statementsOf(chunk.items);
		if (!statements.some((statement) => statement.scoped)) continue;
		const sorted = sort(chunk.items);
		const moved = statementsOf(sorted).some(
			(statement, index) => statement !== statements[index],
		);
		if (moved) {
			// Biome's own fix drops the blank lines between the statements it moves.
			lines.splice(chunk.start, chunk.end - chunk.start, ...render(sorted));
			continue;
		}
		for (const statement of statements.reverse())
			lines.splice(statement.start, statement.lines.length, ...fit(statement));
	}
	return lines.join("\n");
}
