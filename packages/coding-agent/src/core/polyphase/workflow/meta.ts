/**
 * Extracts and validates `export const meta = {...}` from a workflow script, without running it.
 *
 * The parser accepts exactly the pure-literal grammar a model is expected to write: objects,
 * arrays, strings (quoted or template without `${}`), numbers, booleans, `null`, comments and
 * trailing commas. It rejects identifiers, calls, spreads, computed keys, `${}` interpolation and
 * regex literals, each with a 1-based line and column. See DESIGN.md §13.1.
 */

export interface WorkflowPhaseMeta {
	title: string;
	detail?: string;
	model?: string;
}

export interface WorkflowMeta {
	name: string;
	description: string;
	whenToUse?: string;
	phases: WorkflowPhaseMeta[];
}

export interface MetaError {
	message: string;
	line: number;
	column: number;
}

export type MetaExtraction =
	| { ok: true; meta: WorkflowMeta; body: string; warnings: string[] }
	| { ok: false; error: MetaError };

export const WORKFLOW_NAME_PATTERN: RegExp = /^[a-z][a-z0-9-]{0,47}$/;

const PEEK_HEAD_BYTES = 8 * 1024;
const PEEK_LINE_SCAN_BYTES = 256 * 1024;

interface Position {
	readonly pos: number;
	readonly line: number;
	readonly column: number;
}

interface ObjectEntry {
	readonly key: string;
	readonly value: LiteralNode;
}

type LiteralNode =
	| { kind: "object"; entries: ObjectEntry[]; pos: Position }
	| { kind: "array"; items: LiteralNode[]; pos: Position }
	| { kind: "string"; value: string; pos: Position }
	| { kind: "number"; value: number; pos: Position }
	| { kind: "boolean"; value: boolean; pos: Position }
	| { kind: "null"; pos: Position };

class MetaSyntaxError extends Error {
	readonly line: number;
	readonly column: number;
	constructor(message: string, line: number, column: number) {
		super(message);
		this.name = "MetaSyntaxError";
		this.line = line;
		this.column = column;
	}
}

function isIdentifierStart(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch: string | undefined): boolean {
	return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
	return ch !== undefined && ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string | undefined): boolean {
	return ch !== undefined && /[0-9a-fA-F]/.test(ch);
}

class Scanner {
	readonly source: string;
	pos = 0;
	line = 1;
	column = 1;

	constructor(source: string) {
		this.source = source;
	}

	peek(offset = 0): string | undefined {
		return this.source[this.pos + offset];
	}

	peekIs(text: string): boolean {
		return this.source.slice(this.pos, this.pos + text.length) === text;
	}

	position(): Position {
		return { pos: this.pos, line: this.line, column: this.column };
	}

	advance(): string | undefined {
		const ch = this.source[this.pos];
		if (ch === undefined) return undefined;
		this.pos++;
		if (ch === "\n") {
			this.line++;
			this.column = 1;
		} else {
			this.column++;
		}
		return ch;
	}

	fail(message: string, at?: Position): never {
		const p = at ?? this.position();
		throw new MetaSyntaxError(message, p.line, p.column);
	}

	skipTrivia(): void {
		for (;;) {
			const ch = this.peek();
			if (ch === undefined) return;
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
				this.advance();
				continue;
			}
			if (ch === "/" && this.peek(1) === "/") {
				while (this.peek() !== undefined && this.peek() !== "\n") this.advance();
				continue;
			}
			if (ch === "/" && this.peek(1) === "*") {
				this.advance();
				this.advance();
				while (!(this.peek() === "*" && this.peek(1) === "/")) {
					if (this.peek() === undefined) this.fail("unterminated comment");
					this.advance();
				}
				this.advance();
				this.advance();
				continue;
			}
			return;
		}
	}

	expectKeyword(word: string): void {
		this.skipTrivia();
		const at = this.position();
		if (this.source.slice(this.pos, this.pos + word.length) !== word || isIdentifierPart(this.peek(word.length))) {
			this.fail(`expected "${word}"`, at);
		}
		for (let i = 0; i < word.length; i++) this.advance();
	}

	expectChar(ch: string): void {
		this.skipTrivia();
		if (this.peek() !== ch) this.fail(`expected "${ch}"`);
		this.advance();
	}
}

function readEscape(scanner: Scanner): string {
	const ch = scanner.peek();
	if (ch === undefined) scanner.fail("unterminated string literal");
	scanner.advance();
	switch (ch) {
		case "n":
			return "\n";
		case "t":
			return "\t";
		case "r":
			return "\r";
		case "b":
			return "\b";
		case "f":
			return "\f";
		case "v":
			return "\v";
		case "0":
			return "\0";
		case "\n":
			return "";
		case "\r":
			if (scanner.peek() === "\n") scanner.advance();
			return "";
		case "\u2028":
		case "\u2029":
			return "";
		case "u":
			return readUnicodeEscape(scanner);
		case "x":
			return readHexEscape(scanner);
		default:
			return ch;
	}
}

function readUnicodeEscape(scanner: Scanner): string {
	const at = scanner.position();
	if (scanner.peek() === "{") {
		scanner.advance();
		let hex = "";
		while (scanner.peek() !== "}") {
			if (!isHexDigit(scanner.peek()) || hex.length >= 6) scanner.fail("invalid unicode escape", at);
			hex += scanner.advance();
		}
		scanner.advance();
		if (hex.length === 0) scanner.fail("invalid unicode escape", at);
		const codePoint = Number.parseInt(hex, 16);
		if (codePoint > 0x10ffff) scanner.fail("invalid unicode escape", at);
		return String.fromCodePoint(codePoint);
	}
	let hex = "";
	for (let i = 0; i < 4; i++) {
		if (!isHexDigit(scanner.peek())) scanner.fail("invalid unicode escape", at);
		hex += scanner.advance();
	}
	return String.fromCharCode(Number.parseInt(hex, 16));
}

function readHexEscape(scanner: Scanner): string {
	const at = scanner.position();
	let hex = "";
	for (let i = 0; i < 2; i++) {
		if (!isHexDigit(scanner.peek())) scanner.fail("invalid hex escape", at);
		hex += scanner.advance();
	}
	return String.fromCharCode(Number.parseInt(hex, 16));
}

function parseQuotedString(scanner: Scanner, quote: string): string {
	scanner.advance();
	let out = "";
	for (;;) {
		const ch = scanner.peek();
		if (ch === undefined || ch === "\n") scanner.fail("unterminated string literal");
		if (ch === quote) {
			scanner.advance();
			return out;
		}
		if (ch === "\\") {
			scanner.advance();
			out += readEscape(scanner);
			continue;
		}
		out += ch;
		scanner.advance();
	}
}

function parseTemplateString(scanner: Scanner): string {
	scanner.advance();
	let out = "";
	for (;;) {
		const ch = scanner.peek();
		if (ch === undefined) scanner.fail("unterminated template literal");
		if (ch === "`") {
			scanner.advance();
			return out;
		}
		if (ch === "\\") {
			scanner.advance();
			out += readEscape(scanner);
			continue;
		}
		if (ch === "$" && scanner.peek(1) === "{") {
			scanner.fail(`template literals with interpolation ("$${"{"}...}") are not allowed in meta values`);
		}
		out += ch;
		scanner.advance();
	}
}

function parseNumber(scanner: Scanner): number {
	const start = scanner.pos;
	if (scanner.peek() === "-") scanner.advance();
	if (!isDigit(scanner.peek())) scanner.fail("invalid number literal");
	while (isDigit(scanner.peek())) scanner.advance();
	if (scanner.peek() === ".") {
		scanner.advance();
		while (isDigit(scanner.peek())) scanner.advance();
	}
	if (scanner.peek() === "e" || scanner.peek() === "E") {
		scanner.advance();
		if (scanner.peek() === "+" || scanner.peek() === "-") scanner.advance();
		while (isDigit(scanner.peek())) scanner.advance();
	}
	return Number(scanner.source.slice(start, scanner.pos));
}

function parseIdentifierName(scanner: Scanner): string {
	const start = scanner.pos;
	while (isIdentifierPart(scanner.peek())) scanner.advance();
	return scanner.source.slice(start, scanner.pos);
}

/** Meta needs only depth 3 (object, phases array, phase object); this bounds a malicious or malformed literal. */
const MAX_META_DEPTH = 32;

function parseValue(scanner: Scanner, depth: number): LiteralNode {
	scanner.skipTrivia();
	const pos = scanner.position();
	const ch = scanner.peek();
	if (ch === undefined) scanner.fail("unexpected end of input in meta value", pos);
	if (ch === "{") return parseObject(scanner, depth);
	if (ch === "[") return parseArray(scanner, depth);
	if (ch === '"' || ch === "'") return { kind: "string", value: parseQuotedString(scanner, ch), pos };
	if (ch === "`") return { kind: "string", value: parseTemplateString(scanner), pos };
	if (ch === "-" || isDigit(ch)) return { kind: "number", value: parseNumber(scanner), pos };
	if (ch === "/") scanner.fail("regex literals are not allowed in meta values", pos);
	if (scanner.peekIs("...")) scanner.fail("spread syntax is not allowed in meta values", pos);
	if (isIdentifierStart(ch)) {
		const name = parseIdentifierName(scanner);
		if (name === "true") return { kind: "boolean", value: true, pos };
		if (name === "false") return { kind: "boolean", value: false, pos };
		if (name === "null") return { kind: "null", pos };
		scanner.skipTrivia();
		if (scanner.peek() === "(")
			scanner.fail(`function calls are not allowed in meta values (found "${name}(...)")`, pos);
		scanner.fail(`identifiers are not allowed in meta values (found "${name}")`, pos);
	}
	scanner.fail(`unexpected character "${ch}" in meta value`, pos);
}

function checkMetaDepth(scanner: Scanner, depth: number, pos: Position): void {
	if (depth > MAX_META_DEPTH) scanner.fail("meta nesting is too deep", pos);
}

function parseObjectKey(scanner: Scanner): string {
	const ch = scanner.peek();
	if (ch === '"' || ch === "'") return parseQuotedString(scanner, ch);
	if (ch === "[") scanner.fail("computed keys are not allowed in meta values");
	if (isIdentifierStart(ch)) return parseIdentifierName(scanner);
	scanner.fail("expected a property key");
}

function parseObject(scanner: Scanner, depth: number): LiteralNode {
	const pos = scanner.position();
	checkMetaDepth(scanner, depth, pos);
	scanner.advance();
	const entries: ObjectEntry[] = [];
	scanner.skipTrivia();
	if (scanner.peek() === "}") {
		scanner.advance();
		return { kind: "object", entries, pos };
	}
	for (;;) {
		scanner.skipTrivia();
		if (scanner.peekIs("...")) scanner.fail("spread syntax is not allowed in meta values");
		const key = parseObjectKey(scanner);
		scanner.expectChar(":");
		scanner.skipTrivia();
		const value = parseValue(scanner, depth + 1);
		entries.push({ key, value });
		scanner.skipTrivia();
		const sep = scanner.peek();
		if (sep === ",") {
			scanner.advance();
			scanner.skipTrivia();
			if (scanner.peek() === "}") {
				scanner.advance();
				break;
			}
			continue;
		}
		if (sep === "}") {
			scanner.advance();
			break;
		}
		scanner.fail('expected "," or "}"');
	}
	return { kind: "object", entries, pos };
}

function parseArray(scanner: Scanner, depth: number): LiteralNode {
	const pos = scanner.position();
	checkMetaDepth(scanner, depth, pos);
	scanner.advance();
	const items: LiteralNode[] = [];
	scanner.skipTrivia();
	if (scanner.peek() === "]") {
		scanner.advance();
		return { kind: "array", items, pos };
	}
	for (;;) {
		scanner.skipTrivia();
		if (scanner.peekIs("...")) scanner.fail("spread syntax is not allowed in meta values");
		items.push(parseValue(scanner, depth + 1));
		scanner.skipTrivia();
		const sep = scanner.peek();
		if (sep === ",") {
			scanner.advance();
			scanner.skipTrivia();
			if (scanner.peek() === "]") {
				scanner.advance();
				break;
			}
			continue;
		}
		if (sep === "]") {
			scanner.advance();
			break;
		}
		scanner.fail('expected "," or "]"');
	}
	return { kind: "array", items, pos };
}

function failAt(pos: Position, message: string): never {
	throw new MetaSyntaxError(message, pos.line, pos.column);
}

function lastEntry(node: Extract<LiteralNode, { kind: "object" }>, key: string): ObjectEntry | undefined {
	let found: ObjectEntry | undefined;
	for (const entry of node.entries) if (entry.key === key) found = entry;
	return found;
}

function requireStringLen(node: LiteralNode, path: string, max: number, nonEmpty: boolean): string {
	const message = nonEmpty
		? `${path} must be a non-empty string of at most ${max} characters`
		: `${path} must be a string of at most ${max} characters`;
	if (node.kind !== "string") failAt(node.pos, message);
	if (nonEmpty && node.value.length === 0) failAt(node.pos, message);
	if (node.value.length > max) failAt(node.pos, message);
	return node.value;
}

function requireName(node: LiteralNode): string {
	const message = `meta.name must match ${WORKFLOW_NAME_PATTERN} (lowercase letters, digits and hyphens, starting with a letter, at most 48 characters)`;
	if (node.kind !== "string" || !WORKFLOW_NAME_PATTERN.test(node.value)) failAt(node.pos, message);
	return node.value;
}

function validatePhase(node: LiteralNode, index: number, warnings: string[]): WorkflowPhaseMeta {
	const path = `meta.phases[${index}]`;
	if (node.kind !== "object") failAt(node.pos, `${path} must be an object`);
	const known = new Set(["title", "detail", "model"]);
	for (const entry of node.entries) if (!known.has(entry.key)) warnings.push(`unknown key "${path}.${entry.key}"`);

	const titleEntry = lastEntry(node, "title");
	if (!titleEntry) failAt(node.pos, `${path}.title is required`);
	const title = requireStringLen(titleEntry.value, `${path}.title`, 60, true);

	const detailEntry = lastEntry(node, "detail");
	const detail = detailEntry ? requireStringLen(detailEntry.value, `${path}.detail`, 200, false) : undefined;

	const modelEntry = lastEntry(node, "model");
	const model = modelEntry ? requireStringLen(modelEntry.value, `${path}.model`, 120, false) : undefined;

	const phase: WorkflowPhaseMeta = { title };
	if (detail !== undefined) phase.detail = detail;
	if (model !== undefined) phase.model = model;
	return phase;
}

function validateMeta(root: LiteralNode, warnings: string[]): WorkflowMeta {
	if (root.kind !== "object") failAt(root.pos, "meta must be an object literal");
	const known = new Set(["name", "description", "whenToUse", "phases"]);
	for (const entry of root.entries) if (!known.has(entry.key)) warnings.push(`unknown key "meta.${entry.key}"`);

	const nameEntry = lastEntry(root, "name");
	if (!nameEntry) failAt(root.pos, "meta.name is required");
	const name = requireName(nameEntry.value);

	const descriptionEntry = lastEntry(root, "description");
	if (!descriptionEntry) failAt(root.pos, "meta.description is required");
	const description = requireStringLen(descriptionEntry.value, "meta.description", 300, true);

	const whenToUseEntry = lastEntry(root, "whenToUse");
	const whenToUse = whenToUseEntry ? requireStringLen(whenToUseEntry.value, "meta.whenToUse", 300, false) : undefined;

	const phasesEntry = lastEntry(root, "phases");
	if (!phasesEntry) failAt(root.pos, "meta.phases is required");
	if (phasesEntry.value.kind !== "array")
		failAt(phasesEntry.value.pos, "meta.phases must be an array of 1 to 20 entries");
	if (phasesEntry.value.items.length < 1 || phasesEntry.value.items.length > 20) {
		failAt(phasesEntry.value.pos, "meta.phases must be an array of 1 to 20 entries");
	}
	const phases = phasesEntry.value.items.map((item, index) => validatePhase(item, index, warnings));

	return whenToUse === undefined ? { name, description, phases } : { name, description, whenToUse, phases };
}

function blankSpan(source: string, start: number, end: number): string {
	const span = source.slice(start, end);
	let blanked = "";
	for (let i = 0; i < span.length; i++) blanked += span[i] === "\n" ? "\n" : " ";
	return source.slice(0, start) + blanked + source.slice(end);
}

export function extractWorkflowMeta(source: string): MetaExtraction {
	const unwrapped = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
	const scanner = new Scanner(unwrapped);
	try {
		scanner.skipTrivia();
		const declStart = scanner.position();
		scanner.expectKeyword("export");
		scanner.expectKeyword("const");
		scanner.expectKeyword("meta");
		scanner.expectChar("=");
		scanner.skipTrivia();
		const root = parseValue(scanner, 0);
		scanner.skipTrivia();
		if (scanner.peek() === ";") scanner.advance();
		const declEnd = scanner.position();
		const warnings: string[] = [];
		const meta = validateMeta(root, warnings);
		const body = blankSpan(unwrapped, declStart.pos, declEnd.pos);
		return { ok: true, meta, body, warnings };
	} catch (error) {
		if (error instanceof MetaSyntaxError) {
			return { ok: false, error: { message: error.message, line: error.line, column: error.column } };
		}
		throw error;
	}
}

/**
 * A key boundary that also allows a matching quote around the key itself (`"name":` as well as
 * `name:`), mirroring the quoted-or-unquoted object keys `extractWorkflowMeta` accepts.
 */
function keyPattern(key: string): string {
	return `(?:^|[^\\w'"])(['"]?)${key}\\1`;
}

function matchQuoted(text: string, key: string): string | undefined {
	const match = new RegExp(`${keyPattern(key)}\\s*:\\s*(['"])((?:\\\\.|(?!\\2)[^\\\\\\n])*)\\2`).exec(text);
	if (!match) return undefined;
	return match[3].replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
}

function matchAllTitles(text: string): string[] {
	const pattern = new RegExp(`${keyPattern("title")}\\s*:\\s*(['"])((?:\\\\.|(?!\\2)[^\\\\\\n])*)\\2`, "g");
	const titles: string[] = [];
	for (const match of text.matchAll(pattern)) {
		titles.push(match[3].replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c)));
	}
	return titles;
}

/** Tolerant, for streaming args: scans at most {@link PEEK_HEAD_BYTES} for fields and counts lines up to {@link PEEK_LINE_SCAN_BYTES}. */
export function peekWorkflowMeta(partial: string): {
	name?: string;
	description?: string;
	phases?: string[];
	lines: number;
} {
	const bounded = partial.length > PEEK_LINE_SCAN_BYTES ? partial.slice(0, PEEK_LINE_SCAN_BYTES) : partial;
	let lines = 0;
	for (let i = 0; i < bounded.length; i++) if (bounded.charCodeAt(i) === 10) lines++;

	const head = partial.slice(0, PEEK_HEAD_BYTES);
	const name = matchQuoted(head, "name");
	const description = matchQuoted(head, "description");
	const phases = matchAllTitles(head);
	return { name, description, phases: phases.length > 0 ? phases : undefined, lines };
}
