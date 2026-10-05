import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuildOverrides, runApprove, runBuild, runPlan, runReject } from "../src/cli.ts";
import type { StoryPlan } from "../src/plan-story.ts";
import type { ModelCompleter } from "../src/script.ts";
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

/** Throws if ever called: proves the plan's story path never resolves/invokes a model completer (no LLM calls). */
const throwingCompleter: ModelCompleter = async () => {
	throw new Error("plan must never call the model completer");
};

function seedChangelog(repo: GitRepo): string {
	return repo.commit("chore: seed changelog", { path: "CHANGELOG.md", content: "## [Unreleased]\n\n### Added\n\n" });
}

function addChangelogEntry(repo: GitRepo, entryLine: string): string {
	return repo.commit("docs: changelog entry", {
		path: "CHANGELOG.md",
		content: `## [Unreleased]\n\n### Added\n\n${entryLine}\n`,
	});
}

/** Non-tiny release: 2 feature merges, one pooled upstream anchor (via a sync merge), and one weak changelog
 * feature — see `cli-release.test.ts`'s identical fixture. */
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

const planArgv = (repo: string, out: string, drafts: string, extra: string[] = []): string[] => [
	"--repo",
	repo,
	"--name",
	"demo",
	"--out",
	out,
	"--drafts-dir",
	drafts,
	...extra,
];

const buildArgv = (repo: string, out: string, drafts: string, extra: string[] = []): string[] => [
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
	drafts,
	...extra,
];

const fallingBackCompleter: ModelCompleter = async () => {
	const text = JSON.stringify({ title: "t", subtitle: "s", summary: { text: "x", cites: [] }, scenes: [] });
	return { text };
};

async function capturePlan(argv: string[], overrides: BuildOverrides = {}): Promise<{ plan: StoryPlan; text: string }> {
	const logs: string[] = [];
	const original = console.log;
	console.log = (msg?: unknown) => {
		logs.push(String(msg));
	};
	try {
		await runPlan([...argv, "--json"], overrides);
	} finally {
		console.log = original;
	}
	const jsonLine = logs.find((l) => l.startsWith("{"));
	if (!jsonLine) throw new Error(`no JSON line in plan output: ${logs.join("\n")}`);
	return { plan: JSON.parse(jsonLine) as StoryPlan, text: logs.join("\n") };
}

async function captureTextPlan(argv: string[], overrides: BuildOverrides = {}): Promise<string> {
	const logs: string[] = [];
	const original = console.log;
	console.log = (msg?: unknown) => {
		logs.push(String(msg));
	};
	try {
		await runPlan(argv, overrides);
	} finally {
		console.log = original;
	}
	return logs.join("\n");
}

describe("plan --unit story: read-only dry run, never calls the model completer", () => {
	test(
		"a brand-new feature-branch story is reported as status new",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				const unreleased = plan.releases.find((r) => r.tag === undefined);
				expect(unreleased).toBeDefined();
				const story = unreleased?.stories.find((s) => s.id === mergeSha);
				expect(story?.status).toBe("new");
				expect(story?.origin).toBe("branch");
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"a drafted story is reported as pending, an approved one as approved, a rejected one as rejected",
		withRepo(async (repo) => {
			const shaPending = addFeatureBranchMerge(repo, { subject: "Merge pending" });
			const shaApproved = addFeatureBranchMerge(repo, { subject: "Merge approved" });
			const shaRejected = addFeatureBranchMerge(repo, { subject: "Merge rejected" });
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const overrides: BuildOverrides = { complete: fallingBackCompleter };
				await runBuild(buildArgv(repo.dir, out, drafts), overrides);

				await runApprove(["--repo", repo.dir, "--name", "demo", "--out", out, "--drafts-dir", drafts, shaApproved]);
				await runReject(["--repo", repo.dir, "--name", "demo", "--out", out, "--drafts-dir", drafts, shaRejected]);

				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				const unreleased = plan.releases.find((r) => r.tag === undefined);
				const byId = new Map(unreleased?.stories.map((s) => [s.id, s.status]));
				expect(byId.get(shaPending)).toBe("pending");
				expect(byId.get(shaApproved)).toBe("approved");
				expect(byId.get(shaRejected)).toBe("rejected");
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"a non-tiny release lists its weak feature, pooled anchor count, and would draft an overview and a recap",
		withRepo(async (repo) => {
			const tag = buildNonTinyReleaseWithUpstreamPool(repo, "v1.0.0");
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				const release = plan.releases.find((r) => r.tag === tag);
				expect(release).toBeDefined();
				expect(release?.tiny).toBe(false);
				expect(release?.weakFeatures).toContain("improve the general experience for everyone");
				expect(release?.upstreamAnchorCount).toBeGreaterThan(0);
				expect(release?.overview.wouldDraft).toBe(true);
				expect(release?.overview.status).toBe("new");
				expect(release?.recap.wouldDraft).toBe(true);
				expect(release?.recap.status).toBe("new");
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"unreleased work would draft neither an overview nor a recap, but its stories stay eligible",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			seedChangelog(repo);
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			addFeatureBranchMerge(repo, { subject: "Merge feature B" });
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
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				const unreleased = plan.releases.find((r) => r.tag === undefined);
				expect(unreleased).toBeDefined();
				expect(unreleased?.tiny).toBe(false);
				expect(unreleased?.upstreamAnchorCount).toBeGreaterThan(0);
				expect(unreleased?.overview.wouldDraft).toBe(false);
				expect(unreleased?.recap.wouldDraft).toBe(false);
				expect(unreleased?.stories.some((s) => s.status === "new")).toBe(true);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"a tiny release would draft neither an overview nor a recap",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge only feature" });
			repo.tag("v1.0.0");
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				const release = plan.releases.find((r) => r.tag === "v1.0.0");
				expect(release?.tiny).toBe(true);
				expect(release?.overview.wouldDraft).toBe(false);
				expect(release?.recap.wouldDraft).toBe(false);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"the TTS estimate totals status-new items and marks which fit within a small cap",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo, { subject: "Merge A" });
			addFeatureBranchMerge(repo, { subject: "Merge B" });
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts, ["--max-tts-chars", "1500"]), {
					complete: throwingCompleter,
				});
				expect(plan.maxTtsChars).toBe(1500);
				expect(plan.ttsEstimate.items.length).toBeGreaterThanOrEqual(2);
				expect(plan.ttsEstimate.items[0]?.fits).toBe(true);
				const lastFits = plan.ttsEstimate.items.at(-1)?.fits;
				expect(typeof lastFits).toBe("boolean");
				expect(plan.ttsEstimate.fitsWithinCap).toBe(plan.ttsEstimate.totalChars <= 1500);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"--limit marks stories beyond the window as later instead of new, and the TTS estimate totals only this run",
		withRepo(async (repo) => {
			const shaA = addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			const shaB = addFeatureBranchMerge(repo, { subject: "Merge feature B" });
			const shaC = addFeatureBranchMerge(repo, { subject: "Merge feature C" });
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts, ["--limit", "1"]), {
					complete: throwingCompleter,
				});
				const unreleased = plan.releases.find((r) => r.tag === undefined);
				const byId = new Map(unreleased?.stories.map((s) => [s.id, s.status]));
				// selectStoryUnits keeps the NEWEST id within the window when bootstrapping (no floor yet): C is
				// newest, so it alone is "new" this run; A and B are eligible but beyond --limit 1, hence "later".
				expect(byId.get(shaC)).toBe("new");
				expect(byId.get(shaB)).toBe("later");
				expect(byId.get(shaA)).toBe("later");
				expect(plan.ttsEstimate.items.map((i) => i.id)).toEqual([shaC]);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"a release's weak features are deduplicated and capped, with a remainder count for the rest",
		withRepo(async (repo) => {
			seedChangelog(repo);
			addFeatureBranchMerge(repo, { subject: "Merge feature A" });
			const unrelatedWeakFeatures = [
				"improve startup latency for cold boots",
				"fix off-by-one error in pagination cursor",
				"add caching layer to avoid redundant requests",
				"clean up unused imports across the codebase",
				"improve error messages when a request times out",
				"add defensive null checks to the parser",
				"fix typo in the help text for a command",
				"improve color contrast in the settings panel",
				"add retry with backoff for flaky network calls",
				"reduce memory usage during large file uploads",
				"fix race condition when saving config concurrently",
				"improve logging detail for failed authentication attempts",
			];
			for (const feature of unrelatedWeakFeatures) addChangelogEntry(repo, `- ${feature}`);
			repo.tag("v1.0.0");
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				const release = plan.releases.find((r) => r.tag === "v1.0.0");
				expect(release?.weakFeatures.length).toBeLessThanOrEqual(10);
				expect(release?.weakFeaturesRemainderCount).toBeGreaterThan(0);
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);

	test(
		"--json prints parseable JSON matching the plain-text report's content",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo);
			const out = tmpDir("plan-out-");
			const drafts = tmpDir("plan-drafts-");
			try {
				const { plan } = await capturePlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				expect(plan.name).toBe("demo");
				const text = await captureTextPlan(planArgv(repo.dir, out, drafts), { complete: throwingCompleter });
				expect(text).toContain("draht-reels plan --unit story: demo");
				expect(() => JSON.parse(text)).toThrow();
			} finally {
				rmSync(out, { recursive: true, force: true });
				rmSync(drafts, { recursive: true, force: true });
			}
		}),
	);
});

describe("plan --unit commit: unchanged", () => {
	test(
		"prints the changeSets/scripts JSON report, same as before story units existed",
		withRepo(async (repo) => {
			repo.commit("feat: something");
			try {
				const logs: string[] = [];
				const original = console.log;
				console.log = (msg?: unknown) => logs.push(String(msg));
				try {
					await runPlan(["--repo", repo.dir, "--unit", "commit"]);
				} finally {
					console.log = original;
				}
				const parsed = JSON.parse(logs.join("\n")) as { changeSets: unknown[]; scripts: unknown[] };
				expect(Array.isArray(parsed.changeSets)).toBe(true);
				expect(Array.isArray(parsed.scripts)).toBe(true);
			} finally {
				// no out/drafts dirs created by --unit commit
			}
		}),
	);
});
