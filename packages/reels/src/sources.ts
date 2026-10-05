/**
 * The registry of sources a story's context assembly handed to the writer,
 * keyed by stable id. Validation (`story-validate.ts`) checks every cite
 * against this registry, so a quote can only be confirmed against text the
 * model actually saw, and a cite to a source that exists but was truncated
 * out of the prompt is an error rather than silently accepted.
 *
 * Id shapes (`src/sources.ts` builders), stable and safe to publish as
 * {@link PublicSource.id}: `c:<sha12>` (commit), `pr:<n>` / `rv:<n>.<i>`
 * (PR review or comment), `cl:<pkg>@<version>#<i>` (changelog entry),
 * `doc:<path>#<heading-slug>` (doc chunk), `f:<path>` (head content of a
 * context file), `h:<path>#<hunkIndex>` (hunk index entry), `rel:<sha12>`
 * (related commit), `st:<sha12>` (story summary).
 */

import type { PublicSource } from "./contract.ts";
import { redactText, testBounded } from "./privacy.ts";

const SHA12_RE = /^[0-9a-f]{12}$/;

function assertSha12(sha12: string): string {
	if (!SHA12_RE.test(sha12))
		throw new Error(`sources: expected a 12-char lowercase hex sha, got ${JSON.stringify(sha12)}`);
	return sha12;
}

export function commitSourceId(sha12: string): string {
	return `c:${assertSha12(sha12)}`;
}

export function relatedCommitSourceId(sha12: string): string {
	return `rel:${assertSha12(sha12)}`;
}

export function storySourceId(sha12: string): string {
	return `st:${assertSha12(sha12)}`;
}

export function pullRequestSourceId(number: number): string {
	return `pr:${number}`;
}

export function pullRequestReviewSourceId(number: number, index: number): string {
	return `rv:${number}.${index}`;
}

export function changelogSourceId(pkg: string, version: string, index: number): string {
	return `cl:${pkg}@${version}#${index}`;
}

export function docSourceId(path: string, headingSlug: string): string {
	return `doc:${path}#${headingSlug}`;
}

export function headFileSourceId(path: string): string {
	return `f:${path}`;
}

export function hunkIndexSourceId(path: string, hunkIndex: number): string {
	return `h:${path}#${hunkIndex}`;
}

/** One source handed to the writer, keyed by a stable id (see module doc). */
export interface SourceRecord {
	id: string;
	kind: PublicSource["kind"];
	label: string;
	url?: string;
	/** The exact (already policed/redacted) text the model saw for this source, used to check quotes. */
	text: string;
	/**
	 * `false` when the source is known to the pipeline (e.g. it exists in
	 * the context manifest) but was dropped by budget truncation before the
	 * prompt was sent, so the model never saw it and cannot legitimately
	 * cite it. Defaults to `true`.
	 */
	included?: boolean;
}

/** Lookup table of sources handed to (or known-but-withheld-from) one writer call. */
export type SourceRegistry = ReadonlyMap<string, SourceRecord>;

export function createSourceRegistry(records: Iterable<SourceRecord>): SourceRegistry {
	const map = new Map<string, SourceRecord>();
	for (const record of records) map.set(record.id, record);
	return map;
}

export function getSource(registry: SourceRegistry, id: string): SourceRecord | undefined {
	return registry.get(id);
}

/** True when `id` names a source the model actually saw (exists and was not truncated out). */
export function isSourceAvailable(registry: SourceRegistry, id: string): boolean {
	const record = registry.get(id);
	return record !== undefined && record.included !== false;
}

export function toPublicSources(registry: SourceRegistry): PublicSource[] {
	return Array.from(registry.values())
		.filter((record) => record.included !== false)
		.map(({ id, kind, label, url }) => ({ id, kind, label, ...(url ? { url } : {}) }));
}

/**
 * Normalizes text for quote matching: trims, collapses internal whitespace
 * runs to a single space, and lowercases. Both the writer's `quote` and the
 * source text go through this before comparison, so a quote that merely
 * differs in casing or line-wrapping from the source still matches.
 */
export function normalizeForQuote(text: string): string {
	return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True if `quote`, after {@link normalizeForQuote}, occurs verbatim somewhere in `sourceText`. */
export function quoteOccursIn(quote: string, sourceText: string): boolean {
	const needle = normalizeForQuote(quote);
	if (needle.length === 0) return false;
	return normalizeForQuote(sourceText).includes(needle);
}

const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;

/** `redactText`, then owner decision Q7: URLs are always stripped from narration and prose fields. */
export function cleanProse(text: string): string {
	return redactText(text)
		.replace(URL_RE, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** True when `text` matches any of `patterns`, used to reject a deny-listed prose field. */
export function proseViolatesDenyPatterns(text: string, patterns: RegExp[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return false;
	return patterns.some((pattern) => testBounded(pattern, text));
}

const QUOTE_STOPWORDS = new Set([
	"that",
	"this",
	"with",
	"from",
	"have",
	"been",
	"were",
	"which",
	"while",
	"about",
	"after",
	"before",
	"because",
	"then",
	"than",
	"they",
	"them",
	"their",
	"there",
	"what",
	"when",
	"where",
	"into",
	"would",
	"could",
	"should",
	"your",
	"will",
]);

/** A quote with code punctuation or an identifier-like token is held to a character length, not a word count. */
function isCodeLikeQuote(quote: string): boolean {
	return /[{}()[\];=<>]|::|->|=>/.test(quote) || /[a-z][_.][a-z]/i.test(quote);
}

/** 4-25 words for prose, or at least 20 characters for a code-like quote (a punctuation-heavy or identifier-bearing fragment). */
export function quoteHasValidLength(quote: string): boolean {
	const trimmed = quote.trim();
	if (trimmed.length === 0) return false;
	if (isCodeLikeQuote(trimmed)) return trimmed.length >= 20;
	const words = trimmed.split(/\s+/).filter(Boolean);
	return words.length >= 4 && words.length <= 25;
}

function contentWords(text: string): Set<string> {
	const words = text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [];
	return new Set(words.filter((w) => !QUOTE_STOPWORDS.has(w)));
}

function codeIdentifiers(text: string): string[] {
	return text.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)?.filter((id) => id.length >= 3 && /[A-Z_]/.test(id)) ?? [];
}

/**
 * True when `quote` shares at least one content word (length >= 4, after stopword removal) with `beatText`, or
 * when one of `beatText`'s code-shaped identifiers (camelCase/snake_case, length >= 3) occurs verbatim in `quote`.
 */
export function quoteOverlapsBeat(quote: string, beatText: string): boolean {
	const quoteWords = contentWords(quote);
	for (const word of contentWords(beatText)) {
		if (quoteWords.has(word)) return true;
	}
	const lowerQuote = quote.toLowerCase();
	return codeIdentifiers(beatText).some((id) => lowerQuote.includes(id.toLowerCase()));
}

/** The combined quote-shape rule (length plus overlap with the beat it supports). `quoteIsWellFormed("the", beatText)` is always false. */
export function quoteIsWellFormed(quote: string, beatText: string): boolean {
	return quoteHasValidLength(quote) && quoteOverlapsBeat(quote, beatText);
}
