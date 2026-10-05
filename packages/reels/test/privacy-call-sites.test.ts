import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBuild } from "../src/cli.ts";
import type { Feed } from "../src/contract.ts";
import { templateWriter } from "../src/script.ts";

const SECRET_SUBJECT = `add key sk-proj-${"a".repeat(30)} to config`;

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function initRepoWithSecretCommit(): string {
	const dir = mkdtempSync(join(tmpdir(), "reels-privacy-callsites-"));
	git(dir, ["init", "-q"]);
	writeFileSync(join(dir, "a.txt"), "1\n");
	git(dir, ["add", "a.txt"]);
	git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", SECRET_SUBJECT]);
	return dir;
}

describe("privacy call sites: a secret-shaped commit subject never reaches public output", () => {
	test("build: feed.json's entry title/authors never contain the raw secret substring", async () => {
		const repo = initRepoWithSecretCommit();
		const outDir = mkdtempSync(join(tmpdir(), "reels-privacy-callsites-out-"));
		try {
			await runBuild(
				["--repo", repo, "--name", "demo", "--unit", "commit", "--out", outDir, "--tts", "none", "--mode", "audio"],
				{
					writer: templateWriter,
				},
			);

			const feedRaw = readFileSync(join(outDir, "demo", "feed.json"), "utf-8");
			expect(feedRaw).not.toContain("sk-proj-");

			const feed = JSON.parse(feedRaw) as Feed;
			expect(feed.reels).toHaveLength(1);
			expect(feed.reels[0].title).not.toContain("sk-proj-");
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("plan: the printed report never contains the raw secret substring", () => {
		const repo = initRepoWithSecretCommit();
		try {
			const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
			const result = spawnSync("bun", ["run", cliPath, "plan", "--repo", repo, "--limit", "1"], {
				encoding: "utf8",
			});
			expect(result.status).toBe(0);
			expect(result.stdout).not.toContain("sk-proj-");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
