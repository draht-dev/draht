/**
 * Assembles the context a story writer sees (T8): a {@link SourceRegistry}
 * plus the literal, source-delimited prompt text, built from a {@link Story}
 * in priority order (see the plan's "Context assembly" section) and cut to
 * a character budget. Every prose field goes through {@link redactText} and
 * `prose.denyPatterns`; every doc and head-file read goes through the D8
 * privacy order: {@link applyContentPolicy} (hunks) first, then
 * {@link policeHeadFile} (whole file), then {@link policeDocChunk}, then
 * redaction and deny-pattern checks on what remains.
 *
 * Priority order (never reordered, only shrunk from the back when the
 * budget is tight): 1 header, 2 commit messages, 3 PR text, 4 changelog
 * entries, 5 docs, 6 key files, 7 the hunk index of every other file,
 * 8 related commits.
 */

import { randomBytes } from "node:crypto";
import type { AnchorContext } from "./anchored-diagram.ts";
import type { HeadFileContent } from "./code-ref.ts";
import type { GitRunner } from "./collect.ts";
import { assertValidSha, fetchCommitMetadata, type RawCommit, runGit } from "./collect.ts";
import type { FileChange, Story } from "./contract.ts";
import {
	applyContentPolicy,
	DEFAULT_DENY_GLOBS,
	isDocAllowed,
	isPathDenied,
	matchesProseDeny,
	policeDocChunk,
	policeHeadFile,
	redactText,
} from "./privacy.ts";
import type { ReelsConfig } from "./reels-config.ts";
import {
	changelogSourceId,
	commitSourceId,
	createSourceRegistry,
	docSourceId,
	headFileSourceId,
	pullRequestReviewSourceId,
	pullRequestSourceId,
	relatedCommitSourceId,
	type SourceRecord,
	type SourceRegistry,
} from "./sources.ts";
import { extractIdentifiers } from "./stories.ts";

/** Token estimate used only for display/logging; the budget itself is char-based. */
export const CHARS_PER_TOKEN = 4;

export function tokensToChars(tokens: number): number {
	return Math.floor(tokens * CHARS_PER_TOKEN);
}

export interface ContextBudget {
	/** Target total chars for the assembled prompt context. */
	targetChars: number;
	/** Hard clamp, e.g. `(model.contextWindow - maxOutput - 4k) * CHARS_PER_TOKEN`. Defaults to `targetChars`. */
	maxChars?: number;
}

const COMMIT_BUCKET_CAP = 16_000;
const COMMIT_BODY_CAP = 4_000;
const PR_BUCKET_CAP = 16_000;
const CHANGELOG_BUCKET_CAP = 4_000;
const DOCS_BUCKET_CAP = 24_000;
const KEY_FILES_BUCKET_CAP = 80_000;
const MAX_KEY_FILES = 3;
const KEY_FILE_FULL_LINE_LIMIT = 400;
const KEY_FILE_WINDOW_RADIUS = 40;
const MAX_INDEX_FILES = 50;
const RELATED_BUCKET_CAP = 6_000;

export type ManifestAction = "truncated" | "dropped";

export interface ManifestEntry {
	bucket: string;
	id: string;
	action: ManifestAction;
	detail: string;
}

export interface ContextManifest {
	totalChars: number;
	budgetChars: number;
	entries: ManifestEntry[];
}

export interface AssembledStoryContext {
	sources: SourceRegistry;
	promptContext: string;
	manifest: ContextManifest;
	nonce: string;
	/** Head content of every key file shown to the writer, for `resolveCodeRef`'s `ref: "head"`. */
	headFiles: ReadonlyMap<string, HeadFileContent>;
	/** Anchors `validateAndEmitDiagram` may check a diagram node against. */
	anchors: AnchorContext;
}

export interface AssembleStoryContextOptions {
	git?: GitRunner;
}

// --- nonce-delimited source blocks -----------------------------------------

export function createNonce(): string {
	return randomBytes(12).toString("hex");
}

function wrapSource(nonce: string, id: string, kind: string, label: string, text: string): string {
	return `<<src id=${JSON.stringify(id)} kind=${kind} label=${JSON.stringify(label)} nonce=${nonce}>>\n${text}\n<</src nonce=${nonce}>>`;
}

// --- prompt chunks: the unit the budget cuts -------------------------------

interface PromptChunk {
	/** A registry source id, or a pipeline-internal pseudo id ("header", "index") that is never citable. */
	id: string;
	bucket: string;
	kind: string;
	label: string;
	text: string;
	/** Present only for chunks that become a citable {@link SourceRecord}. */
	record?: Omit<SourceRecord, "text" | "included">;
}

/** The wrapper's own overhead, plus the `"\n\n"` {@link assembleStoryContext} joins blocks with. */
const BLOCK_SEPARATOR_LEN = 2;

function wrapLen(nonce: string, chunk: PromptChunk): number {
	return wrapSource(nonce, chunk.id, chunk.kind, chunk.label, "").length + BLOCK_SEPARATOR_LEN;
}

/** `text.slice(0, maxLen)`, but never leaving a lone leading (high) surrogate at the cut point, which would otherwise split a UTF-16 surrogate pair (e.g. an emoji) into two invalid code units. */
export function sliceAtCharBoundary(text: string, maxLen: number): string {
	if (maxLen <= 0) return "";
	const code = text.charCodeAt(maxLen - 1);
	const end = code >= 0xd800 && code <= 0xdbff ? maxLen - 1 : maxLen;
	return text.slice(0, end);
}

/**
 * Cuts `chunks` (already in priority order) to fit `capChars`: chunks that
 * fit whole are kept; the first chunk that would overflow is truncated to
 * the remaining room (if any room is left) and every chunk after it is
 * dropped. Mutates nothing; returns the kept chunks (truncated chunks keep
 * their reduced `text`) and appends to `manifest`.
 */
function truncateChunks(
	chunks: PromptChunk[],
	capChars: number,
	nonce: string,
	manifest: ManifestEntry[],
): PromptChunk[] {
	const kept: PromptChunk[] = [];
	let used = 0;
	let cutoff = false;

	for (const chunk of chunks) {
		if (cutoff) {
			manifest.push({ bucket: chunk.bucket, id: chunk.id, action: "dropped", detail: "budget exhausted" });
			continue;
		}
		const overhead = wrapLen(nonce, chunk);
		const full = overhead + chunk.text.length;
		if (used + full <= capChars) {
			kept.push(chunk);
			used += full;
			continue;
		}
		const remaining = capChars - used - overhead;
		if (remaining <= 0) {
			cutoff = true;
			manifest.push({ bucket: chunk.bucket, id: chunk.id, action: "dropped", detail: "budget exhausted" });
			continue;
		}
		const truncatedText = sliceAtCharBoundary(chunk.text, remaining);
		kept.push({ ...chunk, text: truncatedText });
		used += overhead + truncatedText.length;
		manifest.push({
			bucket: chunk.bucket,
			id: chunk.id,
			action: "truncated",
			detail: `kept ${truncatedText.length} of ${chunk.text.length} chars`,
		});
		cutoff = true;
	}
	return kept;
}

function capBucket(chunks: PromptChunk[], capChars: number, nonce: string, manifest: ManifestEntry[]): PromptChunk[] {
	return truncateChunks(chunks, capChars, nonce, manifest);
}

// --- markdown chunking -------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

export function slugifyHeading(heading: string): string {
	const slug = heading
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-");
	return slug.length > 0 ? slug : "top";
}

export interface DocChunk {
	heading: string;
	slug: string;
	text: string;
}

/** Splits markdown into chunks at each heading line; text before the first heading becomes the "top" chunk. */
export function splitMarkdownIntoChunks(markdown: string): DocChunk[] {
	const lines = markdown.split("\n");
	const chunks: DocChunk[] = [];
	let heading = "";
	let slug = "top";
	let buffer: string[] = [];

	const flush = () => {
		const text = buffer.join("\n").trim();
		if (text.length > 0) chunks.push({ heading, slug, text });
		buffer = [];
	};

	for (const line of lines) {
		const match = HEADING_RE.exec(line);
		if (match) {
			flush();
			heading = match[2] ?? "";
			slug = slugifyHeading(heading);
			continue;
		}
		buffer.push(line);
	}
	flush();
	return chunks;
}

// --- key file selection -------------------------------------------------------

const LOCKFILE_RE = /(^|\/)(package-lock\.json|bun\.lock(?:b)?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock)$/;
const GENERATED_RE = /\.generated\.[jt]sx?$/;
const MINIFIED_RE = /\.min\.(js|css)$/;
const DIST_RE = /(^|\/)(dist|build|node_modules)\//;
const TEST_PATH_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[jt]sx?$/;

export interface KeyFileDenyOptions {
	/** `code.exclude` plus the built-in secret-shaped-path defaults. */
	denyGlobs?: readonly string[];
	/** `code.include` override for `denyGlobs`. */
	allowGlobs?: readonly string[];
	/** `docs.deny`: also kept out of key files and the hunk index, even though it is a doc-only list. */
	docsDenyGlobs?: readonly string[];
}

/**
 * True when `path` is blocked from ever reaching the writer as a key file or
 * a hunk-index entry: a denied path (`applyContentPolicy`'s own deny-list)
 * still carries a withheld-but-present hunk, which {@link isKeyFileCandidate}
 * alone does not reject, and `docs.deny` paths are never withheld by
 * `applyContentPolicy` at all (it only knows about code deny globs).
 */
function isContextBlocked(path: string, deny: Required<KeyFileDenyOptions>): boolean {
	if (isPathDenied(path, deny.denyGlobs, deny.allowGlobs)) return true;
	return isPathDenied(path, deny.docsDenyGlobs, []);
}

function isKeyFileCandidate(file: FileChange, deny: Required<KeyFileDenyOptions>): boolean {
	if (file.status === "deleted") return false;
	if (file.hunks.length === 0) return false; // binary, or fully withheld (no content to show)
	if (file.hunks.every((h) => h.withheld)) return false;
	if (isContextBlocked(file.path, deny)) return false;
	if (LOCKFILE_RE.test(file.path)) return false;
	if (GENERATED_RE.test(file.path)) return false;
	if (MINIFIED_RE.test(file.path)) return false;
	if (DIST_RE.test(file.path)) return false;
	if (TEST_PATH_RE.test(file.path)) return false;
	return true;
}

const IDENTIFIER_HIT_WEIGHT = 20;

function countIdentifierHits(file: FileChange, identifiers: readonly string[]): number {
	if (identifiers.length === 0) return 0;
	const text = file.hunks
		.filter((h) => !h.withheld)
		.map((h) => h.lines.join("\n"))
		.join("\n");
	let hits = 0;
	for (const id of identifiers) if (text.includes(id)) hits++;
	return hits;
}

/** Ranks changed files by diff size plus identifier hits, skipping lockfiles, generated/minified/dist/test files, and binaries. */
export function rankKeyFiles(
	files: readonly FileChange[],
	identifiers: readonly string[],
	limit: number,
	deny: KeyFileDenyOptions = {},
): FileChange[] {
	const resolvedDeny: Required<KeyFileDenyOptions> = {
		denyGlobs: deny.denyGlobs ?? [],
		allowGlobs: deny.allowGlobs ?? [],
		docsDenyGlobs: deny.docsDenyGlobs ?? [],
	};
	const candidates = files.filter((f) => isKeyFileCandidate(f, resolvedDeny));
	const scored = candidates.map((file) => ({
		file,
		score: file.additions + file.deletions + countIdentifierHits(file, identifiers) * IDENTIFIER_HIT_WEIGHT,
	}));
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, limit).map((s) => s.file);
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function addedLineNumbers(file: FileChange): Set<number> {
	const added = new Set<number>();
	for (const hunk of file.hunks) {
		if (hunk.withheld) continue;
		const match = HUNK_HEADER_RE.exec(hunk.header);
		if (!match) continue;
		let lineNo = Number(match[1]);
		for (const line of hunk.lines) {
			const marker = line.charAt(0);
			if (marker === "-") continue;
			if (marker === "+") added.add(lineNo);
			lineNo += 1;
		}
	}
	return added;
}

function hunkCenters(file: FileChange): number[] {
	const centers: number[] = [];
	for (const hunk of file.hunks) {
		if (hunk.withheld) continue;
		const match = HUNK_HEADER_RE.exec(hunk.header);
		if (match) centers.push(Number(match[1]));
	}
	return centers;
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
	const sorted = [...windows].sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const [start, end] of sorted) {
		const last = merged[merged.length - 1];
		if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/** Full content with line numbers and added-line markers, or `±40`-line windows around each hunk when the file is large. */
function renderHeadFileText(file: FileChange, lines: readonly string[]): string {
	const added = addedLineNumbers(file);
	const renderLine = (n: number) => `${n}\t${added.has(n) ? "+" : " "} ${lines[n - 1] ?? ""}`;

	if (lines.length <= KEY_FILE_FULL_LINE_LIMIT) {
		const out: string[] = [];
		for (let n = 1; n <= lines.length; n++) out.push(renderLine(n));
		return out.join("\n");
	}

	const windows = mergeWindows(
		hunkCenters(file).map(
			(center) =>
				[Math.max(1, center - KEY_FILE_WINDOW_RADIUS), Math.min(lines.length, center + KEY_FILE_WINDOW_RADIUS)] as [
					number,
					number,
				],
		),
	);
	const out: string[] = [];
	for (const [start, end] of windows) {
		if (out.length > 0) out.push("...");
		for (let n = start; n <= end; n++) out.push(renderLine(n));
	}
	return out.join("\n");
}

// --- git reads ----------------------------------------------------------------

/**
 * `sha` must already be a validated commit object id (never a tag/branch
 * name or other attacker-influenced revspec): `--end-of-options` is placed
 * before the revision, but that alone does not stop a crafted ref name from
 * being parsed as a recognized `git show` option (e.g. `--output=<path>`)
 * when the ref itself starts with `--`. {@link resolveRefToSha} must run
 * first for any ref that is not already a known-valid sha.
 */
async function readHeadFile(git: GitRunner, repo: string, sha: string, path: string): Promise<string[] | undefined> {
	try {
		const validSha = assertValidSha(sha);
		const out = await git(["show", "--end-of-options", `${validSha}:${path}`], repo);
		return out.split("\n");
	} catch {
		return undefined;
	}
}

/** Resolves a possibly-untrusted ref (e.g. a release tag name) to a validated commit sha, or `undefined` if it does not resolve to one. */
async function resolveRefToSha(git: GitRunner, repo: string, ref: string): Promise<string | undefined> {
	try {
		const out = await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repo);
		return assertValidSha(out.trim());
	} catch {
		return undefined;
	}
}

/**
 * `docs/**` and (allowlisted) `.planning/**` only. `CHANGELOG.md` is never a
 * doc candidate: changelog entries have their own bucket (4) with exact-match
 * semantics, so showing the raw file here would just be noisy duplication.
 * `README.md` is not listed generically either; it is added only via the
 * "packages touched" heuristic in {@link collectRawDocChunks}, intro-only.
 *
 * `.planning/**` paths are listed only when `docsConfig.allow` contains a
 * glob that itself starts with `.planning/`: a generic allow glob like
 * `**\/README.md` must never admit a `.planning/**` file by accident (e.g.
 * `.planning/geist/README.md`), so the per-path {@link isDocAllowed} check
 * downstream is not the only gate for this directory.
 */
async function listDocCandidates(
	git: GitRunner,
	repo: string,
	sha: string,
	docsAllowGlobs: readonly string[],
): Promise<string[]> {
	let out: string;
	try {
		out = await git(["ls-tree", "-r", "--name-only", "--end-of-options", sha], repo);
	} catch {
		return [];
	}
	const planningAllowed = docsAllowGlobs.some((g) => g.startsWith(".planning/"));
	return out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((path) => path.startsWith("docs/") || (planningAllowed && path.startsWith(".planning/")));
}

async function readTextFile(git: GitRunner, repo: string, sha: string, path: string): Promise<string | undefined> {
	const lines = await readHeadFile(git, repo, sha, path);
	return lines?.join("\n");
}

// --- changelog matching --------------------------------------------------------

function stripConventionalPrefix(subject: string): string {
	return subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").trim();
}

interface RawChangelogEntry {
	pkg: string;
	version: string;
	index: number;
	text: string;
}

function packageFromChangelogPath(path: string): string {
	if (path === "CHANGELOG.md") return "root";
	const match = path.match(/^packages\/([^/]+)\/CHANGELOG\.md$/);
	return match?.[1] ?? "root";
}

function parseChangelogEntries(path: string, content: string, version: string): RawChangelogEntry[] {
	const pkg = packageFromChangelogPath(path);
	const headingRe = new RegExp(`^##\\s*\\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`);
	const lines = content.split("\n");
	const entries: RawChangelogEntry[] = [];
	let inSection = false;
	let index = 0;
	for (const line of lines) {
		if (headingRe.test(line)) {
			inSection = true;
			continue;
		}
		if (inSection && /^##\s+\[/.test(line)) break;
		if (!inSection) continue;
		const bullet = line.match(/^-\s+(.*)$/);
		if (bullet?.[1]) entries.push({ pkg, version, index: index++, text: bullet[1].trim() });
	}
	return entries;
}

async function collectMatchingChangelogEntries(
	git: GitRunner,
	repo: string,
	story: Story,
	descriptions: readonly string[],
): Promise<RawChangelogEntry[]> {
	const packages = new Set<string>(["root"]);
	for (const file of story.files) {
		const match = file.path.match(/^packages\/([^/]+)\//);
		if (match?.[1]) packages.add(match[1]);
	}
	const version = story.release ?? "Unreleased";
	const sha = story.release === undefined ? story.id : await resolveRefToSha(git, repo, story.release);
	if (sha === undefined) return [];
	const normalizedDescriptions = descriptions.map((d) => stripConventionalPrefix(d).toLowerCase().trim());

	const matches: RawChangelogEntry[] = [];
	for (const pkg of packages) {
		const path = pkg === "root" ? "CHANGELOG.md" : `packages/${pkg}/CHANGELOG.md`;
		const content = await readTextFile(git, repo, sha, path);
		if (!content) continue;
		const entries = parseChangelogEntries(path, content, version);
		for (const entry of entries) {
			if (normalizedDescriptions.includes(entry.text.toLowerCase().trim())) matches.push(entry);
		}
	}
	return matches;
}

// --- bucket builders -----------------------------------------------------------

function textRecord(id: string, bucket: string, kind: SourceRecord["kind"], label: string, text: string): PromptChunk {
	return { id, bucket, kind, label, text, record: { id, kind, label } };
}

function buildHeaderChunk(story: Story): PromptChunk {
	const lines = [
		`Story head: ${story.id.slice(0, 12)}`,
		`Origin: ${story.origin}`,
		`Title: ${redactText(story.title)}`,
		`Release: ${story.release ?? "unreleased"}`,
		`Authors: ${redactText(story.authors.join(", "))}`,
		`Date: ${story.date}`,
		`Files changed: ${story.files.length}`,
		`Branch commits folded in: ${story.branchCommits.length}`,
	];
	return { id: "header", bucket: "header", kind: "meta", label: "story header", text: lines.join("\n") };
}

function buildCommitChunks(headCommit: RawCommit, story: Story, proseDeny: RegExp[]): PromptChunk[] {
	const chunks: PromptChunk[] = [];
	const toChunk = (sha: string, subject: string, body: string) => {
		const cappedBody = body.length > COMMIT_BODY_CAP ? body.slice(0, COMMIT_BODY_CAP) : body;
		const text = redactText(`${subject}\n\n${cappedBody}`.trim());
		if (matchesProseDeny(text, proseDeny)) return;
		chunks.push(
			textRecord(commitSourceId(sha.slice(0, 12)), "commits", "commit", `commit ${sha.slice(0, 12)}`, text),
		);
	};
	toChunk(headCommit.sha, headCommit.subject, headCommit.body);
	for (const c of story.branchCommits) toChunk(c.sha, c.subject, c.body);
	return chunks;
}

function buildPrChunks(story: Story, proseDeny: RegExp[]): PromptChunk[] {
	const pr = story.pr;
	if (!pr) return [];
	const chunks: PromptChunk[] = [];
	const prText = redactText(`${pr.title}\n\n${pr.body}`.trim());
	if (!matchesProseDeny(prText, proseDeny)) {
		chunks.push(textRecord(pullRequestSourceId(pr.number), "pr", "pr", `PR #${pr.number}`, prText));
	}
	pr.reviews.forEach((review, i) => {
		const text = redactText(`${review.author} (${review.state}): ${review.body}`.trim());
		if (matchesProseDeny(text, proseDeny)) return;
		chunks.push(
			textRecord(pullRequestReviewSourceId(pr.number, i), "pr", "review", `PR #${pr.number} review ${i}`, text),
		);
	});
	pr.comments.forEach((comment, i) => {
		const text = redactText(`${comment.author}: ${comment.body}`.trim());
		if (matchesProseDeny(text, proseDeny)) return;
		const idx = pr.reviews.length + i;
		chunks.push(
			textRecord(pullRequestReviewSourceId(pr.number, idx), "pr", "review", `PR #${pr.number} comment ${idx}`, text),
		);
	});
	return chunks;
}

function buildChangelogChunks(entries: readonly RawChangelogEntry[], proseDeny: RegExp[]): PromptChunk[] {
	const chunks: PromptChunk[] = [];
	for (const entry of entries) {
		const text = redactText(entry.text);
		if (matchesProseDeny(text, proseDeny)) continue;
		chunks.push(
			textRecord(
				changelogSourceId(entry.pkg, entry.version, entry.index),
				"changelog",
				"changelog",
				`${entry.pkg}@${entry.version} changelog`,
				text,
			),
		);
	}
	return chunks;
}

function mentionText(story: Story, headCommit: RawCommit): string {
	const parts = [story.title, story.body, headCommit.subject, headCommit.body];
	for (const c of story.branchCommits) {
		parts.push(c.subject, c.body);
	}
	if (story.pr) parts.push(story.pr.title, story.pr.body);
	return parts.join("\n");
}

const README_INTRO_CAP = 2_000;
const DOC_IDENTIFIER_HIT_WEIGHT = 10;
/** Large enough that an explicitly mentioned doc always outranks a merely identifier-matched one. */
const DOC_MENTION_BONUS = 1_000;
const MIN_MENTION_BASENAME_LENGTH = 6;

const ADR_PATH_RE = /^docs\/adr\/(\d{4})-/;

/**
 * ADRs are commonly cited by number alone ("ADR 0003 update"), not by their
 * full slugged filename, so a plain basename-on-word-boundary match (which
 * would require "0003-shipped-skills-channel-governance" verbatim) misses
 * the idiom the repo actually uses. This checks for "adr" adjacent to the
 * ADR's own 4-digit number instead.
 */
function isAdrMentioned(path: string, mentions: string): boolean {
	const number = ADR_PATH_RE.exec(path)?.[1];
	if (!number) return false;
	return new RegExp(`\\badr[\\s-]*${number}\\b`, "i").test(mentions);
}

function escapeRegExpLiteralForMention(chunk: string): string {
	return chunk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tightened path-mention match (coordinator feedback): a full repo-relative
 * path match, or a basename (without extension) of at least
 * {@link MIN_MENTION_BASENAME_LENGTH} chars matched on a word boundary — so
 * a short, generic basename like "test" or "index" can never match.
 */
export function isPathMentioned(path: string, mentions: string): boolean {
	if (mentions.includes(path)) return true;
	const basenameNoExt = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
	if (basenameNoExt.length < MIN_MENTION_BASENAME_LENGTH) return false;
	return new RegExp(`\\b${escapeRegExpLiteralForMention(basenameNoExt)}\\b`).test(mentions);
}

/** Content from the start of the file up to (not including) its second heading, capped. */
export function extractReadmeIntro(content: string, capChars: number = README_INTRO_CAP): string {
	const lines = content.split("\n");
	const introLines: string[] = [];
	let headingCount = 0;
	for (const line of lines) {
		if (HEADING_RE.test(line)) {
			headingCount++;
			if (headingCount === 2) break;
		}
		introLines.push(line);
	}
	const text = introLines.join("\n").trim();
	return text.length > capChars ? text.slice(0, capChars) : text;
}

interface RawDocChunk {
	path: string;
	slug: string;
	heading: string;
	text: string;
}

function touchedPackages(story: Story): string[] {
	const packages = new Set<string>();
	for (const file of story.files) {
		const match = file.path.match(/^packages\/([^/]+)\//);
		if (match?.[1]) packages.add(match[1]);
	}
	return Array.from(packages);
}

async function readPolicedDocText(
	git: GitRunner,
	repo: string,
	story: Story,
	path: string,
	docsConfig: ReelsConfig["docs"],
	denyGlobs: readonly string[],
): Promise<string | undefined> {
	if (!isDocAllowed(path, { allowGlobs: docsConfig.allow, denyGlobs: docsConfig.deny })) return undefined;
	if (isPathDenied(path, denyGlobs)) return undefined;
	return readTextFile(git, repo, story.id, path);
}

/** Every candidate doc chunk (docs/**, allowlisted .planning/**, and one README intro per touched package), unranked. */
async function collectRawDocChunks(
	git: GitRunner,
	repo: string,
	story: Story,
	docsConfig: ReelsConfig["docs"],
	denyGlobs: readonly string[],
	proseDeny: readonly RegExp[],
): Promise<RawDocChunk[]> {
	const raw: RawDocChunk[] = [];
	const slugCountsByPath = new Map<string, Map<string, number>>();
	/** `splitMarkdownIntoChunks` slugs on heading text alone, so the same heading repeated under different parent sections collides; number every repeat after the first so every doc source id stays unique within its file. */
	const uniqueSlug = (path: string, slug: string): string => {
		let counts = slugCountsByPath.get(path);
		if (!counts) {
			counts = new Map();
			slugCountsByPath.set(path, counts);
		}
		const count = (counts.get(slug) ?? 0) + 1;
		counts.set(slug, count);
		return count === 1 ? slug : `${slug}-${count}`;
	};
	const policeAndPush = (path: string, heading: string, candidateText: string) => {
		const policed = policeDocChunk(candidateText);
		if (policed.dropped) return;
		const text = redactText(policed.text);
		if (matchesProseDeny(text, proseDeny)) return;
		// The heading becomes a published PublicSource.label, so it goes through
		// the same redaction and deny-pattern gate as the chunk body. The slug
		// (part of the published source id) is re-derived from the *redacted*
		// heading, never the raw one, or a secret-shaped heading would survive
		// verbatim inside the id even though the label itself is clean.
		const redactedHeading = redactText(heading);
		if (matchesProseDeny(redactedHeading, proseDeny)) return;
		const slug = uniqueSlug(path, slugifyHeading(redactedHeading));
		raw.push({ path, slug, heading: redactedHeading, text });
	};

	for (const path of await listDocCandidates(git, repo, story.id, docsConfig.allow)) {
		const content = await readPolicedDocText(git, repo, story, path, docsConfig, denyGlobs);
		if (content === undefined) continue;
		for (const chunk of splitMarkdownIntoChunks(content)) policeAndPush(path, chunk.heading, chunk.text);
	}

	for (const pkg of touchedPackages(story)) {
		const path = `packages/${pkg}/README.md`;
		const content = await readPolicedDocText(git, repo, story, path, docsConfig, denyGlobs);
		if (content === undefined) continue;
		policeAndPush(path, "intro", extractReadmeIntro(content));
	}

	return raw;
}

/**
 * Ranks doc chunks by identifier hits (from `src/stories.ts`'s
 * `extractIdentifiers` on the story's title/body/anchor text) plus an
 * explicit-mention bonus, drops zero-score chunks unless they are an ADR or
 * explicitly mentioned, and caps the result at `maxChunks`.
 */
export function rankDocChunks(
	raw: readonly RawDocChunk[],
	identifiers: readonly string[],
	mentions: string,
	maxChunks: number,
): RawDocChunk[] {
	const scored = raw.map((chunk) => {
		const hits = identifiers.reduce((count, id) => count + (chunk.text.includes(id) ? 1 : 0), 0);
		const mentioned = isPathMentioned(chunk.path, mentions) || isAdrMentioned(chunk.path, mentions);
		const score = hits * DOC_IDENTIFIER_HIT_WEIGHT + (mentioned ? DOC_MENTION_BONUS : 0);
		return { chunk, score, keep: score > 0 };
	});
	return scored
		.filter((s) => s.keep)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxChunks)
		.map((s) => s.chunk);
}

async function buildDocChunks(
	git: GitRunner,
	repo: string,
	story: Story,
	docsConfig: ReelsConfig["docs"],
	denyGlobs: readonly string[],
	proseDeny: RegExp[],
	mentions: string,
	identifiers: readonly string[],
): Promise<PromptChunk[]> {
	const raw = await collectRawDocChunks(git, repo, story, docsConfig, denyGlobs, proseDeny);
	const ranked = rankDocChunks(raw, identifiers, mentions, docsConfig.maxChunks);
	return ranked.map((chunk) =>
		textRecord(
			docSourceId(chunk.path, chunk.slug),
			"docs",
			"doc",
			`${chunk.path} § ${chunk.heading || chunk.path}`,
			chunk.text,
		),
	);
}

async function buildKeyFileChunks(
	git: GitRunner,
	repo: string,
	story: Story,
	identifiers: readonly string[],
	maxFiles: number,
	deny: KeyFileDenyOptions,
): Promise<{ chunks: PromptChunk[]; selectedPaths: Set<string>; headFiles: Map<string, HeadFileContent> }> {
	const ranked = rankKeyFiles(story.files, identifiers, maxFiles, deny);
	const chunks: PromptChunk[] = [];
	const selectedPaths = new Set<string>();
	const headFiles = new Map<string, HeadFileContent>();
	for (const file of ranked) {
		const lines = await readHeadFile(git, repo, story.id, file.path);
		if (!lines) continue;
		const policed = policeHeadFile(lines);
		// A withheld head file is left out of `selectedPaths` too, so it falls
		// through to the hunk index instead of disappearing from the context
		// entirely: its own (individually policed) hunks still stand on their
		// own, per D8.
		if (policed.withheld) continue;
		selectedPaths.add(file.path);
		headFiles.set(file.path, { path: file.path, lines: policed.lines });
		const text = renderHeadFileText(file, policed.lines);
		chunks.push(textRecord(headFileSourceId(file.path), "keyFiles", "file", `${file.path} (head)`, text));
	}
	return { chunks, selectedPaths, headFiles };
}

function buildTextByPath(story: Story, headFiles: ReadonlyMap<string, HeadFileContent>): Map<string, string> {
	const textByPath = new Map<string, string>();
	for (const file of story.files) {
		const diffText = file.hunks
			.filter((h) => !h.withheld)
			.map((h) => h.lines.join("\n"))
			.join("\n");
		const headText = headFiles.get(file.path)?.lines.join("\n") ?? "";
		textByPath.set(file.path, `${diffText}\n${headText}`);
	}
	return textByPath;
}

function buildAnchorContext(story: Story, headFiles: ReadonlyMap<string, HeadFileContent>): AnchorContext {
	const changedPaths = new Set(story.files.map((f) => f.path));
	const packageNames = new Set<string>();
	const topLevelDirs = new Set<string>();
	for (const file of story.files) {
		const match = file.path.match(/^packages\/([^/]+)\//);
		if (match) packageNames.add(`@draht/${match[1]}`);
		topLevelDirs.add(file.path.includes("/") ? file.path.slice(0, file.path.indexOf("/")) : file.path);
	}
	return {
		changedPaths,
		contextPaths: new Set(),
		textByPath: buildTextByPath(story, headFiles),
		packageNames,
		topLevelDirs,
	};
}

function buildIndexChunk(
	files: readonly FileChange[],
	keyFilePaths: ReadonlySet<string>,
	deny: Required<KeyFileDenyOptions>,
): PromptChunk | undefined {
	const remaining = files
		.filter((f) => !keyFilePaths.has(f.path) && !isContextBlocked(f.path, deny))
		.slice(0, MAX_INDEX_FILES);
	if (remaining.length === 0) return undefined;
	const lines = remaining.map((file) => {
		const nonWithheld = file.hunks.filter((h) => !h.withheld);
		const headers = nonWithheld.map((h) => h.header).join(" | ") || "(none, binary or withheld)";
		return `${file.path} (${file.status}): ${nonWithheld.length} hunk(s), headers: ${headers}`;
	});
	return {
		id: "index",
		bucket: "index",
		kind: "meta",
		label: "hunk index of remaining changed files",
		text: lines.join("\n"),
	};
}

function buildRelatedChunks(story: Story, proseDeny: RegExp[]): PromptChunk[] {
	const chunks: PromptChunk[] = [];
	for (const c of story.related) {
		const text = redactText(`${c.subject}\n\n${c.body}`.trim());
		if (matchesProseDeny(text, proseDeny)) continue;
		chunks.push(
			textRecord(
				relatedCommitSourceId(c.sha.slice(0, 12)),
				"related",
				"related",
				`related ${c.sha.slice(0, 12)}`,
				text,
			),
		);
	}
	return chunks;
}

// --- main entry point -----------------------------------------------------------

export async function assembleStoryContext(
	story: Story,
	repo: string,
	config: ReelsConfig,
	budget: ContextBudget,
	options: AssembleStoryContextOptions = {},
): Promise<AssembledStoryContext> {
	const git = options.git ?? runGit;
	const nonce = createNonce();
	const manifest: ManifestEntry[] = [];

	const denyGlobs = [...DEFAULT_DENY_GLOBS, ...config.code.exclude];
	const allowGlobs = config.code.include;
	const proseDeny = config.prose.denyPatterns.map((p) => new RegExp(p, "i"));

	const policedStory: Story = { ...story, files: applyContentPolicy(story, { denyGlobs, allowGlobs }).files };

	const headCommit = await fetchCommitMetadata(git, repo, story.id);
	const identifierSource = [headCommit.subject, headCommit.body, story.pr?.title ?? "", story.pr?.body ?? ""].join(
		"\n",
	);
	const identifiers = extractIdentifiers(identifierSource, 16);
	const mentions = mentionText(policedStory, headCommit);
	// Doc ranking scores against the story's own title/body/anchor text (not the
	// head commit or PR, which the identifier-based key-file ranking above uses).
	const docIdentifiers = extractIdentifiers(`${policedStory.title}\n${policedStory.body}`, 16);

	const descriptions = [headCommit.subject, ...story.branchCommits.map((c) => c.subject)];
	const changelogEntries = await collectMatchingChangelogEntries(git, repo, policedStory, descriptions);

	const headerChunk = buildHeaderChunk(policedStory);
	const commitChunks = capBucket(
		buildCommitChunks(headCommit, policedStory, proseDeny),
		COMMIT_BUCKET_CAP,
		nonce,
		manifest,
	);
	const prChunks = capBucket(buildPrChunks(policedStory, proseDeny), PR_BUCKET_CAP, nonce, manifest);
	const changelogChunks = capBucket(
		buildChangelogChunks(changelogEntries, proseDeny),
		CHANGELOG_BUCKET_CAP,
		nonce,
		manifest,
	);
	const docChunks = capBucket(
		await buildDocChunks(git, repo, policedStory, config.docs, denyGlobs, proseDeny, mentions, docIdentifiers),
		DOCS_BUCKET_CAP,
		nonce,
		manifest,
	);
	const keyFileDeny: Required<KeyFileDenyOptions> = {
		denyGlobs,
		allowGlobs,
		docsDenyGlobs: config.docs.deny,
	};
	const {
		chunks: keyFileChunks,
		selectedPaths,
		headFiles,
	} = await buildKeyFileChunks(git, repo, policedStory, identifiers, MAX_KEY_FILES, keyFileDeny);
	const cappedKeyFileChunks = capBucket(keyFileChunks, KEY_FILES_BUCKET_CAP, nonce, manifest);
	const indexChunk = buildIndexChunk(policedStory.files, selectedPaths, keyFileDeny);
	const relatedChunks = capBucket(buildRelatedChunks(policedStory, proseDeny), RELATED_BUCKET_CAP, nonce, manifest);

	const body: PromptChunk[] = [
		...commitChunks,
		...prChunks,
		...changelogChunks,
		...docChunks,
		...cappedKeyFileChunks,
		...(indexChunk ? [indexChunk] : []),
		...relatedChunks,
	];

	const effectiveBudget = Math.min(budget.targetChars, budget.maxChars ?? budget.targetChars);
	const headerBudget = wrapLen(nonce, headerChunk) + headerChunk.text.length;
	const remainingBudget = Math.max(0, effectiveBudget - headerBudget);
	const keptBody = truncateChunks(body, remainingBudget, nonce, manifest);

	const allChunks = [headerChunk, ...keptBody];
	const promptContext = allChunks.map((c) => wrapSource(nonce, c.id, c.kind, c.label, c.text)).join("\n\n");

	const droppedIds = new Set(manifest.filter((m) => m.action === "dropped").map((m) => m.id));
	const records: SourceRecord[] = [];
	const chunkById = new Map<string, PromptChunk>();
	for (const chunk of [
		...commitChunks,
		...prChunks,
		...changelogChunks,
		...docChunks,
		...cappedKeyFileChunks,
		...relatedChunks,
	]) {
		chunkById.set(chunk.id, chunk);
	}
	for (const [id, chunk] of chunkById) {
		if (!chunk.record) continue;
		const kept = allChunks.find((c) => c.id === id);
		records.push({
			...chunk.record,
			text: kept ? kept.text : chunk.text,
			included: !droppedIds.has(id),
		});
	}

	return {
		sources: createSourceRegistry(records),
		promptContext,
		manifest: { totalChars: promptContext.length, budgetChars: effectiveBudget, entries: manifest },
		nonce,
		headFiles,
		anchors: buildAnchorContext(policedStory, headFiles),
	};
}
