import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "../src/collect.ts";
import {
	assertValidSha,
	collectChangeSets,
	collectChangeSetsForShas,
	foldMergeChangeSets,
	parseUnifiedDiff,
	runGit,
	selectBuildShas,
} from "../src/collect.ts";
import type { ReelsState } from "../src/state.ts";
import { cappedIds, MAX_RENDER_ATTEMPTS, recordFailure, recordSuccess } from "../src/state.ts";

const NUL = "\x00";

describe("parseUnifiedDiff", () => {
	test("parses a single modified file with one hunk verbatim", () => {
		const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line one
+line two
 line three
-line four
`;
		const numstat = `1\t1\tsrc/foo.ts${NUL}`;
		const nameStatus = `M${NUL}src/foo.ts${NUL}`;
		const files = parseUnifiedDiff(diff, numstat, nameStatus);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("src/foo.ts");
		expect(files[0].status).toBe("modified");
		expect(files[0].additions).toBe(1);
		expect(files[0].deletions).toBe(1);
		expect(files[0].hunks).toHaveLength(1);
		expect(files[0].hunks[0].header).toBe("@@ -1,3 +1,4 @@");
		expect(files[0].hunks[0].lines).toEqual([" line one", "+line two", " line three", "-line four"]);
	});

	test("parses a rename with no content change (-z rename fields)", () => {
		const diff = `diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`;
		const numstat = `0\t0${NUL}old/name.ts${NUL}new/name.ts${NUL}`;
		const nameStatus = `R100${NUL}old/name.ts${NUL}new/name.ts${NUL}`;
		const files = parseUnifiedDiff(diff, numstat, nameStatus);
		expect(files).toHaveLength(1);
		expect(files[0].status).toBe("renamed");
		expect(files[0].oldPath).toBe("old/name.ts");
		expect(files[0].path).toBe("new/name.ts");
		expect(files[0].hunks).toHaveLength(0);
	});

	test("binary files get empty hunks and are not parsed as text", () => {
		const diff = `diff --git a/image.png b/image.png
index 111..222 100644
Binary files a/image.png and b/image.png differ
`;
		const numstat = `-\t-\timage.png${NUL}`;
		const nameStatus = `M${NUL}image.png${NUL}`;
		const files = parseUnifiedDiff(diff, numstat, nameStatus);
		expect(files).toHaveLength(1);
		expect(files[0].hunks).toEqual([]);
		expect(files[0].additions).toBe(0);
		expect(files[0].deletions).toBe(0);
	});

	test("parses multiple hunks in one file", () => {
		const diff = `diff --git a/src/bar.ts b/src/bar.ts
index 111..222 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,2 @@
-old top
+new top
@@ -10,2 +10,2 @@
-old bottom
+new bottom
`;
		const files = parseUnifiedDiff(diff, `2\t2\tsrc/bar.ts${NUL}`, `M${NUL}src/bar.ts${NUL}`);
		expect(files[0].hunks).toHaveLength(2);
		expect(files[0].hunks[0].header).toBe("@@ -1,2 +1,2 @@");
		expect(files[0].hunks[1].header).toBe("@@ -10,2 +10,2 @@");
	});

	test("parses multiple files from one diff stream", () => {
		const diffOne = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,1 @@
-x
+y
`;
		const diff = diffOne + diffOne.replace(/foo\.ts/g, "baz.ts");
		const numstat = `1\t1\tsrc/foo.ts${NUL}1\t1\tsrc/baz.ts${NUL}`;
		const nameStatus = `M${NUL}src/foo.ts${NUL}M${NUL}src/baz.ts${NUL}`;
		const files = parseUnifiedDiff(diff, numstat, nameStatus);
		expect(files.map((f) => f.path)).toEqual(["src/foo.ts", "src/baz.ts"]);
	});
});

describe("assertValidSha", () => {
	test("accepts a real 40-hex sha", () => {
		expect(assertValidSha("a".repeat(40))).toBe("a".repeat(40));
	});

	test("rejects anything that is not a bare hex sha", () => {
		expect(() => assertValidSha("--output=pwn.html")).toThrow();
		expect(() => assertValidSha("not-a-sha")).toThrow();
		expect(() => assertValidSha("")).toThrow();
	});
});

describe("foldMergeChangeSets", () => {
	test("each non-merge commit becomes its own change set", () => {
		const commits = [
			{ sha: "c2", parents: ["c1"], authorName: "A", date: "2024-01-02", subject: "second", body: "" },
			{ sha: "c1", parents: [], authorName: "A", date: "2024-01-01", subject: "first", body: "" },
		];
		const sets = foldMergeChangeSets(commits, commits, new Map());
		expect(sets.map((s) => s.id)).toEqual(["c2", "c1"]);
		expect(sets[0].commits).toEqual(["c2"]);
		expect(sets[1].commits).toEqual(["c1"]);
	});

	test("folds a merge commit's second-parent branch commits into one change set", () => {
		const allCommits = [
			{
				sha: "merge",
				parents: ["main2", "branch2"],
				authorName: "A",
				date: "2024-01-05",
				subject: "Merge",
				body: "",
			},
			{ sha: "branch2", parents: ["branch1"], authorName: "B", date: "2024-01-04", subject: "branch 2", body: "" },
			{ sha: "branch1", parents: ["main1"], authorName: "B", date: "2024-01-03", subject: "branch 1", body: "" },
			{ sha: "main2", parents: ["main1"], authorName: "A", date: "2024-01-02", subject: "main 2", body: "" },
			{ sha: "main1", parents: [], authorName: "A", date: "2024-01-01", subject: "main 1", body: "" },
		];
		const firstParentCommits = [allCommits[0], allCommits[3], allCommits[4]];
		const sets = foldMergeChangeSets(firstParentCommits, allCommits, new Map());
		const mergeSet = sets.find((s) => s.id === "merge");
		expect(mergeSet?.commits).toEqual(["merge", "branch2", "branch1"]);
		expect(mergeSet?.authors.sort()).toEqual(["A", "B"]);
	});
});

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "reels-collect-test-"));
	git(dir, ["init", "-q"]);
	git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"]);
	return dir;
}

describe("collectChangeSets (real git repo)", () => {
	test("collects a linear history with real diffs", async () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "a.txt"), "hello\n");
			git(dir, ["add", "a.txt"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add a.txt"]);

			const changeSets = await collectChangeSets({ repo: dir, ref: "HEAD" });
			expect(changeSets[0].title).toBe("add a.txt");
			expect(changeSets[0].files[0].path).toBe("a.txt");
			expect(changeSets[0].files[0].hunks[0].lines).toEqual(["+hello"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("folds a real merge commit's branch commits into one change set with real files and stats (P3)", async () => {
		const dir = initRepo();
		try {
			const baseBranch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
			git(dir, ["checkout", "-q", "-b", "feature"]);
			writeFileSync(join(dir, "feature.txt"), "one\n");
			git(dir, ["add", "feature.txt"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature 1"]);
			appendFileSync(join(dir, "feature.txt"), "two\n");
			git(dir, ["add", "feature.txt"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature 2"]);
			git(dir, ["checkout", "-q", baseBranch]);
			git(dir, [
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"merge",
				"--no-ff",
				"-m",
				"Merge feature",
				"feature",
			]);

			const changeSets = await collectChangeSets({ repo: dir, ref: "HEAD" });
			const merge = changeSets.find((cs) => cs.title === "Merge feature");
			expect(merge).toBeDefined();
			expect(merge?.commits).toHaveLength(3);
			// P3: the merge's own diff (first-parent) must show the real file, not an empty combined diff.
			expect(merge?.files.map((f) => f.path)).toEqual(["feature.txt"]);
			expect(merge?.files[0].additions).toBe(2);
			expect(merge?.files[0].hunks.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("P4: handles unicode, space, quoted, and brace-rename paths via -z/core.quotePath=false", async () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "ä b.ts"), "x\n");
			writeFileSync(join(dir, 'q"uote.ts'), "y\n");
			git(dir, ["add", "."]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "unicode and quotes"]);

			const changeSets = await collectChangeSets({ repo: dir, ref: "HEAD" });
			const paths = changeSets[0].files.map((f) => f.path).sort();
			expect(paths).toEqual(['q"uote.ts', "ä b.ts"]);
			for (const file of changeSets[0].files) {
				expect(file.additions).toBe(1);
				expect(file.hunks.length).toBeGreaterThan(0);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("P4: a rename into a new directory does not collapse into the default 'old => new' brace form", async () => {
		const dir = initRepo();
		try {
			writeFileSync(join(dir, "old.ts"), "line1\nline2\nline3\nline4\nline5\n");
			git(dir, ["add", "old.ts"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "add old.ts"]);

			git(dir, ["mv", "old.ts", "x.ts"]);
			writeFileSync(join(dir, "x.ts"), "line1\nline2\nline3\nline4\nline5\nline6\n");
			git(dir, ["add", "-A"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "rename old to x"]);

			const changeSets = await collectChangeSets({ repo: dir, ref: "HEAD" });
			const renamed = changeSets[0].files.find((f) => f.status === "renamed");
			expect(renamed?.path).toBe("x.ts");
			expect(renamed?.oldPath).toBe("old.ts");
			expect(renamed?.additions).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("folds a real merge commit's branch commits into one change set", async () => {
		const dir = initRepo();
		try {
			const baseBranch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
			git(dir, ["checkout", "-q", "-b", "feature2"]);
			writeFileSync(join(dir, "f2.txt"), "one\n");
			git(dir, ["add", "f2.txt"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "f2 1"]);
			git(dir, ["checkout", "-q", baseBranch]);
			git(dir, [
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"merge",
				"--no-ff",
				"-m",
				"Merge feature2",
				"feature2",
			]);

			const changeSets = await collectChangeSets({ repo: dir, ref: "HEAD" });
			const merge = changeSets.find((cs) => cs.title === "Merge feature2");
			expect(merge).toBeDefined();
			expect(merge?.commits).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("collectChangeSetsForShas (real merge commit)", () => {
	test("folds a real merge commit's branch commits and returns the first-parent diff's files with non-zero stats", async () => {
		const dir = initRepo();
		try {
			const baseBranch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
			git(dir, ["checkout", "-q", "-b", "feature3"]);
			writeFileSync(join(dir, "feature3.txt"), "one\n");
			git(dir, ["add", "feature3.txt"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature3 1"]);
			appendFileSync(join(dir, "feature3.txt"), "two\n");
			git(dir, ["add", "feature3.txt"]);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "feature3 2"]);
			git(dir, ["checkout", "-q", baseBranch]);
			git(dir, [
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"merge",
				"--no-ff",
				"-m",
				"Merge feature3",
				"feature3",
			]);
			const mergeSha = git(dir, ["rev-parse", "HEAD"]);

			const changeSets = await collectChangeSetsForShas([mergeSha], { repo: dir });
			expect(changeSets).toHaveLength(1);
			const merge = changeSets[0];
			expect(merge.title).toBe("Merge feature3");
			expect(merge.commits).toHaveLength(3);
			// The merge's own (first-parent) diff must show the real file, not an empty combined diff.
			expect(merge.files.map((f) => f.path)).toEqual(["feature3.txt"]);
			expect(merge.files[0].additions).toBeGreaterThan(0);
			expect(merge.files[0].hunks.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** A `GitRunner` stub for `rev-list` calls only, returning shas newest-first in the given order. */
function fauxRevListGit(shasNewestFirst: string[]): GitRunner {
	return async (args: string[]) => {
		if (args[0] === "rev-list") {
			return `${shasNewestFirst.join("\n")}\n`;
		}
		throw new Error(`unexpected git call in test: ${args.join(" ")}`);
	};
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("selectBuildShas (faux rev-list)", () => {
	test("with an existing feed and a reachable published id, drains the oldest N above the floor", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: false,
			publishedIds: new Set([SHA_A]),
			cappedIds: new Set(),
			git: fauxRevListGit([SHA_B, SHA_A]),
		});
		expect(selection).toEqual({ shas: [SHA_B], cappedSkipped: [] });
	});

	test("bootstraps with the newest N when no published id falls within the window (rewritten history)", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: false,
			publishedIds: new Set([SHA_A]),
			cappedIds: new Set(),
			git: fauxRevListGit([SHA_B, SHA_C]),
		});
		expect(selection).toEqual({ shas: [SHA_C, SHA_B], cappedSkipped: [] });
	});

	test("first run (no feed yet) bootstraps with only the newest N, not the whole history", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: false,
			limit: 1,
			publishedIds: new Set(),
			cappedIds: new Set(),
			git: fauxRevListGit([SHA_C, SHA_B, SHA_A]),
		});
		expect(selection).toEqual({ shas: [SHA_C], cappedSkipped: [] });
	});

	test("capped ids are excluded unless force, and reported in cappedSkipped", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: false,
			publishedIds: new Set([SHA_A]),
			cappedIds: new Set([SHA_B]),
			git: fauxRevListGit([SHA_B, SHA_A]),
		});
		expect(selection).toEqual({ shas: [], cappedSkipped: [SHA_B] });
	});

	test("--force bypasses the cap so the capped commit is selected again", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: false,
			force: true,
			limit: 1,
			publishedIds: new Set([SHA_A]),
			cappedIds: new Set([SHA_B]),
			git: fauxRevListGit([SHA_B, SHA_A]),
		});
		expect(selection).toEqual({ shas: [SHA_B], cappedSkipped: [] });
	});

	test("--all-history ignores the floor and selects every unpublished commit in the window, oldest first, with no default limit", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: true,
			publishedIds: new Set([SHA_A]),
			cappedIds: new Set(),
			git: fauxRevListGit([SHA_C, SHA_B, SHA_A]),
		});
		expect(selection).toEqual({ shas: [SHA_B, SHA_C], cappedSkipped: [] });
	});

	test("--all-history with an explicit --limit keeps the OLDEST, so a backfill drains in order", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: true,
			limit: 1,
			publishedIds: new Set(),
			cappedIds: new Set(),
			git: fauxRevListGit([SHA_C, SHA_B, SHA_A]),
		});
		expect(selection).toEqual({ shas: [SHA_A], cappedSkipped: [] });
	});

	test("--force never re-selects published commits", async () => {
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: false,
			force: true,
			publishedIds: new Set([SHA_A, SHA_B]),
			cappedIds: new Set(),
			git: fauxRevListGit([SHA_B, SHA_A]),
		});
		expect(selection).toEqual({ shas: [], cappedSkipped: [] });
	});

	test("--force reaches a capped commit deep in a mature feed instead of re-rendering old reels", async () => {
		// 15 commits newest first; all published except #14, which hit the retry cap.
		const shas = Array.from({ length: 15 }, (_, i) => (15 - i).toString(16).padStart(40, "0"));
		const capped = (14).toString(16).padStart(40, "0");
		const selection = await selectBuildShas({
			repo: "/repo",
			ref: "HEAD",
			allHistory: false,
			force: true,
			limit: 3,
			publishedIds: new Set(shas.filter((s) => s !== capped)),
			cappedIds: new Set([capped]),
			git: fauxRevListGit(shas),
		});
		expect(selection).toEqual({ shas: [capped], cappedSkipped: [] });
	});
});

/** Commits with an explicit, strictly increasing author date so chronological fixtures are unambiguous. */
function commitAt(dir: string, index: number, file: string, dateIso?: string): void {
	const iso = dateIso ?? new Date(Date.UTC(2024, 0, 1, 0, index, 0)).toISOString();
	appendFileSync(join(dir, file), `line ${index}\n`);
	git(dir, ["add", file]);
	git(dir, [
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"--date",
		iso,
		"-m",
		`commit ${index}`,
	]);
}

describe("selectBuildShas + collectChangeSetsForShas (real git repo, git-order draining)", () => {
	test("(a) first run with 15 commits renders only the newest 10, not the whole history", async () => {
		const dir = initRepo();
		try {
			for (let i = 1; i <= 15; i++) commitAt(dir, i, "f.txt");

			const selection = await selectBuildShas({
				repo: dir,
				ref: "HEAD",
				allHistory: false,
				publishedIds: new Set(),
				cappedIds: new Set(),
			});
			const changeSets = await collectChangeSetsForShas(selection.shas, { repo: dir });
			expect(changeSets.map((c) => c.title)).toEqual(Array.from({ length: 10 }, (_, i) => `commit ${i + 6}`));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(b) a burst of 15 unpublished commits after a published one drains oldest-first over two runs of limit 10", async () => {
		const dir = initRepo();
		try {
			commitAt(dir, 0, "f.txt");
			const firstPublishedSha = git(dir, ["rev-parse", "HEAD"]);

			for (let i = 1; i <= 15; i++) commitAt(dir, i, "f.txt");

			const published = new Set([firstPublishedSha]);
			const selection1 = await selectBuildShas({
				repo: dir,
				ref: "HEAD",
				allHistory: false,
				publishedIds: published,
				cappedIds: new Set(),
			});
			const run1 = await collectChangeSetsForShas(selection1.shas, { repo: dir });
			expect(run1.map((c) => c.title)).toEqual(Array.from({ length: 10 }, (_, i) => `commit ${i + 1}`));

			for (const cs of run1) published.add(cs.id);
			const selection2 = await selectBuildShas({
				repo: dir,
				ref: "HEAD",
				allHistory: false,
				publishedIds: published,
				cappedIds: new Set(),
			});
			const run2 = await collectChangeSetsForShas(selection2.shas, { repo: dir });
			expect(run2.map((c) => c.title)).toEqual(Array.from({ length: 5 }, (_, i) => `commit ${i + 11}`));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(c) a commit that fails between two published ones is retried on later runs until the writer succeeds", async () => {
		const dir = initRepo();
		try {
			commitAt(dir, 1, "f.txt");
			const shaA = git(dir, ["rev-parse", "HEAD"]);
			commitAt(dir, 2, "f.txt");
			const shaB = git(dir, ["rev-parse", "HEAD"]);
			commitAt(dir, 3, "f.txt");
			const shaC = git(dir, ["rev-parse", "HEAD"]);

			let state: ReelsState = { failed: {} };
			const published = new Set<string>();
			let bFailuresLeft = 1;

			for (let run = 0; run < 2; run++) {
				const selection = await selectBuildShas({
					repo: dir,
					ref: "HEAD",
					allHistory: false,
					publishedIds: published,
					cappedIds: cappedIds(state),
				});
				for (const sha of selection.shas) {
					if (sha === shaB && bFailuresLeft > 0) {
						bFailuresLeft--;
						state = recordFailure(state, sha, "simulated writer failure", new Date().toISOString());
					} else {
						state = recordSuccess(state, sha);
						published.add(sha);
					}
				}
			}

			expect(published.has(shaA)).toBe(true);
			expect(published.has(shaB)).toBe(true);
			expect(published.has(shaC)).toBe(true);
			expect(state.failed[shaB]).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(c) a commit that always fails stops being retried after MAX_RENDER_ATTEMPTS", async () => {
		const dir = initRepo();
		try {
			commitAt(dir, 1, "f.txt");
			commitAt(dir, 2, "f.txt");
			const shaB = git(dir, ["rev-parse", "HEAD"]);
			commitAt(dir, 3, "f.txt");

			let state: ReelsState = { failed: {} };
			const published = new Set<string>();

			for (let run = 0; run < MAX_RENDER_ATTEMPTS; run++) {
				const selection = await selectBuildShas({
					repo: dir,
					ref: "HEAD",
					allHistory: false,
					publishedIds: published,
					cappedIds: cappedIds(state),
				});
				for (const sha of selection.shas) {
					if (sha === shaB) {
						state = recordFailure(state, sha, "permanent failure", new Date().toISOString());
					} else {
						state = recordSuccess(state, sha);
						published.add(sha);
					}
				}
			}
			expect(state.failed[shaB]?.attempts).toBe(MAX_RENDER_ATTEMPTS);

			const finalSelection = await selectBuildShas({
				repo: dir,
				ref: "HEAD",
				allHistory: false,
				publishedIds: published,
				cappedIds: cappedIds(state),
			});
			expect(finalSelection.shas).not.toContain(shaB);
			expect(finalSelection.cappedSkipped).toContain(shaB);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(d) after a force-push rewrite with no published sha in the window, only the newest N render, never the root", async () => {
		const dir = initRepo();
		try {
			commitAt(dir, 0, "f.txt");
			const rewrittenAwaySha = git(dir, ["rev-parse", "HEAD"]);
			git(dir, ["commit", "--amend", "-m", "commit 0 (rewritten)"]);
			for (let i = 1; i <= 12; i++) commitAt(dir, i, "f.txt");

			const published = new Set([rewrittenAwaySha]);
			const selection = await selectBuildShas({
				repo: dir,
				ref: "HEAD",
				allHistory: false,
				publishedIds: published,
				cappedIds: new Set(),
			});
			const changeSets = await collectChangeSetsForShas(selection.shas, { repo: dir });
			expect(changeSets.map((c) => c.title)).toEqual(Array.from({ length: 10 }, (_, i) => `commit ${i + 3}`));
			expect(changeSets.map((c) => c.title)).not.toContain("init");
			expect(changeSets.map((c) => c.title)).not.toContain("commit 0 (rewritten)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(e) commits with out-of-order author dates are all rendered, in git order not date order", async () => {
		const dir = initRepo();
		try {
			// Commit creation order is A, then B, then C (C is HEAD). Author dates
			// are deliberately out of creation order (as a rebase/cherry-pick would
			// leave them), so a date-based selection would strand B or reorder it.
			appendFileSync(join(dir, "f.txt"), "a\n");
			git(dir, ["add", "f.txt"]);
			git(dir, [
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"--date",
				"2024-01-05T00:00:00Z",
				"-m",
				"commit A",
			]);

			const published = new Set<string>();
			const rendered: string[] = [];

			for (const [label, date] of [
				["A", "2024-01-05T00:00:00Z"],
				["B", "2024-01-01T00:00:00Z"],
				["C", "2024-01-10T00:00:00Z"],
			] as const) {
				if (label !== "A") {
					appendFileSync(join(dir, "f.txt"), `${label}\n`);
					git(dir, ["add", "f.txt"]);
					git(dir, [
						"-c",
						"user.name=Test",
						"-c",
						"user.email=test@example.com",
						"commit",
						"--date",
						date,
						"-m",
						`commit ${label}`,
					]);
				}

				const selection = await selectBuildShas({
					repo: dir,
					ref: "HEAD",
					allHistory: false,
					limit: 1,
					publishedIds: published,
					cappedIds: new Set(),
				});
				const changeSets = await collectChangeSetsForShas(selection.shas, { repo: dir });
				expect(changeSets).toHaveLength(1);
				rendered.push(changeSets[0].title);
				published.add(changeSets[0].id);
			}

			expect(rendered).toEqual(["commit A", "commit B", "commit C"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("(g) a counting GitRunner shows `show` calls bounded by the selection, never proportional to the scan window", async () => {
		const dir = initRepo();
		try {
			for (let i = 1; i <= 50; i++) commitAt(dir, i, "f.txt");

			let showCalls = 0;
			const countingGit: GitRunner = async (args, cwd) => {
				if (args[0] === "show") showCalls++;
				return runGit(args, cwd);
			};

			const selection = await selectBuildShas({
				repo: dir,
				ref: "HEAD",
				allHistory: false,
				limit: 2,
				publishedIds: new Set(),
				cappedIds: new Set(),
				git: countingGit,
			});
			expect(selection.shas).toHaveLength(2);

			showCalls = 0;
			const changeSets = await collectChangeSetsForShas(selection.shas, { repo: dir, git: countingGit });
			expect(changeSets).toHaveLength(2);
			// 1 metadata (`show -s`) + 3 diff passes (`show --patch`/`--numstat`/`--name-status`) per selected head; no merges here.
			expect(showCalls).toBe(2 * 4);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
