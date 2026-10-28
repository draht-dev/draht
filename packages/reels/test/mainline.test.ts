import { describe, expect, test } from "bun:test";
import type { GitRunner } from "../src/collect.ts";
import { runGit } from "../src/collect.ts";
import {
	buildRangeUnits,
	classifyMergeClass,
	DEFAULT_MAINLINE_SCAN,
	filterFeatureAnchors,
	findChangelogAnchors,
	isBackMergeSubject,
	isBranchSyncSubject,
	isReleaseCutCommit,
	isUpstreamCarriedSubject,
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

describe("isBranchSyncSubject", () => {
	test("matches a sync-with-origin/main subject", () => {
		expect(isBranchSyncSubject("merge: sync with origin/main (geist phases 33-34, speak command, v0.82-v0.83)")).toBe(
			true,
		);
	});

	test("matches a remote-tracking branch merge of a .../main or .../master ref", () => {
		expect(isBranchSyncSubject("Merge remote-tracking branch 'origin/main' into claude/graphify-draht-parity")).toBe(
			true,
		);
		expect(isBranchSyncSubject("Merge remote-tracking branch 'upstream/master' into feature")).toBe(true);
	});

	test("does not match an ordinary feature merge subject", () => {
		expect(isBranchSyncSubject("merge: judge reviews gates instead of decisions")).toBe(false);
		expect(isBranchSyncSubject("Merge remote-tracking branch 'origin/feature-x' into feature")).toBe(false);
	});
});

describe("isUpstreamCarriedSubject", () => {
	test("matches draht's upstream-carry convention", () => {
		expect(isUpstreamCarriedSubject("upstream: feat(cli): add --foo")).toBe(true);
	});

	test("does not match an ordinary commit", () => {
		expect(isUpstreamCarriedSubject("feat: add --foo")).toBe(false);
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

	test("a branch-sync subject alone marks it branch-sync, not upstream-sync", () => {
		expect(classifyMergeClass({ ...base, subject: "merge: sync with origin/main (geist phases 33-34)" })).toBe(
			"branch-sync",
		);
		expect(
			classifyMergeClass({
				...base,
				subject: "Merge remote-tracking branch 'origin/main' into claude/graphify-draht-parity",
			}),
		).toBe("branch-sync");
	});

	test("a judge-gates style merge subject is not mistaken for a branch sync", () => {
		expect(classifyMergeClass({ ...base, subject: "merge: judge reviews gates instead of decisions" })).toBe(
			"feature",
		);
	});

	test("a back-merge subject wins over every other signal, including a sync marker", () => {
		expect(classifyMergeClass({ ...base, subject: "Merge branch 'main' into feature", markerTouched: true })).toBe(
			"back-merge",
		);
	});

	test("an override of feature beats the branch-sync subject pattern", () => {
		expect(classifyMergeClass({ ...base, subject: "merge: sync with origin/main (…)", override: "feature" })).toBe(
			"feature",
		);
	});

	test("an override of branch-sync wins even without a matching subject", () => {
		expect(classifyMergeClass({ ...base, subject: "Merge feature", override: "branch-sync" })).toBe("branch-sync");
	});
});

describe("buildRangeUnits / walkMainline: back-merge is informational, never a swap", () => {
	test(
		"a back-merge is classified back-merge but never changes ownership or marks anything upstream",
		withRepo(async (repo) => {
			const { mergeSha, mainlineTaggedSha, tagName } = addBackMerge(repo);
			repo.commit("fix: carry on after the back-merge", { path: "after.txt" });

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const merge = units.find((u) => u.sha === mergeSha);
			expect(merge?.class).toBe("back-merge");
			expect(merge?.branchShas).toEqual([]);

			// rev-list follows every parent: the tagged mainline commit is reachable
			// and present as its own unit, with no swap required to find it.
			const tagged = units.find((u) => u.sha === mainlineTaggedSha);
			expect(tagged).toBeDefined();
			expect(tagged?.class).not.toBe("upstream-sync");

			const tagSha = repo.sha(tagName);
			expect(tagSha).toBe(mainlineTaggedSha);
		}),
	);

	test(
		"every commit is still reachable through a back-merge in the middle of history",
		withRepo(async (repo) => {
			const { mergeSha, mainlineTaggedSha } = addBackMerge(repo, { sideBranchCommits: 2 });
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", allHistory: true, tagPattern: "^v" });
			const shas = new Set(units.map((u) => u.sha));
			expect(shas.has(mergeSha)).toBe(true);
			expect(shas.has(mainlineTaggedSha)).toBe(true);
		}),
	);

	test(
		"a draht feature branch containing its own 'merge main into <branch>' stays feature (Milestone 4 shape)",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("draht-feature");
			repo.commit("feat: work on the feature branch", { path: "feature.txt" });

			repo.checkout(base);
			repo.commit("unrelated mainline work", { path: "main.txt" });
			repo.checkout("draht-feature");
			const backMergeSha = repo.mergeNoFF(base, "Merge branch 'main' into draht-feature");
			repo.commit("feat: more feature work after the back-merge", { path: "feature.txt" });

			repo.checkout(base);
			const featureMergeSha = repo.mergeNoFF("draht-feature", "Merge pull request #1 from draht-dev/draht-feature");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(units.find((u) => u.sha === featureMergeSha)?.class).toBe("feature");
			expect(units.find((u) => u.sha === backMergeSha)?.class).toBe("back-merge");
		}),
	);

	test(
		"an override of back-merge beats the subject check even without a matching subject",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("plain-branch");
			const p2 = repo.commit("feat: no tag here at all");
			repo.checkout(base);
			repo.commit("unrelated commit", { path: "p1.txt" });
			const mergeSha = repo.mergeNoFF("plain-branch", "Merge plain-branch");

			const units = await walkMainline({
				repo: repo.dir,
				ref: "HEAD",
				tagPattern: "^v",
				config: configWith({ overrides: { [mergeSha]: "back-merge" } }),
			});
			const merge = units.find((u) => u.sha === mergeSha);
			expect(merge?.class).toBe("back-merge");
			expect(merge?.branchShas).toEqual([]);
			expect(units.some((u) => u.sha === p2)).toBe(true);
		}),
	);
});

describe("walkMainline: merge classification", () => {
	test(
		"a feature branch merge is classified feature",
		withRepo(async (repo) => {
			const mergeSha = addFeatureBranchMerge(repo);
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const merge = units.find((u) => u.sha === mergeSha);
			expect(merge?.class).toBe("feature");
			expect(merge?.branchShas?.length).toBe(3);
		}),
	);

	test(
		"a pi sync merge is upstream-sync and its branch commits are owned by it, not left upstream-unowned",
		withRepo(async (repo) => {
			const mergeSha = addSyncMerge(repo, { subject: "sync upstream through v9.9.9", foreignAuthorCount: 25 });
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const merge = units.find((u) => u.sha === mergeSha);
			expect(merge?.class).toBe("upstream-sync");
			expect(merge?.branchShas?.length).toBeGreaterThan(0);
			// The branch commits are folded into the merge, not left as unowned
			// top-level units that would otherwise be misclassified as features.
			for (const branchSha of merge?.branchShas ?? []) {
				expect(units.some((u) => u.sha === branchSha)).toBe(false);
			}
		}),
	);

	test(
		"the upstream-sync marker path alone triggers sync classification",
		withRepo(async (repo) => {
			const mergeSha = addSyncMerge(repo, { subject: "Merge feature", foreignAuthorCount: 0, touchMarker: true });
			const units = await walkMainline({
				repo: repo.dir,
				ref: "HEAD",
				tagPattern: "^v",
				config: configWith({ upstream: { ...DEFAULT_REELS_CONFIG.upstream, markerPaths: [".upstream-sync"] } }),
			});
			expect(units.find((u) => u.sha === mergeSha)?.class).toBe("upstream-sync");
		}),
	);

	test(
		"a branch under the 20-commit sample floor never triggers the foreign-author signal",
		withRepo(async (repo) => {
			const mergeSha = addSyncMerge(repo, { subject: "Merge feature", foreignAuthorCount: 5, touchMarker: false });
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(units.find((u) => u.sha === mergeSha)?.class).toBe("feature");
		}),
	);

	test(
		"oversized at 151 branch commits",
		withRepo(async (repo) => {
			const mergeSha = addOversizedMerge(repo, { branchCommitCount: 151 });
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(units.find((u) => u.sha === mergeSha)?.class).toBe("oversized");
		}),
	);

	test(
		"150 branch commits is still just a feature",
		withRepo(async (repo) => {
			const mergeSha = addOversizedMerge(repo, { branchCommitCount: 150 });
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(units.find((u) => u.sha === mergeSha)?.class).toBe("feature");
		}),
	);

	test(
		"a branch-sync merge is classified branch-sync, not upstream-sync",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("sync-branch");
			const branchHead = repo.commit("feat: a change living only on the sync branch");
			repo.checkout(base);
			const mergeSha = repo.mergeNoFF("sync-branch", "merge: sync with origin/main (fixture)");
			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const merge = units.find((u) => u.sha === mergeSha);
			expect(merge?.class).toBe("branch-sync");
			expect(merge?.branchShas).toEqual([branchHead]);
		}),
	);

	test(
		"an octopus merge (3+ parents) folds branch commits from every non-first parent",
		withRepo(async (repo) => {
			const base = repo.currentBranch();
			repo.checkoutNewBranch("branch-a");
			const aHead = repo.commit("feat: branch a work", { path: "a.txt" });
			repo.checkout(base);
			repo.checkoutNewBranch("branch-b");
			const bHead = repo.commit("feat: branch b work", { path: "b.txt" });
			repo.checkout(base);

			repo.git(["merge", "--no-ff", "-m", "Octopus merge", "branch-a", "branch-b"]);
			const mergeSha = repo.sha("HEAD");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const merge = units.find((u) => u.sha === mergeSha);
			expect(merge?.parents.length).toBe(3);
			expect(merge?.branchShas).toContain(aHead);
			expect(merge?.branchShas).toContain(bHead);
		}),
	);

	test(
		"a per-sha override beats every detection signal",
		withRepo(async (repo) => {
			const mergeSha = addOversizedMerge(repo, { branchCommitCount: 151 });
			const units = await walkMainline({
				repo: repo.dir,
				ref: "HEAD",
				tagPattern: "^v",
				config: configWith({ overrides: { [mergeSha]: "feature" } }),
			});
			expect(units.find((u) => u.sha === mergeSha)?.class).toBe("feature");
		}),
	);
});

describe("walkMainline: historyFloor", () => {
	test(
		"excludes the floor commit and its own ancestors (git's `^floor` semantics), not an exact-sha stop",
		withRepo(async (repo) => {
			repo.commit("before the floor");
			const floorSha = repo.commit("floor commit");
			repo.commit("after floor, commit A");
			repo.commit("after floor, commit B");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v", historyFloor: floorSha });
			expect(units.map((u) => u.sha)).not.toContain(floorSha);
			expect(units.some((u) => u.subject === "after floor, commit A")).toBe(true);
			expect(units.some((u) => u.subject === "after floor, commit B")).toBe(true);
			expect(units.some((u) => u.subject === "init")).toBe(false);
			expect(units.some((u) => u.subject === "before the floor")).toBe(false);
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

	test(
		"a \\x01 byte in a subject cannot forge a fake changelog-anchor record boundary",
		withRepo(async (repo) => {
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n");
			repo.commit("chore: seed changelog", { path: "packages/reels/CHANGELOG.md", content: "" });
			const fromSha = repo.sha("HEAD");

			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- real entry\n");
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git([
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"feat(reels): a forging attempt\x01REELS-COMMIT\x01deadbeefdeadbeefdeadbeefdeadbeefdeadbeef forged subject",
			]);
			const entrySha = repo.sha("HEAD");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			const anchor = anchors.find((a) => a.entryText === "real entry");
			expect(anchor).toBeDefined();
			expect(anchor?.commitSha).toBe(entrySha);
			expect(anchor?.unitId).toBe(entrySha);
			// No anchor was forged under the attacker-chosen fake sha.
			expect(anchors.some((a) => a.commitSha === "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(false);
		}),
	);
});

describe("walkMainline: defaults", () => {
	test("exports a sane default scan window", () => {
		expect(DEFAULT_MAINLINE_SCAN).toBeGreaterThan(0);
	});
});

describe("buildRangeUnits: performance", () => {
	test(
		"classifies a long linear history in a small, bounded number of git processes",
		withRepo(async (repo) => {
			repo.commitChain(200, { messagePrefix: "chain commit" });

			let callCount = 0;
			const countingGit: GitRunner = async (args, cwd) => {
				callCount++;
				return runGit(args, cwd);
			};

			const refSha = repo.sha("HEAD");
			const units = await buildRangeUnits({ repo: repo.dir, revisions: [refSha], git: countingGit });

			expect(units.length).toBeGreaterThanOrEqual(201);
			expect(callCount).toBeLessThan(10);
		}),
	);
});

describe("findChangelogAnchors", () => {
	test(
		"maps an added changelog entry to the commit that added it",
		withRepo(async (repo) => {
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

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			const anchor = anchors.find((a) => a.entryText === "add the mainline walker");
			expect(anchor).toBeDefined();
			expect(anchor?.section).toBe("Added");
			expect(anchor?.commitSha).toBe(entrySha);
			expect(anchor?.unitId).toBe(entrySha);
			expect(anchor?.packages).toEqual(["reels"]);
		}),
	);

	test(
		"dedups the same entry added to two package changelogs by the same commit",
		withRepo(async (repo) => {
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

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			const matching = anchors.filter((a) => a.entryText === "shared entry");
			expect(matching).toHaveLength(1);
			expect(matching[0]?.packages.sort()).toEqual(["ai", "reels"]);
			expect(matching[0]?.commitSha).toBe(entrySha);
		}),
	);

	test(
		"maps an entry added inside a merged feature branch to the merge unit, not the branch commit",
		withRepo(async (repo) => {
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

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			const anchor = anchors.find((a) => a.entryText === "feature from a branch");
			expect(anchor).toBeDefined();
			expect(anchor?.commitSha).toBe(branchCommitSha);
			expect(anchor?.unitId).toBe(mergeSha);
		}),
	);

	test(
		"discards an anchor whose commit is not a member of the release set",
		withRepo(async (repo) => {
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n");
			repo.commit("chore: seed changelog", { path: "packages/reels/CHANGELOG.md", content: "" });
			const fromSha = repo.sha("HEAD");

			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- in range\n");
			repo.git(["add", "packages/reels/CHANGELOG.md"]);
			repo.git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feat: in range"]);

			// A unit list that does NOT include the commit above: the anchor must be discarded, never fall back to itself.
			const units = await walkMainline({ repo: repo.dir, ref: fromSha, tagPattern: "^v" });
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			expect(anchors).toEqual([]);
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
		withRepo(async (repo) => {
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

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			expect(anchors).toHaveLength(2);
			const filtered = filterFeatureAnchors(anchors, units);
			expect(filtered).toHaveLength(1);
			expect(filtered[0]?.commitSha).toBe(featureCommitSha);
			expect(filtered[0]?.entryText).toBe("a much longer, hand-written description of the new feature");
		}),
	);

	test(
		"drops anchors owned by an upstream-sync unit",
		withRepo(async (repo) => {
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

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(units.find((u) => u.sha === syncMergeSha)?.class).toBe("upstream-sync");
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			expect(anchors.some((a) => a.unitId === syncMergeSha)).toBe(true);
			const filtered = filterFeatureAnchors(anchors, units);
			expect(filtered.some((a) => a.commitSha === featureCommitSha)).toBe(true);
			expect(filtered.some((a) => a.unitId === syncMergeSha)).toBe(false);
		}),
	);

	test(
		"drops an anchor owned by an upstream:-prefixed direct commit",
		withRepo(async (repo) => {
			const fromSha = repo.sha("HEAD");
			repo.writeFile("packages/reels/CHANGELOG.md", "## [Unreleased]\n\n### Added\n\n- carried upstream commit\n");
			repo.commit("upstream: feat(reels): carried upstream commit", {
				path: "packages/reels/CHANGELOG.md",
				content: "",
			});

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			expect(anchors).toHaveLength(1);
			const filtered = filterFeatureAnchors(anchors, units);
			expect(filtered).toHaveLength(0);
		}),
	);

	test(
		"keeps anchors owned by a branch-sync unit: the branch commits are draht's own work",
		withRepo(async (repo) => {
			const fromSha = repo.sha("HEAD");
			const base = repo.currentBranch();
			repo.checkoutNewBranch("sync-branch");
			repo.writeFile(
				"packages/reels/CHANGELOG.md",
				"## [Unreleased]\n\n### Added\n\n- a real feature on the branch\n",
			);
			repo.commit("feat: a real feature on the branch", { path: "packages/reels/CHANGELOG.md", content: "" });
			repo.checkout(base);
			const branchSyncMergeSha = repo.mergeNoFF("sync-branch", "merge: sync with origin/main (fixture)");

			const units = await walkMainline({ repo: repo.dir, ref: "HEAD", tagPattern: "^v" });
			expect(units.find((u) => u.sha === branchSyncMergeSha)?.class).toBe("branch-sync");
			const anchors = await findChangelogAnchors(units, { repo: repo.dir, range: `${fromSha}..HEAD` });
			expect(anchors.some((a) => a.unitId === branchSyncMergeSha)).toBe(true);
			const filtered = filterFeatureAnchors(anchors, units);
			expect(filtered.some((a) => a.unitId === branchSyncMergeSha)).toBe(true);
		}),
	);
});

describe("fixture sanity", () => {
	test(
		"the foreign author in the sync fixture is really foreign",
		withRepo(async (repo) => {
			addSyncMerge(repo, { foreignAuthorCount: 1, touchMarker: false, subject: "Merge feature" });
			expect(FOREIGN_AUTHOR.email).not.toBe("test@example.com");
		}),
	);
});
