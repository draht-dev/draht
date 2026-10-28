import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBuild, runPrune } from "../src/cli.ts";
import { type GitRunner, runGit } from "../src/collect.ts";
import { templateWriter } from "../src/script.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "reels-cli-prune-"));
	git(dir, ["init", "-q"]);
	git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"]);
	return dir;
}

describe("prune performance", () => {
	test("determines reachability with a single `git rev-list`, never `git show`, regardless of history size", async () => {
		const repo = initRepo();
		const outDir = mkdtempSync(join(tmpdir(), "reels-cli-prune-out-"));
		try {
			for (let i = 1; i <= 20; i++) {
				writeFileSync(join(repo, "f.txt"), `${i}\n`);
				git(repo, ["add", "f.txt"]);
				git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", `commit ${i}`]);
			}

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
					"--all-history",
				],
				{ writer: templateWriter },
			);

			let showCalls = 0;
			let revListCalls = 0;
			const countingGit: GitRunner = async (args, cwd) => {
				if (args[0] === "show") showCalls++;
				if (args[0] === "rev-list") revListCalls++;
				return runGit(args, cwd);
			};

			await runPrune(["--repo", repo, "--name", "demo", "--out", outDir], { git: countingGit });

			expect(showCalls).toBe(0);
			expect(revListCalls).toBe(1);
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
