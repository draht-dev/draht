import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild } from "../src/cli.ts";
import type { Feed } from "../src/contract.ts";
import type { ScriptWriter } from "../src/script.ts";
import { templateWriter } from "../src/script.ts";
import { readState } from "../src/state.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "reels-cli-p1-"));
	git(dir, ["init", "-q"]);
	git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"]);
	return dir;
}

describe("P1: one reel's failure does not lose the whole run", () => {
	test("a deterministically-failing commit is skipped; earlier/later successful reels still publish", async () => {
		const repo = initRepo();
		const outDir = mkdtempSync(join(tmpdir(), "reels-cli-p1-out-"));
		try {
			writeFileSync(join(repo, "a.txt"), "1\n");
			git(repo, ["add", "a.txt"]);
			git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "good commit one"]);
			const failingSha = (() => {
				appendFileSync(join(repo, "a.txt"), "2\n");
				git(repo, ["add", "a.txt"]);
				git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "bad commit"]);
				return git(repo, ["rev-parse", "HEAD"]);
			})();
			appendFileSync(join(repo, "a.txt"), "3\n");
			git(repo, ["add", "a.txt"]);
			git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "good commit two"]);

			const flakyWriter: ScriptWriter = async (changeSet, options) => {
				if (changeSet.id === failingSha) throw new Error("simulated writer failure");
				return templateWriter(changeSet, options);
			};

			await runBuild(
				["--repo", repo, "--name", "demo", "--unit", "commit", "--out", outDir, "--tts", "none", "--mode", "audio"],
				{
					writer: flakyWriter,
				},
			);

			const feed = JSON.parse(readFileSync(join(outDir, "demo", "feed.json"), "utf-8")) as Feed;
			const publishedTitles = feed.reels.map((r) => r.title).sort();
			expect(publishedTitles).toEqual(["good commit one", "good commit two", "init"]);
			expect(feed.reels.map((r) => r.id)).not.toContain(failingSha);

			const state = await readState(outDir, "demo");
			expect(state.failed[failingSha]?.attempts).toBe(1);
			expect(state.failed[failingSha]?.lastError).toContain("simulated writer failure");

			// The partial media dir for the failed reel must not be left behind.
			expect(existsSync(join(outDir, "demo", "reels", failingSha.slice(0, 12)))).toBe(false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("a commit that always fails is skipped after MAX_RENDER_ATTEMPTS runs, letting later commits advance", async () => {
		const repo = initRepo();
		const outDir = mkdtempSync(join(tmpdir(), "reels-cli-p1-out-"));
		try {
			appendFileSync(join(repo, "a.txt"), "1\n");
			git(repo, ["add", "a.txt"]);
			git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "always bad"]);
			const badSha = git(repo, ["rev-parse", "HEAD"]);

			const alwaysFailWriter: ScriptWriter = async () => {
				throw new Error("permanent failure");
			};

			for (let i = 0; i < 3; i++) {
				await runBuild(
					[
						"--repo",
						repo,
						"--name",
						"demo",
						"--unit",
						"commit",
						"--out",
						outDir,
						"--tts",
						"none",
						"--mode",
						"audio",
					],
					{
						writer: alwaysFailWriter,
					},
				);
			}
			let state = await readState(outDir, "demo");
			expect(state.failed[badSha]?.attempts).toBe(3);

			// A 4th run must not retry it (shouldSkip trips), and must not error.
			await runBuild(
				["--repo", repo, "--name", "demo", "--unit", "commit", "--out", outDir, "--tts", "none", "--mode", "audio"],
				{
					writer: alwaysFailWriter,
				},
			);
			state = await readState(outDir, "demo");
			expect(state.failed[badSha]?.attempts).toBe(3); // unchanged: skipped, not retried
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

describe("M7: runBuild reports failures via its return value, not process.exitCode", () => {
	test("a run with failures returns { failed > 0 } without touching process.exitCode", async () => {
		const repo = initRepo();
		const outDir = mkdtempSync(join(tmpdir(), "reels-cli-p1-out-"));
		const exitCodeBefore = process.exitCode;
		process.exitCode = undefined;
		try {
			writeFileSync(join(repo, "a.txt"), "1\n");
			git(repo, ["add", "a.txt"]);
			git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "bad commit"]);

			const alwaysFailWriter: ScriptWriter = async () => {
				throw new Error("permanent failure");
			};

			const result = await runBuild(
				["--repo", repo, "--name", "demo", "--unit", "commit", "--out", outDir, "--tts", "none", "--mode", "audio"],
				{ writer: alwaysFailWriter },
			);

			expect(result).toEqual({ published: 0, failed: 2 });
			expect(process.exitCode).toBeUndefined();
		} finally {
			process.exitCode = exitCodeBefore;
			rmSync(repo, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

describe("S7: a failing render must not touch already-published media or feed entries", () => {
	test("a failing new reel leaves the previously published media and feed entry intact, with no scratch dirs", async () => {
		const repo = initRepo();
		const outDir = mkdtempSync(join(tmpdir(), "reels-cli-p1-out-"));
		try {
			writeFileSync(join(repo, "a.txt"), "1\n");
			git(repo, ["add", "a.txt"]);
			git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "published commit"]);
			const sha = git(repo, ["rev-parse", "HEAD"]);

			await runBuild(
				["--repo", repo, "--name", "demo", "--unit", "commit", "--out", outDir, "--tts", "none", "--mode", "audio"],
				{
					writer: templateWriter,
				},
			);

			const mediaDir = join(outDir, "demo", "reels", sha.slice(0, 12));
			const canaryFile = join(mediaDir, "live-media-canary.txt");
			writeFileSync(canaryFile, "pretend this is already-rendered media\n");

			const feedBefore = JSON.parse(readFileSync(join(outDir, "demo", "feed.json"), "utf-8")) as Feed;
			const entryBefore = feedBefore.reels.find((r) => r.id === sha);
			expect(entryBefore).toBeDefined();

			const alwaysFailWriter: ScriptWriter = async () => {
				throw new Error("simulated re-render failure");
			};

			writeFileSync(join(repo, "b.txt"), "2\n");
			git(repo, ["add", "b.txt"]);
			git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "failing commit"]);

			const result = await runBuild(
				["--repo", repo, "--name", "demo", "--unit", "commit", "--out", outDir, "--tts", "none", "--mode", "audio"],
				{
					writer: alwaysFailWriter,
				},
			);
			expect(result.failed).toBe(1);

			expect(existsSync(canaryFile)).toBe(true);
			const feedAfter = JSON.parse(readFileSync(join(outDir, "demo", "feed.json"), "utf-8")) as Feed;
			expect(feedAfter.reels.find((r) => r.id === sha)).toEqual(entryBefore);

			// No stray .tmp-/.old- scratch dirs left behind after the failed re-render.
			const leftovers = readdirSync(join(outDir, "demo", "reels")).filter(
				(name) => name.startsWith(".tmp-") || name.includes(".old-"),
			);
			expect(leftovers).toEqual([]);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
