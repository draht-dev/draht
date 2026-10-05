import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BuildOverrides } from "../src/cli.ts";
import { runApprove, runBuild, runReject, runReview } from "../src/cli.ts";
import type { Feed, ReelEntry } from "../src/contract.ts";
import type { DraftScriptSnapshot } from "../src/review.ts";
import { excerptAroundQuote, renderReviewMd } from "../src/review.ts";
import type { ModelCompleter, ModelCompletionResult } from "../src/script.ts";
import { readState } from "../src/state.ts";
import { addFeatureBranchMerge, cleanupGitRepo, type GitRepo, initGitRepo } from "./fixtures/git-repo.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function fallingBackCompleter(usage?: ModelCompletionResult["usage"]): ModelCompleter {
	const text = JSON.stringify({ title: "t", subtitle: "s", summary: { text: "x", cites: [] }, scenes: [] });
	return async () => ({ text, usage });
}

function withRepo(fn: (repo: GitRepo) => void | Promise<void>): () => Promise<void> {
	return async () => {
		const repo = initGitRepo();
		try {
			await fn(repo);
		} finally {
			cleanupGitRepo(repo);
		}
	};
}

function readDraftIds(draftsDir: string, name: string): string[] {
	try {
		return readdirSync(join(draftsDir, name)).filter((e) => !e.startsWith("."));
	} catch {
		return [];
	}
}

const targetArgv = (repo: string, draftsDir: string, out: string, extra: string[] = []): string[] => [
	"--repo",
	repo,
	"--name",
	"demo",
	"--out",
	out,
	"--drafts-dir",
	draftsDir,
	...extra,
];

const baseArgv = (repo: string, draftsDir: string, out: string, extra: string[] = []): string[] => [
	"--repo",
	repo,
	"--name",
	"demo",
	"--unit",
	"story",
	"--model",
	"test/fake",
	"--tts",
	"none",
	"--mode",
	"audio",
	"--deep-dive",
	"never",
	"--out",
	out,
	"--drafts-dir",
	draftsDir,
	...extra,
];

describe("review.md: claims next to their cited source text (T12b)", () => {
	test("renderReviewMd marks the quote with »...« inside an excerpt, and shows code lines verbatim", () => {
		const sourceText =
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. The widget factory exists because on-call kept paging about the missing retry budget on Tuesdays. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";
		const quote = "on-call kept paging about the missing retry budget";

		const entry: ReelEntry = {
			id: "0123456789abcdef0123456789abcdef01234567",
			commits: ["0123456789ab"],
			title: "feat: add the widget factory",
			authors: ["Ada Lovelace"],
			date: "2024-01-01T00:00:00Z",
			durationMs: 1000,
			scenes: [],
			transcript: [],
			stats: { files: 1, additions: 2, deletions: 0 },
			kind: "story",
			writer: "llm",
		};

		const snapshot: DraftScriptSnapshot = {
			script: {
				changeSetId: entry.id,
				writer: "llm",
				scenes: [
					{
						kind: "title",
						title: "The widget factory",
						subtitle: "why it exists",
						narration: "The widget factory exists because on-call kept paging.",
						section: "problem",
						beats: [
							{
								text: "The widget factory exists because on-call kept paging about the missing retry budget.",
								cites: ["c:0123456789ab"],
							},
						],
					},
					{
						kind: "code",
						path: "src/widgetFactory.ts",
						language: "ts",
						hunkHeader: "@@ -1,0 +1,3 @@",
						lines: ["+export function widgetFactory() {", "+\treturn 1;", "+}"],
						narration: "Here is the fix.",
						section: "code",
						beats: [{ text: "Here is the fix.", cites: ["h:src/widgetFactory.ts#0"] }],
					},
				],
			},
			notes: [{ beats: [{ claim: "why", quote }] }, { beats: [{ claim: "meta" }] }],
			sources: [
				{
					id: "c:0123456789ab",
					kind: "commit",
					label: "feat: add the widget factory",
					text: sourceText,
					included: true,
				},
				{
					id: "h:src/widgetFactory.ts#0",
					kind: "hunk",
					label: "src/widgetFactory.ts",
					text: "+export function widgetFactory() {\n+\treturn 1;\n+}",
					included: true,
				},
			],
			meta: {
				title: entry.title,
				origin: "commit",
				attribution: "strong",
				writer: "llm",
				repaired: false,
				costUsd: 0.01,
				createdAt: "2024-01-01T00:00:00Z",
			},
		};

		const md = renderReviewMd(entry, snapshot);

		expect(md).toContain(`quote: "${quote}"`);
		expect(md).toContain(`»${quote}«`);
		// The excerpt around the quote is the real source text, not a paraphrase.
		expect(md).toContain("The widget factory exists because »");
		expect(md).toContain("« on Tuesdays.");
		expect(md).toContain("consectetur adipiscing elit");

		// Code lines are verbatim, inside a fenced block naming the path.
		expect(md).toContain("src/widgetFactory.ts");
		expect(md).toContain("+export function widgetFactory() {");
		expect(md).toContain("+\treturn 1;");

		// Claim kinds surface next to the beat text.
		expect(md).toContain("[why]");
		expect(md).toContain("[meta]");

		// The closing human checklist is always present.
		expect(md).toContain("every claim matches its cited source's text");
		expect(md).toContain("no injected or promotional text");
		expect(md).toContain("nothing private");
	});

	test("excerptAroundQuote marks the quote and bounds the excerpt to ~200 chars on each side", () => {
		const before = "a".repeat(400);
		const after = "b".repeat(400);
		const quote = "the exact quote";
		const text = `${before} ${quote} ${after}`;

		const excerpt = excerptAroundQuote(text, quote, 200);
		expect(excerpt).toContain(`»${quote}«`);
		expect(excerpt.length).toBeLessThan(text.length);
		expect(excerpt.startsWith("…")).toBe(true);
		expect(excerpt.endsWith("…")).toBe(true);
	});
});

describe("build --unit story: draft review.md, review command", () => {
	test(
		"build writes entry.json, script.json, and review.md for a drafted story; review lists it and prints it",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);

				const draftDir = join(drafts, "demo", mergeSha);
				const reviewMd = readFileSync(join(draftDir, "review.md"), "utf-8");
				expect(reviewMd).toContain("Checklist");

				const listed = await captureStdout(() => runReview(targetArgv(repo.dir, drafts, out)));
				expect(listed).toContain(mergeSha);

				const shown = await captureStdout(() => runReview(targetArgv(repo.dir, drafts, out, [mergeSha])));
				expect(shown).toContain("Checklist");
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const original = console.log;
	let out = "";
	console.log = (...args: unknown[]) => {
		out += `${args.map(String).join(" ")}\n`;
	};
	try {
		await fn();
	} finally {
		console.log = original;
	}
	return out;
}

describe("approve: publishes atomically and is idempotent", () => {
	test(
		"approve moves media, merges the feed entry, removes the draft, and is idempotent",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(readDraftIds(drafts, "demo")).toContain(mergeSha);
				expect(() => readFileSync(join(out, "demo", "feed.json"), "utf-8")).toThrow();

				await runApprove(targetArgv(repo.dir, drafts, out, [mergeSha]));

				const feed = JSON.parse(readFileSync(join(out, "demo", "feed.json"), "utf-8")) as Feed;
				expect(feed.reels.map((r) => r.id)).toContain(mergeSha);
				expect(readDraftIds(drafts, "demo")).not.toContain(mergeSha);

				// Idempotent: approving an already-approved id a second time is a no-op, not an error.
				await captureStdout(() => runApprove(targetArgv(repo.dir, drafts, out, [mergeSha])));
				const feedAgain = JSON.parse(readFileSync(join(out, "demo", "feed.json"), "utf-8")) as Feed;
				expect(feedAgain.reels.filter((r) => r.id === mergeSha)).toHaveLength(1);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"approve rejects an invalid id",
		withRepo(async (repo) => {
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
				const result = spawnSync(
					"bun",
					["run", cliPath, "approve", "../not-valid", "--repo", repo.dir, "--out", out, "--drafts-dir", drafts],
					{ encoding: "utf8" },
				);
				expect(result.status).not.toBe(0);
				expect(result.stderr).toContain("not a valid draft id");
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"the public feed is unchanged by build and only changed by approve",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(() => readFileSync(join(out, "demo", "feed.json"), "utf-8")).toThrow();

				await runApprove(targetArgv(repo.dir, drafts, out, [mergeSha]));
				expect(() => readFileSync(join(out, "demo", "feed.json"), "utf-8")).not.toThrow();
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("reject: removes the draft, build skips it unless --force", () => {
	test(
		"a rejected story is not redrafted without --force, but is with --force",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(readDraftIds(drafts, "demo")).toContain(mergeSha);

				await runReject(targetArgv(repo.dir, drafts, out, [mergeSha, "--reason", "not useful"]));
				expect(readDraftIds(drafts, "demo")).not.toContain(mergeSha);

				const state = await readState(drafts, "demo");
				expect(state.rejected?.[mergeSha]?.reason).toBe("not useful");

				const result1 = await runBuild(baseArgv(repo.dir, drafts, out, ["--limit", "10"]), overrides);
				expect(result1.published).toBe(0);
				expect(readDraftIds(drafts, "demo")).not.toContain(mergeSha);

				const result2 = await runBuild(baseArgv(repo.dir, drafts, out, ["--limit", "10", "--force"]), overrides);
				expect(result2.published).toBe(1);
				expect(readDraftIds(drafts, "demo")).toContain(mergeSha);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("build: a pending draft is not regenerated without --force", () => {
	test(
		"a second build run does not redraft an already-drafted story",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				const result1 = await runBuild(baseArgv(repo.dir, drafts, out, ["--limit", "10"]), overrides);
				expect(result1.published).toBe(1);

				const result2 = await runBuild(baseArgv(repo.dir, drafts, out, ["--limit", "10"]), overrides);
				expect(result2.published).toBe(0);
				expect(readDraftIds(drafts, "demo")).toEqual([mergeSha]);

				const result3 = await runBuild(baseArgv(repo.dir, drafts, out, ["--limit", "10", "--force"]), overrides);
				expect(result3.published).toBe(1);
				expect(readDraftIds(drafts, "demo")).toEqual([mergeSha]);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

/** Hand-writes a draft dir the way `runBuildStory`/`renderReleaseArtifactDraft` would, with media paths
 * relative to the draft dir itself (`video.mp4`, `deep/video.mp4`, …), for tests that need to assert what
 * `approve` does to those paths without paying for a real TTS/render pipeline. */
function writeDraft(draftsDir: string, name: string, id: string, entry: ReelEntry): void {
	const dir = join(draftsDir, name, id);
	mkdirSync(join(dir, "deep"), { recursive: true });
	writeFileSync(join(dir, "video.mp4"), "video-bytes");
	writeFileSync(join(dir, "audio.mp3"), "audio-bytes");
	writeFileSync(join(dir, "poster.jpg"), "poster-bytes");
	writeFileSync(join(dir, "deep", "video.mp4"), "deep-video-bytes");
	writeFileSync(join(dir, "deep", "audio.mp3"), "deep-audio-bytes");
	writeFileSync(join(dir, "deep", "poster.jpg"), "deep-poster-bytes");
	writeFileSync(join(dir, "entry.json"), `${JSON.stringify(entry, null, "\t")}\n`);
}

const DRAFT_ID = "a".repeat(40);

function draftStoryEntry(id: string): ReelEntry {
	return {
		id,
		commits: [id.slice(0, 12)],
		title: "feat: add the widget factory",
		authors: ["Ada Lovelace"],
		date: "2024-01-01T00:00:00Z",
		durationMs: 1000,
		video: "video.mp4",
		audio: "audio.mp3",
		poster: "poster.jpg",
		scenes: [],
		transcript: [],
		stats: { files: 1, additions: 2, deletions: 0 },
		kind: "story",
		deepDive: {
			durationMs: 500,
			video: "deep/video.mp4",
			audio: "deep/audio.mp3",
			poster: "deep/poster.jpg",
			scenes: [],
			transcript: [],
		},
	};
}

describe("approve: rewrites draft-relative media paths to reels/<id>/... (critical)", () => {
	test(
		"the published entry's video/audio/poster and deepDive media all gain the reels/<id>/ prefix",
		withRepo(async (repo) => {
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				writeDraft(drafts, "demo", DRAFT_ID, draftStoryEntry(DRAFT_ID));

				await runApprove(targetArgv(repo.dir, drafts, out, [DRAFT_ID]));

				const feed = JSON.parse(readFileSync(join(out, "demo", "feed.json"), "utf-8")) as Feed;
				const published = feed.reels.find((r) => r.id === DRAFT_ID);
				expect(published?.video).toBe(`reels/${DRAFT_ID}/video.mp4`);
				expect(published?.audio).toBe(`reels/${DRAFT_ID}/audio.mp3`);
				expect(published?.poster).toBe(`reels/${DRAFT_ID}/poster.jpg`);
				expect(published?.deepDive?.video).toBe(`reels/${DRAFT_ID}/deep/video.mp4`);
				expect(published?.deepDive?.audio).toBe(`reels/${DRAFT_ID}/deep/audio.mp3`);
				expect(published?.deepDive?.poster).toBe(`reels/${DRAFT_ID}/deep/poster.jpg`);

				// The rewritten paths must resolve to where approve actually put the media.
				expect(readFileSync(join(out, "demo", published?.video as string), "utf-8")).toBe("video-bytes");
				expect(readFileSync(join(out, "demo", published?.deepDive?.video as string), "utf-8")).toBe(
					"deep-video-bytes",
				);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("approve: refuses a draft whose entry.json id does not match the directory", () => {
	test(
		"approve fails and does not publish when entry.json's id disagrees with the draft dir",
		withRepo(async (repo) => {
			const out = tmpDir("gate-out-");
			const drafts = tmpDir("gate-drafts-");
			try {
				const wrongId = "b".repeat(40);
				writeDraft(drafts, "demo", DRAFT_ID, draftStoryEntry(wrongId));

				const originalError = console.error;
				let loggedError = "";
				console.error = (...args: unknown[]) => {
					loggedError += args.map(String).join(" ");
				};
				try {
					await runApprove(targetArgv(repo.dir, drafts, out, [DRAFT_ID]));
				} finally {
					console.error = originalError;
				}

				expect(process.exitCode).toBe(1);
				process.exitCode = 0;
				expect(loggedError).toContain(DRAFT_ID);
				expect(() => readFileSync(join(out, "demo", "feed.json"), "utf-8")).toThrow();
				expect(readDraftIds(drafts, "demo")).toContain(DRAFT_ID);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});
