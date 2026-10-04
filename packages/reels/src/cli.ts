#!/usr/bin/env bun
/**
 * draht-reels — turns git history into narrated explainer reels.
 * Commands: build, site, plan, prune. See README.md for usage.
 */

import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { elevenLabsKeyFilePath, resolveElevenLabsApiKey } from "./api-key.ts";
import {
	assertValidSha,
	collectChangeSetsForShas,
	type GitRunner,
	listReachableShas,
	selectBuildShas,
} from "./collect.ts";
import type { ChangeSet, ReelEntry, ReelScript } from "./contract.ts";
import { applyContentPolicy, DEFAULT_DENY_GLOBS, redactText } from "./privacy.ts";
import { pruneFeed, publishFeed, publishSite, readFeed } from "./publish.ts";
import { createBundle, publishAudioForRender, renderReel } from "./render.ts";
import {
	type Lang,
	llmWriter,
	type ModelCompleter,
	type ScriptWriter,
	templateWriter,
	withTemplateFallback,
} from "./script.ts";
import { cappedIds, MAX_RENDER_ATTEMPTS, readState, recordFailure, recordSuccess, writeState } from "./state.ts";
import { elevenLabsProvider, silentProvider, type TtsProvider } from "./tts.ts";

type Mode = "visual" | "audio" | "both";
type WriterKind = "template" | "llm";
type TtsKind = "elevenlabs" | "none";

const MODES: Mode[] = ["visual", "audio", "both"];
const TTS_KINDS: TtsKind[] = ["elevenlabs", "none"];
const WRITER_KINDS: WriterKind[] = ["template", "llm"];
const LANGS: Lang[] = ["en", "de"];

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

async function resolveWriter(args: Pick<BuildArgs, "writer" | "model">): Promise<ScriptWriter> {
	if (args.writer === "template") return templateWriter;
	if (!args.model) fail("--writer llm requires --model <provider/id>");

	let mod: AiCompleterModule;
	try {
		mod = await importAiCompleterLazy();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		fail(`--writer llm requires @draht/ai to be built first (run "npm run build" in packages/ai): ${message}`);
	}

	let completer: ModelCompleter;
	try {
		completer = mod.createAiModelCompleter(args.model);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	return withTemplateFallback(llmWriter(completer), (changeSet, error) => {
		console.warn(
			`draht-reels: llm writer failed for ${changeSet.id.slice(0, 12)} (${error.message}); using the template writer`,
		);
	});
}

function resolveTts(args: Pick<BuildArgs, "tts" | "voice" | "ttsModel">): TtsProvider {
	if (args.tts === "none") return silentProvider;
	const resolved = resolveElevenLabsApiKey();
	if (!resolved) {
		fail(
			`--tts elevenlabs needs an ElevenLabs key: set ELEVENLABS_API_KEY or write it to ${elevenLabsKeyFilePath()} (chmod 600). Use --tts none to skip narration audio.`,
		);
	}
	if (resolved.warning) console.warn(`draht-reels: ${resolved.warning}`);
	return elevenLabsProvider({ apiKey: resolved.key, voice: args.voice, model: args.ttsModel });
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

/** `overrides` exists only for tests: production always resolves `writer`/`tts` from `args`. */
export async function runBuild(
	argv: string[],
	overrides: { writer?: ScriptWriter; tts?: TtsProvider } = {},
): Promise<BuildResult> {
	const args = parseBuildArgs(argv);
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

async function runSite(argv: string[]): Promise<void> {
	const args = parseBuildArgs(argv);
	const outDir = resolve(args.out);
	const appDistDir = resolve(import.meta.dirname, "..", "app", "dist");
	await publishSite(appDistDir, outDir);
	console.log(`draht-reels: published site to ${outDir}`);
}

/** Removes feed entries (and media) no longer reachable from `--ref`, for retraction after a force-push. */
export async function runPrune(argv: string[], overrides: { git?: GitRunner } = {}): Promise<void> {
	const args = parseBuildArgs(argv);
	const name = repoName(args);
	const outDir = resolve(args.out);

	const reachable = await collectOrFail(
		() => listReachableShas({ repo: args.repo, ref: args.ref, git: overrides.git }),
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
