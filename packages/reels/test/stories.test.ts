import { describe, expect, test } from "bun:test";
import type { PullRequestInfo } from "../src/contract.ts";
import type { GithubLookup } from "../src/github.ts";
import { filterFeatureAnchors, findChangelogAnchors, walkMainline } from "../src/mainline.ts";
import {
	collectStories,
	computeStoryId,
	extractIdentifiers,
	isValidStoryId,
	selectStoryUnits,
} from "../src/stories.ts";
import { addFeatureBranchMerge, cleanupGitRepo, type GitRepo, initGitRepo } from "./fixtures/git-repo.ts";

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

/** Seeds an empty changelog section so later additions diff cleanly as "added". */
function seedChangelog(repo: GitRepo, path = "packages/reels/CHANGELOG.md"): string {
	return repo.commit("chore: seed changelog", { path, content: "## [Unreleased]\n\n### Added\n\n" });
}

function addChangelogEntry(repo: GitRepo, entryLine: string, path = "packages/reels/CHANGELOG.md"): string {
	return repo.commit(`docs: changelog entry`, {
		path,
		content: `## [Unreleased]\n\n### Added\n\n${entryLine}\n`,
	});
}

function commitWithBody(repo: GitRepo, subject: string, body: string, path: string, content: string): string {
	repo.writeFile(path, content);
	repo.git(["add", path]);
	repo.git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", subject, "-m", body]);
	return repo.sha("HEAD");
}

describe("extractIdentifiers", () => {
	test("extracts backticked tokens, flags, env vars, paths, and camel/snake names", () => {
		const text =
			"add `widgetFactory` behind --new-widget, reading WIDGET_MODE, touching src/widgets/factory.ts and widget_count";
		const ids = extractIdentifiers(text);
		expect(ids).toContain("widgetFactory");
		expect(ids).toContain("--new-widget");
		expect(ids).toContain("WIDGET_MODE");
		expect(ids).toContain("src/widgets/factory.ts");
		expect(ids).toContain("widget_count");
	});

	test("a prose-only entry yields no identifiers", () => {
		expect(extractIdentifiers("improve the general experience for everyone")).toEqual([]);
	});
});

describe("computeStoryId / isValidStoryId", () => {
	const sha = "a".repeat(40);

	test("is the head sha when it is not already used", () => {
		expect(computeStoryId(sha, ["feature one"], new Set())).toBe(sha);
	});

	test("is stable across repeated calls with the same inputs", () => {
		const id1 = computeStoryId(sha, ["feature one", "feature two"], new Set([sha]));
		const id2 = computeStoryId(sha, ["feature one", "feature two"], new Set([sha]));
		expect(id1).toBe(id2);
		expect(isValidStoryId(id1)).toBe(true);
	});

	test("disambiguates a collision with a different hash suffix", () => {
		const idA = computeStoryId(sha, ["feature one"], new Set([sha]));
		const idB = computeStoryId(sha, ["feature two"], new Set([sha]));
		expect(idA).not.toBe(idB);
	});
});

describe("selectStoryUnits (faux window, no git)", () => {
	const SHA_A = "a".repeat(40);
	const SHA_B = "b".repeat(40);
	const SHA_C = "c".repeat(40);

	test("drains the oldest above the floor", () => {
		const selection = selectStoryUnits([SHA_B, SHA_A], new Set([SHA_A]), new Set());
		expect(selection).toEqual({ ids: [SHA_B], cappedSkipped: [] });
	});

	test("bootstraps with the newest N when nothing published falls in the window", () => {
		const selection = selectStoryUnits([SHA_C, SHA_B], new Set([SHA_A]), new Set(), { limit: 1 });
		expect(selection).toEqual({ ids: [SHA_C], cappedSkipped: [] });
	});

	test("all-history drains everything unpublished, oldest first", () => {
		const selection = selectStoryUnits([SHA_C, SHA_B, SHA_A], new Set([SHA_A]), new Set(), { allHistory: true });
		expect(selection).toEqual({ ids: [SHA_B, SHA_C], cappedSkipped: [] });
	});

	test("capped stories are skipped unless force", () => {
		const selection = selectStoryUnits([SHA_B, SHA_A], new Set([SHA_A]), new Set([SHA_B]));
		expect(selection).toEqual({ ids: [], cappedSkipped: [SHA_B] });

		const forced = selectStoryUnits([SHA_B, SHA_A], new Set([SHA_A]), new Set([SHA_B]), { force: true });
		expect(forced).toEqual({ ids: [SHA_B], cappedSkipped: [] });
	});

	test("a legacy per-commit `change` id in the published set still establishes the floor", () => {
		// A pre-story feed publishes change entries keyed by commit sha; selectStoryUnits
		// treats that id the same as a story id, since both are opaque strings to it.
		const legacyChangeId = SHA_A;
		const selection = selectStoryUnits([SHA_B, legacyChangeId], new Set([legacyChangeId]), new Set());
		expect(selection).toEqual({ ids: [SHA_B], cappedSkipped: [] });
	});
});

describe("collectStories: branch merges", () => {
	test(
		"a feature merge with a GitHub PR for its head sha becomes an origin: pr story",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });

			const pr: PullRequestInfo = {
				number: 7,
				url: "https://github.com/acme/widget/pull/7",
				title: "Add the new thing",
				body: "Because it was needed.",
				author: "octocat",
				labels: [],
				reviews: [],
				comments: [],
			};
			const gh: GithubLookup = {
				lookupPullRequestForSha: async (sha) => (sha === mergeSha ? pr : undefined),
			};

			const result = await collectStories(units, { repo: repo.dir, gh });
			const story = result.stories.find((s) => s.id === mergeSha);
			expect(story?.origin).toBe("pr");
			expect(story?.pr?.number).toBe(7);
		}),
	);

	test(
		"a feature merge without a PR becomes an origin: branch story",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });

			const result = await collectStories(units, { repo: repo.dir });
			const story = result.stories.find((s) => s.id === mergeSha);
			expect(story?.origin).toBe("branch");
			expect(story?.pr).toBeUndefined();
		}),
	);

	test(
		"branch commit bodies are collected from the existing walk data",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("body-feature");
			commitWithBody(
				repo,
				"feat: add the new thing",
				"Why this was needed: a detailed explanation of the rationale.",
				"feature.txt",
				"one\n",
			);
			repo.checkout(base);
			const mergeSha = repo.mergeNoFF("body-feature", "Merge feature");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const result = await collectStories(units, { repo: repo.dir });
			const story = result.stories.find((s) => s.id === mergeSha);
			expect(story?.branchCommits.length).toBeGreaterThan(0);
			expect(story?.branchCommits.some((c) => c.body.includes("detailed explanation of the rationale"))).toBe(true);
		}),
	);
});

describe("collectStories: branch-sync merges", () => {
	test(
		"the branch-sync merge itself is skipped, not a story and not a sync recap",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("sync-branch");
			repo.commit("feat: a change living only on the sync branch");
			repo.checkout(base);
			const mergeSha = repo.mergeNoFF("sync-branch", "merge: sync with origin/main (fixture)");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(units.find((u) => u.sha === mergeSha)?.class).toBe("branch-sync");

			const result = await collectStories(units, { repo: repo.dir });
			expect(result.stories.some((s) => s.id === mergeSha)).toBe(false);
			expect(result.syncRecap.some((r) => r.implementing.includes(mergeSha))).toBe(false);
			expect(result.skipped).toContainEqual({ sha: mergeSha, reason: "branch-sync" });
		}),
	);

	test(
		"a changelog entry implemented inside a branch-sync's branch still becomes its own story, not a sync recap",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);

			const base = repo.currentBranch();
			repo.checkoutNewBranch("sync-branch");
			const implSha = commitWithBody(
				repo,
				"feat: add branchWidgetHelper",
				"",
				"packages/reels/src/branchWidgetHelper.ts",
				"export function branchWidgetHelper() {}\n",
			);
			repo.checkout(base);
			repo.mergeNoFF("sync-branch", "merge: sync with origin/main (fixture)");

			const docsSha = addChangelogEntry(repo, "- add the `branchWidgetHelper` function");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const range = `${fromSha}..HEAD`;
			const rawAnchors = await findChangelogAnchors(units, { repo: repo.dir, range });
			const anchors = filterFeatureAnchors(rawAnchors, units);
			// filterFeatureAnchors deliberately keeps anchors owned by a
			// branch-sync unit: the branch's own commits are draht's work, not
			// upstream's.
			expect(anchors.some((a) => a.commitSha === docsSha)).toBe(true);

			const result = await collectStories(units, {
				repo: repo.dir,
				anchors: anchors.map((anchor) => ({ anchor, range })),
			});

			const story = result.stories.find((s) => s.origin === "commit");
			expect(story?.id).toBe(implSha);
			expect(result.syncRecap).toHaveLength(0);
		}),
	);
});

describe("collectStories: changelog attribution (T1 amendment)", () => {
	test(
		"finds the implementing commit when a later docs commit added the changelog entry (42fdbb49c pattern)",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);
			const implSha = repo.commit("feat(reels): add the widget factory", {
				path: "packages/reels/src/widgetFactory.ts",
				content: "export function widgetFactory() {\n\treturn 1;\n}\n",
			});
			const docsSha = addChangelogEntry(repo, "- add the `widgetFactory` helper");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const range = `${fromSha}..HEAD`;
			const rawAnchors = await findChangelogAnchors(units, { repo: repo.dir, range });
			const anchors = filterFeatureAnchors(rawAnchors, units);
			expect(anchors.map((a) => a.commitSha)).toContain(docsSha);

			const result = await collectStories(units, {
				repo: repo.dir,
				anchors: anchors.map((anchor) => ({ anchor, range })),
			});

			const story = result.stories.find((s) => s.origin === "commit");
			expect(story?.id).toBe(implSha);
			expect(story?.id).not.toBe(docsSha);
			expect(result.attribution.get(implSha)).toBe("strong");
		}),
	);

	test(
		"falls back to the anchor commit with weak attribution when no identifiers are found",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);
			const docsSha = addChangelogEntry(repo, "- improve the general experience for everyone");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const range = `${fromSha}..HEAD`;
			const rawAnchors = await findChangelogAnchors(units, { repo: repo.dir, range });
			const anchors = filterFeatureAnchors(rawAnchors, units);

			const result = await collectStories(units, {
				repo: repo.dir,
				anchors: anchors.map((anchor) => ({ anchor, range })),
			});

			const story = result.stories.find((s) => s.origin === "commit");
			expect(story?.id).toBe(docsSha);
			expect(result.attribution.get(docsSha)).toBe("weak");
		}),
	);

	test(
		"an entry whose implementing commit was carried in from upstream is routed to the sync recap, not a story",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);

			const base = repo.currentBranch();
			repo.checkoutNewBranch("sync-branch");
			commitWithBody(
				repo,
				"feat: add syncedWidgetHelper upstream",
				"",
				"packages/reels/src/syncedWidgetHelper.ts",
				"export function syncedWidgetHelper() {}\n",
			);
			repo.checkout(base);
			repo.mergeNoFF("sync-branch", "sync upstream through v9.9.9");

			const docsSha = addChangelogEntry(repo, "- add the `syncedWidgetHelper` function");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const range = `${fromSha}..HEAD`;
			const rawAnchors = await findChangelogAnchors(units, { repo: repo.dir, range });
			const anchors = filterFeatureAnchors(rawAnchors, units);
			// The anchor's own owning commit (the docs commit) is not itself the sync
			// merge, so filterFeatureAnchors keeps it; only identifier attribution
			// (inside collectStories) can discover it was actually upstream work.
			expect(anchors.some((a) => a.commitSha === docsSha)).toBe(true);

			const result = await collectStories(units, {
				repo: repo.dir,
				anchors: anchors.map((anchor) => ({ anchor, range })),
			});

			expect(result.stories.some((s) => s.origin === "commit")).toBe(false);
			expect(result.syncRecap.some((entry) => entry.anchor.commitSha === docsSha)).toBe(true);
		}),
	);

	test(
		"two changelog entries whose implementing commits overlap merge into one story",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);
			const implSha = repo.commit("feat(reels): add the shared helper", {
				path: "packages/reels/src/sharedHelper.ts",
				content: "export function sharedHelper() {\n\treturn 1;\n}\n",
			});
			addChangelogEntry(repo, "- add the `sharedHelper` function");
			addChangelogEntry(repo, "- wire up the `sharedHelper` function in the CLI");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const range = `${fromSha}..HEAD`;
			const rawAnchors = await findChangelogAnchors(units, { repo: repo.dir, range });
			const anchors = filterFeatureAnchors(rawAnchors, units);
			expect(anchors.length).toBeGreaterThanOrEqual(2);

			const result = await collectStories(units, {
				repo: repo.dir,
				anchors: anchors.map((anchor) => ({ anchor, range })),
			});

			const commitStories = result.stories.filter((s) => s.origin === "commit");
			expect(commitStories).toHaveLength(1);
			expect(commitStories[0]?.id).toBe(implSha);
		}),
	);

	test(
		"collectStories produces the same story id across two runs over the same history",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);
			const implSha = repo.commit("feat(reels): add the widget factory", {
				path: "packages/reels/src/widgetFactory.ts",
				content: "export function widgetFactory() {\n\treturn 1;\n}\n",
			});
			addChangelogEntry(repo, "- add the `widgetFactory` helper");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const range = `${fromSha}..HEAD`;
			const rawAnchors = await findChangelogAnchors(units, { repo: repo.dir, range });
			const anchors = filterFeatureAnchors(rawAnchors, units).map((anchor) => ({ anchor, range }));

			const run1 = await collectStories(units, { repo: repo.dir, anchors });
			const run2 = await collectStories(units, { repo: repo.dir, anchors });
			expect(run1.stories.map((s) => s.id)).toEqual(run2.stories.map((s) => s.id));
			expect(run1.stories.find((s) => s.origin === "commit")?.id).toBe(implSha);
		}),
	);
});
