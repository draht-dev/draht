import { describe, expect, test } from "bun:test";
import type { GitRunner } from "../src/collect.ts";
import { runGit } from "../src/collect.ts";
import {
	classifyMergeClass,
	DEFAULT_MAINLINE_SCAN,
	filterFeatureAnchors,
	findChangelogAnchors,
	isBackMergeSubject,
	isReleaseCutCommit,
	walkMainline,
} from "../src/mainline.ts";
import { DEFAULT_REELS_CONFIG, type ReelsConfig } from "../src/reels-config.ts";
import {
	addBackMerge,
	addFeatureBranchMerge,
	addOversizedMerge,
	addSyncMerge,
	cleanupGitRepo,
	FOREIGN_AUTHOR,
	type GitRepo,
	initGitRepo,
} from "./fixtures/git-repo.ts";

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

function configWith(overrides: Partial<ReelsConfig>): ReelsConfig {
	return { ...DEFAULT_REELS_CONFIG, ...overrides };
}

describe("isBackMergeSubject", () => {
	test("matches the documented back-merge subject patterns", () => {
		expect(isBackMergeSubject("Merge branch 'main' into feature")).toBe(true);
		expect(isBackMergeSubject("merge origin/main into feature")).toBe(true);
		expect(isBackMergeSubject("bring GitHub main into the v0.99.2 upstream sync")).toBe(true);
	});

	test("does not match an ordinary feature merge subject", () => {
		expect(isBackMergeSubject("Merge pull request #1 from draht-dev/dev")).toBe(false);
		expect(isBackMergeSubject("Merge feature")).toBe(false);
	});
});

describe("classifyMergeClass", () => {
	const base = {
		subject: "Merge feature",
		branchCommitCount: 5,
		markerTouched: false,
		foreignAuthorRatio: undefined,
		upstream: DEFAULT_REELS_CONFIG.upstream,
		maxBranchCommits: 150,
	};

	test("defaults to feature", () => {
		expect(classifyMergeClass(base)).toBe("feature");
	});

	test("subject pattern alone marks a sync", () => {
		expect(classifyMergeClass({ ...base, subject: "sync upstream through v9.9.9" })).toBe("upstream-sync");
	});

	test("marker path alone marks a sync", () => {
		expect(classifyMergeClass({ ...base, markerTouched: true })).toBe("upstream-sync");
	});

	test("foreign author ratio alone marks a sync", () => {
		expect(classifyMergeClass({ ...base, foreignAuthorRatio: 0.9 })).toBe("upstream-sync");
	});

	test("a foreign ratio at or below the threshold does not mark a sync", () => {
		expect(classifyMergeClass({ ...base, foreignAuthorRatio: 0.6 })).toBe("feature");
	});

	test("branch commits over the cap mark it oversized, unless it is also a sync", () => {
		expect(classifyMergeClass({ ...base, branchCommitCount: 151 })).toBe("oversized");
		expect(classifyMergeClass({ ...base, branchCommitCount: 151, markerTouched: true })).toBe("upstream-sync");
	});

	test("an override wins over every mechanical signal", () => {
		expect(classifyMergeClass({ ...base, branchCommitCount: 151, override: "feature" })).toBe("feature");
		expect(classifyMergeClass({ ...base, markerTouched: true, override: "feature" })).toBe("feature");
	});
});

describe("walkMainline: back-merge swap", () => {
	test(
		"follows M^2 and finds the tag and commit on the swapped line",
		withRepo((repo) => {
			const { mergeSha, mainlineTaggedSha, tagName } = addBackMerge(repo);
			repo.commit("fix: carry on after the back-merge", { path: "after.txt" });

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				const merge = units.find((u) => u.sha === mergeSha);
				expect(merge?.class).toBe("back-merge");

				const swapped = units.find((u) => u.sha === mainlineTaggedSha);
				expect(swapped).toBeDefined();
				expect(swapped?.side).toBe("main");

				const tagSha = repo.sha(tagName);
				expect(tagSha).toBe(mainlineTaggedSha);
			});
		}),
	);

	test(
		"the side (first-parent) chain is walked too, tagged side",
		withRepo((repo) => {
			const { mergeSha } = addBackMerge(repo, { sideBranchCommits: 2 });
			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				const merge = units.find((u) => u.sha === mergeSha);
				expect(merge).toBeDefined();
				const sideUnits = units.filter((u) => u.side === "side");
				expect(sideUnits.length).toBeGreaterThan(0);
			});
		}),
	);

	test(
		"an override of back-merge beats the tag/subject check even without matching tags",
		withRepo((repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("plain-branch");
			const p2 = repo.commit("feat: no tag here at all");
			repo.checkout(base);
			repo.commit("unrelated commit", { path: "p1.txt" });
			const mergeSha = repo.mergeNoFF("plain-branch", "Merge plain-branch");

			return walkMainline({
				repo: repo.dir,
				ref: "HEAD",
				tagPattern: "^v",
				config: configWith({ overrides: { [mergeSha]: "back-merge" } }),
			}).then((units) => {
				const merge = units.find((u) => u.sha === mergeSha);
				expect(merge?.class).toBe("back-merge");
				expect(units.find((u) => u.sha === p2)?.side).toBe("main");
			});
		}),
	);
});

describe("walkMainline: merge classification", () => {
	test(
		"a feature branch merge is classified feature",
		withRepo((repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				const merge = units.find((u) => u.sha === mergeSha);
				expect(merge?.class).toBe("feature");
				expect(merge?.branchShas?.length).toBe(3);
			});
		}),
	);

	test(
		"the upstream-sync marker path alone triggers sync classification",
		withRepo((repo) => {
			const mergeSha = addSyncMerge(repo, {
				subject: "Merge feature",
				foreignAuthorCount: 0,
				touchMarker: true,
			});
			return walkMainline({
				repo: repo.dir,
				ref: "HEAD",
				tagPattern: "^v",
				config: configWith({ upstream: { ...DEFAULT_REELS_CONFIG.upstream, markerPaths: [".upstream-sync"] } }),
			}).then((units) => {
				expect(units.find((u) => u.sha === mergeSha)?.class).toBe("upstream-sync");
			});
		}),
	);

	test(
		"the sync subject pattern alone triggers sync classification",
		withRepo((repo) => {
			const mergeSha = addSyncMerge(repo, {
				subject: "sync upstream through v9.9.9",
				foreignAuthorCount: 0,
				touchMarker: false,
			});
			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				expect(units.find((u) => u.sha === mergeSha)?.class).toBe("upstream-sync");
			});
		}),
	);

	test(
		"a dominant foreign-author ratio alone triggers sync classification",
		withRepo((repo) => {
			const mergeSha = addSyncMerge(repo, {
				subject: "Merge feature",
				foreignAuthorCount: 25,
				touchMarker: false,
			});
			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				expect(units.find((u) => u.sha === mergeSha)?.class).toBe("upstream-sync");
			});
		}),
	);

	test(
		"a branch under the 20-commit sample floor never triggers the foreign-author signal",
		withRepo((repo) => {
			const mergeSha = addSyncMerge(repo, {
				subject: "Merge feature",
				foreignAuthorCount: 5,
				touchMarker: false,
			});
			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				expect(units.find((u) => u.sha === mergeSha)?.class).toBe("feature");
			});
		}),
	);

	test(
		"oversized at 151 branch commits",
		withRepo((repo) => {
			const mergeSha = addOversizedMerge(repo, { branchCommitCount: 151 });
			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				expect(units.find((u) => u.sha === mergeSha)?.class).toBe("oversized");
			});
		}),
	);

	test(
		"150 branch commits is still just a feature",
		withRepo((repo) => {
			const mergeSha = addOversizedMerge(repo, { branchCommitCount: 150 });
			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				expect(units.find((u) => u.sha === mergeSha)?.class).toBe("feature");
			});
		}),
	);

	test(
		"a per-sha override beats every detection signal",
		withRepo((repo) => {
			const mergeSha = addOversizedMerge(repo, { branchCommitCount: 151 });
			return walkMainline({
				repo: repo.dir,
				ref: "HEAD",
				tagPattern: "^v",
				config: configWith({ overrides: { [mergeSha]: "feature" } }),
			}).then((units) => {
				expect(units.find((u) => u.sha === mergeSha)?.class).toBe("feature");
			});
		}),
	);
});

describe("walkMainline: historyFloor", () => {
	test(
		"stops the walk at the floor commit, inclusive",
		withRepo((repo) => {
			const floorSha = repo.commit("floor commit");
			repo.commit("after floor, commit A");
			repo.commit("after floor, commit B");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v", historyFloor: floorSha }).then(
				(units) => {
					expect(units.map((u) => u.sha)).toContain(floorSha);
					expect(units.some((u) => u.subject === "init")).toBe(false);
				},
			);
		}),
	);
});

describe("walkMainline: security", () => {
	test(
		"a malicious commit subject never reaches argv as a git revision",
		withRepo(async (repo) => {
			repo.commit("--output=pwned.html");

			const seenArgs: string[][] = [];
			const spyGit: GitRunner = async (args, cwd) => {
				seenArgs.push(args);
				return runGit(args, cwd);
			};

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v", git: spyGit });
			expect(units[0]?.subject).toBe("--output=pwned.html");
			for (const args of seenArgs) {
				expect(args).not.toContain("--output=pwned.html");
			}
		}),
	);
});

describe("walkMainline: defaults", () => {
	test("exports a sane default scan window", () => {
		expect(DEFAULT_MAINLINE_SCAN).toBeGreaterThan(0);
	});
});

describe("findChangelogAnchors", () => {
	test(
		"maps an added changelog entry to the commit that added it",
		withRepo((repo) => {
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- initial\n");
			repo.commit("chore: seed changelog", { path: "packages/reels/CHANGELOG.md", content: "" });
			const fromSha = repo.sha("HEAD");

			repo.writeFile(
				"packages/reels/CHANGELOG.md",
				"## [Unreleased]\n\n### Added\n\n- initial\n- add the mainline walker\n",
			);
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"feat(reels): add the mainline walker",
			]);
			const entrySha = repo.sha("HEAD");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` }).then((anchors) => {
					const anchor = anchors.find((a) => a.entryText === "add the mainline walker");
					expect(anchor).toBeDefined();
					expect(anchor?.section).toBe("Added");
					expect(anchor?.commitSha).toBe(entrySha);
					expect(anchor?.unitId).toBe(entrySha);
					expect(anchor?.packages).toEqual(["reels"]);
				}),
			);
		}),
	);

	test(
		"dedups the same entry added to two package changelogs by the same commit",
		withRepo((repo) => {
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n");
			repo.writeFile("packages/ai/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n");
			repo.git(["add", "packages/reels/CHANGELOG.md", "packages/ai/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"chore: seed changelogs",
			]);
			const fromSha = repo.sha("HEAD");

			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- shared entry\n");
			repo.writeFile("packages/ai/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- shared entry\n");
			repo.git(["add", "packages/reels/CHANGELOG.md", "packages/ai/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"feat: shared entry in two packages",
			]);
			const entrySha = repo.sha("HEAD");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` }).then((anchors) => {
					const matching = anchors.filter((a) => a.entryText === "shared entry");
					expect(matching).toHaveLength(1);
					expect(matching[0]?.packages.sort()).toEqual(["ai", "reels"]);
					expect(matching[0]?.commitSha).toBe(entrySha);
				}),
			);
		}),
	);

	test(
		"maps an entry added inside a merged feature branch to the merge unit, not the branch commit",
		withRepo((repo) => {
			const fromSha = repo.sha("HEAD");
			const base = repo.currentBranch();
			repo.checkoutNewBranch("changelog-feature");
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- feature from a branch\n");
			const branchCommitSha = repo.commit("feat: branch-only changelog entry", {
				path: "packages/reels/CHANGELOG.md",
				content: "",
			});
			repo.checkout(base);
			const mergeSha = repo.mergeNoFF("changelog-feature", "Merge changelog-feature");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` }).then((anchors) => {
					const anchor = anchors.find((a) => a.entryText === "feature from a branch");
					expect(anchor).toBeDefined();
					expect(anchor?.commitSha).toBe(branchCommitSha);
					expect(anchor?.unitId).toBe(mergeSha);
				}),
			);
		}),
	);
});

describe("isReleaseCutCommit", () => {
	test("matches the release-bot subject convention", () => {
		expect(isReleaseCutCommit("release: v2026.10.4-1")).toBe(true);
		expect(isReleaseCutCommit("release: v1.0.0")).toBe(true);
	});

	test("does not match an ordinary commit, even one that mentions release", () => {
		expect(isReleaseCutCommit("feat: prepare for the next release")).toBe(false);
		expect(isReleaseCutCommit("chore: bump release script dependency")).toBe(false);
	});
});

describe("filterFeatureAnchors", () => {
	test(
		"drops the release-cut commit's reworded restatement, keeping the original feature entry",
		withRepo((repo) => {
			const fromSha = repo.sha("HEAD");
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n");
			repo.commit("chore: seed changelog", { path: "packages/reels/CHANGELOG.md", content: "" });

			repo.writeFile(
				"packages/reels/CHANGELOG.md",
				"## [Unreleased]\n\n### Added\n\n- a much longer, hand-written description of the new feature\n",
			);
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"feat(reels): add the new feature",
			]);
			const featureCommitSha = repo.sha("HEAD");

			repo.writeFile(
				"packages/reels/CHANGELOG.md",
				"## [1.0.0] - 2024-01-01\n\n### Added\n\n- add the new feature\n",
			);
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=draht-release[bot]",
				"-c",
				"user.email=release@draht.dev",
				"commit",
				"-m",
				"release: v1.0.0",
			]);

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) =>
				findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` }).then((anchors) => {
					expect(anchors).toHaveLength(2);
					const filtered = filterFeatureAnchors(anchors, units);
					expect(filtered).toHaveLength(1);
					expect(filtered[0]?.commitSha).toBe(featureCommitSha);
					expect(filtered[0]?.entryText).toBe("a much longer, hand-written description of the new feature");
				}),
			);
		}),
	);

	test(
		"drops anchors owned by an upstream-sync unit or its side chain",
		withRepo((repo) => {
			const fromSha = repo.sha("HEAD");
			const base = repo.currentBranch();
			repo.checkoutNewBranch("sync-branch");
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- carried in by the sync\n");
			repo.commit("sync upstream commit", { path: "packages/reels/CHANGELOG.md", content: "" });
			repo.checkout(base);
			const syncMergeSha = repo.mergeNoFF("sync-branch", "sync upstream through v9.9.9");

			repo.writeFile(
				"packages/reels/CHANGELOG.md",
				"## [Unreleased]\n\n### Added\n\n- carried in by the sync\n- a real feature after the sync\n",
			);
			repo.commit("feat: a real feature after the sync", { path: "packages/reels/CHANGELOG.md", content: "" });
			const featureCommitSha = repo.sha("HEAD");

			return walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" }).then((units) => {
				expect(units.find((u) => u.sha === syncMergeSha)?.class).toBe("upstream-sync");
				return findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` }).then((anchors) => {
					expect(anchors.some((a) => a.unitId === syncMergeSha)).toBe(true);
					const filtered = filterFeatureAnchors(anchors, units);
					expect(filtered.some((a) => a.commitSha === featureCommitSha)).toBe(true);
					expect(filtered.some((a) => a.unitId === syncMergeSha)).toBe(false);
				});
			});
		}),
	);
});

describe("fixture sanity", () => {
	test(
		"the foreign author in the sync fixture is really foreign",
		withRepo((repo) => {
			addSyncMerge(repo, { foreignAuthorCount: 1, touchMarker: false, subject: "Merge feature" });
			expect(FOREIGN_AUTHOR.email).not.toBe("test@example.com");
		}),
	);
});
