import { describe, expect, test } from "bun:test";
import { walkMainline } from "../src/mainline.ts";
import {
	attachChangelogAnchors,
	buildReleaseGroups,
	DEFAULT_MIN_CHANGELOG_ENTRIES,
	DEFAULT_MIN_STORIES,
	isTinyRelease,
	listReleaseTags,
	mapUnitsToReleases,
} from "../src/releases.ts";
import { addBackMerge, addFeatureBranchMerge, cleanupGitRepo, type GitRepo, initGitRepo } from "./fixtures/git-repo.ts";

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

describe("mapUnitsToReleases", () => {
	test(
		"partitions units topologically across two tags, oldest first within each group",
		withRepo((repo) => {
			const v1 = repo.commit("feat: first release work");
			repo.tag("v1.0.0", { ref: v1 });
			repo.commit("feat: second release work A");
			const v2 = repo.commit("feat: second release work B");
			repo.tag("v2.0.0", { ref: v2 });
			repo.commit("feat: unreleased work");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				listReleaseTags(repo.dir, "^v").then((tags) => {
					const groups = mapUnitsToReleases(units, tags);

					expect(groups).toHaveLength(3);
					const [unreleased, releaseV2, releaseV1] = groups;

					expect(unreleased?.tag).toBeUndefined();
					expect(unreleased?.units.map((u) => u.subject)).toEqual(["feat: unreleased work"]);

					expect(releaseV2?.tag).toBe("v2.0.0");
					expect(releaseV2?.previousTag).toBe("v1.0.0");
					expect(releaseV2?.units.map((u) => u.subject)).toEqual([
						"feat: second release work B",
						"feat: second release work A",
					]);

					expect(releaseV1?.tag).toBe("v1.0.0");
					expect(releaseV1?.previousTag).toBeUndefined();
					expect(releaseV1?.units.map((u) => u.subject)).toContain("feat: first release work");
				}),
			);
		}),
	);

	test(
		"ignores an off-mainline tag",
		withRepo((repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("abandoned");
			const abandoned = repo.commit("feat: abandoned work");
			repo.tag("v9.0.0", { ref: abandoned });
			repo.checkout(base);
			const v1 = repo.commit("feat: real release work");
			repo.tag("v1.0.0", { ref: v1 });

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				listReleaseTags(repo.dir, "^v").then((tags) => {
					const groups = mapUnitsToReleases(units, tags);
					expect(groups.map((g) => g.tag)).not.toContain("v9.0.0");
					expect(groups.some((g) => g.tag === "v1.0.0")).toBe(true);
				}),
			);
		}),
	);

	test(
		"tagPattern excludes v0.* releases",
		withRepo((repo) => {
			const v0 = repo.commit("feat: old upstream release");
			repo.tag("v0.99.0", { ref: v0 });
			const v1 = repo.commit("feat: first draht release");
			repo.tag("v1.0.0", { ref: v1 });

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				listReleaseTags(repo.dir, "^v[1-9]").then((tags) => {
					const groups = mapUnitsToReleases(units, tags);
					expect(groups).toHaveLength(1);
					expect(groups[0]?.tag).toBe("v1.0.0");
					expect(groups[0]?.units.map((u) => u.subject)).toContain("feat: old upstream release");
				}),
			);
		}),
	);

	test(
		"a tag on a back-merge's M^2 side maps correctly",
		withRepo((repo) => {
			const { mainlineTaggedSha, tagName } = addBackMerge(repo, { tagName: "v1.0.0" });
			repo.commit("fix: carry on after the back-merge");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				listReleaseTags(repo.dir, "^v").then((tags) => {
					const groups = mapUnitsToReleases(units, tags);
					const release = groups.find((g) => g.tag === tagName);
					expect(release).toBeDefined();
					const allIds = [
						...(release?.featureUnitIds ?? []),
						...(release?.syncUnitIds ?? []),
						...(release?.otherUnitIds ?? []),
					];
					expect(allIds).toContain(mainlineTaggedSha);
				}),
			);
		}),
	);

	test(
		"units newer than the newest tag are unreleased",
		withRepo((repo) => {
			const v1 = repo.commit("feat: tagged work");
			repo.tag("v1.0.0", { ref: v1 });
			repo.commit("feat: later work A");
			repo.commit("feat: later work B");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				listReleaseTags(repo.dir, "^v").then((tags) => {
					const groups = mapUnitsToReleases(units, tags);
					const unreleased = groups.find((g) => g.tag === undefined);
					expect(unreleased?.units.map((u) => u.subject)).toEqual(["feat: later work B", "feat: later work A"]);
				}),
			);
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

describe("attachChangelogAnchors / buildReleaseGroups", () => {
	test(
		"attaches changelog anchors to the release they were added in, not an adjacent one",
		withRepo((repo) => {
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

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				buildReleaseGroups({ repo: repo.dir, units, tagPattern: "^v" }).then((groups) => {
					const releaseV1 = groups.find((g) => g.tag === "v1.0.0");
					const releaseV2 = groups.find((g) => g.tag === "v2.0.0");

					expect(releaseV1?.anchors.map((a) => a.entryText)).toEqual(["feature for release one"]);
					expect(releaseV2?.anchors.map((a) => a.entryText)).toEqual(["feature for release two"]);
				}),
			);
		}),
	);

	test(
		"promotes an anchor-owning direct commit from otherUnitIds into featureUnitIds",
		withRepo((repo) => {
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

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				buildReleaseGroups({ repo: repo.dir, units, tagPattern: "^v" }).then((groups) => {
					const release = groups.find((g) => g.tag === "v1.0.0");
					expect(release?.featureUnitIds).toContain(featureCommitSha);
					expect(release?.otherUnitIds).not.toContain(featureCommitSha);
				}),
			);
		}),
	);

	test(
		"a release with no feature anchors and one feature-branch merge is tiny",
		withRepo((repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const v1 = repo.commit("chore: tag commit");
			repo.tag("v1.0.0", { ref: v1 });

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				buildReleaseGroups({ repo: repo.dir, units, tagPattern: "^v" }).then((groups) => {
					const release = groups.find((g) => g.tag === "v1.0.0");
					expect(release?.featureUnitIds).toContain(mergeSha);
					expect(release?.tiny).toBe(true);
				}),
			);
		}),
	);

	test(
		"a release with two feature-branch merges is not tiny",
		withRepo((repo) => {
			addFeatureBranchMerge(repo);
			addFeatureBranchMerge(repo);
			const v1 = repo.commit("chore: tag commit");
			repo.tag("v1.0.0", { ref: v1 });

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				buildReleaseGroups({ repo: repo.dir, units, tagPattern: "^v" }).then((groups) => {
					const release = groups.find((g) => g.tag === "v1.0.0");
					expect(release?.featureUnitIds.length).toBeGreaterThanOrEqual(2);
					expect(release?.tiny).toBe(false);
				}),
			);
		}),
	);

	test(
		"the unreleased group has no anchors call failure and is left as-is when empty",
		withRepo(async (repo) => {
			const v1 = repo.commit("feat: tagged work");
			repo.tag("v1.0.0", { ref: v1 });

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const tags = await listReleaseTags(repo.dir, "^v");
			const groups = mapUnitsToReleases(units, tags);
			const attached = await attachChangelogAnchors(groups, { repo: repo.dir, units });
			expect(attached.find((g) => g.tag === undefined)).toBeUndefined();
		}),
	);
});
