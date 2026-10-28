import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runReview } from "../src/cli.ts";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
	const original = console.log;
	let out = "";
	console.log = (...args: unknown[]) => {
		out += `${args.map(String).join(" ")}\n`;
	};
	return (async () => {
		try {
			await fn();
		} finally {
			console.log = original;
		}
		return out;
	})();
}

describe("--unit commit --writer llm bypasses the draft/approve gate (critical)", () => {
	test("build rejects the combination before touching the repo or spending anything", () => {
		const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
		const result = spawnSync(
			"bun",
			["run", cliPath, "build", "--unit", "commit", "--writer", "llm", "--model", "test/fake"],
			{ encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("--unit commit --writer llm");
	});

	test("build still accepts --unit commit --writer template (auto-publish stays allowed)", () => {
		const cliPath = resolve(import.meta.dirname, "..", "src", "cli.ts");
		const repo = tmpDir("reels-build-args-repo-");
		try {
			spawnSync("git", ["init", "-q"], { cwd: repo });
			spawnSync(
				"git",
				["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-m", "init"],
				{
					cwd: repo,
				},
			);
			const out = tmpDir("reels-build-args-out-");
			try {
				const result = spawnSync(
					"bun",
					[
						"run",
						cliPath,
						"build",
						"--unit",
						"commit",
						"--writer",
						"template",
						"--tts",
						"none",
						"--mode",
						"audio",
						"--repo",
						repo,
						"--out",
						out,
					],
					{ encoding: "utf8" },
				);
				expect(result.stderr).not.toContain("bypasses the draft/approve gate");
			} finally {
				rmSync(out, { recursive: true, force: true });
			}
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("build.draftsDir from the config file resolves relative to the config file's directory", () => {
	test("a relative build.draftsDir in .reels.json is resolved against the config file, not cwd", async () => {
		const repo = tmpDir("reels-draftsdir-repo-");
		const configDir = tmpDir("reels-draftsdir-config-");
		const out = tmpDir("reels-draftsdir-out-");
		try {
			const configPath = join(configDir, ".reels.json");
			writeFileSync(configPath, JSON.stringify({ build: { draftsDir: "nested-drafts" } }));

			// Plant a draft at the location this fix should resolve to (relative to configDir, not cwd/repo).
			const expectedDraftsDir = join(configDir, "nested-drafts", "demo");
			mkdirSync(expectedDraftsDir, { recursive: true });

			const listed = await captureStdout(() =>
				runReview(["--repo", repo, "--name", "demo", "--out", out, "--config", configPath]),
			);

			// `runReview` without an id lists drafts; an empty (but present) dir prints "no drafts in <dir>" with
			// the resolved path, proving which directory it actually looked at.
			expect(listed).toContain(expectedDraftsDir);
			expect(listed).not.toContain(join(resolve(repo), "nested-drafts", "demo"));
		} finally {
			rmSync(repo, { recursive: true, force: true });
			rmSync(configDir, { recursive: true, force: true });
			rmSync(out, { recursive: true, force: true });
		}
	});
});
