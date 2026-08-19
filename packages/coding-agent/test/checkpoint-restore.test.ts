import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECKPOINT_REF_PREFIX, CheckpointManager } from "../src/core/checkpoints/checkpoint-manager.ts";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(dir: string): void {
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "fixture@example.com"]);
	git(dir, ["config", "user.name", "Fixture User"]);
}

function commitAll(dir: string, message: string): void {
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-m", message]);
}

function write(dir: string, path: string, content: string): void {
	const full = join(dir, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

/**
 * Every file in the working tree (excluding `.git`) with its content and
 * executable bit — the byte-identity oracle for restore tests.
 */
function snapshotWorkingTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === ".git") continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			const key = relative(dir, full);
			if (entry.isSymbolicLink()) {
				out[key] = `symlink:${readFileSync(full, "utf8")}`;
				continue;
			}
			const executable = (lstatSync(full).mode & 0o111) !== 0 ? "x" : "-";
			out[key] = `${executable}:${readFileSync(full, "utf8")}`;
		}
	};
	walk(dir);
	return out;
}

function listCheckpointRefs(dir: string): string[] {
	const out = git(dir, ["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX]);
	return out ? out.split("\n") : [];
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CheckpointManager restore (R42-RWD.3, R42-RWD.4, R42-RWD.5)", () => {
	let root: string;
	let repo: string;
	let sessionFile: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "draht-checkpoint-restore-test-"));
		repo = join(root, "repo");
		const sessionsDir = join(root, "sessions");
		mkdirSync(repo, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
		sessionFile = join(sessionsDir, "2026-08-18T00-00-00-000Z_test-session.jsonl");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createManager(overrides?: { cwd?: string }): CheckpointManager {
		return new CheckpointManager({
			cwd: overrides?.cwd ?? repo,
			sessionId: "sess-1",
			sessionFile,
		});
	}

	/** A repo with a checkpoint at `entry-1` covering a tracked, an untracked and an ignored file. */
	async function seedCheckpoint(): Promise<{ manager: CheckpointManager; before: Record<string, string> }> {
		initRepo(repo);
		write(repo, ".gitignore", "ignored.log\n");
		write(repo, "tracked.txt", "original tracked\n");
		write(repo, "sub/kept.txt", "kept\n");
		write(repo, "doomed.txt", "delete me later\n");
		commitAll(repo, "initial");
		write(repo, "untracked.txt", "untracked original\n");
		write(repo, "ignored.log", "checkpoint-time noise\n");

		const manager = createManager();
		const captured = await manager.captureIfChanged("entry-1");
		expect(captured.status).toBe("created");
		return { manager, before: snapshotWorkingTree(repo) };
	}

	describe("diff-driven restore (R42-RWD.4)", () => {
		it("restores an edited file, removes a created file, and brings a deleted file back", async () => {
			const { manager, before } = await seedCheckpoint();

			// The agent edits, creates and deletes.
			write(repo, "tracked.txt", "agent overwrote this\n");
			write(repo, "untracked.txt", "agent overwrote the untracked one too\n");
			write(repo, "agent-created.txt", "brand new\n");
			write(repo, "nested/agent-created.txt", "brand new nested\n");
			rmSync(join(repo, "doomed.txt"));

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("restored");
			expect(result.target?.entryId).toBe("entry-1");
			expect(snapshotWorkingTree(repo)).toEqual(before);
			expect(existsSync(join(repo, "agent-created.txt"))).toBe(false);
			expect(existsSync(join(repo, "nested/agent-created.txt"))).toBe(false);
			expect(readFileSync(join(repo, "doomed.txt"), "utf8")).toBe("delete me later\n");
			expect(result.restored.sort()).toEqual(["doomed.txt", "tracked.txt", "untracked.txt"]);
			expect(result.deleted.sort()).toEqual(["agent-created.txt", "nested/agent-created.txt"]);
		});

		it("deletes a path that is absent in the target snapshot", async () => {
			const { manager } = await seedCheckpoint();
			write(repo, "late/addition.txt", "added after the checkpoint\n");

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("restored");
			expect(result.deleted).toEqual(["late/addition.txt"]);
			expect(existsSync(join(repo, "late/addition.txt"))).toBe(false);
		});

		it("never touches ignored files", async () => {
			const { manager } = await seedCheckpoint();
			// Both an ignored file that existed at checkpoint time and one created afterwards.
			write(repo, "ignored.log", "post-checkpoint noise\n");
			write(repo, "tracked.txt", "changed\n");

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("restored");
			expect(readFileSync(join(repo, "ignored.log"), "utf8")).toBe("post-checkpoint noise\n");
			expect(result.restored).not.toContain("ignored.log");
			expect(result.deleted).not.toContain("ignored.log");
			expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("original tracked\n");
		});

		it("is a no-op when the working tree already matches the target snapshot", async () => {
			const { manager, before } = await seedCheckpoint();

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("unchanged");
			expect(result.restored).toEqual([]);
			expect(result.deleted).toEqual([]);
			expect(snapshotWorkingTree(repo)).toEqual(before);
		});

		it("reports failure without mutating anything when the target checkpoint is unknown", async () => {
			const { manager, before } = await seedCheckpoint();

			const result = await manager.restore({ targetEntryId: "no-such-entry", currentEntryId: "entry-2" });

			expect(result.status).toBe("failed");
			expect(result.reason).toBeTruthy();
			expect(snapshotWorkingTree(repo)).toEqual(before);
		});

		it("reports disabled outside a git repository", async () => {
			const plain = join(root, "plain");
			mkdirSync(plain, { recursive: true });

			const result = await createManager({ cwd: plain }).restore({
				targetEntryId: "entry-1",
				currentEntryId: "entry-2",
			});

			expect(result.status).toBe("disabled");
		});
	});

	describe("safety snapshot (R42-RWD.3)", () => {
		it("anchors and records the pre-rewind tree before any file mutation", async () => {
			const { manager } = await seedCheckpoint();
			write(repo, "tracked.txt", "pre-rewind work\n");
			write(repo, "agent-created.txt", "pre-rewind creation\n");
			const preRewind = snapshotWorkingTree(repo);

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("restored");
			const safety = result.safety;
			expect(safety).toBeDefined();
			if (!safety) return;
			expect(safety.entryId).toBe("entry-2");
			expect(listCheckpointRefs(repo)).toContain(safety.ref);
			expect(git(repo, ["rev-parse", `${safety.ref}^{tree}`])).toBe(safety.treeHash);
			// The safety ref really holds the pre-rewind content, and is recorded
			// against the current leaf so a rewind back to it is a redo.
			expect(git(repo, ["show", `${safety.ref}:tracked.txt`])).toBe("pre-rewind work");
			expect(git(repo, ["show", `${safety.ref}:agent-created.txt`])).toBe("pre-rewind creation");
			expect(manager.get("entry-2")?.ref).toBe(safety.ref);

			// Restoring to the safety snapshot is a true redo of the abandoned state.
			const redo = await manager.restore({ targetEntryId: "entry-2", currentEntryId: "entry-1" });
			expect(redo.status).toBe("restored");
			expect(snapshotWorkingTree(repo)).toEqual(preRewind);
		});

		it("does not overwrite an existing checkpoint ref for the same entry id", async () => {
			const { manager } = await seedCheckpoint();
			const original = manager.get("entry-1");
			write(repo, "tracked.txt", "later work\n");

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-1" });

			expect(result.status).toBe("restored");
			expect(result.safety?.ref).not.toBe(original?.ref);
			expect(git(repo, ["rev-parse", `${original?.ref}^{tree}`])).toBe(original?.treeHash);
		});
	});

	describe("rollback on mid-restore failure (R42-RWD.3)", () => {
		it("rolls the working tree back to the safety snapshot", async () => {
			const { manager } = await seedCheckpoint();
			write(repo, "tracked.txt", "agent overwrote this\n");
			write(repo, "untracked.txt", "agent overwrote the untracked one too\n");
			write(repo, "agent-created.txt", "brand new\n");
			rmSync(join(repo, "doomed.txt"));
			const preRewind = snapshotWorkingTree(repo);

			let touched = 0;
			const result = await manager.restore({
				targetEntryId: "entry-1",
				currentEntryId: "entry-2",
				onPathRestored: () => {
					touched++;
					if (touched === 2) throw new Error("injected mid-restore failure");
				},
			});

			expect(touched).toBe(2);
			expect(result.status).toBe("rolled-back");
			expect(result.reason).toContain("injected mid-restore failure");
			expect(result.restored).toEqual([]);
			expect(result.deleted).toEqual([]);
			expect(result.safety).toBeDefined();
			expect(snapshotWorkingTree(repo)).toEqual(preRewind);
		});
	});

	describe("atomic ordering (R42-RWD.5)", () => {
		it("moves the conversation leaf only after the file restore succeeds", async () => {
			const { manager } = await seedCheckpoint();
			write(repo, "tracked.txt", "agent overwrote this\n");
			const order: string[] = [];

			const result = await manager.rewind({
				targetEntryId: "entry-1",
				currentEntryId: "entry-2",
				onPathRestored: (path) => {
					order.push(`restore:${path}`);
				},
				navigate: () => {
					order.push("navigate");
				},
			});

			expect(result.navigated).toBe(true);
			expect(result.restore.status).toBe("restored");
			expect(order).toEqual(["restore:tracked.txt", "navigate"]);
		});

		it("does not navigate when the file restore fails and rolls back", async () => {
			const { manager } = await seedCheckpoint();
			write(repo, "tracked.txt", "agent overwrote this\n");
			write(repo, "agent-created.txt", "brand new\n");
			const preRewind = snapshotWorkingTree(repo);
			let navigated = false;

			const result = await manager.rewind({
				targetEntryId: "entry-1",
				currentEntryId: "entry-2",
				onPathRestored: () => {
					throw new Error("injected mid-restore failure");
				},
				navigate: () => {
					navigated = true;
				},
			});

			expect(navigated).toBe(false);
			expect(result.navigated).toBe(false);
			expect(result.restore.status).toBe("rolled-back");
			expect(snapshotWorkingTree(repo)).toEqual(preRewind);
		});

		it("does not navigate when the target checkpoint is unknown", async () => {
			const { manager } = await seedCheckpoint();
			let navigated = false;

			const result = await manager.rewind({
				targetEntryId: "no-such-entry",
				currentEntryId: "entry-2",
				navigate: () => {
					navigated = true;
				},
			});

			expect(navigated).toBe(false);
			expect(result.navigated).toBe(false);
			expect(result.restore.status).toBe("failed");
		});
	});
});
