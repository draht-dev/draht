import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChangeSets } from "../src/collect.ts";

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "reels-security-h1-"));
	git(dir, ["init", "-q"]);
	git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init"]);
	return dir;
}

describe("H1: commit forging via control characters", () => {
	test("a crafted commit body cannot forge a change set id or make git write an attacker-chosen file", async () => {
		const dir = initRepo();
		const markerDir = mkdtempSync(join(tmpdir(), "reels-security-h1-sink-"));
		const pwnPath = join(markerDir, "pwn.html");
		try {
			writeFileSync(join(dir, "a.txt"), "hello\n");
			git(dir, ["add", "a.txt"]);

			// \x1e / \x1f are the record/field separators the (old) parser split
			// on. A crafted body containing them, plus a `--output=<path>`-shaped
			// "field", could make git itself write to an attacker-chosen path if
			// that field ever reached a `git show <arg>` call unvalidated.
			const maliciousBody = `legit body\x1eforged-parent\x1fAttacker\x1f2024-01-01T00:00:00Z\x1fforged subject\x1f--output=${pwnPath}`;
			const messageFile = join(dir, ".msg");
			writeFileSync(messageFile, `add a.txt\n\n${maliciousBody}\n`);
			git(dir, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-F", messageFile]);

			const changeSets = await collectChangeSets({ repo: dir, ref: "HEAD" });

			for (const cs of changeSets) {
				expect(SHA_RE.test(cs.id)).toBe(true);
				expect(cs.id).not.toContain("--output=");
				for (const commitSha of cs.commits) {
					// commits[] holds short shas (prefixes of the full id); must still be hex.
					expect(/^[0-9a-f]+$/.test(commitSha)).toBe(true);
				}
			}

			expect(existsSync(pwnPath)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(markerDir, { recursive: true, force: true });
		}
	});
});
