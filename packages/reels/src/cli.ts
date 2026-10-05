#!/usr/bin/env bun
/**
 * draht-reels — turns git history into narrated explainer reels.
 * Commands: build, site, plan, prune. See README.md for usage.
 */

import { randomUUID } from "node:crypto";
import { access, copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { elevenLabsKeyFilePath, resolveElevenLabsApiKey } from "./api-key.ts";
import {
	assertValidSha,
	collectChangeSetsForShas,
	type GitRunner,
	listShas,
	runGit,
	selectBuildShas,
} from "./collect.ts";
import { assembleStoryContext, tokensToChars } from "./context.ts";
import type {
	ChangeSet,
	FileChange,
	ReelEntry,
	ReelMedia,
	ReelScript,
	ReleaseMeta,
	ReleasePlaylist,
	Scene,
	Story,
} from "./contract.ts";
import { createGithubLookup, type GithubLookup, isNestedInside, parseGithubRepo } from "./github.ts";
import { applyContentPolicy, DEFAULT_DENY_GLOBS, redactText } from "./privacy.ts";
import { mergePlaylists, pruneFeed, publishFeed, publishSite, readFeed } from "./publish.ts";
import { DEFAULT_REELS_CONFIG, loadReelsConfig, type ReelsConfig } from "./reels-config.ts";
import {
	buildRecapSourceRegistry,
	buildReleaseSourceRegistry,
	type ChangelogSection,
	computeReleaseThemes,
	type RecapChangelogInput,
	type RecapCommitInput,
	type ReleaseOverviewInput,
	type ReleaseStoryInput,
	type SyncRecapInput,
	type SyncSummaryInput,
	selectRecapCommits,
	type WeakFeatureInput,
	writeReleaseOverview,
	writeSyncRecap,
} from "./release-writer.ts";
import { buildReleaseGroups, listReleaseTags, type ReleaseGroup } from "./releases.ts";
import { type Bundle, createBundle, publishAudioForRender, renderReel } from "./render.ts";
import type { DraftScriptSnapshot } from "./review.ts";
import { renderReviewMd } from "./review.ts";
import {
	type Lang,
	llmWriter,
	type ModelCompleter,
	type ScriptWriter,
	templateWriter,
	withTemplateFallback,
} from "./script.ts";
import { changelogSourceId, type SourceRegistry, toPublicSources } from "./sources.ts";
import {
	cappedIds,
	MAX_RENDER_ATTEMPTS,
	type ReelsState,
	readState,
	recordApproval,
	recordFailure,
	recordRejection,
	recordSuccess,
	writeState,
} from "./state.ts";
import {
	collectStories,
	isValidDraftId,
	isValidReleaseArtifactId,
	isValidStoryId,
	poolReleaseUpstreamRecap,
	recapId,
	releaseArtifactTag,
	releaseOverviewId,
	selectStoryUnits,
	storyIdSha,
} from "./stories.ts";
import type { DeepDiveMode } from "./story-writer.ts";
import { CostMeter, writeStoryScript } from "./story-writer.ts";
import {
	elevenLabsProvider,
	normalizeBeats,
	resolveTtsModel,
	sanitizeForV4,
	silentProvider,
	type TtsProvider,
} from "./tts.ts";

type Mode = "visual" | "audio" | "both";
type WriterKind = "template" | "llm";
type TtsKind = "elevenlabs" | "none";
type Unit = "commit" | "story";

const MODES: Mode[] = ["visual", "audio", "both"];
const TTS_KINDS: TtsKind[] = ["elevenlabs", "none"];
const WRITER_KINDS: WriterKind[] = ["template", "llm"];
const LANGS: Lang[] = ["en", "de"];
const UNITS: Unit[] = ["commit", "story"];
const DEEP_DIVE_MODES: DeepDiveMode[] = ["auto", "always", "never"];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface BuildArgs {
	repo: string;
	name?: string;
	out: string;
	ref: string;
	since?: string;
	until?: string;
	limit?: number;
	scan?: number;
	allHistory: boolean;
	force: boolean;
	mode: Mode;
	tts: TtsKind;
	writer: WriterKind;
	model?: string;
	lang: Lang;
	repoUrl?: string;
	voice?: string;
	ttsModel?: string;
	concurrency?: number;
	excludeGlobs: string[];
	includeGlobs: string[];
	config?: string;
	unit: Unit;
	tagPattern?: string;
	deepDive: DeepDiveMode;
	maxCostUsd?: number;
	maxLlmTokens?: number;
	maxTtsChars?: number;
	draftsDir?: string;
}

function fail(message: string): never {
	console.error(`draht-reels: ${message}`);
	process.exit(1);
}

function takeValue(argv: string[], i: number, flag: string): string {
	const value = argv[i];
	if (value === undefined) fail(`missing value for ${flag}`);
	return value;
}

function parsePositiveInt(raw: string, flag: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) fail(`${flag} must be a positive integer, got "${raw}"`);
	return n;
}

function parsePositiveNumber(raw: string, flag: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) fail(`${flag} must be a positive number, got "${raw}"`);
	return n;
}

function parseEnum<T extends string>(raw: string, flag: string, allowed: readonly T[]): T {
	if (!(allowed as readonly string[]).includes(raw)) {
		fail(`${flag} must be one of ${allowed.join(", ")}, got "${raw}"`);
	}
	return raw as T;
}

function parseBuildArgs(argv: string[]): BuildArgs {
	const args: BuildArgs = {
		repo: process.cwd(),
		out: "./reels-site",
		ref: "HEAD",
		allHistory: false,
		force: false,
		mode: "both",
		tts: "elevenlabs",
		writer: "template",
		lang: "en",
		excludeGlobs: [],
		includeGlobs: [],
		unit: "commit",
		deepDive: "auto",
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--repo":
				args.repo = takeValue(argv, ++i, a);
				break;
			case "--name":
				args.name = takeValue(argv, ++i, a);
				break;
			case "--out":
				args.out = takeValue(argv, ++i, a);
				break;
			case "--ref":
				args.ref = takeValue(argv, ++i, a);
				break;
			case "--since":
				args.since = takeValue(argv, ++i, a);
				break;
			case "--until":
				args.until = takeValue(argv, ++i, a);
				break;
			case "--limit":
				args.limit = parsePositiveInt(takeValue(argv, ++i, a), a);
				break;
			case "--scan":
				args.scan = parsePositiveInt(takeValue(argv, ++i, a), a);
				break;
			case "--all-history":
				args.allHistory = true;
				break;
			case "--force":
				args.force = true;
				break;
			case "--mode":
				args.mode = parseEnum(takeValue(argv, ++i, a), a, MODES);
				break;
			case "--tts":
				args.tts = parseEnum(takeValue(argv, ++i, a), a, TTS_KINDS);
				break;
			case "--writer":
				args.writer = parseEnum(takeValue(argv, ++i, a), a, WRITER_KINDS);
				break;
			case "--model":
				args.model = takeValue(argv, ++i, a);
				break;
			case "--lang":
				args.lang = parseEnum(takeValue(argv, ++i, a), a, LANGS);
				break;
			case "--repo-url":
				args.repoUrl = takeValue(argv, ++i, a);
				break;
			case "--voice":
				args.voice = takeValue(argv, ++i, a);
				break;
			case "--tts-model":
				args.ttsModel = takeValue(argv, ++i, a);
				break;
			case "--concurrency":
				args.concurrency = parsePositiveInt(takeValue(argv, ++i, a), a);
				break;
			case "--exclude":
				args.excludeGlobs.push(takeValue(argv, ++i, a));
				break;
			case "--include":
				args.includeGlobs.push(takeValue(argv, ++i, a));
				break;
			case "--config":
				args.config = takeValue(argv, ++i, a);
				break;
			case "--unit":
				args.unit = parseEnum(takeValue(argv, ++i, a), a, UNITS);
				break;
			case "--tag-pattern":
				args.tagPattern = takeValue(argv, ++i, a);
				break;
			case "--deep-dive":
				args.deepDive = parseEnum(takeValue(argv, ++i, a), a, DEEP_DIVE_MODES);
				break;
			case "--max-cost-usd":
				args.maxCostUsd = parsePositiveNumber(takeValue(argv, ++i, a), a);
				break;
			case "--max-llm-tokens":
				args.maxLlmTokens = parsePositiveNumber(takeValue(argv, ++i, a), a);
				break;
			case "--max-tts-chars":
				args.maxTtsChars = parsePositiveNumber(takeValue(argv, ++i, a), a);
				break;
			case "--drafts-dir":
				args.draftsDir = takeValue(argv, ++i, a);
				break;
			default:
				fail(`unknown option "${a}"`);
		}
	}
	if (args.name !== undefined && !NAME_RE.test(args.name)) {
		fail(`--name "${args.name}" must match ${NAME_RE} (used as a directory and URL path segment)`);
	}
	return args;
}

/**
 * `ai-completer.lazy.ts` imports `@draht/ai/compat` and `@draht/ai/providers/all`,
 * which resolve to `dist/` and are absent in a fresh checkout that has not run
 * `npm run build`. Loading it only when `--writer llm` is actually chosen keeps
 * `--writer template` (the default) working without building `@draht/ai` first.
 */
interface AiCompleterModule {
	createAiModelCompleter(spec: string): ModelCompleter;
}

async function importAiCompleterLazy(): Promise<AiCompleterModule> {
	return import("./ai-completer.lazy.ts");
}

/** Builds a model completer for `--model <provider/id>`, lazily loading `@draht/ai` the same way `resolveWriter` does. Shared by `--writer llm` (`--unit commit`) and the story writer (`--unit story`). */
async function resolveModelCompleter(model: string): Promise<ModelCompleter> {
	let mod: AiCompleterModule;
	try {
		mod = await importAiCompleterLazy();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(`requires @draht/ai to be built first (run "npm run build" in packages/ai): ${message}`);
	}
	try {
		return mod.createAiModelCompleter(model);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

async function resolveWriter(args: Pick<BuildArgs, "writer" | "model">): Promise<ScriptWriter> {
	if (args.writer === "template") return templateWriter;
	if (!args.model) fail("--writer llm requires --model <provider/id>");
	const completer = await resolveModelCompleter(args.model);
	return withTemplateFallback(llmWriter(completer), (changeSet, error) => {
		console.warn(
			`draht-reels: llm writer failed for ${changeSet.id.slice(0, 12)} (${error.message}); using the template writer`,
		);
	});
}

/** `modelOverride` wins over `args.ttsModel` (T12: `--unit story` defaults to {@link resolveTtsModel}'s per-kind default, not `elevenLabsProvider`'s own `DEFAULT_TTS_MODEL`). */
function resolveTts(args: Pick<BuildArgs, "tts" | "voice" | "ttsModel">, modelOverride?: string): TtsProvider {
	if (args.tts === "none") return silentProvider;
	const resolved = resolveElevenLabsApiKey();
	if (!resolved) {
		fail(
			`--tts elevenlabs needs an ElevenLabs key: set ELEVENLABS_API_KEY or write it to ${elevenLabsKeyFilePath()} (chmod 600). Use --tts none to skip narration audio.`,
		);
	}
	if (resolved.warning) console.warn(`draht-reels: ${resolved.warning}`);
	return elevenLabsProvider({ apiKey: resolved.key, voice: args.voice, model: modelOverride ?? args.ttsModel });
}

function repoName(args: Pick<BuildArgs, "name" | "repo">): string {
	const name = args.name ?? basename(resolve(args.repo));
	if (!NAME_RE.test(name)) {
		fail(
			`repo name "${name}" (derived from --repo; pass --name explicitly) must match ${NAME_RE}, since it is used as a directory and URL path segment`,
		);
	}
	return name;
}

/** Validated short id for media paths. Defense in depth: `changeSet.id` is already a validated sha from collect.ts, but never trust a sink input twice-removed from its source without re-checking. */
function shortSha(changeSet: ChangeSet): string {
	return assertValidSha(changeSet.id).slice(0, 12);
}

/** Rewrites common "repo has no commits reachable from ref" git failures into a clear, actionable message. */
async function collectOrFail<T>(action: () => Promise<T>, repo: string, ref: string): Promise<T> {
	try {
		return await action();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/unknown revision|bad revision|ambiguous argument/i.test(message)) {
			fail(`no commits found in "${repo}" on ref "${ref}". Make at least one commit before running build.`);
		}
		throw error;
	}
}

async function runPlan(argv: string[]): Promise<void> {
	const args = parseBuildArgs(argv);
	const writer = await resolveWriter(args);
	const name = repoName(args);
	const outDir = resolve(args.out);

	const existingFeed = await readFeed(outDir, name);
	const publishedIds = new Set(existingFeed?.reels.map((r) => r.id) ?? []);
	const state = await readState(outDir, name);
	const capped = args.force ? new Set<string>() : cappedIds(state);

	const selection = await collectOrFail(
		() =>
			selectBuildShas({
				repo: args.repo,
				ref: args.ref,
				allHistory: args.allHistory,
				scan: args.scan,
				since: args.since,
				until: args.until,
				limit: args.limit,
				force: args.force,
				publishedIds,
				cappedIds: capped,
			}),
		args.repo,
		args.ref,
	);
	const changeSets = await collectOrFail(
		() => collectChangeSetsForShas(selection.shas, { repo: args.repo }),
		args.repo,
		args.ref,
	);
	const scripts: ReelScript[] = [];
	const reportedChangeSets: ChangeSet[] = [];
	for (const changeSet of changeSets) {
		const policed = applyContentPolicy(changeSet, {
			denyGlobs: [...DEFAULT_DENY_GLOBS, ...args.excludeGlobs],
			allowGlobs: args.includeGlobs,
		});
		scripts.push(await writer(policed, { lang: args.lang }));
		reportedChangeSets.push({
			...policed,
			title: redactText(policed.title),
			body: redactText(policed.body),
			authors: policed.authors.map(redactText),
		});
	}
	console.log(JSON.stringify({ changeSets: reportedChangeSets, scripts }, null, "\t"));
}

export interface BuildResult {
	published: number;
	failed: number;
}

/** True if `path` exists (any type): decides whether a render replaces an existing media dir or creates a new one. */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Atomically replaces `finalDir` with the contents of `tmpDir`: the old
 * directory (if any) is renamed aside, the new one renamed into place, then
 * the old one is removed. A crash between the two renames leaves both the
 * old directory (aside) and the new one on disk, never neither — unlike a
 * naive rm-then-rename, which could delete already-published media before
 * the replacement lands.
 */
async function replaceDir(finalDir: string, tmpDir: string): Promise<void> {
	if (!(await pathExists(finalDir))) {
		await rename(tmpDir, finalDir);
		return;
	}
	const asideDir = `${finalDir}.old-${randomUUID()}`;
	await rename(finalDir, asideDir);
	await rename(tmpDir, finalDir);
	await rm(asideDir, { recursive: true, force: true }).catch(() => {});
}

export interface BuildOverrides {
	writer?: ScriptWriter;
	tts?: TtsProvider;
	/** `--unit story` only: the model completer the story writer calls, bypassing `--model`/`@draht/ai`. */
	complete?: ModelCompleter;
	git?: GitRunner;
	gh?: GithubLookup;
	now?: () => string;
}

/** `overrides` exists only for tests: production always resolves `writer`/`tts`/`complete` from `args`. */
export async function runBuild(argv: string[], overrides: BuildOverrides = {}): Promise<BuildResult> {
	const args = parseBuildArgs(argv);
	if (args.unit === "story") return runBuildStory(args, overrides);
	const writer = overrides.writer ?? (await resolveWriter(args));
	const tts = overrides.tts ?? resolveTts(args);
	const name = repoName(args);
	const outDir = resolve(args.out);
	const mediaDir = join(outDir, name, "reels");
	await mkdir(mediaDir, { recursive: true });

	console.log(
		"draht-reels: output is public-facing. Diffs render verbatim except denied/redacted paths — see README.md Privacy warning.",
	);

	const existingFeed = await readFeed(outDir, name);
	const publishedIds = new Set(existingFeed?.reels.map((r) => r.id) ?? []);
	let state = await readState(outDir, name);
	const capped = args.force ? new Set<string>() : cappedIds(state);

	const selection = await collectOrFail(
		() =>
			selectBuildShas({
				repo: args.repo,
				ref: args.ref,
				allHistory: args.allHistory,
				scan: args.scan,
				since: args.since,
				until: args.until,
				limit: args.limit,
				force: args.force,
				publishedIds,
				cappedIds: capped,
			}),
		args.repo,
		args.ref,
	);
	for (const sha of selection.cappedSkipped) {
		console.warn(
			`draht-reels: skipping ${sha.slice(0, 12)} after ${MAX_RENDER_ATTEMPTS} failed attempts (use --force to retry)`,
		);
	}

	const runnable = await collectOrFail(
		() => collectChangeSetsForShas(selection.shas, { repo: args.repo }),
		args.repo,
		args.ref,
	);
	console.log(`draht-reels: rendering ${runnable.length} change set(s)`);

	const renderBundle = runnable.length > 0 && args.mode !== "audio" ? await createBundle() : undefined;
	const denyGlobs = [...DEFAULT_DENY_GLOBS, ...args.excludeGlobs];

	let publishedCount = 0;
	let failedCount = 0;

	for (const changeSet of runnable) {
		const sha = shortSha(changeSet);
		const finalDir = join(mediaDir, sha);
		// Render into a scratch dir first, so a writer/TTS/render failure never
		// touches a media dir that already exists (see runBuild's doc comment).
		const tmpDir = join(mediaDir, `.tmp-${sha}-${randomUUID()}`);
		try {
			const policed = applyContentPolicy(changeSet, { denyGlobs, allowGlobs: args.includeGlobs });
			const script = await writer(policed, { lang: args.lang });
			await mkdir(tmpDir, { recursive: true });
			const narration = await tts.synthesize(script.scenes, tmpDir);

			let video: string | undefined;
			let poster: string | undefined;
			let durationMs = narration.transcript.reduce((max, s) => Math.max(max, s.endMs), 0);

			if (renderBundle) {
				const videoPath = join(tmpDir, "video.mp4");
				const posterPath = join(tmpDir, "poster.jpg");
				const audioSrc = narration.audioPath
					? await publishAudioForRender(renderBundle, changeSet.id, narration.audioPath)
					: undefined;
				const result = await renderReel({
					bundle: renderBundle,
					props: { scenes: script.scenes, transcript: narration.transcript, audioSrc },
					outVideoPath: videoPath,
					outPosterPath: posterPath,
					concurrency: args.concurrency,
				});
				video = `reels/${sha}/video.mp4`;
				poster = `reels/${sha}/poster.jpg`;
				durationMs = Math.max(durationMs, Math.round((result.durationInFrames / result.fps) * 1000));
			}

			if (narration.audioPath) {
				const target = join(tmpDir, "audio.mp3");
				if (narration.audioPath !== target) await copyFile(narration.audioPath, target);
			}

			const entry: ReelEntry = {
				id: changeSet.id,
				commits: changeSet.commits,
				title: redactText(changeSet.title),
				authors: changeSet.authors.map(redactText),
				date: changeSet.date,
				durationMs,
				video,
				audio: narration.audioPath ? `reels/${sha}/audio.mp3` : undefined,
				poster,
				scenes: script.scenes,
				transcript: narration.transcript,
				stats: {
					files: changeSet.files.length,
					additions: changeSet.files.reduce((sum, f) => sum + f.additions, 0),
					deletions: changeSet.files.reduce((sum, f) => sum + f.deletions, 0),
				},
			};

			await replaceDir(finalDir, tmpDir);

			// Publish after every successful reel: one failure later in the run
			// must never lose reels that were already rendered and paid for.
			await publishFeed({ outDir, repo: { name, url: args.repoUrl }, entries: [entry] });
			publishedCount++;
			state = recordSuccess(state, changeSet.id);
		} catch (error) {
			failedCount++;
			const message = error instanceof Error ? error.message : String(error);
			console.error(`draht-reels: failed to render ${sha} (${message}); continuing with the next one`);
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			state = recordFailure(state, changeSet.id, message, new Date().toISOString());
		}
		await writeState(outDir, name, state);
	}

	console.log(`draht-reels: published ${publishedCount} reel(s), ${failedCount} failed`);
	return { published: publishedCount, failed: failedCount };
}

function defaultDraftsDir(repo: string): string {
	return join(resolve(repo), ".reels-drafts");
}

/** Sum of the sanitized narration lengths `tts.synthesize` would actually send, counted the same way `tts.ts`'s providers derive what they send (`normalizeBeats` then, for v3/v4 models, `sanitizeForV4`). */
function countTtsChars(scenes: readonly Scene[], model: string): number {
	return scenes.reduce((sum, scene) => sum + sanitizeForV4(normalizeBeats(scene).narration, model).length, 0);
}

/** A story's (or weak feature's) deterministic theme/package key — `computeReleaseThemes`' grouping key (D-documented in `StoryMeta.theme`) — from its first `packages/<pkg>/...` changed path, else `"general"`. Never chosen by a writer. */
function topPackage(files: readonly FileChange[]): string {
	for (const file of files) {
		const match = /^packages\/([^/]+)\//.exec(file.path);
		if (match) return match[1] as string;
	}
	return "general";
}

/** The "hook" scene's narration, used as a story's one-line summary for the release overview when one was rendered (`ReleaseStoryInput.summary`); `undefined` when the story has no hook scene (e.g. the template writer's commit-origin output). */
function hookSummary(entry: Pick<ReelEntry, "scenes">): string | undefined {
	return entry.scenes.find((s) => s.section === "hook")?.narration || undefined;
}

/**
 * The release metadata a story/overview/recap draft carries forward to
 * `approve` (`entry.releaseMeta`), from the {@link ReleaseGroup} it belongs
 * to. `undefined` for the "unreleased" group (`group.tag`/`group.tagSha`
 * absent) — unreleased work gets no playlist, so it needs no release meta.
 */
function releaseMetaOf(
	group: Pick<ReleaseGroup, "tag" | "tagSha" | "date" | "previousTag" | "tiny" | "changeCount">,
	themes?: string[],
): ReleaseMeta | undefined {
	if (group.tag === undefined || group.tagSha === undefined) return undefined;
	return {
		sha: group.tagSha,
		date: group.date ?? "",
		previousTag: group.previousTag,
		tiny: group.tiny,
		changeCount: group.changeCount,
		themes,
	};
}

const CHANGELOG_SECTIONS = new Set<ChangelogSection>(["Breaking Changes", "Added", "Changed", "Fixed", "Removed"]);

/** Narrows a `ChangelogAnchor.section` string (a CHANGELOG.md heading) to the closed set `release-writer.ts` ranks by, or `undefined` for a heading outside that set (never ranked, not an error). */
function asChangelogSection(section: string): ChangelogSection | undefined {
	return CHANGELOG_SECTIONS.has(section as ChangelogSection) ? (section as ChangelogSection) : undefined;
}

function toReleaseStoryInput(entry: ReelEntry): ReleaseStoryInput {
	return {
		sha12: entry.id.slice(0, 12),
		title: entry.title,
		origin: entry.story?.origin ?? "commit",
		summary: entry.story?.summary ?? hookSummary(entry),
		packages: [entry.story?.theme || "general"],
	};
}

/**
 * This release's story inputs for the overview writer (T12c): approved
 * entries (from the public feed) plus pending drafts (this run's own, and
 * any already on disk from an earlier run) for `tag`, converted to {@link
 * ReleaseStoryInput}. A story can never be both at once (`approve` deletes
 * its draft), so there is nothing to de-duplicate.
 */
async function collectReleaseStoryInputs(
	outDir: string,
	name: string,
	draftsDir: string,
	tag: string | undefined,
): Promise<ReleaseStoryInput[]> {
	const feed = await readFeed(outDir, name);
	const approved = (feed?.reels ?? []).filter((r) => r.kind === "story" && r.release === tag);

	const draftIds = (await readdir(draftsDir).catch(() => [] as string[])).filter(isValidStoryId);
	const pending: ReelEntry[] = [];
	for (const id of draftIds) {
		try {
			pending.push(await readJsonFile<ReelEntry>(join(draftsDir, id, "entry.json")));
		} catch {
			// A draft directory mid-write (no entry.json yet) is not this run's concern; it will exist next run.
		}
	}

	return [...approved, ...pending.filter((e) => e.kind === "story" && e.release === tag)].map(toReleaseStoryInput);
}

/**
 * Weak-attributed changelog stories excluded from their own reel by
 * `story.minAttribution` (default `"strong"`): listed in the release
 * overview instead (owner decision on weak stories), never duplicated when
 * `minAttribution: "weak"` lets them become their own story (then they are
 * simply absent from `storyById`'s complement below).
 */
function collectWeakFeatures(
	group: ReleaseGroup,
	allStories: readonly Story[],
	attribution: ReadonlyMap<string, "strong" | "weak">,
	storyById: ReadonlyMap<string, Story>,
): WeakFeatureInput[] {
	return allStories
		.filter(
			(s) =>
				s.release === group.tag &&
				s.origin === "commit" &&
				attribution.get(s.id) === "weak" &&
				!storyById.has(s.id),
		)
		.map((s, i) => ({
			title: s.title,
			anchorText: s.title,
			changelogSourceId: changelogSourceId(topPackage(s.files), group.tag ?? "unreleased", i),
		}));
}

/** One release overview or sync recap, ready to render into a draft the same way a story is. */
interface ReleaseArtifactDraft {
	id: string;
	kind: "release" | "recap";
	title: string;
	release: string | undefined;
	releaseMeta: ReleaseMeta | undefined;
	script: ReelScript;
	writer: "llm" | "template";
	repaired: boolean;
	costUsd: number;
	sources: SourceRegistry;
	recap?: NonNullable<ReelEntry["recap"]>;
}

/**
 * Writes a release overview for `group` unless it is tiny, sharing `llmMeter`
 * with story drafting (T12c: "same cost caps"). Returns `undefined` for a
 * tiny release (nothing to draft).
 */
async function writeReleaseOverviewArtifact(
	group: ReleaseGroup,
	opts: {
		outDir: string;
		name: string;
		draftsDir: string;
		allStories: readonly Story[];
		attribution: ReadonlyMap<string, "strong" | "weak">;
		storyById: ReadonlyMap<string, Story>;
		complete: ModelCompleter;
		llmMeter: CostMeter;
		denyPatterns: RegExp[];
		onFallback?: (reason: string) => void;
	},
): Promise<ReleaseArtifactDraft | undefined> {
	if (group.tiny) return undefined;
	const tag = group.tag;
	const stories = await collectReleaseStoryInputs(opts.outDir, opts.name, opts.draftsDir, tag);
	const weakFeatures = collectWeakFeatures(group, opts.allStories, opts.attribution, opts.storyById);
	const pool = poolReleaseUpstreamRecap(group.units, []); // syncs mention only; anchors belong to the recap, not the overview
	const syncs: SyncSummaryInput[] = pool.syncMerges.map((m) => ({ title: m.subject, commitCount: m.commitCount }));

	const input: ReleaseOverviewInput = { tag, stories, weakFeatures, syncs, tiny: group.tiny };
	const costBefore = opts.llmMeter.spentAmount;
	const result = await writeReleaseOverview(input, opts.complete, opts.llmMeter, {
		denyPatterns: opts.denyPatterns,
		onFallback: opts.onFallback,
	});
	if (!result.ok) return undefined;

	return {
		id: releaseOverviewId(tag ?? "unreleased"),
		kind: "release",
		title: `Release overview: ${tag ?? "Unreleased"}`,
		release: tag,
		releaseMeta: releaseMetaOf(
			group,
			computeReleaseThemes(stories).map((t) => t.name),
		),
		script: result.script,
		writer: result.writer,
		repaired: result.repaired,
		costUsd: opts.llmMeter.spentAmount - costBefore,
		sources: buildReleaseSourceRegistry(input),
	};
}

/**
 * Writes the pooled upstream recap for `group` (T11 finding) when its pool
 * is non-empty, sharing `llmMeter` with story drafting. Returns `undefined`
 * when the release carries no routed anchor to narrate.
 */
async function writeRecapArtifact(
	group: ReleaseGroup,
	pool: ReturnType<typeof poolReleaseUpstreamRecap>,
	opts: {
		complete: ModelCompleter;
		llmMeter: CostMeter;
		denyPatterns: RegExp[];
		onFallback?: (reason: string) => void;
	},
): Promise<ReleaseArtifactDraft | undefined> {
	if (pool.anchors.length === 0) return undefined;
	const tag = group.tag;

	const commits: RecapCommitInput[] = pool.upstreamCommits.map((c) => ({
		sha12: c.sha.slice(0, 12),
		subject: c.subject,
	}));
	const changelogEntries: RecapChangelogInput[] = pool.anchors.map(({ anchor }, i) => ({
		text: anchor.entryText,
		sourceId: changelogSourceId(anchor.packages[0] ?? "general", tag ?? "unreleased", i),
		pkg: anchor.packages[0] ?? "general",
		section: asChangelogSection(anchor.section),
	}));
	const title =
		pool.syncMerges.length > 0
			? pool.syncMerges.map((m) => m.subject).join(", ")
			: `upstream-carried changes in ${tag ?? "this release"}`;
	const input: SyncRecapInput = {
		title,
		id: tag ?? "unreleased",
		commits,
		changelogEntries,
		versionRange: group.previousTag ? `${group.previousTag}..${tag}` : undefined,
	};

	const costBefore = opts.llmMeter.spentAmount;
	const result = await writeSyncRecap(input, opts.complete, opts.llmMeter, {
		denyPatterns: opts.denyPatterns,
		onFallback: opts.onFallback,
	});
	const shownCommits = selectRecapCommits(input.commits);
	const sources = buildRecapSourceRegistry(input, result.themes, shownCommits);
	const commitCount = pool.syncMerges.reduce((sum, m) => sum + m.commitCount, 0) + pool.upstreamCommits.length;

	return {
		id: recapId(tag ?? "unreleased"),
		kind: "recap",
		title: `Upstream recap: ${tag ?? "Unreleased"}`,
		release: tag,
		releaseMeta: releaseMetaOf(
			group,
			result.themes.map((t) => t.name),
		),
		script: result.script,
		writer: result.writer,
		repaired: result.repaired,
		costUsd: opts.llmMeter.spentAmount - costBefore,
		sources,
		recap: {
			fromRef: group.previousTag ?? "",
			toRef: tag ?? "unreleased",
			commitCount,
			themes: result.themes.map((t) => ({ name: t.name, sourceIds: t.sourceIds })),
		},
	};
}

/** Renders `artifact`'s TTS/video (same media layout as a story draft, no deep dive) and writes `entry.json`/`script.json`/`review.md`, then atomically replaces the final draft dir — the same shape `runBuildStory`'s per-story loop writes. */
async function renderReleaseArtifactDraft(
	artifact: ReleaseArtifactDraft,
	opts: {
		draftsDir: string;
		tts: TtsProvider;
		renderBundle: Bundle | undefined;
		concurrency?: number;
		now: () => string;
	},
): Promise<void> {
	const finalDir = join(opts.draftsDir, artifact.id);
	const tmpDir = join(opts.draftsDir, `.tmp-${randomUUID()}`);
	await mkdir(tmpDir, { recursive: true });

	const narration = await opts.tts.synthesize(artifact.script.scenes, tmpDir);
	let video: string | undefined;
	let poster: string | undefined;
	let durationMs = narration.transcript.reduce((max, s) => Math.max(max, s.endMs), 0);
	if (opts.renderBundle) {
		const videoPath = join(tmpDir, "video.mp4");
		const posterPath = join(tmpDir, "poster.jpg");
		const audioSrc = narration.audioPath
			? await publishAudioForRender(opts.renderBundle, artifact.id, narration.audioPath)
			: undefined;
		const result = await renderReel({
			bundle: opts.renderBundle,
			props: { scenes: artifact.script.scenes, transcript: narration.transcript, audioSrc },
			outVideoPath: videoPath,
			outPosterPath: posterPath,
			concurrency: opts.concurrency,
		});
		video = "video.mp4";
		poster = "poster.jpg";
		durationMs = Math.max(durationMs, Math.round((result.durationInFrames / result.fps) * 1000));
	}
	if (narration.audioPath) {
		const target = join(tmpDir, "audio.mp3");
		if (narration.audioPath !== target) await copyFile(narration.audioPath, target);
	}

	const entry: ReelEntry = {
		id: artifact.id,
		commits: [],
		title: artifact.title,
		authors: [],
		date: opts.now(),
		durationMs,
		video,
		audio: narration.audioPath ? "audio.mp3" : undefined,
		poster,
		scenes: artifact.script.scenes,
		transcript: narration.transcript,
		stats: { files: 0, additions: 0, deletions: 0 },
		kind: artifact.kind,
		release: artifact.release,
		releaseMeta: artifact.releaseMeta,
		sources: toPublicSources(artifact.sources),
		writer: artifact.writer,
		recap: artifact.recap,
	};

	// `DraftMeta.origin` has no "release"/"recap" option (it documents a *story's* provenance); "commit" is an
	// inert placeholder here — review.md's header line is cosmetic for these two kinds, never validated.
	const scriptSnapshot: DraftScriptSnapshot = {
		script: artifact.script,
		sources: Array.from(artifact.sources.values()).map((record) => ({
			id: record.id,
			kind: record.kind,
			label: record.label,
			url: record.url,
			text: record.text,
			included: record.included !== false,
		})),
		meta: {
			title: entry.title,
			origin: "commit",
			release: artifact.release,
			writer: artifact.writer,
			repaired: artifact.repaired,
			costUsd: artifact.costUsd,
			createdAt: opts.now(),
		},
	};

	await writeFile(join(tmpDir, "entry.json"), `${JSON.stringify(entry, null, "\t")}\n`);
	await writeFile(join(tmpDir, "script.json"), `${JSON.stringify(scriptSnapshot, null, "\t")}\n`);
	await writeFile(join(tmpDir, "review.md"), renderReviewMd(entry, scriptSnapshot));
	await replaceDir(finalDir, tmpDir);
}

/**
 * Drafts the release overview and pooled upstream recap for every `groups`
 * entry matching `tagFilter` (all of them when absent), skipping an entry
 * already drafted or approved unless `force`. Shared by `build --unit
 * story` (every non-tiny/non-empty release in the scan, after its own
 * stories) and the `release` command (explicit tags, no story drafting).
 */
async function draftReleaseArtifacts(
	groups: readonly ReleaseGroup[],
	poolByGroup: ReadonlyMap<ReleaseGroup, ReturnType<typeof poolReleaseUpstreamRecap>>,
	ctx: {
		outDir: string;
		name: string;
		draftsDir: string;
		draftsBaseDir: string;
		allStories: readonly Story[];
		attribution: ReadonlyMap<string, "strong" | "weak">;
		storyById: ReadonlyMap<string, Story>;
		complete: ModelCompleter;
		tts: TtsProvider;
		mode: Mode;
		concurrency?: number;
		denyPatterns: RegExp[];
		force: boolean;
		llmMeter: CostMeter;
		ttsModelId: string;
		ttsMeter: CostMeter;
		now: () => string;
	},
	tagFilter: ReadonlySet<string> | undefined,
	state: ReelsState,
): Promise<{ drafted: number; failed: number; state: ReelsState }> {
	let drafted = 0;
	let failed = 0;
	let draftedIds = new Set((await readdir(ctx.draftsDir).catch(() => [] as string[])).filter(isValidDraftId));
	const approvedIds = new Set((await readFeed(ctx.outDir, ctx.name))?.reels.map((r) => r.id) ?? []);
	let renderBundle: Bundle | undefined;

	for (const group of groups) {
		const groupKey = group.tag ?? "unreleased";
		if (tagFilter && !tagFilter.has(groupKey)) continue;

		const onFallback = (reason: string) =>
			console.warn(`draht-reels: release artifact ${groupKey} writer fallback: ${reason}`);
		const candidates: Array<() => Promise<ReleaseArtifactDraft | undefined>> = [
			() =>
				writeReleaseOverviewArtifact(group, {
					outDir: ctx.outDir,
					name: ctx.name,
					draftsDir: ctx.draftsDir,
					allStories: ctx.allStories,
					attribution: ctx.attribution,
					storyById: ctx.storyById,
					complete: ctx.complete,
					llmMeter: ctx.llmMeter,
					denyPatterns: ctx.denyPatterns,
					onFallback,
				}),
			() =>
				writeRecapArtifact(group, poolByGroup.get(group) ?? poolReleaseUpstreamRecap(group.units, []), {
					complete: ctx.complete,
					llmMeter: ctx.llmMeter,
					denyPatterns: ctx.denyPatterns,
					onFallback,
				}),
		];

		for (const build of candidates) {
			if (!ctx.llmMeter.hasBudget() || !ctx.ttsMeter.hasBudget()) {
				console.warn("draht-reels: stopping: a spend cap is reached; keeping already-drafted release artifacts");
				return { drafted, failed, state };
			}
			let artifact: ReleaseArtifactDraft | undefined;
			try {
				artifact = await build();
			} catch (error) {
				failed++;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`draht-reels: failed to draft a release artifact for ${groupKey} (${message})`);
				continue;
			}
			if (!artifact) continue;
			if (!ctx.force && (draftedIds.has(artifact.id) || approvedIds.has(artifact.id))) continue;

			const chars = countTtsChars(artifact.script.scenes, ctx.ttsModelId);
			if (ctx.ttsMeter.spentAmount + chars > ctx.ttsMeter.capAmount) {
				console.warn(
					`draht-reels: stopping: ${artifact.id} needs ${chars} TTS chars, exceeding the remaining budget; keeping already-drafted release artifacts`,
				);
				return { drafted, failed, state };
			}

			try {
				if (!renderBundle && ctx.mode !== "audio") renderBundle = await createBundle();
				await renderReleaseArtifactDraft(artifact, {
					draftsDir: ctx.draftsDir,
					tts: ctx.tts,
					renderBundle,
					concurrency: ctx.concurrency,
					now: ctx.now,
				});
				ctx.ttsMeter.record(chars);
				drafted++;
				draftedIds = new Set([...draftedIds, artifact.id]);
				state = recordSuccess(state, artifact.id);
			} catch (error) {
				failed++;
				const message = error instanceof Error ? error.message : String(error);
				console.error(`draht-reels: failed to render release artifact ${artifact.id} (${message})`);
				state = recordFailure(state, artifact.id, message, ctx.now());
			}
			await writeState(ctx.draftsBaseDir, ctx.name, state);
		}
	}

	return { drafted, failed, state };
}

/** `gh` PR lookup is attached only when `origin`'s remote resolves to a GitHub repo; a missing remote (or non-GitHub host) silently disables it, same as a missing `gh` binary does inside `github.ts` itself. */
async function resolveStoryGithubLookup(
	repo: string,
	outDir: string,
	cacheDir: string,
	git: GitRunner,
): Promise<GithubLookup | undefined> {
	let remoteUrl: string;
	try {
		remoteUrl = (await git(["remote", "get-url", "origin"], repo)).trim();
	} catch {
		return undefined;
	}
	const ownerRepo = parseGithubRepo(remoteUrl);
	if (!ownerRepo) return undefined;
	return createGithubLookup({ repo: ownerRepo, cacheDir, outDir });
}

const STORY_CONTEXT_TARGET_TOKENS = 60_000;

/**
 * `--unit story` (T12a): drafts stories under `<draftsDir>/<name>/<id>/`
 * (media, `entry.json`, `script.json`), never touching the public feed.
 * Three independent {@link CostMeter}s (LLM USD+tokens combined, as the
 * class already tracks; TTS characters separately) are checked before every
 * story starts, so the run stops drafting new stories — without discarding
 * one already finished — the moment any cap is exhausted.
 */
async function runBuildStory(args: BuildArgs, overrides: BuildOverrides): Promise<BuildResult> {
	if (!args.model && !overrides.complete) fail("--unit story requires --model <provider/id>");

	let config = await resolveReelsConfig(args);
	if (args.tagPattern) config = { ...config, tagPattern: args.tagPattern };

	const name = repoName(args);
	const outDir = resolve(args.out);
	const draftsBaseDir = resolve(args.draftsDir ?? config.build.draftsDir ?? defaultDraftsDir(args.repo));
	if (isNestedInside(outDir, draftsBaseDir)) {
		fail(
			`refusing --drafts-dir "${draftsBaseDir}" inside --out "${outDir}": drafts must never land in the public feed`,
		);
	}
	const draftsDir = join(draftsBaseDir, name);

	const maxCostUsd = args.maxCostUsd ?? config.build.maxCostUsd;
	const maxLlmTokens = args.maxLlmTokens ?? config.build.maxLlmTokens;
	const maxTtsChars = args.maxTtsChars ?? config.build.maxTtsChars;

	const git = overrides.git ?? runGit;
	const complete = overrides.complete ?? (await resolveModelCompleter(args.model as string));
	const ttsModelId = resolveTtsModel("story", args.ttsModel);
	const tts = overrides.tts ?? resolveTts(args, ttsModelId);
	const gh = overrides.gh ?? (await resolveStoryGithubLookup(args.repo, outDir, join(args.repo, ".reels-cache"), git));
	const now = overrides.now ?? (() => new Date().toISOString());

	await mkdir(draftsDir, { recursive: true });
	let state = await readState(draftsBaseDir, name);
	const capped = args.force ? new Set<string>() : cappedIds(state);
	// A pending draft is not yet "published" (it has not gone through `approve`), so it must never anchor the
	// floor/bootstrap window the way a real published id does — only the real public feed does that, same as
	// `--unit commit`. `--force` re-selects a pending draft too (T12b: it "regenerates the draft" in place via
	// `replaceDir`, same as an existing media dir); without `--force` it is filtered back out below.
	const draftedIds = new Set((await readdir(draftsDir).catch(() => [] as string[])).filter(isValidStoryId));
	const existingFeed = await readFeed(outDir, name);
	const approvedIds = new Set(existingFeed?.reels.map((r) => r.id) ?? []);
	const rejectedIds = args.force ? new Set<string>() : new Set(Object.keys(state.rejected ?? {}));

	const groups = await collectOrFail(
		() =>
			buildReleaseGroups({
				repo: args.repo,
				ref: args.ref,
				tagPattern: config.tagPattern,
				historyFloor: config.historyFloor,
				scan: args.scan,
				allHistory: args.allHistory,
				config,
				git,
			}),
		args.repo,
		args.ref,
	);

	const allStories: Story[] = [];
	const attribution = new Map<string, "strong" | "weak">();
	// For looking up a story's own group later, by the same `tag` key it was stamped with below.
	const groupByTag = new Map<string | undefined, ReleaseGroup>(groups.map((g) => [g.tag, g]));
	// Pooled upstream recap material (T11 finding), keyed by group (its own
	// `tag`, undefined for "Unreleased"): `collectStories` already separates
	// each group's own `syncRecap` anchors, so pooling them with that group's
	// sync merges and direct `upstream:` commits needs no second pass.
	const poolByGroup = new Map<ReleaseGroup, ReturnType<typeof poolReleaseUpstreamRecap>>();
	for (const group of groups) {
		const anchorsWithRange = group.anchors.map((anchor) => ({ anchor, range: group.range }));
		const result = await collectStories(group.units, { repo: args.repo, git, gh, anchors: anchorsWithRange });
		// A story's `release` must be set before it leaves this loop: every
		// downstream consumer (the entry's own `release` field, the release
		// overview's story list, the playlist a story's approval updates)
		// keys off it, and `collectStories` itself has no notion of releases.
		for (const story of result.stories) story.release = group.tag;
		allStories.push(...result.stories);
		for (const [id, strength] of result.attribution) attribution.set(id, strength);
		poolByGroup.set(group, poolReleaseUpstreamRecap(group.units, result.syncRecap));
	}

	const minAttribution = config.story.minAttribution;
	const eligibleStories = allStories.filter((story) => {
		if (story.origin !== "commit") return true; // branch/pr stories are always eligible
		if (minAttribution === "weak") return true;
		return attribution.get(story.id) !== "weak";
	});
	const storyById = new Map(eligibleStories.map((story) => [story.id, story]));
	const storyIds = eligibleStories.map((story) => story.id).filter((id) => !rejectedIds.has(id));
	for (const id of rejectedIds) {
		if (storyById.has(id))
			console.warn(`draht-reels: skipping rejected story ${id.slice(0, 12)} (use --force to retry)`);
	}

	const selection = selectStoryUnits(storyIds, approvedIds, capped, {
		allHistory: args.allHistory,
		limit: args.limit,
		force: args.force,
	});
	for (const id of selection.cappedSkipped) {
		console.warn(
			`draht-reels: skipping story ${id.slice(0, 12)} after ${MAX_RENDER_ATTEMPTS} failed attempts (use --force to retry)`,
		);
	}
	// A pending (not yet approved/rejected) draft is skipped by default; `--force` regenerates it in place.
	const idsToProcess = selection.ids.filter((id) => args.force || !draftedIds.has(id));
	console.log(`draht-reels: drafting ${idsToProcess.length} story/stories`);

	const renderBundle = idsToProcess.length > 0 && args.mode !== "audio" ? await createBundle() : undefined;
	const budget = { targetChars: tokensToChars(STORY_CONTEXT_TARGET_TOKENS) };

	const llmMeter = new CostMeter(maxCostUsd, maxLlmTokens);
	const ttsMeter = new CostMeter(maxTtsChars);

	let draftedCount = 0;
	let failedCount = 0;

	for (const id of idsToProcess) {
		if (!llmMeter.hasBudget() || !ttsMeter.hasBudget()) {
			console.warn("draht-reels: stopping: a spend cap is reached; keeping already-drafted stories");
			break;
		}
		const story = storyById.get(id);
		if (!story) continue;

		const finalDir = join(draftsDir, id);
		const tmpDir = join(draftsDir, `.tmp-${randomUUID()}`);
		try {
			const ctx = await assembleStoryContext(story, args.repo, config, budget, { git });
			const costBefore = llmMeter.spentAmount;
			const writeResult = await writeStoryScript(story, ctx, complete, llmMeter, {
				deepDive: args.deepDive,
				lang: args.lang,
				denyPatterns: config.prose.denyPatterns.map((p) => new RegExp(p, "i")),
				onFallback: (s, phase, reason) =>
					console.warn(`draht-reels: story ${s.id.slice(0, 12)} ${phase} writer fallback: ${reason}`),
			});

			const shortChars = countTtsChars(writeResult.script.scenes, ttsModelId);
			const deepChars = writeResult.deepDive ? countTtsChars(writeResult.deepDive.script.scenes, ttsModelId) : 0;
			const totalChars = shortChars + deepChars;
			if (ttsMeter.spentAmount + totalChars > ttsMeter.capAmount) {
				console.warn(
					`draht-reels: stopping: story ${id.slice(0, 12)} needs ${totalChars} TTS chars, exceeding the remaining budget; keeping already-drafted stories`,
				);
				break;
			}

			await mkdir(tmpDir, { recursive: true });
			const headSha = storyIdSha(story.id);

			const narration = await tts.synthesize(writeResult.script.scenes, tmpDir);
			ttsMeter.record(shortChars);

			let video: string | undefined;
			let poster: string | undefined;
			let durationMs = narration.transcript.reduce((max, s) => Math.max(max, s.endMs), 0);
			if (renderBundle) {
				const videoPath = join(tmpDir, "video.mp4");
				const posterPath = join(tmpDir, "poster.jpg");
				const audioSrc = narration.audioPath
					? await publishAudioForRender(renderBundle, headSha, narration.audioPath)
					: undefined;
				const result = await renderReel({
					bundle: renderBundle,
					props: { scenes: writeResult.script.scenes, transcript: narration.transcript, audioSrc },
					outVideoPath: videoPath,
					outPosterPath: posterPath,
					concurrency: args.concurrency,
				});
				video = "video.mp4";
				poster = "poster.jpg";
				durationMs = Math.max(durationMs, Math.round((result.durationInFrames / result.fps) * 1000));
			}
			if (narration.audioPath) {
				const target = join(tmpDir, "audio.mp3");
				if (narration.audioPath !== target) await copyFile(narration.audioPath, target);
			}

			let deepDiveMedia: ReelMedia | undefined;
			let deepScript: ReelScript | undefined;
			if (writeResult.deepDive) {
				const deepDir = join(tmpDir, "deep");
				await mkdir(deepDir, { recursive: true });
				const deepNarration = await tts.synthesize(writeResult.deepDive.script.scenes, deepDir);
				ttsMeter.record(deepChars);

				let deepVideo: string | undefined;
				let deepPoster: string | undefined;
				let deepDurationMs = deepNarration.transcript.reduce((max, s) => Math.max(max, s.endMs), 0);
				if (renderBundle) {
					const videoPath = join(deepDir, "video.mp4");
					const posterPath = join(deepDir, "poster.jpg");
					const audioSrc = deepNarration.audioPath
						? await publishAudioForRender(renderBundle, headSha, deepNarration.audioPath)
						: undefined;
					const result = await renderReel({
						bundle: renderBundle,
						props: { scenes: writeResult.deepDive.script.scenes, transcript: deepNarration.transcript, audioSrc },
						outVideoPath: videoPath,
						outPosterPath: posterPath,
						concurrency: args.concurrency,
					});
					deepVideo = "deep/video.mp4";
					deepPoster = "deep/poster.jpg";
					deepDurationMs = Math.max(deepDurationMs, Math.round((result.durationInFrames / result.fps) * 1000));
				}
				if (deepNarration.audioPath) {
					const target = join(deepDir, "audio.mp3");
					if (deepNarration.audioPath !== target) await copyFile(deepNarration.audioPath, target);
				}
				deepDiveMedia = {
					durationMs: deepDurationMs,
					video: deepVideo,
					audio: deepNarration.audioPath ? "deep/audio.mp3" : undefined,
					poster: deepPoster,
					scenes: writeResult.deepDive.script.scenes,
					transcript: deepNarration.transcript,
				};
				deepScript = writeResult.deepDive.script;
			}

			const sources = toPublicSources(ctx.sources);
			const storyGroup = story.release !== undefined ? groupByTag.get(story.release) : undefined;
			const entry: ReelEntry = {
				id: story.id,
				commits: story.commits,
				title: redactText(story.title),
				authors: story.authors.map(redactText),
				date: story.date,
				durationMs,
				video,
				audio: narration.audioPath ? "audio.mp3" : undefined,
				poster,
				scenes: writeResult.script.scenes,
				transcript: narration.transcript,
				stats: {
					files: story.files.length,
					additions: story.files.reduce((sum, f) => sum + f.additions, 0),
					deletions: story.files.reduce((sum, f) => sum + f.deletions, 0),
				},
				kind: "story",
				story: {
					origin: story.origin,
					base: story.base,
					commitCount: 1 + story.branchCommits.length,
					pr: story.pr ? { number: story.pr.number, url: story.pr.url } : undefined,
					theme: topPackage(story.files),
					summary: hookSummary({ scenes: writeResult.script.scenes }),
					deepDive: writeResult.deepDiveOutcome === "rendered" ? "rendered" : "not-warranted",
				},
				release: story.release,
				releaseMeta: storyGroup ? releaseMetaOf(storyGroup, [topPackage(story.files)]) : undefined,
				sources,
				deepDive: deepDiveMedia,
				writer: writeResult.writer,
			};

			// Kept for review (T12b): every source handed to (or withheld from) the writer, by id, plus the
			// writer-internal claim/quote the validator stripped from the published beats, so a reviewer can check
			// every claim next to its cited source's exact text without re-assembling context from git. Never
			// merged into entry.json/feed.json: quotes are verbatim source text, which the public feed never carries.
			const scriptSnapshot: DraftScriptSnapshot = {
				script: writeResult.script,
				notes: writeResult.notes,
				deepDive: deepScript,
				deepDiveNotes: writeResult.deepDive?.notes,
				sources: Array.from(ctx.sources.values()).map((record) => ({
					id: record.id,
					kind: record.kind,
					label: record.label,
					url: record.url,
					text: record.text,
					included: record.included !== false,
				})),
				meta: {
					title: entry.title,
					origin: story.origin,
					attribution: story.origin === "commit" ? attribution.get(id) : undefined,
					release: story.release,
					writer: writeResult.writer,
					repaired: writeResult.repaired,
					costUsd: llmMeter.spentAmount - costBefore,
					createdAt: now(),
					deepDive: writeResult.deepDive
						? { writer: writeResult.deepDive.writer, repaired: writeResult.deepDive.repaired }
						: undefined,
				},
			};

			await writeFile(join(tmpDir, "entry.json"), `${JSON.stringify(entry, null, "\t")}\n`);
			await writeFile(join(tmpDir, "script.json"), `${JSON.stringify(scriptSnapshot, null, "\t")}\n`);
			await writeFile(join(tmpDir, "review.md"), renderReviewMd(entry, scriptSnapshot));

			await replaceDir(finalDir, tmpDir);
			draftedCount++;
			state = recordSuccess(state, id);
		} catch (error) {
			failedCount++;
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`draht-reels: failed to draft story ${id.slice(0, 12)} (${message}); continuing with the next one`,
			);
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			state = recordFailure(state, id, message, now());
		}
		await writeState(draftsBaseDir, name, state);
	}

	const releaseArtifacts = await draftReleaseArtifacts(
		groups,
		poolByGroup,
		{
			outDir,
			name,
			draftsDir,
			draftsBaseDir,
			allStories,
			attribution,
			storyById,
			complete,
			tts,
			mode: args.mode,
			concurrency: args.concurrency,
			denyPatterns: config.prose.denyPatterns.map((p) => new RegExp(p, "i")),
			force: args.force,
			llmMeter,
			ttsModelId,
			ttsMeter,
			now,
		},
		undefined, // every non-tiny/non-empty release in the scan, not an explicit subset (that's the `release` command's job)
		state,
	);
	state = releaseArtifacts.state;
	draftedCount += releaseArtifacts.drafted;
	failedCount += releaseArtifacts.failed;

	console.log(`draht-reels: drafted ${draftedCount} story/stories and release artifact(s), ${failedCount} failed`);
	console.log(
		`draht-reels: spend — LLM $${llmMeter.spentAmount.toFixed(2)}/$${maxCostUsd}, ${llmMeter.spentTokenAmount}/${maxLlmTokens} tokens; TTS ${ttsMeter.spentAmount}/${maxTtsChars} chars`,
	);
	return { published: draftedCount, failed: failedCount };
}

/** Splits `release [<tag>…] [--flags]`'s leading positional tags from the rest, which `parseBuildArgs` then parses exactly like `build`'s own flags. */
function splitReleaseTags(argv: string[]): { tags: string[]; rest: string[] } {
	let i = 0;
	while (i < argv.length && !(argv[i] as string).startsWith("--")) i++;
	return { tags: argv.slice(0, i), rest: argv.slice(i) };
}

/**
 * `draht-reels release [<tag>…]` (T13): drafts the release overview and
 * pooled upstream recap for the given release tags, or every non-tiny
 * release in the scan when none are given, without re-drafting stories —
 * useful after `approve`ing a release's stories, to draft the overview over
 * what is now approved. Shares `draftReleaseArtifacts` with `build --unit
 * story`, so the draft layout, review.md, cost caps, and state are
 * identical.
 */
export async function runRelease(argv: string[], overrides: BuildOverrides = {}): Promise<BuildResult> {
	const { tags, rest } = splitReleaseTags(argv);
	const args = parseBuildArgs(rest);
	if (!args.model && !overrides.complete) fail("release requires --model <provider/id>");

	let config = await resolveReelsConfig(args);
	if (args.tagPattern) config = { ...config, tagPattern: args.tagPattern };

	const name = repoName(args);
	const outDir = resolve(args.out);
	const draftsBaseDir = resolve(args.draftsDir ?? config.build.draftsDir ?? defaultDraftsDir(args.repo));
	if (isNestedInside(outDir, draftsBaseDir)) {
		fail(
			`refusing --drafts-dir "${draftsBaseDir}" inside --out "${outDir}": drafts must never land in the public feed`,
		);
	}
	const draftsDir = join(draftsBaseDir, name);

	const maxCostUsd = args.maxCostUsd ?? config.build.maxCostUsd;
	const maxLlmTokens = args.maxLlmTokens ?? config.build.maxLlmTokens;
	const maxTtsChars = args.maxTtsChars ?? config.build.maxTtsChars;

	const git = overrides.git ?? runGit;
	const complete = overrides.complete ?? (await resolveModelCompleter(args.model as string));
	const ttsModelId = resolveTtsModel("story", args.ttsModel);
	const tts = overrides.tts ?? resolveTts(args, ttsModelId);
	const gh = overrides.gh ?? (await resolveStoryGithubLookup(args.repo, outDir, join(args.repo, ".reels-cache"), git));
	const now = overrides.now ?? (() => new Date().toISOString());

	await mkdir(draftsDir, { recursive: true });
	const state = await readState(draftsBaseDir, name);

	const groups = await collectOrFail(
		() =>
			buildReleaseGroups({
				repo: args.repo,
				ref: args.ref,
				tagPattern: config.tagPattern,
				historyFloor: config.historyFloor,
				scan: args.scan,
				allHistory: args.allHistory,
				config,
				git,
			}),
		args.repo,
		args.ref,
	);

	const allStories: Story[] = [];
	const attribution = new Map<string, "strong" | "weak">();
	const poolByGroup = new Map<ReleaseGroup, ReturnType<typeof poolReleaseUpstreamRecap>>();
	for (const group of groups) {
		const anchorsWithRange = group.anchors.map((anchor) => ({ anchor, range: group.range }));
		const result = await collectStories(group.units, { repo: args.repo, git, gh, anchors: anchorsWithRange });
		for (const story of result.stories) story.release = group.tag;
		allStories.push(...result.stories);
		for (const [id, strength] of result.attribution) attribution.set(id, strength);
		poolByGroup.set(group, poolReleaseUpstreamRecap(group.units, result.syncRecap));
	}

	const minAttribution = config.story.minAttribution;
	const storyById = new Map(
		allStories
			.filter(
				(story) => story.origin !== "commit" || minAttribution === "weak" || attribution.get(story.id) !== "weak",
			)
			.map((story) => [story.id, story]),
	);

	const requestedTags = new Set(tags);
	if (requestedTags.size > 0) {
		const knownTags = new Set(groups.map((group) => group.tag ?? "unreleased"));
		for (const requestedTag of requestedTags) {
			if (!knownTags.has(requestedTag)) console.warn(`draht-reels: "${requestedTag}" is not a release in this scan`);
		}
	}
	const tagFilter = requestedTags.size > 0 ? requestedTags : undefined;

	const llmMeter = new CostMeter(maxCostUsd, maxLlmTokens);
	const ttsMeter = new CostMeter(maxTtsChars);

	const result = await draftReleaseArtifacts(
		groups,
		poolByGroup,
		{
			outDir,
			name,
			draftsDir,
			draftsBaseDir,
			allStories,
			attribution,
			storyById,
			complete,
			tts,
			mode: args.mode,
			concurrency: args.concurrency,
			denyPatterns: config.prose.denyPatterns.map((p) => new RegExp(p, "i")),
			force: args.force,
			llmMeter,
			ttsModelId,
			ttsMeter,
			now,
		},
		tagFilter,
		state,
	);

	console.log(`draht-reels: drafted ${result.drafted} release artifact(s), ${result.failed} failed`);
	console.log(
		`draht-reels: spend — LLM $${llmMeter.spentAmount.toFixed(2)}/$${maxCostUsd}, ${llmMeter.spentTokenAmount}/${maxLlmTokens} tokens; TTS ${ttsMeter.spentAmount}/${maxTtsChars} chars`,
	);
	return { published: result.drafted, failed: result.failed };
}

/** Shared `--repo`/`--name`/`--out`/`--drafts-dir`/`--config` target for `review`/`approve`/`reject` (the publish-gate commands, T12b). */
interface DraftTargetArgs {
	repo: string;
	name?: string;
	out: string;
	draftsDir?: string;
	config?: string;
}

function parseDraftTargetFlag(args: DraftTargetArgs, flag: string, value: string): boolean {
	switch (flag) {
		case "--repo":
			args.repo = value;
			return true;
		case "--name":
			args.name = value;
			return true;
		case "--out":
			args.out = value;
			return true;
		case "--drafts-dir":
			args.draftsDir = value;
			return true;
		case "--config":
			args.config = value;
			return true;
		default:
			return false;
	}
}

const DRAFT_TARGET_FLAGS = new Set(["--repo", "--name", "--out", "--drafts-dir", "--config"]);

function parseReviewArgs(argv: string[]): DraftTargetArgs & { id?: string } {
	const args: DraftTargetArgs & { id?: string } = { repo: process.cwd(), out: "./reels-site" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a !== undefined && DRAFT_TARGET_FLAGS.has(a)) {
			parseDraftTargetFlag(args, a, takeValue(argv, ++i, a));
		} else if (a !== undefined && !a.startsWith("--") && args.id === undefined) {
			args.id = a;
		} else {
			fail(`unknown option "${a}"`);
		}
	}
	return args;
}

function parseApproveArgs(argv: string[]): DraftTargetArgs & { ids: string[] } {
	const args: DraftTargetArgs & { ids: string[] } = { repo: process.cwd(), out: "./reels-site", ids: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a !== undefined && DRAFT_TARGET_FLAGS.has(a)) {
			parseDraftTargetFlag(args, a, takeValue(argv, ++i, a));
		} else if (a !== undefined && !a.startsWith("--")) {
			args.ids.push(a);
		} else {
			fail(`unknown option "${a}"`);
		}
	}
	if (args.ids.length === 0) fail("approve requires at least one draft id");
	return args;
}

function parseRejectArgs(argv: string[]): DraftTargetArgs & { ids: string[]; reason?: string } {
	const args: DraftTargetArgs & { ids: string[]; reason?: string } = {
		repo: process.cwd(),
		out: "./reels-site",
		ids: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--reason") {
			args.reason = takeValue(argv, ++i, a);
		} else if (a !== undefined && DRAFT_TARGET_FLAGS.has(a)) {
			parseDraftTargetFlag(args, a, takeValue(argv, ++i, a));
		} else if (a !== undefined && !a.startsWith("--")) {
			args.ids.push(a);
		} else {
			fail(`unknown option "${a}"`);
		}
	}
	if (args.ids.length === 0) fail("reject requires at least one draft id");
	return args;
}

/** `<draftsDir>/<name>` for `review`/`approve`/`reject`: same `--drafts-dir` > `.reels.json`'s `build.draftsDir` > default rule `runBuildStory` uses, so a draft's id resolves to the same path under either command. */
async function resolveDraftPaths(
	args: DraftTargetArgs,
): Promise<{ name: string; draftsDir: string; draftsBaseDir: string; outDir: string }> {
	const config = await resolveReelsConfig(args);
	const name = repoName(args);
	const draftsBaseDir = resolve(args.draftsDir ?? config.build.draftsDir ?? defaultDraftsDir(args.repo));
	return { name, draftsDir: join(draftsBaseDir, name), draftsBaseDir, outDir: resolve(args.out) };
}

async function readJsonFile<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf-8")) as T;
}

/** `draht-reels review [<id>]`: without an id, lists pending drafts; with one, prints that draft's `review.md` (T12b's human approval view — every claim next to its cited source text). */
export async function runReview(argv: string[]): Promise<void> {
	const args = parseReviewArgs(argv);
	const { draftsDir } = await resolveDraftPaths(args);

	if (args.id !== undefined) {
		if (!isValidDraftId(args.id)) fail(`"${args.id}" is not a valid draft id`);
		let content: string;
		try {
			content = await readFile(join(draftsDir, args.id, "review.md"), "utf-8");
		} catch {
			fail(`no draft "${args.id}" in ${draftsDir}`);
		}
		console.log(content);
		return;
	}

	const ids = (await readdir(draftsDir).catch(() => [] as string[])).filter(isValidDraftId);
	if (ids.length === 0) {
		console.log(`draht-reels: no drafts in ${draftsDir}`);
		return;
	}
	for (const id of ids) {
		const entry = await readJsonFile<ReelEntry>(join(draftsDir, id, "entry.json"));
		const snapshot = await readJsonFile<DraftScriptSnapshot>(join(draftsDir, id, "script.json"));
		console.log(
			`${id}  ${entry.title}  release=${entry.release ?? "unreleased"}  created=${snapshot.meta.createdAt}  writer=${entry.writer ?? "template"}`,
		);
	}
}

/**
 * A release/recap/story entry's own tag, for routing an approval into the
 * right {@link ReleasePlaylist}: `entry.release` when set, else (for a
 * `release-<tag>`/`recap-<tag>` id) the tag the id itself names. `undefined`
 * for a story with no release yet (unreleased; no playlist to update).
 */
function entryPlaylistTag(entry: ReelEntry): string | undefined {
	if (entry.release !== undefined) return entry.release;
	return isValidReleaseArtifactId(entry.id) ? releaseArtifactTag(entry.id) : undefined;
}

/**
 * A fresh playlist for a tag never seen before: every tag-level field
 * (`sha`, `date`, `previousTag`, `tiny`, `changeCount`) comes from
 * `entry.releaseMeta` when the first-approved entry carries it, else
 * defaults to empty/zero exactly as before — filled in later by {@link
 * fillReleaseMeta} the moment any approved entry does carry it.
 */
function blankPlaylist(tag: string, entry: ReelEntry): ReleasePlaylist {
	const meta = entry.releaseMeta;
	return {
		tag,
		sha: meta?.sha ?? "",
		date: meta?.date ?? entry.date,
		previousTag: meta?.previousTag,
		title: tag,
		storyIds: [],
		themes: [],
		syncs: [],
		changeCount: meta?.changeCount ?? 0,
		tiny: meta?.tiny ?? false,
	};
}

/**
 * Fills a playlist's own `sha`/`date`/`previousTag`/`changeCount` from
 * `entry.releaseMeta` wherever the playlist's current value is the blank
 * default (empty string, undefined, or zero) — never overwriting a value an
 * earlier approval already set. `tiny` is always taken from `meta` when
 * present: it is a deterministic fact about the release itself, identical
 * for every entry that belongs to it, so there is nothing to preserve.
 */
function fillReleaseMeta(playlist: ReleasePlaylist, entry: ReelEntry): ReleasePlaylist {
	const meta = entry.releaseMeta;
	if (!meta) return playlist;
	return {
		...playlist,
		sha: playlist.sha !== "" ? playlist.sha : meta.sha,
		date: playlist.date !== "" ? playlist.date : meta.date,
		previousTag: playlist.previousTag ?? meta.previousTag,
		changeCount: playlist.changeCount !== 0 ? playlist.changeCount : meta.changeCount,
		tiny: meta.tiny,
	};
}

/**
 * Updates `tag`'s {@link ReleasePlaylist} for one newly-approved entry:
 * `entry.kind === "story"` recomputes `storyIds` from every approved story
 * for this tag (newest-first by date, the same order `feed.reels` itself
 * keeps — "mainline order" in the absence of a cheaper signal at approve
 * time), `"release"` sets `overviewId`, `"recap"` sets `recapId`. Every
 * field an existing playlist already carries is preserved untouched, except
 * that {@link fillReleaseMeta} fills in a still-blank `sha`/`date`/
 * `previousTag`/`changeCount`/`tiny` from this entry's own release metadata.
 */
async function updateReleasePlaylist(outDir: string, name: string, tag: string, entry: ReelEntry): Promise<void> {
	const feed = await readFeed(outDir, name);
	const existing = feed?.playlists?.find((p) => p.tag === tag) ?? blankPlaylist(tag, entry);

	const withMeta = fillReleaseMeta(existing, entry);
	let playlist: ReleasePlaylist = withMeta;
	if (entry.kind === "story") {
		const storyIds = (feed?.reels ?? [])
			.filter((r) => r.kind === "story" && r.release === tag)
			.map((r) => r.id)
			.includes(entry.id)
			? (feed?.reels ?? []).filter((r) => r.kind === "story" && r.release === tag)
			: [...(feed?.reels ?? []).filter((r) => r.kind === "story" && r.release === tag), entry];
		playlist = { ...withMeta, storyIds: storyIds.map((r) => r.id) };
	} else if (entry.kind === "release") {
		playlist = { ...withMeta, overviewId: entry.id };
	} else if (entry.kind === "recap") {
		playlist = { ...withMeta, recapId: entry.id };
	} else {
		return;
	}

	await publishFeed({ outDir, repo: { name }, entries: [], playlists: mergePlaylists(feed?.playlists, [playlist]) });
}

/** `draht-reels approve <id>…`: publishes a draft's media and feed entry (same atomic media → feed → repos.json order `publishFeed` already uses), updates that release's playlist, removes the draft, and records the approval in state. Idempotent: approving an id with no pending draft is a no-op. */
export async function runApprove(argv: string[]): Promise<void> {
	const args = parseApproveArgs(argv);
	const { name, draftsDir, draftsBaseDir, outDir } = await resolveDraftPaths(args);
	const mediaDir = join(outDir, name, "reels");
	await mkdir(mediaDir, { recursive: true });

	let state: ReelsState = await readState(draftsBaseDir, name);
	for (const id of args.ids) {
		if (!isValidDraftId(id)) {
			console.error(`draht-reels: "${id}" is not a valid draft id`);
			process.exitCode = 1;
			continue;
		}
		const draftDir = join(draftsDir, id);
		if (!(await pathExists(draftDir))) {
			console.log(
				`draht-reels: ${id} has no pending draft (already approved, rejected, or never drafted); nothing to do`,
			);
			continue;
		}

		const entry = await readJsonFile<ReelEntry>(join(draftDir, "entry.json"));
		const finalDir = join(mediaDir, id);
		const mediaTmp = join(mediaDir, `.tmp-${id}-${randomUUID()}`);
		await cp(draftDir, mediaTmp, { recursive: true });
		await rm(join(mediaTmp, "entry.json"), { force: true });
		await rm(join(mediaTmp, "script.json"), { force: true });
		await rm(join(mediaTmp, "review.md"), { force: true });
		await replaceDir(finalDir, mediaTmp);

		await publishFeed({ outDir, repo: { name }, entries: [entry] });

		// A release overview may itself be approved before every one of its stories is (owner decision, T12c):
		// the overview just cites whichever `st:`/`cl:` ids its own draft was built from, and the playlist below
		// only ever grows — approving overview, recap, and stories in any order converges to the same playlist.
		const tag = entryPlaylistTag(entry);
		if (tag !== undefined) await updateReleasePlaylist(outDir, name, tag, entry);

		await rm(draftDir, { recursive: true, force: true });
		state = recordApproval(state, id, new Date().toISOString());
		await writeState(draftsBaseDir, name, state);
		console.log(`draht-reels: approved ${id}`);
	}
}

/** `draht-reels reject <id> [--reason <text>]`: deletes the draft and records the rejection, so `build` skips it unless `--force`. */
export async function runReject(argv: string[]): Promise<void> {
	const args = parseRejectArgs(argv);
	const { name, draftsDir, draftsBaseDir } = await resolveDraftPaths(args);

	let state: ReelsState = await readState(draftsBaseDir, name);
	for (const id of args.ids) {
		if (!isValidDraftId(id)) {
			console.error(`draht-reels: "${id}" is not a valid draft id`);
			process.exitCode = 1;
			continue;
		}
		const draftDir = join(draftsDir, id);
		if (!(await pathExists(draftDir))) {
			console.log(`draht-reels: ${id} has no pending draft; nothing to do`);
			continue;
		}
		await rm(draftDir, { recursive: true, force: true });
		state = recordRejection(state, id, new Date().toISOString(), args.reason);
		await writeState(draftsBaseDir, name, state);
		console.log(`draht-reels: rejected ${id}${args.reason ? ` (${args.reason})` : ""}`);
	}
}

async function runSite(argv: string[]): Promise<void> {
	const args = parseBuildArgs(argv);
	const outDir = resolve(args.out);
	const appDistDir = resolve(import.meta.dirname, "..", "app", "dist");
	await publishSite(appDistDir, outDir);
	console.log(`draht-reels: published site to ${outDir}`);
}

/**
 * Loads `.reels.json`: an explicit `--config` path, else `<repo>/.reels.json`
 * when present, else {@link DEFAULT_REELS_CONFIG}. Same path rule the build
 * command will use (not yet runner-controlled — see the README once T13's
 * sibling tasks land).
 */
async function resolveReelsConfig(args: Pick<BuildArgs, "repo" | "config">): Promise<ReelsConfig> {
	const path = args.config ?? join(args.repo, ".reels.json");
	try {
		return await loadReelsConfig(path);
	} catch (error) {
		if (args.config) throw error; // an explicit --config must exist and parse
		const message = error instanceof Error ? error.message : String(error);
		if (/ENOENT/.test(message)) return DEFAULT_REELS_CONFIG;
		throw error;
	}
}

/** Removes feed entries (and media) no longer reachable from `--ref`, for retraction after a force-push. */
export async function runPrune(argv: string[], overrides: { git?: GitRunner } = {}): Promise<void> {
	const args = parseBuildArgs(argv);
	const name = repoName(args);
	const outDir = resolve(args.out);
	const config = await resolveReelsConfig(args);

	const reachable = await collectOrFail(
		async () => {
			// `rev-list ref` follows every parent by default (no `--first-parent`),
			// so every commit reachable through any merge side is covered without
			// any mainline-walk or classification step.
			const shas = new Set(await listShas(overrides.git ?? runGit, args.repo, args.ref, {}));
			const allTags = await listReleaseTags(args.repo, config.tagPattern, overrides.git);
			const tags = new Set(allTags.filter((tag) => shas.has(tag.sha)).map((tag) => tag.name));
			return { shas, tags };
		},
		args.repo,
		args.ref,
	);
	const result = await pruneFeed(outDir, name, reachable);
	if (!result) {
		console.log(`draht-reels: no feed found at ${join(outDir, name, "feed.json")}; nothing to prune`);
		return;
	}
	console.log(`draht-reels: pruned ${result.removed.length} unreachable reel(s) from ${name}`);
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case "build": {
			const result = await runBuild(rest);
			if (result.failed > 0) process.exitCode = 1;
			break;
		}
		case "release": {
			const result = await runRelease(rest);
			if (result.failed > 0) process.exitCode = 1;
			break;
		}
		case "site":
			await runSite(rest);
			break;
		case "plan":
			await runPlan(rest);
			break;
		case "prune":
			await runPrune(rest);
			break;
		case "review":
			await runReview(rest);
			break;
		case "approve":
			await runApprove(rest);
			break;
		case "reject":
			await runReject(rest);
			break;
		default:
			console.log("usage: draht-reels <build|release|site|plan|prune|review|approve|reject> [options]");
			if (command && command !== "--help" && command !== "-h") process.exit(1);
	}
}

// Guarded so importing this module (e.g. from tests) never runs the CLI.
if (import.meta.main) {
	main().catch((error: unknown) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}
