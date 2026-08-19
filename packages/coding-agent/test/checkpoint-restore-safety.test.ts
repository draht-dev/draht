/**
 * Data-loss regressions for the restore path (Phase 42 review round).
 *
 * Every test here reproduces a way a `/rewind` could destroy work that no
 * snapshot holds, and proves the restore now refuses (or captures) instead.
 * The shared rule: a refusal is recoverable, a deletion is not.
 */

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
import {
	CHECKPOINT_REF_PREFIX,
	CheckpointManager,
	RESTORE_MARKER_FILE,
} from "../src/core/checkpoints/checkpoint-manager.ts";

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

function read(dir: string, path: string): string {
	return readFileSync(join(dir, path), "utf8");
}

/** Every file in the working tree (excluding any `.git`) with its content. */
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
			const executable = (lstatSync(full).mode & 0o111) !== 0 ? "x" : "-";
			out[relative(dir, full)] = `${executable}:${readFileSync(full, "utf8")}`;
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

describe("CheckpointManager restore safety", () => {
	let root: string;
	let repo: string;
	let sessionFile: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "draht-checkpoint-safety-test-"));
		repo = join(root, "repo");
		const sessionsDir = join(root, "sessions");
		mkdirSync(repo, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
		sessionFile = join(sessionsDir, "2026-08-18T00-00-00-000Z_test-session.jsonl");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createManager(): CheckpointManager {
		return new CheckpointManager({ cwd: repo, sessionId: "sess-1", sessionFile });
	}

	/** A repo with a checkpoint at `entry-1` covering a tracked and an ignored file. */
	async function seedCheckpoint(): Promise<CheckpointManager> {
		initRepo(repo);
		write(repo, ".gitignore", "ignored.log\n");
		write(repo, "tracked.txt", "original tracked\n");
		commitAll(repo, "initial");
		write(repo, "ignored.log", "checkpoint-time noise\n");

		const manager = createManager();
		expect((await manager.captureIfChanged("entry-1")).status).toBe("created");
		return manager;
	}

	// ── D1: nested git repositories ──────────────────────────────────────────

	describe("nested git repositories (D1)", () => {
		/**
		 * `git add -A` collapses an embedded clone into a single gitlink path, so
		 * deleting that path takes the nested repository's `.git` — history and
		 * uncommitted work alike — with it, and the gitlink in the safety
		 * snapshot records only a commit id, which restores as an empty
		 * directory. Nothing brings that back, so the restore has to refuse.
		 */
		it("refuses the whole restore and leaves the nested repository byte-intact", async () => {
			const manager = await seedCheckpoint();

			// The agent clones a repository into the tree after the checkpoint.
			const origin = join(root, "origin");
			mkdirSync(origin, { recursive: true });
			initRepo(origin);
			write(origin, "lib.txt", "upstream content\n");
			commitAll(origin, "upstream commit");

			const nested = join(repo, "vendor", "proj");
			mkdirSync(join(repo, "vendor"), { recursive: true });
			git(repo, ["clone", "--quiet", origin, nested]);
			write(repo, "vendor/proj/uncommitted.txt", "work nobody else has\n");
			write(repo, "agent-created.txt", "created after the checkpoint\n");

			const nestedHead = git(nested, ["rev-parse", "HEAD"]);
			const before = snapshotWorkingTree(repo);

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			// Refused, named, and nothing touched.
			expect(result.status).toBe("failed");
			expect(result.reason).toContain("vendor/proj");
			expect(result.reason).toContain("nested git repository");
			expect(result.restored).toEqual([]);
			expect(result.deleted).toEqual([]);

			// The nested repository is exactly as it was: files, history, and the
			// uncommitted work that only ever existed there.
			expect(existsSync(join(nested, ".git"))).toBe(true);
			expect(git(nested, ["rev-parse", "HEAD"])).toBe(nestedHead);
			expect(read(repo, "vendor/proj/lib.txt")).toBe("upstream content\n");
			expect(read(repo, "vendor/proj/uncommitted.txt")).toBe("work nobody else has\n");
			// The refusal is whole: the rest of the diff is not applied either.
			expect(snapshotWorkingTree(repo)).toEqual(before);
			expect(read(repo, "agent-created.txt")).toBe("created after the checkpoint\n");
		}, 60_000);

		it("refuses the batch when the repository is only one of several pending deletions", async () => {
			const manager = await seedCheckpoint();
			write(repo, "workspace/notes.md", "notes\n");
			const inner = join(repo, "workspace", "inner");
			mkdirSync(inner, { recursive: true });
			initRepo(inner);
			write(repo, "workspace/inner/a.txt", "inner work\n");
			commitAll(inner, "inner commit");

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("failed");
			expect(result.reason).toContain("workspace/inner");
			expect(result.reason).toContain("nested git repository");
			expect(existsSync(join(inner, ".git"))).toBe(true);
			expect(read(repo, "workspace/inner/a.txt")).toBe("inner work\n");
			// Ordinary deletions in the same batch are not applied either: the
			// tree stays on one side of the restore, never half-way across.
			expect(read(repo, "workspace/notes.md")).toBe("notes\n");
		}, 60_000);
	});

	// ── D2: tracked-but-ignored files ────────────────────────────────────────

	describe("tracked but ignored files (D2)", () => {
		it("round-trips a file that is tracked and matches .gitignore", async () => {
			initRepo(repo);
			write(repo, ".gitignore", "secret.env\n*.log\n");
			write(repo, "secret.env", "TOKEN=checkpoint\n");
			write(repo, "tracked.txt", "v1\n");
			// Tracked despite matching .gitignore — ignore rules never apply to
			// paths git already knows about.
			git(repo, ["add", "-f", ".gitignore", "secret.env", "tracked.txt"]);
			git(repo, ["commit", "-m", "initial"]);

			const manager = createManager();
			expect((await manager.captureIfChanged("entry-1")).status).toBe("created");

			// The snapshot really contains it — the bug was that it never did.
			const record = manager.get("entry-1");
			expect(record).toBeDefined();
			expect(git(repo, ["ls-tree", "-r", "--name-only", `${record?.ref}^{tree}`]).split("\n")).toContain(
				"secret.env",
			);

			write(repo, "secret.env", "TOKEN=agent-overwrote-this\n");
			write(repo, "tracked.txt", "v2\n");

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("restored");
			expect(result.restored).toContain("secret.env");
			expect(read(repo, "secret.env")).toBe("TOKEN=checkpoint\n");
			expect(read(repo, "tracked.txt")).toBe("v1\n");
			// Untracked ignored files stay outside the system, as documented.
			expect(result.restored).not.toContain("noise.log");
		}, 60_000);
	});

	// ── D3: ignore-rule drift ────────────────────────────────────────────────

	describe("ignore-rule drift between capture and restore (D3)", () => {
		it("refuses rather than deleting a file that was ignored at checkpoint time", async () => {
			initRepo(repo);
			write(repo, ".gitignore", "*.tmp\n");
			write(repo, "tracked.txt", "v1\n");
			commitAll(repo, "initial");
			// Ignored at checkpoint time, so it is in no snapshot.
			write(repo, "notes.tmp", "precious scratch work\n");

			const manager = createManager();
			expect((await manager.captureIfChanged("entry-1")).status).toBe("created");

			// The turn stops ignoring *.tmp, which makes notes.tmp visible to the
			// safety snapshot and absent from the target one: a plain delete.
			write(repo, ".gitignore", "*.bak\n");
			write(repo, "tracked.txt", "v2\n");
			const before = snapshotWorkingTree(repo);

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("failed");
			expect(result.reason).toContain(".gitignore");
			expect(result.deleted).toEqual([]);
			expect(existsSync(join(repo, "notes.tmp"))).toBe(true);
			expect(read(repo, "notes.tmp")).toBe("precious scratch work\n");
			expect(snapshotWorkingTree(repo)).toEqual(before);
		}, 60_000);

		it("refuses rather than overwriting a file that became ignored after the checkpoint", async () => {
			initRepo(repo);
			write(repo, ".gitignore", "*.log\n");
			write(repo, "tracked.txt", "v1\n");
			commitAll(repo, "initial");
			// Untracked but visible, so the checkpoint captures it.
			write(repo, "data.json", '{"from":"checkpoint"}\n');

			const manager = createManager();
			expect((await manager.captureIfChanged("entry-1")).status).toBe("created");

			// The turn starts ignoring it and rewrites it. It is now in the target
			// snapshot but in no snapshot of the *current* tree.
			write(repo, ".gitignore", "*.log\ndata.json\n");
			write(repo, "data.json", '{"from":"precious new work"}\n');
			const before = snapshotWorkingTree(repo);

			const result = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });

			expect(result.status).toBe("failed");
			expect(result.reason).toContain("data.json");
			expect(result.restored).toEqual([]);
			expect(read(repo, "data.json")).toBe('{"from":"precious new work"}\n');
			expect(snapshotWorkingTree(repo)).toEqual(before);
		}, 60_000);
	});

	// ── D4: safety snapshots must not shadow each other ──────────────────────

	describe("independently retrievable safety snapshots (D4)", () => {
		it("keeps the first safety snapshot reachable after a second rewind from the same leaf", async () => {
			const manager = await seedCheckpoint();

			write(repo, "tracked.txt", "work A\n");
			const preRewindA = snapshotWorkingTree(repo);
			const first = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });
			expect(first.status).toBe("restored");

			write(repo, "tracked.txt", "work B\n");
			const second = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });
			expect(second.status).toBe("restored");

			const safetyA = first.safety;
			const safetyB = second.safety;
			expect(safetyA?.recoveryId).toBeDefined();
			expect(safetyA?.recoveryId).not.toBe(safetyB?.recoveryId);
			if (!safetyA?.recoveryId) return;

			// `get` still answers "newest for this entry" — but the first safety
			// snapshot is no longer lost behind it.
			expect(manager.get("entry-2")?.ref).toBe(safetyB?.ref);
			expect(manager.getRecoveryPoint(safetyA.recoveryId)?.ref).toBe(safetyA.ref);
			expect(manager.listSafetySnapshots().map((record) => record.ref)).toEqual([safetyA.ref, safetyB?.ref]);
			expect(listCheckpointRefs(repo)).toContain(safetyA.ref);

			// And it is restorable through the public API, which is what makes it
			// a recovery point rather than a record.
			const redo = await manager.restore({ targetEntryId: safetyA.recoveryId, currentEntryId: "entry-3" });
			expect(redo.status).toBe("restored");
			expect(snapshotWorkingTree(repo)).toEqual(preRewindA);
		}, 60_000);
	});

	// ── D5: interruption safety ──────────────────────────────────────────────

	describe("in-progress marker (D5)", () => {
		const markerPath = (): string => join(repo, ".git", RESTORE_MARKER_FILE);

		it("names the safety ref while mutating and clears the marker on success", async () => {
			const manager = await seedCheckpoint();
			write(repo, "tracked.txt", "agent work\n");
			write(repo, "agent-created.txt", "new\n");

			const seenDuringRestore: string[] = [];
			const result = await manager.restore({
				targetEntryId: "entry-1",
				currentEntryId: "entry-2",
				onPathRestored: () => {
					if (existsSync(markerPath())) seenDuringRestore.push(readFileSync(markerPath(), "utf8"));
				},
			});

			expect(result.status).toBe("restored");
			expect(seenDuringRestore.length).toBeGreaterThan(0);
			expect(seenDuringRestore[0]).toContain(result.safety?.ref);
			expect(existsSync(markerPath())).toBe(false);
		}, 60_000);

		it("clears the marker when a failed restore rolls back", async () => {
			const manager = await seedCheckpoint();
			write(repo, "tracked.txt", "agent work\n");
			write(repo, "agent-created.txt", "new\n");

			const result = await manager.restore({
				targetEntryId: "entry-1",
				currentEntryId: "entry-2",
				onPathRestored: () => {
					throw new Error("injected mid-restore failure");
				},
			});

			expect(result.status).toBe("rolled-back");
			expect(existsSync(markerPath())).toBe(false);
		}, 60_000);

		it("refuses the next restore after an interrupted one and names the recovering ref", async () => {
			const manager = await seedCheckpoint();
			write(repo, "tracked.txt", "agent work\n");
			const before = snapshotWorkingTree(repo);

			// What a SIGINT or crash mid-restore leaves behind.
			writeFileSync(
				markerPath(),
				JSON.stringify({
					safetyRef: `${CHECKPOINT_REF_PREFIX}/sess-1/pre-rewind-entry-2-abc`,
					startedAt: "2026-08-18T10:00:00.000Z",
				}),
			);

			const interrupted = await CheckpointManager.findInterruptedRestore(repo);
			expect(interrupted?.safetyRef).toBe(`${CHECKPOINT_REF_PREFIX}/sess-1/pre-rewind-entry-2-abc`);

			const refused = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });
			expect(refused.status).toBe("failed");
			expect(refused.reason).toContain("interrupted");
			expect(refused.reason).toContain(`${CHECKPOINT_REF_PREFIX}/sess-1/pre-rewind-entry-2-abc`);
			expect(refused.reason).toContain(markerPath());
			expect(snapshotWorkingTree(repo)).toEqual(before);

			// Acknowledging it is the user's call, and unblocks the restore.
			expect(await CheckpointManager.clearInterruptedRestore(repo)).toBe(true);
			const allowed = await manager.restore({ targetEntryId: "entry-1", currentEntryId: "entry-2" });
			expect(allowed.status).toBe("restored");
			expect(read(repo, "tracked.txt")).toBe("original tracked\n");
		}, 60_000);
	});

	// ── D6: repeated capture for one entry id ────────────────────────────────

	describe("repeated capture for the same entry id (D6)", () => {
		it("preserves the earlier snapshot instead of replacing its ref", async () => {
			const manager = await seedCheckpoint();
			const first = manager.get("entry-1");
			expect(first?.recoveryId).toBeDefined();

			// The same entry captured again with a changed tree (a retried turn).
			write(repo, "tracked.txt", "second capture\n");
			expect((await manager.captureIfChanged("entry-1")).status).toBe("created");
			const second = manager.get("entry-1");

			expect(second?.ref).not.toBe(first?.ref);
			expect(second?.treeHash).not.toBe(first?.treeHash);
			// The earlier ref still exists and still points at the earlier tree.
			expect(listCheckpointRefs(repo)).toEqual(expect.arrayContaining([first?.ref, second?.ref]));
			expect(git(repo, ["rev-parse", `${first?.ref}^{tree}`])).toBe(first?.treeHash);

			if (!first?.recoveryId) return;
			expect(manager.getRecoveryPoint(first.recoveryId)?.ref).toBe(first.ref);
			write(repo, "tracked.txt", "third state\n");
			const result = await manager.restore({ targetEntryId: first.recoveryId, currentEntryId: "entry-2" });
			expect(result.status).toBe("restored");
			expect(read(repo, "tracked.txt")).toBe("original tracked\n");
		}, 60_000);
	});
});
