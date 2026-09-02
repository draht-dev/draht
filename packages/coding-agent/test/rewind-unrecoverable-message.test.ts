/**
 * The `unrecoverable` restore outcome (R42-RWD.3).
 *
 * When the forward restore fails *and* the rollback fails, the working tree is
 * stranded between two snapshots. Reporting that honestly is right, but the
 * user is at the exact moment they most need instructions: the message has to
 * name the ref their files are in and the command that puts them back.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointManager } from "../src/core/checkpoints/checkpoint-manager.ts";
import { describeRestore } from "../src/core/checkpoints/rewind.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function write(dir: string, path: string, content: string): void {
	const full = join(dir, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

/** Root ignores mode bits, so the read-only directory would not fail anything. */
const runningAsRoot = process.getuid?.() === 0;

describe("unrecoverable restore reporting (R42-RWD.3)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it.skipIf(runningAsRoot)(
		"names the ref and the command that recover the tree",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "draht-unrecoverable-test-"));
			const repo = join(root, "repo");
			const sessions = join(root, "sessions");
			mkdirSync(repo, { recursive: true });
			mkdirSync(sessions, { recursive: true });
			const locked = join(repo, "locked");
			cleanups.push(() => {
				if (existsSync(locked)) chmodSync(locked, 0o700);
				rmSync(root, { recursive: true, force: true });
			});

			git(repo, ["init", "--initial-branch=main"]);
			git(repo, ["config", "user.email", "fixture@example.com"]);
			git(repo, ["config", "user.name", "Fixture User"]);
			write(repo, "locked/work.txt", "checkpointed\n");
			git(repo, ["add", "-A"]);
			git(repo, ["commit", "-m", "initial"]);

			const manager = new CheckpointManager({
				cwd: repo,
				sessionId: "sess-unrecoverable",
				sessionFile: join(sessions, "2026-08-18T00-00-00-000Z_test.jsonl"),
			});
			expect((await manager.captureIfChanged("entry-1")).status).toBe("created");

			// The agent's edit, then the failure injection the reviewer used: the
			// directory holding the only differing path goes read-only, so the
			// restore's write fails and the rollback's write fails the same way.
			write(repo, "locked/work.txt", "agent edit\n");
			chmodSync(locked, 0o500);

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("unrecoverable");
			expect(result.safety?.ref).toBeDefined();
			expect(result.target?.ref).toBeDefined();
			// Nothing was lost - the tree is simply still the agent's edit.
			expect(readFileSync(join(repo, "locked/work.txt"), "utf8")).toBe("agent edit\n");

			const message = describeRestore(result);
			const safetyRef = result.safety?.ref as string;
			const targetRef = result.target?.ref as string;

			// The exact ref their pre-rewind files are in, and the exact command.
			expect(message).toContain(safetyRef);
			expect(message).toContain(targetRef);
			expect(message).toContain(`git restore --source=${safetyRef} --worktree -- .`);
			expect(message).toContain("repository root");
			// Both failures are named, not just the first.
			expect(message).toContain("rollback then failed too");

			// The named command really is runnable and really brings the files back.
			chmodSync(locked, 0o700);
			write(repo, "locked/work.txt", "clobbered\n");
			git(repo, ["restore", `--source=${safetyRef}`, "--worktree", "--", "."]);
			expect(readFileSync(join(repo, "locked/work.txt"), "utf8")).toBe("agent edit\n");
		},
		60_000,
	);
});
