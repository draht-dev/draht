import { describe, expect, test } from "bun:test";
import {
	buildReleaseGroups,
	DEFAULT_MIN_CHANGELOG_ENTRIES,
	DEFAULT_MIN_STORIES,
	isTinyRelease,
	listReleaseRanges,
	listReleaseTags,
} from "../src/releases.ts";
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

describe("listReleaseTags", () => {
	test(
		"returns only tags matching tagPattern, dereferencing annotated tags",
		withRepo((repo) => {
			const a = repo.commit("feat: a");
			repo.tag("v1.0.0", { ref: a });
			const b = repo.commit("feat: b");
			repo.tag("v2.0.0", { ref: b, annotated: true });
			const c = repo.commit("feat: c (pre-fork)");
			repo.tag("v0.9.0", { ref: c });

			return listReleaseTags(repo.dir, "^v[1-9]").then((tags) => {
				expect(tags.map((t) => t.name).sort()).toEqual(["v1.0.0", "v2.0.0"]);
				const v1 = tags.find((t) => t.name === "v1.0.0");
				const v2 = tags.find((t) => t.name === "v2.0.0");
				expect(v1?.sha).toBe(a);
				expect(v2?.sha).toBe(b);
			});
		}),
	);
});

describe("listReleaseRanges", () => {
	test(
		"one range per tag plus an unreleased range, newest first",
		withRepo(async (repo) => {
			const v1 = repo.commit("feat: first release work");
			repo.tag("v1.0.0", { ref: v1 });
			repo.commit("feat: second release work A");
			const v2 = repo.commit("feat: second release work B");
			repo.tag("v2.0.0", { ref: v2 });
			repo.commit("feat: unreleased work");

			const ranges = await listReleaseRanges({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(ranges.map((r) => r.tag)).toEqual([undefined, "v2.0.0", "v1.0.0"]);
			expect(ranges[1]?.previousTag).toBe("v1.0.0");
			expect(ranges[2]?.previousTag).toBeUndefined();
		}),
	);

	test(
		"ignores an off-mainline tag",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("abandoned");
			const abandoned = repo.commit("feat: abandoned work");
			repo.tag("v9.0.0", { ref: abandoned });
			repo.checkout(base);
			const v1 = repo.commit("feat: real release work");
			repo.tag("v1.0.0", { ref: v1 });

			const ranges = await listReleaseRanges({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(ranges.map((r) => r.tag)).not.toContain("v9.0.0");
			expect(ranges.some((r) => r.tag === "v1.0.0")).toBe(true);
		}),
	);

	test(
		"a tag name containing a comma is not mistaken for a shorter tag via %D decoration splitting",
		withRepo(async (repo) => {
			const v1 = repo.commit("feat: real release work");
			repo.tag("v2.0.0,junk", { ref: v1 });

			const ranges = await listReleaseRanges({ repo: repo.dir, ref: "HEAD", tagPattern: "^v2\\.0\\.0,junk$" });
			const tagged = ranges.filter((r) => r.tag !== undefined);
			expect(tagged.map((r) => r.tag)).toEqual(["v2.0.0,junk"]);
			expect(ranges.some((r) => r.tag === "v2.0.0")).toBe(false);
		}),
	);

	test(
		"tagPattern excludes v0.* releases",
		withRepo(async (repo) => {
			const v0 = repo.commit("feat: old upstream release");
			repo.tag("v0.99.0", { ref: v0 });
			const v1 = repo.commit("feat: first draht release");
			repo.tag("v1.0.0", { ref: v1 });

			const ranges = await listReleaseRanges({ repo: repo.dir, ref: "HEAD", tagPattern: "^v[1-9]" });
			const tagged = ranges.filter((r) => r.tag !== undefined);
			expect(tagged).toHaveLength(1);
			expect(tagged[0]?.tag).toBe("v1.0.0");
		}),
	);

	test(
		"the scan budget counts releases: scan 2 still finds the newest 2 tags plus unreleased, no more",
		withRepo(async (repo) => {
			const shas: string[] = [];
			for (let i = 1; i <= 5; i++) {
				const sha = repo.commit(`feat: release ${i} work`);
				repo.tag(`v${i}.0.0`, { ref: sha });
				shas.push(sha);
			}
			repo.commit("feat: unreleased work");

			const ranges = await listReleaseRanges({ repo: repo.dir, ref: "HEAD", tagPattern: "^v", scan: 2 });
			const tagged = ranges.filter((r) => r.tag !== undefined);
			expect(tagged.map((r) => r.tag)).toEqual(["v5.0.0", "v4.0.0"]);
		}),
	);

	test(
		"allHistory builds every release",
		withRepo(async (repo) => {
			for (let i = 1; i <= 5; i++) {
				const sha = repo.commit(`feat: release ${i} work`);
				repo.tag(`v${i}.0.0`, { ref: sha });
			}
			const ranges = await listReleaseRanges({ repo: repo.dir, ref: "HEAD", tagPattern: "^v", allHistory: true });
			const tagged = ranges.filter((r) => r.tag !== undefined);
			expect(tagged).toHaveLength(5);
		}),
	);

	test(
		"historyFloor excludes its own ancestors from every range",
		withRepo(async (repo) => {
			const floor = repo.commit("chore: floor commit");
			const v1 = repo.commit("feat: release one work");
			repo.tag("v1.0.0", { ref: v1 });

			const ranges = await listReleaseRanges({
				repo: repo.dir,
				ref: "HEAD",
				tagPattern: "^v",
				historyFloor: floor,
				allHistory: true,
			});
			const releaseV1 = ranges.find((r) => r.tag === "v1.0.0");
			expect(releaseV1?.revisions).toContain(`^${floor}`);
		}),
	);
});

describe("isTinyRelease", () => {
	test("exports sane default thresholds", () => {
		expect(DEFAULT_MIN_STORIES).toBeGreaterThan(0);
		expect(DEFAULT_MIN_CHANGELOG_ENTRIES).toBeGreaterThan(0);
	});

	test("tiny when both feature units and changelog entries are below the thresholds", () => {
		expect(isTinyRelease({ featureUnitIds: ["a"], anchors: [] })).toBe(true);
	});

	test("not tiny once enough feature units are present", () => {
		expect(isTinyRelease({ featureUnitIds: ["a", "b"], anchors: [] })).toBe(false);
	});

	test("not tiny once enough changelog entries are present, even with few feature units", () => {
		const anchors = Array.from({ length: 8 }, (_, i) => ({
			entryText: `entry ${i}`,
			section: "Added",
			packages: ["reels"],
			commitSha: "x",
			commitSubject: "feat: x",
			unitId: "x",
		}));
		expect(isTinyRelease({ featureUnitIds: ["a"], anchors })).toBe(false);
	});

	test("thresholds are overridable", () => {
		expect(isTinyRelease({ featureUnitIds: ["a"], anchors: [] }, { minStories: 1 })).toBe(false);
	});
});

describe("buildReleaseGroups", () => {
	test(
		"attaches changelog anchors to the release they were added in, not an adjacent one",
		withRepo(async (repo) => {
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n");
			repo.commit("chore: seed changelog", { path: "packages/reels/CHANGELOG.md", content: "" });

			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- feature for release one\n");
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"feat(reels): feature for release one",
			]);
			const v1 = repo.commit("feat: tag commit one");
			repo.tag("v1.0.0", { ref: v1 });

			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- feature for release two\n");
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"feat(reels): feature for release two",
			]);
			const v2 = repo.commit("feat: tag commit two");
			repo.tag("v2.0.0", { ref: v2 });

			const groups = await buildReleaseGroups({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const releaseV1 = groups.find((g) => g.tag === "v1.0.0");
			const releaseV2 = groups.find((g) => g.tag === "v2.0.0");

			expect(releaseV1?.anchors.map((a) => a.entryText)).toEqual(["feature for release one"]);
			expect(releaseV2?.anchors.map((a) => a.entryText)).toEqual(["feature for release two"]);
		}),
	);

	test(
		"promotes an anchor-owning direct commit from otherUnitIds into featureUnitIds",
		withRepo(async (repo) => {
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n");
			repo.commit("chore: seed changelog", { path: "packages/reels/CHANGELOG.md", content: "" });

			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- a direct feature\n");
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"feat(reels): a direct feature",
			]);
			const featureCommitSha = repo.sha("HEAD");
			const v1 = repo.commit("chore: tag commit");
			repo.tag("v1.0.0", { ref: v1 });

			const groups = await buildReleaseGroups({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const release = groups.find((g) => g.tag === "v1.0.0");
			expect(release?.featureUnitIds).toContain(featureCommitSha);
			expect(release?.otherUnitIds).not.toContain(featureCommitSha);
		}),
	);

	test(
		"a release with no feature anchors and one feature-branch merge is tiny",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const v1 = repo.commit("chore: tag commit");
			repo.tag("v1.0.0", { ref: v1 });

			const groups = await buildReleaseGroups({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const release = groups.find((g) => g.tag === "v1.0.0");
			expect(release?.featureUnitIds).toContain(mergeSha);
			expect(release?.tiny).toBe(true);
		}),
	);

	test(
		"a release with two feature-branch merges is not tiny",
		withRepo(async (repo) => {
			addFeatureBranchMerge(repo);
			addFeatureBranchMerge(repo);
			const v1 = repo.commit("chore: tag commit");
			repo.tag("v1.0.0", { ref: v1 });

			const groups = await buildReleaseGroups({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const release = groups.find((g) => g.tag === "v1.0.0");
			expect(release?.featureUnitIds.length).toBeGreaterThanOrEqual(2);
			expect(release?.tiny).toBe(false);
		}),
	);

	test(
		"the unreleased group is produced even when empty",
		withRepo(async (repo) => {
			const v1 = repo.commit("feat: tagged work");
			repo.tag("v1.0.0", { ref: v1 });

			const groups = await buildReleaseGroups({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const unreleased = groups.find((g) => g.tag === undefined);
			expect(unreleased).toBeDefined();
			expect(unreleased?.units).toEqual([]);
		}),
	);

	test(
		"units newer than the newest tag are unreleased",
		withRepo(async (repo) => {
			const v1 = repo.commit("feat: tagged work");
			repo.tag("v1.0.0", { ref: v1 });
			repo.commit("feat: later work A");
			repo.commit("feat: later work B");

			const groups = await buildReleaseGroups({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const unreleased = groups.find((g) => g.tag === undefined);
			expect(unreleased?.units.map((u) => u.subject)).toEqual(["feat: later work B", "feat: later work A"]);
		}),
	);
});
