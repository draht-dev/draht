import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BuildOverrides } from "../src/cli.ts";
import { runApprove, runBuild, runPrune, runReject, runRelease } from "../src/cli.ts";
import type { Feed, ReelEntry } from "../src/contract.ts";
import type { ModelCompleter, ModelCompletionResult } from "../src/script.ts";
import {
	addFeatureBranchMerge,
	cleanupGitRepo,
	FOREIGN_AUTHOR,
	type GitRepo,
	initGitRepo,
} from "./fixtures/git-repo.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Always invalid (empty scenes / no themes): exercises the deterministic template fallback for both stories and
 * release artifacts, so these CLI-level tests never depend on a real LLM response shape. */
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

function seedChangelog(repo: GitRepo): string {
	return repo.commit("chore: seed changelog", { path: "CHANGELOG.md", content: "## [Unreleased]\n\n### Added\n\n" });
}

function addChangelogEntry(repo: GitRepo, entryLine: string): string {
	return repo.commit("docs: changelog entry", {
		path: "CHANGELOG.md",
		content: `## [Unreleased]\n\n### Added\n\n${entryLine}\n`,
	});
}

/** Builds a non-tiny release (2 feature merges), one pooled upstream anchor (via a sync merge), one weak
 * changelog feature, and one direct `upstream:` commit, then tags it. Returns the tag name. */
function buildNonTinyReleaseWithUpstreamPool(repo: GitRepo, tag: string): string {
	seedChangelog(repo);
	addFeatureBranchMerge(repo, { subject: "Merge feature A" });
	addFeatureBranchMerge(repo, { subject: "Merge feature B" });

	const base = repo.currentBranch();
	repo.checkoutNewBranch("sync-branch");
	repo.commit("add upstream widget", {
		path: "upstream.txt",
		content: "export function upstreamWidget() {\n\treturn 1;\n}\n",
		author: FOREIGN_AUTHOR,
	});
	repo.commit("mark sync", { path: ".upstream-sync", content: "synced\n" });
	repo.checkout(base);
	repo.mergeNoFF("sync-branch", "sync upstream through v9.9.9");

	addChangelogEntry(repo, "- add the `upstreamWidget` helper");
	repo.commit("upstream: fix(core): a direct replay commit", { path: "upstream-direct.txt" });
	addChangelogEntry(repo, "- improve the general experience for everyone");

	repo.tag(tag);
	return tag;
}

function readDraftIds(draftsDir: string, name: string): string[] {
	try {
		return readdirSync(join(draftsDir, name)).filter((e) => !e.startsWith("."));
	} catch {
		return [];
	}
}

function readDraftEntry(draftsDir: string, name: string, id: string): ReelEntry {
	return JSON.parse(readFileSync(join(draftsDir, name, id, "entry.json"), "utf-8")) as ReelEntry;
}

function readFeed(out: string, name: string): Feed {
	return JSON.parse(readFileSync(join(out, name, "feed.json"), "utf-8")) as Feed;
}

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

const releaseArgv = (tags: string[], repo: string, draftsDir: string, out: string, extra: string[] = []): string[] => [
	...tags,
	"--repo",
	repo,
	"--name",
	"demo",
	"--model",
	"test/fake",
	"--tts",
	"none",
	"--mode",
	"audio",
	"--out",
	out,
	"--drafts-dir",
	draftsDir,
	...extra,
];

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

describe("build --unit story: pooled upstream recap and release overview (T12c)", () => {
	test(
		"a release with stories, weak features, and upstream: commits drafts one overview and one recap",
		withRepo(async (repo) => {
			const tag = buildNonTinyReleaseWithUpstreamPool(repo, "v1.0.0");
			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);

				const ids = readDraftIds(drafts, "demo");
				expect(ids).toContain(`release-${tag}`);
				expect(ids).toContain(`recap-${tag}`);
				expect(ids.filter((id) => id === `release-${tag}`)).toHaveLength(1);
				expect(ids.filter((id) => id === `recap-${tag}`)).toHaveLength(1);

				const overview = readDraftEntry(drafts, "demo", `release-${tag}`);
				expect(overview.kind).toBe("release");
				expect(overview.release).toBe(tag);

				const recap = readDraftEntry(drafts, "demo", `recap-${tag}`);
				expect(recap.kind).toBe("recap");
				expect(recap.release).toBe(tag);
				expect(recap.recap).toBeDefined();
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"a tiny release drafts neither an overview nor a recap",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge only feature" });
			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);

				const ids = readDraftIds(drafts, "demo");
				expect(ids).not.toContain("release-v1.0.0");
				expect(ids).not.toContain("recap-v1.0.0");
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"the recap pools anchors from both a sync merge and a direct upstream: commit",
		withRepo(async (repo) => {
			seedChangelog(repo);
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });

			const base = repo.currentBranch();
			repo.checkoutNewBranch("sync-branch");
			repo.commit("add upstream alpha", {
				path: "upstream.txt",
				content: "export function upstreamAlpha() {\n\treturn 1;\n}\n",
				author: FOREIGN_AUTHOR,
			});
			repo.commit("mark sync", { path: ".upstream-sync", content: "synced\n" });
			repo.checkout(base);
			repo.mergeNoFF("sync-branch", "sync upstream through v9.9.9");
			addChangelogEntry(repo, "- add the `upstreamAlpha` helper");

			// A direct `upstream:` replay commit, found by a second changelog entry's identifier search.
			repo.commit("upstream: feat(core): add upstream beta", {
				path: "upstream-direct.txt",
				content: "export function upstreamBeta() {\n\treturn 1;\n}\n",
			});
			addChangelogEntry(repo, "- add the `upstreamBeta` helper");

			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);

				const recap = readDraftEntry(drafts, "demo", "recap-v1.0.0");
				expect(recap.kind).toBe("recap");
				expect(recap.recap?.themes.flatMap((t) => t.sourceIds).length).toBeGreaterThanOrEqual(2);

				const snapshot = JSON.parse(readFileSync(join(drafts, "demo", "recap-v1.0.0", "script.json"), "utf-8")) as {
					sources: Array<{ label: string; text: string }>;
				};
				const sourceText = snapshot.sources.map((s) => `${s.label} ${s.text}`).join(" ");
				expect(sourceText).toContain("upstreamAlpha");
				expect(sourceText).toContain("upstreamBeta");
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("approve: release playlists (T12c)", () => {
	test(
		"approving a story creates or updates the playlist with ordered story ids",
		withRepo(async (repo) => {
			const shaA = addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			const shaB = addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);

				await runApprove(targetArgv(repo.dir, drafts, out, [shaA]));
				let feed = readFeed(out, "demo");
				let playlist = feed.playlists?.find((p) => p.tag === "v1.0.0");
				expect(playlist?.storyIds).toEqual([shaA]);

				await runApprove(targetArgv(repo.dir, drafts, out, [shaB]));
				feed = readFeed(out, "demo");
				playlist = feed.playlists?.find((p) => p.tag === "v1.0.0");
				expect(playlist?.storyIds).toHaveLength(2);
				expect(new Set(playlist?.storyIds)).toEqual(new Set([shaA, shaB]));
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"approving a story creates a playlist with tag, sha, date, prevTag, tiny, and changeCount",
		withRepo(async (repo) => {
			repo.commit("feat: setup");
			repo.tag("v0.9.0");
			const shaA = addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			repo.tag("v1.0.0");
			const tagDate = repo.git(["log", "-1", "--format=%cI", "v1.0.0"]);

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				await runApprove(targetArgv(repo.dir, drafts, out, [shaA]));

				const feed = readFeed(out, "demo");
				const playlist = feed.playlists?.find((p) => p.tag === "v1.0.0");
				expect(playlist?.sha).toBe(repo.sha("v1.0.0"));
				expect(playlist?.date).toBe(tagDate);
				expect(playlist?.previousTag).toBe("v0.9.0");
				expect(typeof playlist?.tiny).toBe("boolean");
				expect(playlist?.changeCount).toBeGreaterThan(0);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"approving a second story does not clear the playlist's release fields",
		withRepo(async (repo) => {
			const shaA = addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			const shaB = addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				await runApprove(targetArgv(repo.dir, drafts, out, [shaA]));

				const first = readFeed(out, "demo").playlists?.find((p) => p.tag === "v1.0.0");
				expect(first?.sha).not.toBe("");

				await runApprove(targetArgv(repo.dir, drafts, out, [shaB]));
				const second = readFeed(out, "demo").playlists?.find((p) => p.tag === "v1.0.0");
				expect(second?.sha).toBe(first?.sha);
				expect(second?.date).toBe(first?.date);
				expect(second?.changeCount).toBe(first?.changeCount);
				expect(second?.storyIds).toHaveLength(2);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"filling in a playlist with a blanked date/sha/changeCount backfills them from a later approval",
		withRepo(async (repo) => {
			const shaA = addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			const shaB = addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			repo.tag("v1.0.0");
			const tagDate = repo.git(["log", "-1", "--format=%cI", "v1.0.0"]);

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				await runApprove(targetArgv(repo.dir, drafts, out, [shaA]));

				// Simulate a pre-fix playlist: blank date/sha/changeCount, same as `blankPlaylist` used to leave them.
				const feedPath = join(out, "demo", "feed.json");
				const feed = JSON.parse(readFileSync(feedPath, "utf-8")) as Feed;
				const playlist = feed.playlists?.find((p) => p.tag === "v1.0.0");
				expect(playlist).toBeDefined();
				if (playlist) {
					playlist.sha = "";
					playlist.date = "";
					playlist.changeCount = 0;
				}
				writeFileSync(feedPath, JSON.stringify(feed, null, "\t"));

				await runApprove(targetArgv(repo.dir, drafts, out, [shaB]));
				const refilled = readFeed(out, "demo").playlists?.find((p) => p.tag === "v1.0.0");
				expect(refilled?.date).toBe(tagDate);
				expect(refilled?.sha).toBe(repo.sha("v1.0.0"));
				expect(refilled?.changeCount).toBeGreaterThan(0);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"playlists sort newest first by the tag's own date, regardless of approval order",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			const shaA2 = addFeatureBranchMerge(repo, { subject: "Merge feature A2" });
			repo.tag("v1.0.0");
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			const shaB2 = addFeatureBranchMerge(repo, { subject: "Merge feature B2" });
			repo.tag("v2.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out, ["--all-history"]), overrides);

				// Approve the newer release first: playlist order must come from each tag's own date, never approval order.
				await runApprove(targetArgv(repo.dir, drafts, out, [shaB2]));
				await runApprove(targetArgv(repo.dir, drafts, out, [shaA2]));

				const feed = readFeed(out, "demo");
				const tags = (feed.playlists ?? []).map((p) => p.tag);
				expect(tags).toEqual(["v2.0.0", "v1.0.0"]);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"approving the overview and recap sets overviewId and recapId on the playlist",
		withRepo(async (repo) => {
			const tag = buildNonTinyReleaseWithUpstreamPool(repo, "v1.0.0");
			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);

				await runApprove(targetArgv(repo.dir, drafts, out, [`release-${tag}`]));
				let feed = readFeed(out, "demo");
				let playlist = feed.playlists?.find((p) => p.tag === tag);
				expect(playlist?.overviewId).toBe(`release-${tag}`);

				await runApprove(targetArgv(repo.dir, drafts, out, [`recap-${tag}`]));
				feed = readFeed(out, "demo");
				playlist = feed.playlists?.find((p) => p.tag === tag);
				expect(playlist?.recapId).toBe(`recap-${tag}`);
				// Approving the overview before any of its stories must not break anything (owner decision, T12c).
				expect(playlist?.overviewId).toBe(`release-${tag}`);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("build --unit story: release artifacts are not re-written/re-paid on an already-drafted run (A)", () => {
	test(
		"a pending release overview/recap is not rebuilt (no extra LLM call) on the next run without --force",
		withRepo(async (repo) => {
			const tag = buildNonTinyReleaseWithUpstreamPool(repo, "v1.0.0");
			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				let calls = 0;
				const counting: ModelCompleter = async () => {
					calls++;
					return fallingBackCompleter()({ prompt: "", maxTokens: 0 });
				};
				const overrides: BuildOverrides = { complete: counting };

				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(readDraftIds(drafts, "demo")).toContain(`release-${tag}`);
				expect(readDraftIds(drafts, "demo")).toContain(`recap-${tag}`);
				const callsAfterFirst = calls;
				expect(callsAfterFirst).toBeGreaterThan(0);

				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(calls).toBe(callsAfterFirst);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"a rejected release overview is skipped (not rebuilt) without --force",
		withRepo(async (repo) => {
			const tag = buildNonTinyReleaseWithUpstreamPool(repo, "v1.0.0");
			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(readDraftIds(drafts, "demo")).toContain(`release-${tag}`);

				await runReject([
					"--repo",
					repo.dir,
					"--name",
					"demo",
					"--out",
					out,
					"--drafts-dir",
					drafts,
					`release-${tag}`,
				]);
				expect(readDraftIds(drafts, "demo")).not.toContain(`release-${tag}`);

				await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(readDraftIds(drafts, "demo")).not.toContain(`release-${tag}`);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("build --unit story: a release tag outside SAFE_TAG_RE is skipped, not fatal (regression)", () => {
	test(
		"a tag matching tagPattern but failing SAFE_TAG_RE (e.g. v2.0.0+hotfix) does not abort drafting other releases",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge unsafe-tag A" });
			addFeatureBranchMerge(repo, { subject: "Merge unsafe-tag B" });
			repo.tag("v2.0.0+hotfix"); // matches the default `^v` tagPattern, fails SAFE_TAG_RE

			const safeTag = buildNonTinyReleaseWithUpstreamPool(repo, "v3.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				const result = await runBuild(baseArgv(repo.dir, drafts, out, ["--all-history"]), overrides);
				expect(result.failed).toBe(0); // a warning, not a failure: the tag cannot change, so it must not fail every run

				const ids = readDraftIds(drafts, "demo");
				// The unsafe-tag release never gets an overview/recap id built (it would throw), but the safe one still does.
				expect(ids).toContain(`release-${safeTag}`);
				expect(ids).toContain(`recap-${safeTag}`);
				expect(ids.some((id) => id.includes("v2.0.0+hotfix"))).toBe(false);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("release command: model precedence (C: --model, then story.model)", () => {
	test("story.model in .reels.json is used by `release` when --model is absent", () => {
		const repo = initGitRepo();
		const configPath = join(repo.dir, ".reels.json");
		try {
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			repo.tag("v1.0.0");
			writeFileSync(configPath, JSON.stringify({ story: { model: "config-provider/config-id" } }));
			const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
			const result = spawnSync("bun", ["run", cliPath, "release", "v1.0.0", "--repo", repo.dir], {
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).not.toContain("release requires --model");
			expect(result.stderr).toContain('"config-provider/config-id"');
		} finally {
			cleanupGitRepo(repo);
		}
	});
});

describe("release command (T13)", () => {
	test(
		"drafts only the overview and recap, never a story draft",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				const result = await runRelease(releaseArgv(["v1.0.0"], repo.dir, drafts, out), overrides);
				expect(result.published).toBe(1); // overview only: no changelog anchors, so the pool is empty

				const ids = readDraftIds(drafts, "demo");
				expect(ids).toEqual(["release-v1.0.0"]);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("prune: release and recap entries and playlists (T12c)", () => {
	test(
		"removes release/recap entries and playlists for a deleted tag, keeps them for a surviving one",
		withRepo(async (repo) => {
			const tagWithRecap = buildNonTinyReleaseWithUpstreamPool(repo, "v1.0.0");
			addFeatureBranchMerge(repo, { subject: "Merge feature C" });
			addFeatureBranchMerge(repo, { subject: "Merge feature D" });
			repo.tag("v2.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, drafts, out, ["--all-history"]), overrides);

				await runApprove(targetArgv(repo.dir, drafts, out, [`release-${tagWithRecap}`, `recap-${tagWithRecap}`]));
				await runApprove(targetArgv(repo.dir, drafts, out, ["release-v2.0.0"]));

				let feed = readFeed(out, "demo");
				expect(feed.reels.some((r) => r.id === "release-v1.0.0")).toBe(true);
				expect(feed.reels.some((r) => r.id === "recap-v1.0.0")).toBe(true);
				expect(feed.reels.some((r) => r.id === "release-v2.0.0")).toBe(true);

				repo.git(["tag", "-d", "v1.0.0"]);
				await runPrune(["--repo", repo.dir, "--name", "demo", "--out", out]);

				feed = readFeed(out, "demo");
				expect(feed.reels.some((r) => r.id === "release-v1.0.0")).toBe(false);
				expect(feed.reels.some((r) => r.id === "recap-v1.0.0")).toBe(false);
				expect(feed.playlists?.some((p) => p.tag === "v1.0.0")).toBe(false);

				expect(feed.reels.some((r) => r.id === "release-v2.0.0")).toBe(true);
				expect(feed.playlists?.some((p) => p.tag === "v2.0.0")).toBe(true);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("approve/reject: invalid release ids are refused", () => {
	test("approve rejects an invalid release-<tag> id", () => {
		const repo = initGitRepo();
		const out = tmpDir("release-out-");
		const drafts = tmpDir("release-drafts-");
		try {
			const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
			const result = spawnSync(
				"bun",
				[
					"run",
					cliPath,
					"approve",
					"release-../../../etc",
					"--repo",
					repo.dir,
					"--out",
					out,
					"--drafts-dir",
					drafts,
				],
				{ encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("not a valid draft id");
		} finally {
			cleanupGitRepo(repo);
			rmSync(out, { recursive: true, force: true });
			rmSync(drafts, { recursive: true, force: true });
		}
	});

	test("reject rejects an invalid recap-<tag> id", () => {
		const repo = initGitRepo();
		const out = tmpDir("release-out-");
		const drafts = tmpDir("release-drafts-");
		try {
			const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
			const result = spawnSync(
				"bun",
				["run", cliPath, "reject", "recap-../../../etc", "--repo", repo.dir, "--out", out, "--drafts-dir", drafts],
				{ encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("not a valid draft id");
		} finally {
			cleanupGitRepo(repo);
			rmSync(out, { recursive: true, force: true });
			rmSync(drafts, { recursive: true, force: true });
		}
	});
});

describe("release artifacts: capped (MAX_RENDER_ATTEMPTS) ids are skipped without --force (regression)", () => {
	test(
		"a release overview that fails after TTS on 3 runs is not retried on a 4th run, but --force retries it",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				let calls = 0;
				const counting: ModelCompleter = async () => {
					calls++;
					return fallingBackCompleter()({ prompt: "", maxTokens: 0 });
				};
				// Simulates a render failure that happens only after the (paid) TTS call already returned, same
				// fixture `cli-release.test.ts`'s own cleanup test uses.
				const failingAfterTts = {
					synthesize: async () => ({
						scenes: [],
						transcript: [],
						audioPath: join(drafts, "narration-that-does-not-exist.mp3"),
					}),
				};
				const overrides: BuildOverrides = { complete: counting, tts: failingAfterTts };

				for (let i = 0; i < 3; i++) {
					const result = await runRelease(releaseArgv(["v1.0.0"], repo.dir, drafts, out), overrides);
					expect(result.failed).toBe(1);
				}
				const callsAfterThreeFailures = calls;
				expect(callsAfterThreeFailures).toBeGreaterThan(0);

				// A 4th run must not retry: the artifact is now capped at MAX_RENDER_ATTEMPTS. No further model
				// calls means `build()` was never invoked for it.
				const fourth = await runRelease(releaseArgv(["v1.0.0"], repo.dir, drafts, out), overrides);
				expect(fourth.failed).toBe(0);
				expect(fourth.published).toBe(0);
				expect(calls).toBe(callsAfterThreeFailures);

				// --force bypasses the cap, same as build/plan do for stories: `build()` runs again.
				const forced = await runRelease(releaseArgv(["v1.0.0"], repo.dir, drafts, out, ["--force"]), overrides);
				expect(forced.failed).toBe(1);
				expect(calls).toBeGreaterThan(callsAfterThreeFailures);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("release artifacts: TTS chars count toward --max-tts-chars even when the render fails after synthesize (regression)", () => {
	test(
		"a release overview that fails after TTS still records its chars against the TTS meter",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				const failingAfterTts = {
					synthesize: async () => ({
						scenes: [],
						transcript: [],
						audioPath: join(drafts, "narration-that-does-not-exist.mp3"),
					}),
				};
				const overrides: BuildOverrides = { complete: fallingBackCompleter(), tts: failingAfterTts };

				const logs: string[] = [];
				const originalLog = console.log;
				console.log = (msg?: unknown) => logs.push(String(msg));
				try {
					const result = await runRelease(
						releaseArgv(["v1.0.0"], repo.dir, drafts, out, ["--max-tts-chars", "100"]),
						overrides,
					);
					expect(result.failed).toBe(1);
				} finally {
					console.log = originalLog;
				}

				const spendLine = logs.find((l) => l.includes("TTS"));
				expect(spendLine).toBeDefined();
				// Chars were recorded even though the render failed after synthesize: the spend line must show more
				// than 0/100, not 0/100 (which would mean a failed render never counted against the cap).
				expect(spendLine).not.toContain("TTS 0/100 chars");
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("release artifact draft: cleans up its .tmp-<uuid> dir on render failure after TTS", () => {
	test(
		"a release overview draft that fails after TTS leaves no .tmp-* directory behind",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			repo.tag("v1.0.0");

			const out = tmpDir("release-out-");
			const drafts = tmpDir("release-drafts-");
			try {
				// Simulates a render failure that happens only after the (paid) TTS call already returned: the
				// narration "succeeds" with an audio path that does not actually exist, so the post-synthesize
				// copyFile in renderReleaseArtifactDraft throws.
				const failingAfterTts = {
					synthesize: async () => ({
						scenes: [],
						transcript: [],
						audioPath: join(drafts, "narration-that-does-not-exist.mp3"),
					}),
				};
				const overrides: BuildOverrides = { complete: fallingBackCompleter(), tts: failingAfterTts };

				const result = await runRelease(releaseArgv(["v1.0.0"], repo.dir, drafts, out), overrides);
				expect(result.failed).toBe(1);
				expect(result.published).toBe(0);

				const leftoverTmpDirs = readdirSync(join(drafts, "demo")).filter((e) => e.startsWith(".tmp-"));
				expect(leftoverTmpDirs).toEqual([]);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});
