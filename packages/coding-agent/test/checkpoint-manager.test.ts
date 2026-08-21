import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@draht/ai";
import { getModel } from "@draht/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import checkpointsBuiltin from "../src/core/builtins/checkpoints.ts";
import { handleCheckpointCommand } from "../src/core/checkpoints/checkpoint-cli.ts";
import {
	CHECKPOINT_REF_PREFIX,
	CheckpointManager,
	type CheckpointRestoreOptions,
	checkpointSidecarPath,
	propagateCheckpointSidecar,
	readCheckpointSidecar,
} from "../src/core/checkpoints/checkpoint-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function git(cwd: string, args: string[], env?: Record<string, string>): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: env ? { ...process.env, ...env } : process.env,
	}).trim();
}

/** git init without configuring a user identity. */
function initRepoBare(dir: string): void {
	git(dir, ["init", "--initial-branch=main"]);
}

function initRepo(dir: string): void {
	initRepoBare(dir);
	git(dir, ["config", "user.email", "fixture@example.com"]);
	git(dir, ["config", "user.name", "Fixture User"]);
}

function commitAll(dir: string, message: string): void {
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-m", message]);
}

function listCheckpointRefs(dir: string): string[] {
	const out = git(dir, ["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX]);
	return out ? out.split("\n") : [];
}

/**
 * Everything about the user's git state that capture must never touch:
 * stash list, staged entries, worktree status, HEAD, and the HEAD reflog.
 */
function userGitState(dir: string): string {
	return [
		git(dir, ["stash", "list"]),
		git(dir, ["ls-files", "--stage"]),
		git(dir, ["status", "--porcelain"]),
		git(dir, ["rev-parse", "HEAD"]),
		git(dir, ["reflog", "--format=%H %gs"]),
	].join("\n---\n");
}

/** Create a checkpoint-shaped ref with a controlled committer date (for prune tests). */
function makeCheckpointRef(repo: string, refName: string, dateIso: string): void {
	const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
	const env = {
		GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.com",
		GIT_COMMITTER_NAME: "fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.com",
		GIT_AUTHOR_DATE: dateIso,
		GIT_COMMITTER_DATE: dateIso,
	};
	const commit = git(repo, ["commit-tree", tree, "-m", "fixture checkpoint"], env);
	git(repo, ["update-ref", refName, commit]);
}

function daysAgoIso(days: number): string {
	return new Date(Date.now() - days * 86_400_000).toISOString();
}

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] }) as Message;
const assistantMessage = (): Message => ({ role: "assistant", content: [] }) as unknown as Message;
const toolResultMessage = (): Message =>
	({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false }) as unknown as Message;

// ─── Fake extension harness for builtin wiring tests ────────────────────────

type AnyHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function createFakePi() {
	const handlers = new Map<string, AnyHandler[]>();
	// `pi.checkpoints` is backed by the session the handlers are currently
	// running under, the same way the real ExtensionRunner resolves it.
	let current: ExtensionContext | undefined;
	const resolveManager = (): CheckpointManager | undefined => {
		const sessionFile = current?.sessionManager.getSessionFile();
		if (!current || !sessionFile) return undefined;
		return new CheckpointManager({
			cwd: current.cwd,
			sessionId: current.sessionManager.getSessionId(),
			sessionFile,
		});
	};
	const pi = {
		on(event: string, handler: AnyHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		checkpoints: {
			list: () => resolveManager()?.list() ?? [],
			get: (entryId: string) => resolveManager()?.get(entryId),
			restore: async (options: CheckpointRestoreOptions) =>
				(await resolveManager()?.restore(options)) ?? {
					status: "disabled" as const,
					restored: [],
					deleted: [],
					reason: "no session",
				},
			capture: async (entryId: string) =>
				(await resolveManager()?.captureIfChanged(entryId)) ?? {
					status: "disabled" as const,
					reason: "no session",
				},
		},
	} as unknown as ExtensionAPI;
	const emit = async (event: { type: string } & Record<string, unknown>, ctx: ExtensionContext): Promise<void> => {
		current = ctx;
		for (const handler of handlers.get(event.type) ?? []) {
			await handler(event, ctx);
		}
	};
	return { pi, emit, handlers };
}

function createFakeContext(options: {
	cwd: string;
	sessionManager: SessionManager;
	onNotify?: (message: string, type?: string) => void;
}): ExtensionContext {
	return {
		cwd: options.cwd,
		sessionManager: options.sessionManager,
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => options.onNotify?.(message, type),
		},
	} as unknown as ExtensionContext;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CheckpointManager", () => {
	let root: string;
	let repo: string;
	let sessionsDir: string;
	let sessionFile: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "draht-checkpoint-test-"));
		repo = join(root, "repo");
		sessionsDir = join(root, "sessions");
		mkdirSync(repo, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
		sessionFile = join(sessionsDir, "2026-08-12T00-00-00-000Z_test-session.jsonl");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function createManager(overrides?: { cwd?: string; sessionId?: string; sessionFile?: string }): CheckpointManager {
		return new CheckpointManager({
			cwd: overrides?.cwd ?? repo,
			sessionId: overrides?.sessionId ?? "sess-1",
			sessionFile: overrides?.sessionFile ?? sessionFile,
		});
	}

	describe("capture (R41-CKP.1, R41-CKP.2, R41-CKP.3)", () => {
		it("snapshots tracked modifications and untracked files into a namespaced durable ref, excluding ignored files", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "tracked.txt"), "original");
			writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
			commitAll(repo, "initial");
			writeFileSync(join(repo, "tracked.txt"), "modified");
			writeFileSync(join(repo, "untracked.txt"), "new-file");
			writeFileSync(join(repo, "ignored.log"), "noise");

			const result = await createManager().captureIfChanged("entry-01");

			expect(result.status).toBe("created");
			const record = result.record;
			expect(record).toBeDefined();
			if (!record) return;
			expect(record.entryId).toBe("entry-01");
			expect(record.ref).toBe(`${CHECKPOINT_REF_PREFIX}/sess-1/entry-01`);
			expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
			expect(record.dirtyFileCount).toBe(2);

			const commitHash = git(repo, ["rev-parse", "--verify", `${record.ref}^{commit}`]);
			expect(commitHash).toMatch(/^[0-9a-f]{40,64}$/);
			expect(git(repo, ["rev-parse", `${record.ref}^{tree}`])).toBe(record.treeHash);

			expect(git(repo, ["show", `${record.ref}:tracked.txt`])).toBe("modified");
			expect(git(repo, ["show", `${record.ref}:untracked.txt`])).toBe("new-file");
			const treeFiles = git(repo, ["ls-tree", "-r", "--name-only", record.ref]).split("\n");
			expect(treeFiles).toContain("tracked.txt");
			expect(treeFiles).not.toContain("ignored.log");
		});

		it("snapshots the rewritten content of a same-size rewrite whose stat still matches the index's cache", async () => {
			initRepo(repo);
			// ctime cannot be set from userspace the way mtime can, so this
			// repo opts out of comparing it (core.trustctime); the fields left
			// are exactly the ones the same-second interleaving collides on.
			git(repo, ["config", "core.trustctime", "false"]);
			const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
			writeFileSync(join(repo, "a.txt"), "v1");
			utimesSync(join(repo, "a.txt"), second, second);
			commitAll(repo, "initial");
			// The interleaving CI hits, pinned instead of raced: write, `add`
			// and `commit` all landed in the same wall-clock second, so the
			// index file's own mtime equals the cached entry's...
			const realIndex = join(repo, git(repo, ["rev-parse", "--git-path", "index"]));
			utimesSync(realIndex, second, second);
			// ...and the rewrite landed in that second too, with the same size,
			// so only the content distinguishes v2 from the cached stat of v1.
			writeFileSync(join(repo, "a.txt"), "v2");
			utimesSync(join(repo, "a.txt"), second, second);

			const result = await createManager().captureIfChanged("entry-01");

			expect(result.status).toBe("created");
			expect(git(repo, ["show", `${result.record?.ref}:a.txt`])).toBe("v2");
		});

		it("captures in a repository with no commits yet (unborn HEAD)", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "first.txt"), "hello");

			const result = await createManager().captureIfChanged("entry-02");

			expect(result.status).toBe("created");
			expect(result.record?.dirtyFileCount).toBe(1);
			expect(git(repo, ["show", `${result.record?.ref}:first.txt`])).toBe("hello");
		});

		it("captures even when no git identity is configured anywhere", async () => {
			vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
			vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
			initRepoBare(repo);
			writeFileSync(join(repo, "file.txt"), "content");

			const result = await createManager().captureIfChanged("entry-03");

			expect(result.status).toBe("created");
			expect(git(repo, ["rev-parse", "--verify", `${result.record?.ref}^{commit}`])).toBeTruthy();
		});

		it("sanitizes ref components that would be invalid git ref names", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "content");

			const result = await createManager({ sessionId: "weird..session." }).captureIfChanged("entry-04");

			expect(result.status).toBe("created");
			expect(result.record?.ref).not.toContain("..");
			expect(git(repo, ["rev-parse", "--verify", `${result.record?.ref}^{commit}`])).toBeTruthy();
		});

		it("leaves the user's index, HEAD, stash, reflog, and status byte-identical (R41-CKP.1)", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "a.txt"), "a-original");
			writeFileSync(join(repo, "b.txt"), "b-original");
			commitAll(repo, "initial");
			// Build a rich user state: one stash entry, one staged change, one unstaged change.
			writeFileSync(join(repo, "a.txt"), "a-stashed");
			git(repo, ["stash", "push", "-m", "user-stash"]);
			writeFileSync(join(repo, "a.txt"), "a-staged");
			git(repo, ["add", "a.txt"]);
			writeFileSync(join(repo, "b.txt"), "b-unstaged");
			writeFileSync(join(repo, "untracked.txt"), "loose");

			const before = userGitState(repo);
			const result = await createManager().captureIfChanged("entry-05");
			const after = userGitState(repo);

			expect(result.status).toBe("created");
			expect(after).toBe(before);
			expect(git(repo, ["stash", "list"])).toContain("user-stash");
		});
	});

	describe("dedup (R41-CKP.4)", () => {
		it("skips the snapshot when the tree hash equals the previous checkpoint's", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			commitAll(repo, "initial");
			writeFileSync(join(repo, "file.txt"), "v2");
			const manager = createManager();

			const first = await manager.captureIfChanged("entry-06a");
			const second = await manager.captureIfChanged("entry-06b");

			expect(first.status).toBe("created");
			expect(second.status).toBe("deduplicated");
			expect(second.record).toBeUndefined();
			expect(listCheckpointRefs(repo)).toHaveLength(1);
			expect(readCheckpointSidecar(checkpointSidecarPath(sessionFile))).toHaveLength(1);
		});

		it("creates a new ref again once the tree changes", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			commitAll(repo, "initial");
			writeFileSync(join(repo, "file.txt"), "v2");
			const manager = createManager();

			const first = await manager.captureIfChanged("entry-07a");
			writeFileSync(join(repo, "file.txt"), "v3");
			const second = await manager.captureIfChanged("entry-07b");

			expect(first.status).toBe("created");
			expect(second.status).toBe("created");
			expect(first.record?.treeHash).not.toBe(second.record?.treeHash);
			expect(listCheckpointRefs(repo)).toHaveLength(2);
		});
	});

	describe("sidecar (R41-CKP.5)", () => {
		it("appends one JSONL record per created checkpoint next to the session file", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			const manager = createManager();

			await manager.captureIfChanged("entry-08a");
			writeFileSync(join(repo, "file.txt"), "v2");
			await manager.captureIfChanged("entry-08b");

			const sidecar = checkpointSidecarPath(sessionFile);
			expect(sidecar).toBe(`${sessionFile}.checkpoints.jsonl`);
			expect(existsSync(sidecar)).toBe(true);

			const records = readCheckpointSidecar(sidecar);
			expect(records.map((r) => r.entryId)).toEqual(["entry-08a", "entry-08b"]);
			for (const record of records) {
				expect(record.ref.startsWith(`${CHECKPOINT_REF_PREFIX}/sess-1/`)).toBe(true);
				expect(record.treeHash).toMatch(/^[0-9a-f]{40,64}$/);
				expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
				expect(typeof record.dirtyFileCount).toBe("number");
			}
			expect(manager.list()).toEqual(records);
			expect(manager.get("entry-08b")?.treeHash).toBe(records[1].treeHash);
		});

		it("tolerates malformed sidecar lines when reading", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			const manager = createManager();
			await manager.captureIfChanged("entry-09");

			const sidecar = checkpointSidecarPath(sessionFile);
			writeFileSync(sidecar, `not-json\n${JSON.stringify(readCheckpointSidecar(sidecar)[0])}\n{"half":\n`);

			const records = readCheckpointSidecar(sidecar);
			expect(records).toHaveLength(1);
			expect(records[0].entryId).toBe("entry-09");
		});

		it("copies only records for preserved entry ids between session files", () => {
			const sourceSession = join(sessionsDir, "source.jsonl");
			const targetSession = join(sessionsDir, "target.jsonl");
			const record = (entryId: string) => ({
				entryId,
				ref: `${CHECKPOINT_REF_PREFIX}/sess-src/${entryId}`,
				treeHash: "a".repeat(40),
				timestamp: new Date().toISOString(),
				dirtyFileCount: 1,
			});
			writeFileSync(
				checkpointSidecarPath(sourceSession),
				`${[record("e1"), record("e2"), record("e3")].map((r) => JSON.stringify(r)).join("\n")}\n`,
			);

			const copied = propagateCheckpointSidecar(sourceSession, targetSession, new Set(["e1", "e3"]));

			expect(copied).toBe(2);
			const records = readCheckpointSidecar(checkpointSidecarPath(targetSession));
			expect(records.map((r) => r.entryId)).toEqual(["e1", "e3"]);
			// Refs are copied verbatim — they still point at the source session's namespace.
			expect(records[0].ref).toBe(`${CHECKPOINT_REF_PREFIX}/sess-src/e1`);
		});

		it("copies nothing when the source has no sidecar", () => {
			const sourceSession = join(sessionsDir, "no-sidecar.jsonl");
			const targetSession = join(sessionsDir, "target2.jsonl");

			const copied = propagateCheckpointSidecar(sourceSession, targetSession, new Set(["e1"]));

			expect(copied).toBe(0);
			expect(existsSync(checkpointSidecarPath(targetSession))).toBe(false);
		});
	});

	describe("non-git degradation (R41-CKP.6)", () => {
		it("returns disabled without throwing and writes no sidecar", async () => {
			const plainDir = join(root, "plain");
			mkdirSync(plainDir, { recursive: true });

			const result = await createManager({ cwd: plainDir }).captureIfChanged("entry-10");

			expect(result.status).toBe("disabled");
			expect(result.reason).toMatch(/git/i);
			expect(existsSync(checkpointSidecarPath(sessionFile))).toBe(false);
		});
	});

	describe("prune (R41-CKP.7)", () => {
		it("removes refs older than the retention period", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			commitAll(repo, "initial");
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-a/old1`, daysAgoIso(40));
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-a/new1`, daysAgoIso(1));
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-b/old2`, daysAgoIso(35));

			const result = await CheckpointManager.pruneRepository(repo, { retentionDays: 30 });

			expect(result.examined).toBe(3);
			expect(result.deleted.sort()).toEqual([
				`${CHECKPOINT_REF_PREFIX}/sess-a/old1`,
				`${CHECKPOINT_REF_PREFIX}/sess-b/old2`,
			]);
			expect(listCheckpointRefs(repo)).toEqual([`${CHECKPOINT_REF_PREFIX}/sess-a/new1`]);
		});

		it("keeps at most maxPerSession newest refs per session namespace", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			commitAll(repo, "initial");
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-c/e1`, daysAgoIso(3));
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-c/e2`, daysAgoIso(2));
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-c/e3`, daysAgoIso(1));
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-d/e1`, daysAgoIso(2));

			const result = await CheckpointManager.pruneRepository(repo, { retentionDays: 365, maxPerSession: 2 });

			expect(result.deleted).toEqual([`${CHECKPOINT_REF_PREFIX}/sess-c/e1`]);
			const remaining = listCheckpointRefs(repo);
			expect(remaining).toContain(`${CHECKPOINT_REF_PREFIX}/sess-c/e2`);
			expect(remaining).toContain(`${CHECKPOINT_REF_PREFIX}/sess-c/e3`);
			expect(remaining).toContain(`${CHECKPOINT_REF_PREFIX}/sess-d/e1`);
		});

		it("supports dry-run without deleting anything", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			commitAll(repo, "initial");
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-e/old`, daysAgoIso(60));

			const result = await CheckpointManager.pruneRepository(repo, { retentionDays: 30, dryRun: true });

			expect(result.deleted).toEqual([`${CHECKPOINT_REF_PREFIX}/sess-e/old`]);
			expect(listCheckpointRefs(repo)).toEqual([`${CHECKPOINT_REF_PREFIX}/sess-e/old`]);
		});

		it("is a no-op outside a git repository", async () => {
			const plainDir = join(root, "plain-prune");
			mkdirSync(plainDir, { recursive: true });

			const result = await CheckpointManager.pruneRepository(plainDir, { retentionDays: 30 });

			expect(result).toEqual({ examined: 0, deleted: [] });
		});
	});

	describe("builtin wiring (R41-CKP.4, R41-CKP.5, R41-CKP.6)", () => {
		it("captures on the first assistant message_start keyed to the initiating user message", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			const sessionManager = SessionManager.create(repo, sessionsDir);
			const userEntryId = sessionManager.appendMessage(userMessage("do something"));

			const { pi, emit } = createFakePi();
			checkpointsBuiltin(pi);
			const ctx = createFakeContext({ cwd: repo, sessionManager });

			// turn_start fires before the user entry is persisted in a real run,
			// so turn 0 must not capture (the leaf id would be wrong or missing).
			await emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
			expect(listCheckpointRefs(repo)).toHaveLength(0);

			await emit({ type: "message_start", message: assistantMessage() }, ctx);

			const sessionId = sessionManager.getSessionId();
			expect(listCheckpointRefs(repo)).toEqual([`${CHECKPOINT_REF_PREFIX}/${sessionId}/${userEntryId}`]);
		});

		it("captures on turn_start for later turns keyed to the current leaf", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			const sessionManager = SessionManager.create(repo, sessionsDir);
			sessionManager.appendMessage(userMessage("do something"));
			sessionManager.appendMessage(assistantMessage());
			const toolResultEntryId = sessionManager.appendMessage(toolResultMessage());

			const { pi, emit } = createFakePi();
			checkpointsBuiltin(pi);
			const ctx = createFakeContext({ cwd: repo, sessionManager });

			await emit({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);

			const sessionId = sessionManager.getSessionId();
			expect(listCheckpointRefs(repo)).toEqual([`${CHECKPOINT_REF_PREFIX}/${sessionId}/${toolResultEntryId}`]);
		});

		it("does not capture on assistant message_start when the leaf is not a user message", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			const sessionManager = SessionManager.create(repo, sessionsDir);
			sessionManager.appendMessage(userMessage("do something"));
			sessionManager.appendMessage(assistantMessage());
			sessionManager.appendMessage(toolResultMessage());

			const { pi, emit } = createFakePi();
			checkpointsBuiltin(pi);
			const ctx = createFakeContext({ cwd: repo, sessionManager });

			await emit({ type: "message_start", message: assistantMessage() }, ctx);

			expect(listCheckpointRefs(repo)).toHaveLength(0);
		});

		it("shows the non-git notice exactly once and keeps the session running (R41-CKP.6)", async () => {
			const plainDir = join(root, "plain-builtin");
			mkdirSync(plainDir, { recursive: true });
			const sessionManager = SessionManager.create(plainDir, sessionsDir);
			sessionManager.appendMessage(userMessage("hello"));

			const notifications: string[] = [];
			const { pi, emit } = createFakePi();
			checkpointsBuiltin(pi);
			const ctx = createFakeContext({
				cwd: plainDir,
				sessionManager,
				onNotify: (message) => notifications.push(message),
			});

			await emit({ type: "turn_start", turnIndex: 1, timestamp: Date.now() }, ctx);
			await emit({ type: "turn_start", turnIndex: 2, timestamp: Date.now() }, ctx);
			await emit({ type: "message_start", message: assistantMessage() }, ctx);

			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatch(/git/i);
		});

		it("copies sidecar records for preserved entries on fork (R41-CKP.5)", async () => {
			const sessionManager = SessionManager.create(repo, sessionsDir);
			const keptEntryId = sessionManager.appendMessage(userMessage("first"));
			sessionManager.appendMessage(assistantMessage());
			const droppedEntryId = sessionManager.appendMessage(userMessage("second"));
			const previousSessionFile = sessionManager.getSessionFile();
			expect(previousSessionFile).toBeDefined();
			if (!previousSessionFile) return;

			const record = (entryId: string) => ({
				entryId,
				ref: `${CHECKPOINT_REF_PREFIX}/${sessionManager.getSessionId()}/${entryId}`,
				treeHash: "b".repeat(40),
				timestamp: new Date().toISOString(),
				dirtyFileCount: 0,
			});
			writeFileSync(
				checkpointSidecarPath(previousSessionFile),
				`${[record(keptEntryId), record(droppedEntryId)].map((r) => JSON.stringify(r)).join("\n")}\n`,
			);

			// /fork branches from an earlier entry: descendants are dropped.
			const newSessionFile = sessionManager.createBranchedSession(keptEntryId);
			expect(newSessionFile).toBeDefined();
			if (!newSessionFile) return;

			const { pi, emit } = createFakePi();
			checkpointsBuiltin(pi);
			const ctx = createFakeContext({ cwd: repo, sessionManager });
			await emit({ type: "session_start", reason: "fork", previousSessionFile }, ctx);

			const copied = readCheckpointSidecar(checkpointSidecarPath(newSessionFile));
			expect(copied.map((r) => r.entryId)).toEqual([keptEntryId]);
		});

		it("copies all records on clone (fork at the leaf) (R41-CKP.5)", async () => {
			const sessionManager = SessionManager.create(repo, sessionsDir);
			const firstEntryId = sessionManager.appendMessage(userMessage("first"));
			sessionManager.appendMessage(assistantMessage());
			const leafEntryId = sessionManager.appendMessage(userMessage("second"));
			const previousSessionFile = sessionManager.getSessionFile();
			if (!previousSessionFile) return;

			const record = (entryId: string) => ({
				entryId,
				ref: `${CHECKPOINT_REF_PREFIX}/${sessionManager.getSessionId()}/${entryId}`,
				treeHash: "c".repeat(40),
				timestamp: new Date().toISOString(),
				dirtyFileCount: 0,
			});
			writeFileSync(
				checkpointSidecarPath(previousSessionFile),
				`${[record(firstEntryId), record(leafEntryId)].map((r) => JSON.stringify(r)).join("\n")}\n`,
			);

			const newSessionFile = sessionManager.createBranchedSession(leafEntryId);
			if (!newSessionFile) return;

			const { pi, emit } = createFakePi();
			checkpointsBuiltin(pi);
			const ctx = createFakeContext({ cwd: repo, sessionManager });
			await emit({ type: "session_start", reason: "fork", previousSessionFile }, ctx);

			const copied = readCheckpointSidecar(checkpointSidecarPath(newSessionFile));
			expect(copied.map((r) => r.entryId)).toEqual([firstEntryId, leafEntryId]);
		});
	});

	describe("settings (R41-CKP.7)", () => {
		it("exposes checkpoint retention settings with a 30-day default", () => {
			const defaults = SettingsManager.inMemory({});
			expect(defaults.getCheckpointSettings()).toEqual({ retentionDays: 30, maxPerSession: undefined });

			const custom = SettingsManager.inMemory({ checkpoints: { retentionDays: 7, maxPerSession: 5 } });
			expect(custom.getCheckpointSettings()).toEqual({ retentionDays: 7, maxPerSession: 5 });
		});
	});

	describe("draht checkpoint prune CLI (R41-CKP.7)", () => {
		afterEach(() => {
			process.exitCode = 0;
		});

		it("ignores non-checkpoint invocations", async () => {
			expect(await handleCheckpointCommand(["install", "something"])).toBe(false);
			expect(await handleCheckpointCommand([])).toBe(false);
		});

		it("prunes refs per the retention policy from settings and flags", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			commitAll(repo, "initial");
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-f/old`, daysAgoIso(40));
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-f/new`, daysAgoIso(1));

			const handled = await handleCheckpointCommand(["checkpoint", "prune"], {
				cwd: repo,
				settingsManager: SettingsManager.inMemory({}),
			});

			expect(handled).toBe(true);
			expect(process.exitCode ?? 0).toBe(0);
			expect(listCheckpointRefs(repo)).toEqual([`${CHECKPOINT_REF_PREFIX}/sess-f/new`]);
		});

		it("honors --days and --dry-run flags", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "v1");
			commitAll(repo, "initial");
			makeCheckpointRef(repo, `${CHECKPOINT_REF_PREFIX}/sess-g/e1`, daysAgoIso(10));

			const handled = await handleCheckpointCommand(["checkpoint", "prune", "--days", "5", "--dry-run"], {
				cwd: repo,
				settingsManager: SettingsManager.inMemory({}),
			});

			expect(handled).toBe(true);
			expect(process.exitCode ?? 0).toBe(0);
			expect(listCheckpointRefs(repo)).toEqual([`${CHECKPOINT_REF_PREFIX}/sess-g/e1`]);

			await handleCheckpointCommand(["checkpoint", "prune", "--days", "5"], {
				cwd: repo,
				settingsManager: SettingsManager.inMemory({}),
			});
			expect(listCheckpointRefs(repo)).toEqual([]);
		});

		it("reports usage errors for unknown subcommands", async () => {
			const handled = await handleCheckpointCommand(["checkpoint", "bogus"], {
				cwd: repo,
				settingsManager: SettingsManager.inMemory({}),
			});

			expect(handled).toBe(true);
			expect(process.exitCode).toBe(1);
		});
	});

	describe("real-session builtin loading proof (R41-CKP.7)", () => {
		it("loads the checkpoints builtin in a from-scratch session and captures through real extension dispatch", async () => {
			initRepo(repo);
			writeFileSync(join(repo, "file.txt"), "content");
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });

			const settingsManager = SettingsManager.create(repo, agentDir);
			const sessionManager = SessionManager.create(repo, sessionsDir);
			const services = await createAgentSessionServices({ cwd: repo, agentDir, settingsManager });
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
			});

			try {
				// Negative control: nothing captured before any turn events.
				expect(listCheckpointRefs(repo)).toHaveLength(0);

				const userEntryId = sessionManager.appendMessage(userMessage("real session prompt"));
				await session.extensionRunner.emit({ type: "message_start", message: assistantMessage() });

				const expectedRef = `${CHECKPOINT_REF_PREFIX}/${sessionManager.getSessionId()}/${userEntryId}`;
				expect(listCheckpointRefs(repo)).toContain(expectedRef);

				const sessionFilePath = sessionManager.getSessionFile();
				expect(sessionFilePath).toBeDefined();
				if (!sessionFilePath) return;
				const records = readCheckpointSidecar(checkpointSidecarPath(sessionFilePath));
				expect(records.map((r) => r.entryId)).toContain(userEntryId);
			} finally {
				session.dispose();
			}
		});
	});
});
