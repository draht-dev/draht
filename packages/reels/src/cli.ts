#!/usr/bin/env bun
/**
 * draht-reels — turns git history into narrated explainer reels.
 * Commands: build, site, plan, prune. See README.md for usage.
 */

import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
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
import type { ChangeSet, ReelEntry, ReelMedia, ReelScript, Scene, Story } from "./contract.ts";
import { createGithubLookup, type GithubLookup, isNestedInside, parseGithubRepo } from "./github.ts";
import { applyContentPolicy, DEFAULT_DENY_GLOBS, redactText } from "./privacy.ts";
import { pruneFeed, publishFeed, publishSite, readFeed } from "./publish.ts";
import { DEFAULT_REELS_CONFIG, loadReelsConfig, type ReelsConfig } from "./reels-config.ts";
import { buildReleaseGroups, listReleaseTags } from "./releases.ts";
import { createBundle, publishAudioForRender, renderReel } from "./render.ts";
import {
	type Lang,
	llmWriter,
	type ModelCompleter,
	type ScriptWriter,
	templateWriter,
	withTemplateFallback,
} from "./script.ts";
import { toPublicSources } from "./sources.ts";
import { cappedIds, MAX_RENDER_ATTEMPTS, readState, recordFailure, recordSuccess, writeState } from "./state.ts";
import { collectStories, isValidStoryId, selectStoryUnits, storyIdSha } from "./stories.ts";
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
	const draftedIds = (await readdir(draftsDir).catch(() => [] as string[])).filter((entry) => isValidStoryId(entry));
	const publishedIds = new Set(draftedIds);

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
	for (const group of groups) {
		const anchorsWithRange = group.anchors.map((anchor) => ({ anchor, range: group.range }));
		const result = await collectStories(group.units, { repo: args.repo, git, gh, anchors: anchorsWithRange });
		allStories.push(...result.stories);
		for (const [id, strength] of result.attribution) attribution.set(id, strength);
	}

	const minAttribution = config.story.minAttribution;
	const eligibleStories = allStories.filter((story) => {
		if (story.origin !== "commit") return true; // branch/pr stories are always eligible
		if (minAttribution === "weak") return true;
		return attribution.get(story.id) !== "weak";
	});
	const storyById = new Map(eligibleStories.map((story) => [story.id, story]));
	const storyIds = eligibleStories.map((story) => story.id);

	const selection = selectStoryUnits(storyIds, publishedIds, capped, {
		allHistory: args.allHistory,
		limit: args.limit,
		force: args.force,
	});
	for (const id of selection.cappedSkipped) {
		console.warn(
			`draht-reels: skipping story ${id.slice(0, 12)} after ${MAX_RENDER_ATTEMPTS} failed attempts (use --force to retry)`,
		);
	}
	console.log(`draht-reels: drafting ${selection.ids.length} story/stories`);

	const renderBundle = selection.ids.length > 0 && args.mode !== "audio" ? await createBundle() : undefined;
	const budget = { targetChars: tokensToChars(STORY_CONTEXT_TARGET_TOKENS) };

	const llmMeter = new CostMeter(maxCostUsd, maxLlmTokens);
	const ttsMeter = new CostMeter(maxTtsChars);

	let draftedCount = 0;
	let failedCount = 0;

	for (const id of selection.ids) {
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
					theme: "",
					deepDive: writeResult.deepDiveOutcome === "rendered" ? "rendered" : "not-warranted",
				},
				release: story.release,
				sources,
				deepDive: deepDiveMedia,
				writer: writeResult.writer,
			};

			// Kept for review (T12b): every source handed to (or withheld from) the writer, by id, so a reviewer can
			// check a cite's quote against the exact text the model saw, without re-assembling context from git.
			const scriptSnapshot = {
				script: writeResult.script,
				deepDive: deepScript,
				sources: Array.from(ctx.sources.values()).map((record) => ({
					id: record.id,
					kind: record.kind,
					label: record.label,
					url: record.url,
					text: record.text,
					included: record.included !== false,
				})),
			};

			await writeFile(join(tmpDir, "entry.json"), `${JSON.stringify(entry, null, "\t")}\n`);
			await writeFile(join(tmpDir, "script.json"), `${JSON.stringify(scriptSnapshot, null, "\t")}\n`);

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

	console.log(`draht-reels: drafted ${draftedCount} story/stories, ${failedCount} failed`);
	console.log(
		`draht-reels: spend — LLM $${llmMeter.spentAmount.toFixed(2)}/$${maxCostUsd}, ${llmMeter.spentTokenAmount}/${maxLlmTokens} tokens; TTS ${ttsMeter.spentAmount}/${maxTtsChars} chars`,
	);
	return { published: draftedCount, failed: failedCount };
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
		case "site":
			await runSite(rest);
			break;
		case "plan":
			await runPlan(rest);
			break;
		case "prune":
			await runPrune(rest);
			break;
		default:
			console.log("usage: draht-reels <build|site|plan|prune> [options]");
			if (command && command !== "--help" && command !== "-h") process.exit(1);
	}
}

// Guarded so importing this module (e.g. from tests) never runs the CLI.
if (import.meta.main) {
	main().catch((error: unknown) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}
