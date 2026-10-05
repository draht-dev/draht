import { describe, expect, test } from "bun:test";
import type { PullRequestInfo } from "../src/contract.ts";
import type { GithubLookup } from "../src/github.ts";
import { filterFeatureAnchors, findChangelogAnchors, walkMainline } from "../src/mainline.ts";
import {
	collectStories,
	computeBranchStoryId,
	computeChangelogStoryId,
	createPickaxeBudget,
	deriveBranchTitle,
	deriveShortTitle,
	extractIdentifiers,
	findExactSubjectMatch,
	findImplementingCommits,
	groupOverlappingAttributions,
	isValidStoryId,
	selectStoryUnits,
	storyIdSha,
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

	test("the stoplist drops common prose that matches an identifier pattern syntactically", () => {
		expect(extractIdentifiers("supports read/write and input/output, e.g. and/or on/off")).toEqual([]);
	});

	test("a short code-shaped token below the minimum length is dropped", () => {
		// "id" is code-shaped-ish (short, lowercase) but shorter than the minimum.
		expect(extractIdentifiers("return the id")).toEqual([]);
	});

	test("a capitalized proper noun is never mistaken for a symbol: every survivor must be code-shaped", () => {
		// "GitHub" and "Widget" look like identifiers (capital letters) but carry
		// no code shape (no backtick, no _/./ //camelCase/--/leading /).
		expect(extractIdentifiers("GitHub now supports Widget uploads")).toEqual([]);
	});

	test("input longer than the entry-text cap is truncated before any regex runs", () => {
		const huge = `\`realIdentifier\` ${"x".repeat(20_000)}`;
		expect(extractIdentifiers(huge)).toContain("realIdentifier");
	});
});

describe("findExactSubjectMatch", () => {
	test("matches a commit subject stated near-verbatim in the entry text", () => {
		const match = findExactSubjectMatch("add the mainline walker and its tests", [
			{ sha: "a".repeat(40), subject: "feat(reels): add the mainline walker and its tests", body: "" },
		]);
		expect(match).toHaveLength(1);
		expect(match[0]?.sha).toBe("a".repeat(40));
	});

	test("matches against a commit body", () => {
		const match = findExactSubjectMatch("adds a brand new widget factory for the pipeline", [
			{
				sha: "b".repeat(40),
				subject: "feat: unrelated subject",
				body: "This adds a brand new widget factory for the pipeline.",
			},
		]);
		expect(match).toHaveLength(1);
	});

	test("does not match on a short, coincidental substring", () => {
		const match = findExactSubjectMatch("fix bug", [
			{ sha: "c".repeat(40), subject: "fix bug in renderer", body: "" },
		]);
		expect(match).toHaveLength(0);
	});

	test("returns nothing when no candidate is close", () => {
		const match = findExactSubjectMatch("completely unrelated changelog wording here", [
			{ sha: "d".repeat(40), subject: "feat: something else entirely", body: "" },
		]);
		expect(match).toHaveLength(0);
	});

	test("stays well under the unfixed quadratic blowup for 500 anchors against 2000 large-bodied candidates", () => {
		const candidates = Array.from({ length: 2000 }, (_, i) => ({
			sha: i.toString(16).padStart(40, "0"),
			subject: `feat: candidate subject number ${i} with enough words to pass the length floor`,
			body: `commit body filler text repeated to simulate a real release note. `.repeat(200),
		}));

		const start = performance.now();
		for (let i = 0; i < 500; i++) {
			findExactSubjectMatch(`anchor entry number ${i} that never matches any candidate wording at all`, candidates);
		}
		const elapsedMs = performance.now() - start;
		// Without per-range normalization caching this takes ~40s; the fixed
		// version takes ~1.1s. 5s leaves ample margin for CI jitter while
		// still catching a reintroduced per-anchor renormalization pass.
		expect(elapsedMs).toBeLessThan(5000);
	}, 10_000);
});

describe("deriveShortTitle", () => {
	test("splits at the first sentence boundary", () => {
		const entry =
			"Add the `widgetFactory` helper. It replaces the old ad-hoc construction code scattered across three call sites.";
		expect(deriveShortTitle(entry)).toBe("Add the `widgetFactory` helper");
	});

	test("splits at a semicolon clause boundary", () => {
		const entry = "Speed up cold start by lazily loading the renderer; this cuts startup time by roughly 40%.";
		expect(deriveShortTitle(entry)).toBe("Speed up cold start by lazily loading the renderer");
	});

	test("splits at a colon clause boundary", () => {
		const entry = "Fix the release writer: it was dropping the second paragraph of every commit body.";
		expect(deriveShortTitle(entry)).toBe("Fix the release writer");
	});

	test("splits at an em-dash clause boundary", () => {
		const entry = "Rework the pickaxe budget — it used to leak across runs and starve later entries of search quota.";
		expect(deriveShortTitle(entry)).toBe("Rework the pickaxe budget");
	});

	test("splits at the first comma only once past the 40-char floor", () => {
		const entry =
			"Add support for nested skill channels with cascading overrides, falling back to the parent channel when unset.";
		expect(deriveShortTitle(entry)).toBe("Add support for nested skill channels with cascading overrides");
	});

	test("a comma before the 40-char floor is not treated as a split point", () => {
		const entry = "Fix flaky, intermittent test failures in the collection pipeline under load.";
		expect(deriveShortTitle(entry)).toBe(entry);
	});

	test("keeps markdown backticks in the derived title", () => {
		const entry = "Rename `--old-flag` to `--new-flag`. Old scripts keep working via a deprecation shim.";
		expect(deriveShortTitle(entry)).toBe("Rename `--old-flag` to `--new-flag`");
	});

	test("caps a long, delimiter-free clause at 90 chars on a word boundary with an ellipsis", () => {
		const entry =
			"Overhaul the entire mainline walker to classify branch syncs apart from ordinary feature branches and upstream carries";
		const title = deriveShortTitle(entry);
		expect(title.length).toBeLessThanOrEqual(90);
		expect(title.endsWith("…")).toBe(true);
		expect(title).not.toMatch(/ …$/);
	});

	test("a short entry with no delimiter is returned unchanged", () => {
		expect(deriveShortTitle("improve the general experience for everyone")).toBe(
			"improve the general experience for everyone",
		);
	});
});

describe("deriveBranchTitle", () => {
	test("prefers the PR title when one is available", () => {
		expect(deriveBranchTitle("Merge pull request #42 from acme/widget-branch", "Add the widget factory")).toBe(
			"Add the widget factory",
		);
	});

	test("strips a leading merge: prefix when there is no PR", () => {
		expect(deriveBranchTitle("merge: add the widget factory")).toBe("add the widget factory");
	});

	test("strips a Merge pull request #N from … prefix when there is no PR", () => {
		const subject = "Merge pull request #42 from acme/widget-branch add the widget factory";
		expect(deriveBranchTitle(subject)).toBe("add the widget factory");
	});

	test("falls back to the unstripped subject when stripping would leave nothing", () => {
		const subject = "Merge pull request #42 from acme/widget-branch";
		expect(deriveBranchTitle(subject)).toBe(subject);
	});

	test("leaves an ordinary subject untouched", () => {
		expect(deriveBranchTitle("feat: add the widget factory")).toBe("feat: add the widget factory");
	});
});

describe("groupOverlappingAttributions", () => {
	function attribution(entryText: string, implementing: string[], strength: "strong" | "weak") {
		return {
			anchor: {
				entryText,
				section: "Added",
				packages: ["reels"],
				commitSha: implementing[0] ?? "x",
				commitSubject: "feat: x",
				unitId: implementing[0] ?? "x",
			},
			implementing,
			strength,
		};
	}

	test("unions two strong attributions sharing an implementing commit", () => {
		const shared = "a".repeat(40);
		const groups = groupOverlappingAttributions([
			attribution("entry one", [shared], "strong"),
			attribution("entry two", [shared], "strong"),
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toHaveLength(2);
	});

	test("never merges two weak attributions through a shared fallback anchor commit alone", () => {
		const sharedAnchor = "b".repeat(40);
		const groups = groupOverlappingAttributions([
			attribution("unrelated entry one", [sharedAnchor], "weak"),
			attribution("unrelated entry two", [sharedAnchor], "weak"),
		]);
		expect(groups).toHaveLength(2);
	});

	test("a weak attribution never joins a strong group even if it shares that group's commit", () => {
		const shared = "c".repeat(40);
		const groups = groupOverlappingAttributions([
			attribution("strong entry", [shared], "strong"),
			attribution("weak entry", [shared], "weak"),
		]);
		expect(groups).toHaveLength(2);
		expect(groups.some((g) => g.length === 1 && g[0]?.strength === "weak")).toBe(true);
	});
});

describe("findImplementingCommits: pickaxe cap", () => {
	test("a run budget of 0 finds nothing and never spawns a pickaxe process", async () => {
		let calls = 0;
		const git = async (args: string[]) => {
			calls++;
			if (args[0] === "log" && args.some((a) => a.startsWith("-S"))) throw new Error("pickaxe should not run");
			return "";
		};
		const budget = createPickaxeBudget(0);
		const result = await findImplementingCommits("add `someRealIdentifier` here", {
			repo: "/tmp/does-not-matter",
			range: "a..b",
			packages: ["reels"],
			git,
			runBudget: budget,
		});
		expect(result).toEqual([]);
		expect(calls).toBe(0);
	});
});

describe("computeBranchStoryId / computeChangelogStoryId / storyIdSha / isValidStoryId", () => {
	const sha = "a".repeat(40);

	test("a branch story id is exactly the merge sha", () => {
		expect(computeBranchStoryId(sha)).toBe(sha);
	});

	test("a changelog story id is the anchor sha plus a stable hash of the entry texts", () => {
		const id1 = computeChangelogStoryId(sha, ["feature one", "feature two"]);
		const id2 = computeChangelogStoryId(sha, ["feature one", "feature two"]);
		expect(id1).toBe(id2);
		expect(id1).not.toBe(sha);
		expect(isValidStoryId(id1)).toBe(true);
	});

	test("different entry texts on the same anchor sha disambiguate", () => {
		const idA = computeChangelogStoryId(sha, ["feature one"]);
		const idB = computeChangelogStoryId(sha, ["feature two"]);
		expect(idA).not.toBe(idB);
	});

	test("storyIdSha recovers the sha from a suffixed id", () => {
		const id = computeChangelogStoryId(sha, ["feature one"]);
		expect(storyIdSha(id)).toBe(sha);
		expect(storyIdSha(sha)).toBe(sha);
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
			commitWithBody(
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
			expect(story).toBeDefined();
			expect(result.syncRecap).toHaveLength(0);
		}),
	);
});

describe("collectStories: changelog attribution (T1 amendment, strengthened in the fix round)", () => {
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
			// The id is now built from the anchor (docs) commit, not the
			// implementing commit, so it stays stable as new commits land later —
			// but the story's own `commits` field still names the real implementer.
			expect(story?.id.startsWith(docsSha)).toBe(true);
			expect(story?.commits[0]).toBe(implSha.slice(0, 12));
			expect(result.attribution.get(story?.id ?? "")).toBe("strong");
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
			expect(story?.id.startsWith(docsSha)).toBe(true);
			expect(result.attribution.get(story?.id ?? "")).toBe("weak");
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
			expect(commitStories[0]?.commits[0]).toBe(implSha.slice(0, 12));
			// The merged story's id is derived from the earliest anchor of the
			// group and combines both entries' texts, not just the first one's.
			const firstAnchor = anchors[0];
			expect(firstAnchor).toBeDefined();
			expect(commitStories[0]?.id).toBe(
				computeChangelogStoryId(
					firstAnchor?.commitSha as string,
					anchors.map((a) => a.entryText),
				),
			);
			expect(commitStories[0]?.title).toBe(deriveShortTitle(anchors[0]?.entryText ?? ""));
		}),
	);

	test(
		"a merged story's id is stable across runs regardless of pickaxe candidate ordering",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);
			repo.commit("feat(reels): add the shared helper", {
				path: "packages/reels/src/sharedHelper.ts",
				content: "export function sharedHelper() {\n\treturn 1;\n}\n",
			});
			addChangelogEntry(repo, "- add the `sharedHelper` function");
			addChangelogEntry(repo, "- wire up the `sharedHelper` function in the CLI");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const range = `${fromSha}..HEAD`;
			const anchors = filterFeatureAnchors(await findChangelogAnchors(units, { repo: repo.dir, range }), units).map(
				(anchor) => ({ anchor, range }),
			);

			const run1 = await collectStories(units, { repo: repo.dir, anchors });
			const run2 = await collectStories(units, { repo: repo.dir, anchors });
			const id1 = run1.stories.find((s) => s.origin === "commit")?.id;
			const id2 = run2.stories.find((s) => s.origin === "commit")?.id;
			expect(id1).toBeDefined();
			expect(id1).toBe(id2);
		}),
	);

	test(
		"collectStories produces the same story id across two runs over the same history",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);
			repo.commit("feat(reels): add the widget factory", {
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
		}),
	);

	test(
		"the changelog story id stays stable as the Unreleased range grows with later, unrelated commits",
		withRepo(async (repo) => {
			const fromSha = seedChangelog(repo);
			repo.commit("feat(reels): add the widget factory", {
				path: "packages/reels/src/widgetFactory.ts",
				content: "export function widgetFactory() {\n\treturn 1;\n}\n",
			});
			addChangelogEntry(repo, "- add the `widgetFactory` helper");

			const unitsBefore = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const rangeBefore = `${fromSha}..HEAD`;
			const anchorsBefore = filterFeatureAnchors(
				await findChangelogAnchors(unitsBefore, { repo: repo.dir, range: rangeBefore }),
				unitsBefore,
			).map((anchor) => ({ anchor, range: rangeBefore }));
			const before = await collectStories(unitsBefore, { repo: repo.dir, anchors: anchorsBefore });
			const idBefore = before.stories.find((s) => s.origin === "commit")?.id;
			expect(idBefore).toBeDefined();

			// More, unrelated history lands afterward in the still-open Unreleased range.
			repo.commit("chore: unrelated later work", { path: "unrelated.txt" });

			const unitsAfter = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const rangeAfter = `${fromSha}..HEAD`;
			const anchorsAfter = filterFeatureAnchors(
				await findChangelogAnchors(unitsAfter, { repo: repo.dir, range: rangeAfter }),
				unitsAfter,
			).map((anchor) => ({ anchor, range: rangeAfter }));
			const after = await collectStories(unitsAfter, { repo: repo.dir, anchors: anchorsAfter });
			const idAfter = after.stories.find((s) => s.origin === "commit")?.id;

			expect(idAfter).toBe(idBefore);
		}),
	);
});
