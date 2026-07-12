import type { Project } from "../project.js";

/**
 * Voice/text resolution grammar (spec §9.5, R36-M4.2/M4.4).
 *
 * `resolveUtterance` turns an already-transcribed string (whisper.cpp produced
 * it back in Phase 33 — this module never touches audio) into a structured
 * `ResolvedUtterance`, following the EXACT resolution order the spec locks:
 *
 *   reserved verbs → command match → harness qualifier → project qualifier → text
 *
 * with the hard invariant "nothing may shadow anything earlier in the chain":
 * a later stage can never demote a token an earlier stage already claimed. The
 * two board-grammar patterns named in §9.5 (`new … session …:` and
 * `variants <n> …:`) are recognized as their own structured shapes.
 *
 * This is pure string parsing. It is harness-free and ACP-free: the advertised
 * command list arrives as a plain array (a sibling task builds the code that
 * derives it from ACP capability data — we only consume the shape here, staying
 * decoupled per the geist import boundary, spec §17.1).
 */

/** A reserved permission verb, normalized across the two languages (spec §9.5). */
export type ReservedVerb = "allow" | "deny";

/**
 * One command the agent advertised over ACP (`available_commands_update`,
 * spec §6). Shape only — geist-core does not import ACP wire types. A parallel
 * task produces this list from real capability data; we consume it as-is.
 */
export interface AdvertisedCommand {
	readonly name: string;
	readonly description?: string;
}

/**
 * Everything the resolver needs to recognize qualifiers. All three collections
 * are closed vocabularies at resolution time — the harness qualifier and the
 * board `with` list are matched against `configuredHarnesses`, the project
 * qualifier against `knownProjects`, and the command match against
 * `availableCommands`.
 */
export interface ResolutionContext {
	/** Closed vocab for the harness qualifier = the configured agents (spec §9.5). */
	readonly configuredHarnesses: readonly string[];
	/** The project registry entries; only `slug`/`name` are used as qualifier aliases. */
	readonly knownProjects: readonly Pick<Project, "slug" | "name">[];
	/** Commands the pointed session advertised over ACP; matched by name. */
	readonly availableCommands: readonly AdvertisedCommand[];
}

/** Stage 1: `allow|erlauben` / `deny|ablehnen` resolved the pending permission request. */
export interface ResolvedPermission {
	readonly kind: "permission";
	readonly verb: ReservedVerb;
}

/**
 * Stage 2: a slash pass-through (`raw: true`) or a match against an advertised
 * command (`raw: false`). `command` is the command name WITHOUT its leading
 * slash; `text` carries any trailing arguments (or `undefined` when there are
 * none). geist does not interpret the command — each harness owns its own slash
 * semantics (spec §6).
 */
export interface ResolvedCommand {
	readonly kind: "command";
	readonly command: string;
	readonly raw: boolean;
	readonly text?: string;
}

/** Board grammar: `new [<harness>] [<command|persona>] session [in <project>]: <text>`. */
export interface ResolvedBoardNew {
	readonly kind: "board-new";
	/** Present when a configured harness led the qualifier slot; omitted → default applies downstream. */
	readonly harness?: string;
	/** The optional `<command|persona>` slot, verbatim (e.g. `"/plan"` or a persona name). */
	readonly command?: string;
	/** Resolved project slug when an `in <project>` qualifier was present and known. */
	readonly project?: string;
	readonly text: string;
}

/** Board grammar: `variants <n> [with <harness>[, <harness>…]] [in <project>]: <text>`. */
export interface ResolvedBoardVariants {
	readonly kind: "board-variants";
	readonly count: number;
	/** Configured harnesses named in the `with …` list, in order; empty when omitted. */
	readonly harnesses: readonly string[];
	readonly project?: string;
	readonly text: string;
}

/** Stages 3–5: a plain message with any recognized qualifiers stripped off. */
export interface ResolvedMessage {
	readonly kind: "message";
	readonly harness?: string;
	readonly project?: string;
	readonly text: string;
}

export type ResolvedUtterance =
	| ResolvedPermission
	| ResolvedCommand
	| ResolvedBoardNew
	| ResolvedBoardVariants
	| ResolvedMessage;

/**
 * Resolves one transcribed utterance to a structured shape following the locked
 * §9.5 order. Reserved verbs are checked first (the operative leading verb
 * always wins), then the two board patterns, then the command match, then the
 * qualifier chain — so no later stage can shadow an earlier one.
 */
export function resolveUtterance(rawText: string, ctx: ResolutionContext): ResolvedUtterance {
	const text = rawText.trim();

	// Stage 1 — reserved verbs. Anchored at the utterance start: allow/deny are
	// addressing verbs, and a trailing harness/project/command can never demote
	// them (spec §9.5 "nothing may shadow anything earlier in the chain").
	const verb = matchReservedVerb(text);
	if (verb) {
		return { kind: "permission", verb };
	}

	// Board grammar — distinct structured shapes. Recognized before the generic
	// command/qualifier chain because they are fully-anchored patterns.
	const variants = tryBoardVariants(text, ctx);
	if (variants) return variants;
	const boardNew = tryBoardNew(text, ctx);
	if (boardNew) return boardNew;

	// Stage 2 — command match (verbatim `/…` always; advertised name otherwise).
	const command = tryCommand(text, ctx);
	if (command) return command;

	// Stages 3–5 — harness qualifier → project qualifier → free text.
	return resolveMessage(text, ctx);
}

const RESERVED_VERB_RE = /^(allow|erlauben|deny|ablehnen)\b/i;

/**
 * Matches a leading reserved verb. Anchored (`^`) so a slash form like `/allow`
 * — which starts with `/`, not the verb — is left for the command stage, and
 * word-boundary bounded so `allowing` is not a false positive.
 */
function matchReservedVerb(text: string): ReservedVerb | undefined {
	const m = RESERVED_VERB_RE.exec(text);
	if (!m) return undefined;
	const w = m[1].toLowerCase();
	return w === "allow" || w === "erlauben" ? "allow" : "deny";
}

const SLASH_COMMAND_RE = /^\/(\S+)\s*([\s\S]*)$/;
const LEADING_WORD_RE = /^([\w-]+)\s*([\s\S]*)$/;

/** Stage 2: verbatim `/…` pass-through (always available) or an advertised-command match. */
function tryCommand(text: string, ctx: ResolutionContext): ResolvedCommand | undefined {
	const slash = SLASH_COMMAND_RE.exec(text);
	if (slash) {
		return { kind: "command", command: slash[1], raw: true, text: emptyToUndefined(slash[2]) };
	}
	const word = LEADING_WORD_RE.exec(text);
	if (word) {
		const canonical = matchCommand(word[1], ctx.availableCommands);
		if (canonical) {
			return { kind: "command", command: canonical, raw: false, text: emptyToUndefined(word[2]) };
		}
	}
	return undefined;
}

const BOARD_VARIANTS_RE = /^variants\b\s+(\d+)\s*([\s\S]*)$/i;
const WITH_LIST_RE = /^with\b\s+([\s\S]+)$/i;

/** Board grammar: `variants <n> [with <harness>[, …]] [in <project>]: <text>`. */
function tryBoardVariants(text: string, ctx: ResolutionContext): ResolvedBoardVariants | undefined {
	const split = splitAtColon(text);
	if (!split) return undefined;
	const head = BOARD_VARIANTS_RE.exec(split.head);
	if (!head) return undefined;

	const count = Number.parseInt(head[1], 10);
	// `[with …]` comes before `[in <project>]` in the grammar, so the project is
	// the trailing clause: peel it off first, then read the `with` list.
	const { rest, slug } = stripTrailingProjectClause(head[2].trim(), ctx.knownProjects);
	const withList = WITH_LIST_RE.exec(rest.trim());
	const harnesses = withList ? parseHarnessList(withList[1], ctx.configuredHarnesses) : [];

	return { kind: "board-variants", count, harnesses, project: slug, text: split.body };
}

const BOARD_NEW_RE = /^new\b\s*([\s\S]*?)\bsession\b\s*([\s\S]*)$/i;
const IN_PROJECT_RE = /^in\s+([\s\S]+)$/i;

/** Board grammar: `new [<harness>] [<command|persona>] session [in <project>]: <text>`. */
function tryBoardNew(text: string, ctx: ResolutionContext): ResolvedBoardNew | undefined {
	const split = splitAtColon(text);
	if (!split) return undefined;
	const head = BOARD_NEW_RE.exec(split.head);
	if (!head) return undefined;

	// Tokens between `new` and `session`: an optional harness then an optional
	// command/persona. The harness must come from the closed vocab; anything
	// that is not a configured harness is the command/persona slot.
	let harness: string | undefined;
	let command: string | undefined;
	const between = head[1].trim();
	if (between.length > 0) {
		const tokens = between.split(/\s+/);
		const canonical = matchHarness(tokens[0], ctx.configuredHarnesses);
		if (canonical) {
			harness = canonical;
			const remainder = tokens.slice(1);
			if (remainder.length > 0) command = remainder.join(" ");
		} else {
			command = tokens.join(" ");
		}
	}

	let project: string | undefined;
	const after = IN_PROJECT_RE.exec(head[2].trim());
	if (after) {
		project = resolveProjectAlias(after[1], ctx.knownProjects);
	}

	return { kind: "board-new", harness, command, project, text: split.body };
}

const HARNESS_QUALIFIER_RE = /^([\w-]+)[:;,.!?]*(?:\s+|$)/;
const SESSION_FILLER_RE = /^session\b[\s:;,]*/i;

/** Stages 3–5: strip a leading harness qualifier, then an `in <project>` clause, then keep the text. */
function resolveMessage(text: string, ctx: ResolutionContext): ResolvedMessage {
	let working = text;
	let harness: string | undefined;

	const lead = HARNESS_QUALIFIER_RE.exec(working);
	if (lead) {
		const canonical = matchHarness(lead[1], ctx.configuredHarnesses);
		if (canonical) {
			harness = canonical;
			working = working.slice(lead[0].length);
			// A `session` filler only follows a recognized harness qualifier
			// (spec §9.5 example "claude session in kintura: …"); dropping it
			// here keeps the free text clean without mangling a plain sentence
			// that merely happens to start with the word "session".
			const filler = SESSION_FILLER_RE.exec(working);
			if (filler) working = working.slice(filler[0].length);
		}
	}

	let project: string | undefined;
	const proj = extractProjectPhrase(working, ctx.knownProjects);
	if (proj) {
		project = proj.slug;
		working = `${working.slice(0, proj.start)} ${working.slice(proj.end)}`;
	}

	return { kind: "message", harness, project, text: normalizeText(working) };
}

// --- shared helpers ---------------------------------------------------------

interface ColonSplit {
	readonly head: string;
	readonly body: string;
}

/** Splits a board utterance into its structured head and free-text body at the first colon. */
function splitAtColon(text: string): ColonSplit | undefined {
	const idx = text.indexOf(":");
	if (idx < 0) return undefined;
	return { head: text.slice(0, idx).trim(), body: text.slice(idx + 1).trim() };
}

/** Case-insensitive match of a token (punctuation-trimmed) against the closed harness vocab. */
function matchHarness(token: string, configured: readonly string[]): string | undefined {
	const t = token.replace(/^[^\w-]+|[^\w-]+$/g, "").toLowerCase();
	if (t.length === 0) return undefined;
	return configured.find((h) => h.toLowerCase() === t);
}

/** Case-insensitive match of a token against advertised command names (leading slash ignored). */
function matchCommand(token: string, commands: readonly AdvertisedCommand[]): string | undefined {
	const t = token.replace(/^\//, "").toLowerCase();
	return commands.find((c) => c.name.replace(/^\//, "").toLowerCase() === t)?.name;
}

/** Resolves a bare project candidate to its slug, matching either slug or display name. */
function resolveProjectAlias(
	candidate: string,
	projects: readonly Pick<Project, "slug" | "name">[],
): string | undefined {
	const c = candidate.trim().toLowerCase();
	if (c.length === 0) return undefined;
	return projects.find((p) => p.slug.toLowerCase() === c || p.name.toLowerCase() === c)?.slug;
}

const TRAILING_IN_RE = /\bin\s+([\s\S]+)$/i;

/**
 * Peels a trailing `in <project>` clause off a board sub-string, but only when
 * the candidate actually resolves to a known project (so `in-progress`-style
 * text or an unknown place is left untouched).
 */
function stripTrailingProjectClause(
	str: string,
	projects: readonly Pick<Project, "slug" | "name">[],
): { rest: string; slug?: string } {
	const m = TRAILING_IN_RE.exec(str);
	if (m) {
		const slug = resolveProjectAlias(m[1], projects);
		if (slug) return { rest: str.slice(0, m.index).trim(), slug };
	}
	return { rest: str };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds an `in <alias>` project qualifier anywhere in a message, where `<alias>`
 * is exactly a known project's slug or display name. Returns the match span so
 * the caller can excise it. Longest aliases are tried first so a multi-word
 * display name wins over a shorter substring.
 */
function extractProjectPhrase(
	working: string,
	projects: readonly Pick<Project, "slug" | "name">[],
): { slug: string; start: number; end: number } | undefined {
	if (projects.length === 0) return undefined;

	const aliases: { alias: string; slug: string }[] = [];
	for (const p of projects) {
		aliases.push({ alias: p.slug, slug: p.slug });
		if (p.name.toLowerCase() !== p.slug.toLowerCase()) aliases.push({ alias: p.name, slug: p.slug });
	}
	aliases.sort((a, b) => b.alias.length - a.alias.length);

	const alternation = aliases.map((a) => escapeRegExp(a.alias)).join("|");
	const re = new RegExp(`\\bin\\s+(${alternation})\\b`, "i");
	const m = re.exec(working);
	if (!m) return undefined;

	const matched = m[1].toLowerCase();
	const found = aliases.find((a) => a.alias.toLowerCase() === matched);
	return { slug: found ? found.slug : matched, start: m.index, end: m.index + m[0].length };
}

/** Splits a `with …` list on commas and the word "and", keeping only configured harnesses in order. */
function parseHarnessList(list: string, configured: readonly string[]): string[] {
	return list
		.split(/\s*,\s*|\s+and\s+/i)
		.map((token) => matchHarness(token, configured))
		.filter((h): h is string => h !== undefined);
}

/** Collapses whitespace and strips leading residual delimiters left by qualifier excision. */
function normalizeText(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/^[\s:;,]+/, "")
		.trim();
}

function emptyToUndefined(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
