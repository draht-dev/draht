import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BuildOverrides } from "../src/cli.ts";
import { runBuild } from "../src/cli.ts";
import type { Feed, ReelEntry } from "../src/contract.ts";
import type { ModelCompleter, ModelCompletionResult } from "../src/script.ts";
import { createSourceRegistry } from "../src/sources.ts";
import { readState } from "../src/state.ts";
import { REASON_NOT_RECORDED_TEXT } from "../src/story-validate.ts";
import { CostMeter, writeStoryScript } from "../src/story-writer.ts";
import { silentProvider, type TtsProvider } from "../src/tts.ts";
import { addFeatureBranchMerge, cleanupGitRepo, type GitRepo, initGitRepo } from "./fixtures/git-repo.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Always invalid (empty scenes): exercises the deterministic `writeOneScript` fallback to `templateWriter`, so
 * these CLI-level orchestration tests never depend on a real diff's exact shape matching a hand-crafted LLM
 * response. The LLM-success path itself is covered exhaustively by story-writer.test.ts/story-validate.test.ts. */
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

function seedChangelog(repo: GitRepo, path = "packages/reels/CHANGELOG.md"): string {
	return repo.commit("chore: seed changelog", { path, content: "## [Unreleased]\n\n### Added\n\n" });
}

function addChangelogEntry(repo: GitRepo, entryLine: string, path = "packages/reels/CHANGELOG.md"): string {
	return repo.commit("docs: changelog entry", { path, content: `## [Unreleased]\n\n### Added\n\n${entryLine}\n` });
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

describe("build --unit story: drafts, never the public feed", () => {
	test(
		"writes a draft for a feature-branch story; the public feed is never created",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const out = tmpDir("reels-story-out-");
			const drafts = tmpDir("reels-story-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				const result = await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(result.published).toBe(1);
				expect(result.failed).toBe(0);

				const ids = readDraftIds(drafts, "demo");
				expect(ids).toContain(mergeSha);
				const entry = readDraftEntry(drafts, "demo", mergeSha);
				expect(entry.kind).toBe("story");
				expect(entry.writer).toBe("template");

				expect(() => readFileSync(join(out, "demo", "feed.json"), "utf-8")).toThrow();
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("build --unit story: argument errors happen before any work", () => {
	test("--unit story without --model fails with a non-zero exit before touching git", () => {
		const repo = initGitRepo();
		try {
			const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
			const result = spawnSync("bun", ["run", cliPath, "build", "--unit", "story", "--repo", repo.dir], {
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("--unit story requires --model");
		} finally {
			cleanupGitRepo(repo);
		}
	});

	test("a --drafts-dir nested inside --out is refused", () => {
		const repo = initGitRepo();
		const out = tmpDir("reels-story-out-");
		try {
			const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
			const result = spawnSync(
				"bun",
				[
					"run",
					cliPath,
					"build",
					"--unit",
					"story",
					"--repo",
					repo.dir,
					"--model",
					"test/fake",
					"--out",
					out,
					"--drafts-dir",
					join(out, "drafts"),
				],
				{ encoding: "utf8" },
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("drafts");
		} finally {
			cleanupGitRepo(repo);
			rmSync(out, { recursive: true, force: true });
		}
	});
});

describe("build --unit story: minAttribution eligibility", () => {
	test(
		"a weak changelog story is skipped by default and drafted with story.minAttribution weak",
		withRepo(async (repo) => {
			seedChangelog(repo);
			repo.commit("feat(reels): add the widget factory", {
				path: "packages/reels/src/widgetFactory.ts",
				content: "export function widgetFactory() {\n\treturn 1;\n}\n",
			});
			const strongDocsSha = addChangelogEntry(repo, "- add the `widgetFactory` helper");
			const weakDocsSha = addChangelogEntry(repo, "- improve the general experience for everyone");

			const out = tmpDir("reels-story-out-");
			const drafts = tmpDir("reels-story-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				const result1 = await runBuild(baseArgv(repo.dir, drafts, out), overrides);
				expect(result1.published).toBe(1);
				const idsAfterFirst = readDraftIds(drafts, "demo");
				expect(idsAfterFirst.some((id) => id.startsWith(strongDocsSha))).toBe(true);
				expect(idsAfterFirst.some((id) => id.startsWith(weakDocsSha))).toBe(false);

				const configPath = join(out, "weak.reels.json");
				writeFileSync(configPath, JSON.stringify({ story: { minAttribution: "weak" } }));
				const result2 = await runBuild(baseArgv(repo.dir, drafts, out, ["--config", configPath]), overrides);
				expect(result2.published).toBe(1); // the strong one is already drafted; only the weak one is new

				const idsAfterSecond = readDraftIds(drafts, "demo");
				expect(idsAfterSecond.some((id) => id.startsWith(weakDocsSha))).toBe(true);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("build --unit story: a failing story is recorded and the run continues", () => {
	test(
		"one story's TTS failure does not stop the next story from drafting",
		withRepo(async (repo) => {
			const goodSha = addFeatureBranchMerge(repo, { subject: "Merge good feature" });
			const badSha = addFeatureBranchMerge(repo, { subject: "Merge bad feature" });

			const out = tmpDir("reels-story-out-");
			const drafts = tmpDir("reels-story-drafts-");
			try {
				const flakyTts: TtsProvider = {
					async synthesize(scenes, dir) {
						const titleScene = scenes.find((s) => s.kind === "title");
						if (titleScene && "title" in titleScene && titleScene.title === "Merge bad feature") {
							throw new Error("simulated tts failure");
						}
						return silentProvider.synthesize(scenes, dir);
					},
				};
				const overrides: BuildOverrides = { complete: fallingBackCompleter(), tts: flakyTts };
				const result = await runBuild(baseArgv(repo.dir, drafts, out, ["--limit", "10"]), overrides);

				expect(result.published).toBe(1);
				expect(result.failed).toBe(1);

				const ids = readDraftIds(drafts, "demo");
				expect(ids).toContain(goodSha);
				expect(ids).not.toContain(badSha);

				const state = await readState(drafts, "demo");
				expect(state.failed[badSha]?.attempts).toBe(1);
				expect(state.failed[badSha]?.lastError).toContain("simulated tts failure");
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("build --unit story: spend caps stop the run but keep finished drafts", () => {
	test(
		"the LLM USD cap stops before a second story starts",
		withRepo(async (repo) => {
			const shaA = addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			const shaB = addFeatureBranchMerge(repo, { subject: "Merge feature B" });

			const out = tmpDir("reels-story-out-");
			const drafts = tmpDir("reels-story-drafts-");
			try {
				// Each story makes 2 model calls (initial + repair) before the deterministic fallback; $0.6 each means
				// the first story alone (1.2) already exceeds a $1 cap, so the second story must never start.
				const overrides: BuildOverrides = {
					complete: fallingBackCompleter({ input: 0, output: 0, costUsd: 0.6 }),
				};
				const result = await runBuild(
					baseArgv(repo.dir, drafts, out, ["--limit", "10", "--max-cost-usd", "1"]),
					overrides,
				);
				expect(result.published).toBe(1);
				const ids = readDraftIds(drafts, "demo");
				expect(ids).toHaveLength(1);
				expect([shaA, shaB]).toContain(ids[0]);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"the LLM token cap stops before a second story starts",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });

			const out = tmpDir("reels-story-out-");
			const drafts = tmpDir("reels-story-drafts-");
			try {
				const overrides: BuildOverrides = {
					complete: fallingBackCompleter({ input: 300, output: 300, costUsd: 0 }),
				};
				const result = await runBuild(
					baseArgv(repo.dir, drafts, out, ["--limit", "10", "--max-llm-tokens", "1000"]),
					overrides,
				);
				expect(result.published).toBe(1);
				expect(readDraftIds(drafts, "demo")).toHaveLength(1);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"the TTS character cap stops before a second story starts, without discarding the first draft",
		withRepo(async (repo) => {
			// Identical subject/content on both branches: the two stories' sanitized narration is exactly the same
			// length, so one probe run gives an exact per-story character cost `C`; a cap of `C` is enough for
			// exactly one story and never two.
			const shaA = addFeatureBranchMerge(repo, { subject: "Merge feature" });
			const shaB = addFeatureBranchMerge(repo, { subject: "Merge feature" });

			const probeOut = tmpDir("reels-story-probe-out-");
			const probeDrafts = tmpDir("reels-story-probe-drafts-");
			const out = tmpDir("reels-story-out-");
			const drafts = tmpDir("reels-story-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter() };
				await runBuild(baseArgv(repo.dir, probeDrafts, probeOut, ["--limit", "1"]), overrides);
				const [probedId] = readDraftIds(probeDrafts, "demo");
				expect(probedId).toBeDefined();
				const probedEntry = readDraftEntry(probeDrafts, "demo", probedId as string);
				const perStoryChars = probedEntry.transcript.reduce((sum, seg) => sum + seg.text.length, 0);
				expect(perStoryChars).toBeGreaterThan(0);

				const result = await runBuild(
					baseArgv(repo.dir, drafts, out, ["--limit", "10", "--max-tts-chars", String(perStoryChars)]),
					overrides,
				);
				expect(result.published).toBe(1);
				const ids = readDraftIds(drafts, "demo");
				expect(ids).toHaveLength(1);
				expect([shaA, shaB]).toContain(ids[0]);
			} finally {
				cleanupGitRepo(repo);
				rmSync(probeOut, { recursive: true, force: true });
				rmSync(probeDrafts, { recursive: true, force: true });
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("--unit story: lang de reaches the validator", () => {
	test("the German 'not recorded' sentence is accepted without a repair round", async () => {
		const files = [
			{
				path: "src/foo.ts",
				status: "modified" as const,
				additions: 1,
				deletions: 1,
				hunks: [
					{
						header: "@@ -10,3 +10,4 @@",
						lines: [" line ten", "+line eleven (added)", " line twelve", "-line thirteen (removed)"],
					},
				],
			},
		];
		const headSha = "0123456789abcdef0123456789abcdef01234567";
		const story = {
			id: headSha,
			commits: [headSha.slice(0, 12)],
			title: "fix: slow query",
			body: "",
			authors: ["Ada Lovelace"],
			date: "2024-01-01T00:00:00Z",
			files,
			origin: "commit" as const,
			base: "parent12345678901234567890123456789012345",
			branchCommits: [],
			related: [],
		};
		const ctx = {
			sources: createSourceRegistry([]),
			promptContext: "",
			manifest: { totalChars: 0, budgetChars: 0, entries: [] },
			nonce: "n",
			headFiles: new Map(),
			anchors: {
				changedPaths: new Set(["src/foo.ts"]),
				contextPaths: new Set<string>(),
				textByPath: new Map([["src/foo.ts", "export function resolveCodeRef() {}"]]),
				packageNames: new Set<string>(),
				topLevelDirs: new Set(["src"]),
			},
			files,
			isBlocked: () => false,
		};
		const metaBeat = (text: string) => ({ text, claim: "meta" as const, cites: [] });
		const germanWhyBeat = { text: REASON_NOT_RECORDED_TEXT.de, claim: "why" as const, cites: [] };
		const validDiagram = {
			nodes: [
				{ id: "a", anchor: { kind: "component" as const, value: "src" }, caption: "the source" },
				{ id: "b", anchor: { kind: "path" as const, value: "src/foo.ts" }, caption: "the file" },
				{ id: "c", anchor: { kind: "symbol" as const, value: "resolveCodeRef" }, caption: "resolves it" },
			],
			edges: [],
		};
		const validCode = { path: "src/foo.ts", ref: "diff" as const, hunk: 0, lines: [1, 2] as [number, number] };
		const response = JSON.stringify({
			title: "A fix",
			subtitle: "By Ada",
			summary: { text: "A fix.", cites: [] },
			scenes: [
				{ section: "problem", beats: [germanWhyBeat] },
				{ section: "idea", beats: [metaBeat("Idee.")] },
				{ section: "mechanism", diagram: validDiagram, beats: [metaBeat("Mechanismus.")] },
				{ section: "code", code: validCode, beats: [metaBeat("Code.")] },
				{ section: "impact", beats: [metaBeat("Auswirkung.")] },
				{ section: "outro", beats: [metaBeat("Das war die Änderung.")] },
			],
		});
		const complete: ModelCompleter = async () => ({ text: response });
		const costMeter = new CostMeter(100);

		const result = await writeStoryScript(story, ctx, complete, costMeter, { deepDive: "never", lang: "de" });
		expect(result.writer).toBe("llm");
		const problemScene = result.script.scenes.find((s) => s.section === "problem");
		expect(problemScene?.beats?.[0]).toMatchObject({ text: REASON_NOT_RECORDED_TEXT.de });
	});
});

describe("--unit commit is unchanged", () => {
	test(
		"the default (--unit commit) still publishes to the public feed",
		withRepo(async (repo) => {
			repo.commit("feat: a plain commit", { path: "a.txt" });
			const out = tmpDir("reels-story-out-");
			try {
				const result = await runBuild([
					"--repo",
					repo.dir,
					"--name",
					"demo",
					"--out",
					out,
					"--tts",
					"none",
					"--mode",
					"audio",
				]);
				expect(result.published).toBeGreaterThan(0);
				const feed = JSON.parse(readFileSync(join(out, "demo", "feed.json"), "utf-8")) as Feed;
				expect(feed.reels.length).toBeGreaterThan(0);
			} finally {
				cleanupGitRepo(repo);
				rmSync(out, { recursive: true, force: true });
			}
		}),
	);
});
