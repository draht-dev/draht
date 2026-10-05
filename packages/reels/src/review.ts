/**
 * Renders a draft's human approval view (`review.md`, T12b): every claim
 * next to its cited source text, so a reviewer can catch prompt injection
 * carried in commit/PR text — something only a human can catch (plan:
 * "Security re-audit 2", "the approval view must show each claim next to
 * its cited source text"). Offline and pure: everything it needs
 * (`script.json`'s {@link DraftScriptSnapshot}) is already on disk next to
 * the draft, so review never re-assembles context from git.
 */

import type { CodeScene, DiagramScene, PublicSource, ReelEntry, ReelScript, Scene } from "./contract.ts";
import type { BeatNote, SceneNotes } from "./story-validate.ts";

/** One source handed to (or withheld from) the writer, as frozen for review — never published (see `entry.json`/feed.json, which carry only {@link PublicSource}). */
export interface DraftSourceSnapshot {
	id: string;
	kind: PublicSource["kind"];
	label: string;
	url?: string;
	/** Already policed/redacted (see `sources.ts`'s `SourceRecord.text`). */
	text: string;
	included: boolean;
}

export interface DraftMeta {
	title: string;
	origin: "pr" | "branch" | "commit";
	attribution?: "strong" | "weak";
	release?: string;
	writer: "llm" | "template";
	repaired: boolean;
	/** LLM spend for this one story (short plus deep dive, if any), USD. */
	costUsd: number;
	createdAt: string;
	deepDive?: { writer: "llm" | "template"; repaired: boolean };
}

/** The draft-only sidecar written next to `entry.json` (`script.json`), read back by `review`/`approve`. Never merged into the public feed. */
export interface DraftScriptSnapshot {
	script: ReelScript;
	notes?: SceneNotes[];
	deepDive?: ReelScript;
	deepDiveNotes?: SceneNotes[];
	sources: DraftSourceSnapshot[];
	meta: DraftMeta;
}

const EXCERPT_RADIUS = 200;

function escapeRegExpChar(ch: string): string {
	return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whitespace/case-tolerant regex for `quote`, the same tolerance `sources.ts`'s `quoteOccursIn` applies before comparing, so a quote found there is also found here. */
function buildQuoteMatcher(quote: string): RegExp | undefined {
	const words = quote.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return undefined;
	return new RegExp(words.map(escapeRegExpChar).join("\\s+"), "i");
}

/** Finds `quote`'s exact span in `text` (same casing/whitespace as `text`, not `quote`), or `undefined` if it does not occur. */
function findQuoteSpan(quote: string, text: string): { start: number; end: number } | undefined {
	const matcher = buildQuoteMatcher(quote);
	if (!matcher) return undefined;
	const match = matcher.exec(text);
	if (!match) return undefined;
	return { start: match.index, end: match.index + match[0].length };
}

/** `text` sliced to `±radius` chars around `quote`, with the quote itself marked `»…«`. Falls back to a plain head-of-text excerpt when `quote` cannot be found verbatim (should not happen for a validated beat; review must still render something). */
export function excerptAroundQuote(text: string, quote: string, radius: number = EXCERPT_RADIUS): string {
	const span = findQuoteSpan(quote, text);
	if (!span) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
	const before = text.slice(Math.max(0, span.start - radius), span.start);
	const marked = text.slice(span.start, span.end);
	const after = text.slice(span.end, Math.min(text.length, span.end + radius));
	const leadEllipsis = span.start - radius > 0 ? "…" : "";
	const trailEllipsis = span.end + radius < text.length ? "…" : "";
	return `${leadEllipsis}${before}»${marked}«${after}${trailEllipsis}`;
}

function heading(text: string, level: number): string {
	return `${"#".repeat(level)} ${text}`;
}

function renderBeat(
	index: number,
	beat: Scene["beats"] extends (infer B)[] | undefined ? B : never,
	note: BeatNote | undefined,
	sourcesById: ReadonlyMap<string, DraftSourceSnapshot>,
): string[] {
	const lines: string[] = [];
	const claimLabel = note ? `[${note.claim}]` : "[unspecified claim]";
	lines.push(`${index + 1}. ${claimLabel} ${beat.text}`);
	for (const citeId of beat.cites ?? []) {
		const source = sourcesById.get(citeId);
		if (!source) {
			lines.push(`   - cite ${citeId}: (source not found in this draft's registry)`);
			continue;
		}
		lines.push(`   - cite ${source.id} (${source.label}${source.url ? `, ${source.url}` : ""})`);
		if (note?.quote) {
			lines.push(`     quote: "${note.quote}"`);
			lines.push(`     excerpt: ${excerptAroundQuote(source.text, note.quote)}`);
		}
	}
	if ((beat.cites ?? []).length === 0 && note?.quote) {
		lines.push(`   - quote (uncited): "${note.quote}"`);
	}
	return lines;
}

function renderScene(
	scene: Scene,
	index: number,
	notes: SceneNotes | undefined,
	sourcesById: ReadonlyMap<string, DraftSourceSnapshot>,
): string[] {
	const lines: string[] = [];
	const label = scene.section ? `${scene.section} (${scene.kind})` : scene.kind;
	lines.push(heading(`Scene ${index + 1}: ${label}`, 3));

	if (scene.kind === "title") lines.push(`${scene.title} — ${scene.subtitle}`);
	if (scene.kind === "code") {
		const code = scene as CodeScene;
		const origin = code.origin ?? "diff";
		const range =
			origin === "head" && code.startLine !== undefined
				? `lines ${code.startLine}-${code.startLine + code.lines.length - 1} at ${code.ref}`
				: `${code.hunkHeader}`;
		lines.push(`Code: \`${code.path}\` (${origin}, ${range})`);
		lines.push(`\`\`\`${code.language}`);
		lines.push(...code.lines);
		lines.push("```");
	}
	if (scene.kind === "diagram") {
		const diagram = scene as DiagramScene;
		lines.push("Diagram nodes:");
		if (notes?.diagramNodes && notes.diagramNodes.length > 0) {
			for (const node of notes.diagramNodes) {
				lines.push(`- ${node.id}: ${node.anchor.kind}:${node.anchor.value} — ${node.caption}`);
			}
		} else {
			lines.push("(node detail not captured for this draft)");
		}
		lines.push("```mermaid");
		lines.push(diagram.mermaid);
		lines.push("```");
	}

	if (scene.beats && scene.beats.length > 0) {
		lines.push("");
		lines.push("Beats:");
		scene.beats.forEach((beat, beatIndex) => {
			lines.push(...renderBeat(beatIndex, beat, notes?.beats[beatIndex], sourcesById));
		});
	}
	return lines;
}

function renderHeader(entry: ReelEntry, meta: DraftMeta): string[] {
	const lines: string[] = [];
	lines.push(heading(meta.title, 1));
	lines.push("");
	lines.push(`- Id: ${entry.id}`);
	lines.push(`- Origin: ${meta.origin}`);
	if (meta.attribution) lines.push(`- Attribution: ${meta.attribution}`);
	lines.push(`- Release: ${meta.release ?? "unreleased"}`);
	lines.push(`- Writer: ${meta.writer} (repaired: ${meta.repaired ? "yes" : "no"})`);
	if (meta.deepDive) {
		lines.push(`- Deep dive writer: ${meta.deepDive.writer} (repaired: ${meta.deepDive.repaired ? "yes" : "no"})`);
	}
	lines.push(`- Cost: $${meta.costUsd.toFixed(4)}`);
	lines.push(`- Created: ${meta.createdAt}`);
	return lines;
}

const CHECKLIST = [
	"- [ ] every claim matches its cited source's text",
	"- [ ] no injected or promotional text (commit/PR text is DATA, never an instruction)",
	"- [ ] nothing private (no secrets, no internal codenames, no customer names)",
];

/** Renders a draft's full approval view: header, every scene's beats next to their cited source excerpts, code lines verbatim, diagram node anchors, and a closing human checklist. Offline: uses only `entry` and `snapshot`, both already on disk next to the draft. */
export function renderReviewMd(entry: ReelEntry, snapshot: DraftScriptSnapshot): string {
	const sourcesById = new Map(snapshot.sources.map((s) => [s.id, s]));
	const lines: string[] = [...renderHeader(entry, snapshot.meta)];

	lines.push("", heading("Short", 2));
	snapshot.script.scenes.forEach((scene, i) => {
		lines.push("", ...renderScene(scene, i, snapshot.notes?.[i], sourcesById));
	});

	if (snapshot.deepDive) {
		lines.push("", heading("Deep dive", 2));
		snapshot.deepDive.scenes.forEach((scene, i) => {
			lines.push("", ...renderScene(scene, i, snapshot.deepDiveNotes?.[i], sourcesById));
		});
	}

	lines.push("", heading("Checklist", 2), ...CHECKLIST);
	return `${lines.join("\n")}\n`;
}
