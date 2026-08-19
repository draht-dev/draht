import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CHECKPOINT_REF_PREFIX,
	CheckpointManager,
	SAFETY_REF_SEGMENT,
} from "../src/core/checkpoints/checkpoint-manager.ts";
import { performRewind } from "../src/core/checkpoints/rewind.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionUIContext,
	SessionBeforeTreeEvent,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKPOINTS_BUILTIN = resolve(HERE, "../src/core/builtins/checkpoints.ts");

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(dir: string): void {
	git(dir, ["init", "--initial-branch=main"]);
	git(dir, ["config", "user.email", "fixture@example.com"]);
	git(dir, ["config", "user.name", "Fixture User"]);
}

function write(dir: string, path: string, content: string): void {
	const full = join(dir, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
}

/** Every file in the working tree (excluding `.git`) with its content. */
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
			out[relative(dir, full)] = readFileSync(full, "utf8");
		}
	};
	walk(dir);
	return out;
}

function listCheckpointRefs(dir: string): string[] {
	const out = git(dir, ["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX]);
	return out ? out.split("\n") : [];
}

const extensionActions: ExtensionActions = {
	sendMessage: () => {},
	sendUserMessage: () => {},
	appendEntry: () => {},
	setSessionName: () => {},
	getSessionName: () => undefined,
	setLabel: () => {},
	getActiveTools: () => [],
	getAllTools: () => [],
	setActiveTools: () => {},
	refreshTools: () => {},
	getCommands: () => [],
	setModel: async () => false,
	getThinkingLevel: () => "off",
	setThinkingLevel: () => {},
};

const extensionContextActions: ExtensionContextActions = {
	getModel: () => undefined,
	getScopedModels: () => [],
	isIdle: () => true,
	isProjectTrusted: () => true,
	getSignal: () => undefined,
	abort: () => {},
	hasPendingMessages: () => false,
	shutdown: () => {},
	getContextUsage: () => undefined,
	compact: () => {},
	getSystemPrompt: () => "",
};

/** UI context that answers the restore prompt with `answer` and records notifications. */
function stubUI(answer: boolean, notifications: string[]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => answer,
		input: async () => undefined,
		notify: (message: string) => {
			notifications.push(message);
		},
	} as unknown as ExtensionUIContext;
}

describe("checkpoint extension surface (R42-RWD.7, R42-RWD.8)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	/**
	 * Fixture timeline (built inside each test body, not in a hook: git work
	 * needs the full test budget rather than the 10s hook budget):
	 *   commit  a.txt=v1, b.txt=keep
	 *   u1      checkpoint of that state
	 *   (agent) a.txt=v2, b.txt deleted, c.txt created
	 *   u2      checkpoint of the edited state, and the current leaf
	 */
	async function buildFixture() {
		const root = mkdtempSync(join(tmpdir(), "draht-checkpoint-surface-test-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));

		const repo = join(root, "repo");
		const sessionsDir = join(root, "sessions");
		const extensionsDir = join(root, "extensions");
		mkdirSync(repo, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });
		mkdirSync(extensionsDir, { recursive: true });

		initRepo(repo);
		write(repo, "a.txt", "v1");
		write(repo, "b.txt", "keep");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-m", "initial"]);

		const sessionManager = SessionManager.create(repo, sessionsDir);
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("session file missing");
		const u1 = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });

		const manager = new CheckpointManager({ cwd: repo, sessionId: sessionManager.getSessionId(), sessionFile });
		expect((await manager.captureIfChanged(u1)).status).toBe("created");
		const checkpointedTree = snapshotWorkingTree(repo);

		write(repo, "a.txt", "v2");
		rmSync(join(repo, "b.txt"));
		write(repo, "c.txt", "new");
		const u2 = sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		expect((await manager.captureIfChanged(u2)).status).toBe("created");
		const editedTree = snapshotWorkingTree(repo);

		return {
			root,
			repo,
			sessionsDir,
			extensionsDir,
			sessionManager,
			sessionFile,
			u1,
			u2,
			checkpointedTree,
			editedTree,
		};
	}

	async function createRunner(options: {
		repo: string;
		extensionsDir: string;
		sessionManager: SessionManager;
		files: Record<string, string>;
		ui?: ExtensionUIContext;
		/** Overrides merged over the defaults, e.g. `{ isIdle: () => false }`. */
		contextActions?: Partial<ExtensionContextActions>;
	}) {
		for (const [name, source] of Object.entries(options.files)) {
			writeFileSync(join(options.extensionsDir, name), source);
		}
		const paths = Object.keys(options.files).map((name) => join(options.extensionsDir, name));
		const loaded = await loadExtensions(paths, options.repo);
		expect(loaded.errors).toEqual([]);

		const authStorage = AuthStorage.inMemory();
		const modelRegistry = await createModelRegistry(authStorage);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			options.repo,
			options.sessionManager,
			modelRegistry,
		);
		runner.bindCore(extensionActions, { ...extensionContextActions, ...options.contextActions });
		if (options.ui) runner.setUIContext(options.ui, "tui");
		return runner;
	}

	/** The `session_before_tree` event `AgentSession.navigateTree` emits. */
	function beforeTreeEvent(targetId: string, oldLeafId: string | null): SessionBeforeTreeEvent {
		return {
			type: "session_before_tree",
			preparation: {
				targetId,
				oldLeafId,
				commonAncestorId: null,
				entriesToSummarize: [],
				userWantsSummary: false,
			},
			signal: new AbortController().signal,
		};
	}

	/** The `session_tree` event `navigateTree` emits once the leaf has moved. */
	function treeEvent(newLeafId: string | null, oldLeafId: string | null) {
		return { type: "session_tree", newLeafId, oldLeafId } as const;
	}

	/** Loads the real always-on checkpoints builtin as an extension. */
	const builtinReexport = `export { default } from ${JSON.stringify(CHECKPOINTS_BUILTIN)};`;

	// ── R42-RWD.7 ────────────────────────────────────────────────────────────

	it("offers file restore on /tree navigation to a checkpointed entry", async () => {
		const fixture = await buildFixture();
		const notifications: string[] = [];
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport },
			ui: stubUI(true, notifications),
		});

		const result = await runner.emit(beforeTreeEvent(fixture.u1, fixture.u2));
		await runner.emit(treeEvent(fixture.u1, fixture.u2));

		// Accepting restores the files; navigation is never cancelled by the offer.
		expect(result?.cancel).toBeFalsy();
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.checkpointedTree);
	}, 60_000);

	it("honors a declined /tree restore offer: nothing restored, navigation continues", async () => {
		const fixture = await buildFixture();
		const refsBefore = listCheckpointRefs(fixture.repo);
		const notifications: string[] = [];
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport },
			ui: stubUI(false, notifications),
		});

		const result = await runner.emit(beforeTreeEvent(fixture.u1, fixture.u2));
		await runner.emit(treeEvent(fixture.u1, fixture.u2));

		expect(result?.cancel).toBeFalsy();
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
		// Declining must not even take a safety snapshot.
		expect(listCheckpointRefs(fixture.repo)).toEqual(refsBefore);
	}, 60_000);

	it("offers file restore on /fork and honors decline", async () => {
		const fixture = await buildFixture();
		const refsBefore = listCheckpointRefs(fixture.repo);
		const notifications: string[] = [];

		const declining = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport },
			ui: stubUI(false, notifications),
		});
		const declined = await declining.emit({
			type: "session_before_fork",
			entryId: fixture.u1,
			position: "before",
		});
		expect(declined?.cancel).toBeFalsy();
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
		expect(listCheckpointRefs(fixture.repo)).toEqual(refsBefore);

		const accepting = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin-2.ts": builtinReexport },
			ui: stubUI(true, notifications),
		});
		const accepted = await accepting.emit({
			type: "session_before_fork",
			entryId: fixture.u1,
			position: "before",
		});
		expect(accepted?.cancel).toBeFalsy();
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.checkpointedTree);
	}, 60_000);

	it("makes no restore offer for an entry without a checkpoint", async () => {
		const fixture = await buildFixture();
		const notifications: string[] = [];
		let confirms = 0;
		const ui = {
			select: async () => undefined,
			confirm: async () => {
				confirms++;
				return true;
			},
			input: async () => undefined,
			notify: (message: string) => notifications.push(message),
		} as unknown as ExtensionUIContext;

		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport },
			ui,
		});

		await runner.emit({ type: "session_before_fork", entryId: "no-such-entry", position: "before" });

		expect(confirms).toBe(0);
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
	}, 60_000);

	// ── Regressions: restore ordering, streaming, and the promised undo ──────

	/**
	 * `session_before_tree` is cancelable and fires before the leaf moves.
	 * Restoring from it meant an accepted offer rewound the working tree even
	 * when the navigation was then vetoed, aborted mid-summary, or threw:
	 * files at the old point, conversation at the new one. The restore now
	 * waits for `session_tree`, which only fires once the leaf has moved.
	 */
	it("does not touch the working tree until the /tree navigation commits", async () => {
		const fixture = await buildFixture();
		const refsBefore = listCheckpointRefs(fixture.repo);
		const notifications: string[] = [];
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport },
			ui: stubUI(true, notifications),
		});

		await runner.emit(beforeTreeEvent(fixture.u1, fixture.u2));

		// Offer accepted, leaf not moved yet: nothing written, nothing deleted,
		// and not even a safety snapshot anchored.
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
		expect(listCheckpointRefs(fixture.repo)).toEqual(refsBefore);

		await runner.emit(treeEvent(fixture.u1, fixture.u2));
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.checkpointedTree);
	}, 60_000);

	it("leaves files and conversation consistent when the navigation aborts after the offer", async () => {
		const fixture = await buildFixture();
		const refsBefore = listCheckpointRefs(fixture.repo);
		const notifications: string[] = [];
		// A second extension vetoes the navigation after the builtin's handler
		// has already asked - the "abort after the handler" case.
		const veto = `
export default function (pi) {
	pi.on("session_before_tree", () => ({ cancel: true }));
}
`;
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport, "veto.ts": veto },
			ui: stubUI(true, notifications),
		});

		const cancelled = await runner.emit(beforeTreeEvent(fixture.u1, fixture.u2));

		// The leaf stayed at u2, so the files must still be u2's files.
		expect(cancelled?.cancel).toBe(true);
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
		expect(listCheckpointRefs(fixture.repo)).toEqual(refsBefore);

		// The abandoned decision must not be applied to a later navigation
		// either: this one is for an entry with no checkpoint, so it must not
		// restore anything when it commits.
		await runner.emit(beforeTreeEvent("no-such-entry", fixture.u2));
		await runner.emit(treeEvent("no-such-entry", fixture.u2));
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
		expect(listCheckpointRefs(fixture.repo)).toEqual(refsBefore);
	}, 60_000);

	/**
	 * A restore that runs while the agent is still writing races those writes
	 * and, worse, takes its safety snapshot from that moving tree - so the
	 * "undo" would capture a half-written state. Refuse instead.
	 */
	it("refuses a /fork restore while the agent is still running", async () => {
		const fixture = await buildFixture();
		const refsBefore = listCheckpointRefs(fixture.repo);
		const notifications: string[] = [];
		let confirms = 0;
		const ui = {
			select: async () => undefined,
			confirm: async () => {
				confirms++;
				return true;
			},
			input: async () => undefined,
			notify: (message: string) => notifications.push(message),
		} as unknown as ExtensionUIContext;

		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport },
			ui,
			contextActions: { isIdle: () => false },
		});

		const result = await runner.emit({
			type: "session_before_fork",
			entryId: fixture.u1,
			position: "before",
		});

		// Not even asked, nothing written, no safety snapshot from a moving tree.
		expect(result?.cancel).toBeFalsy();
		expect(confirms).toBe(0);
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
		expect(listCheckpointRefs(fixture.repo)).toEqual(refsBefore);
		expect(notifications.join("\n")).toContain("the agent is still running");
	}, 60_000);

	/**
	 * The fork offer used to say "your current files are snapshotted first",
	 * but the safety record is keyed to a leaf the fork drops, so
	 * `propagateCheckpointSidecar` filters it out and the forked session cannot
	 * /rewind to it. The offer must name where the snapshot really is.
	 */
	it("names where the pre-restore files can be reached after a /fork restore", async () => {
		const fixture = await buildFixture();
		const notifications: string[] = [];
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport },
			ui: stubUI(true, notifications),
		});

		await runner.emit({ type: "session_before_fork", entryId: fixture.u1, position: "before" });
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.checkpointedTree);

		const safetyRef = listCheckpointRefs(fixture.repo).find((ref) => ref.includes(SAFETY_REF_SEGMENT));
		expect(safetyRef).toBeDefined();

		const message = notifications.at(-1) ?? "";
		expect(message).toContain(safetyRef as string);
		expect(message).toContain(`git restore --source=${safetyRef} --worktree -- .`);

		// The undo it points at is real: the session being forked from keeps the
		// safety record, keyed to the leaf it was taken at, so /rewind there
		// restores the pre-fork tree exactly.
		const manager = new CheckpointManager({
			cwd: fixture.repo,
			sessionId: fixture.sessionManager.getSessionId(),
			sessionFile: fixture.sessionFile,
		});
		expect(manager.get(fixture.u2)?.ref).toBe(safetyRef);
		const undo = await manager.restore({ targetEntryId: fixture.u2, currentEntryId: fixture.u1 });
		expect(undo.status).toBe("restored");
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
	}, 60_000);

	// ── R42-RWD.8: pi.checkpoints ────────────────────────────────────────────

	it("exposes pi.checkpoints list/get/restore to a real extension", async () => {
		const fixture = await buildFixture();
		const observationsPath = join(fixture.root, "observations.json");
		const testExtension = `
import { writeFileSync } from "node:fs";

export default function (pi) {
	pi.on("turn_start", async (event, ctx) => {
		const target = ${JSON.stringify(fixture.u1)};
		const current = ${JSON.stringify(fixture.u2)};
		const listed = pi.checkpoints.list();
		const found = pi.checkpoints.get(target);
		const missing = pi.checkpoints.get("no-such-entry");
		const restore = await pi.checkpoints.restore({ targetEntryId: target, currentEntryId: current });
		writeFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
			listedEntryIds: listed.map((record) => record.entryId),
			foundEntryId: found?.entryId,
			foundRefSuffix: found?.ref.split("/").pop(),
			missing: missing === undefined,
			restoreStatus: restore.status,
			restored: restore.restored.slice().sort(),
			deleted: restore.deleted.slice().sort(),
		}));
	});
}
`;
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "surface.ts": testExtension },
		});

		await runner.emit({ type: "turn_start", turnIndex: 3, timestamp: Date.now() });

		expect(existsSync(observationsPath)).toBe(true);
		const observed = JSON.parse(readFileSync(observationsPath, "utf8"));
		expect(observed.listedEntryIds).toEqual([fixture.u1, fixture.u2]);
		expect(observed.foundEntryId).toBe(fixture.u1);
		expect(observed.missing).toBe(true);
		expect(observed.restoreStatus).toBe("restored");
		expect(observed.restored).toEqual(["a.txt", "b.txt"]);
		expect(observed.deleted).toEqual(["c.txt"]);
		// The restore an extension asked for really moved the working tree.
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.checkpointedTree);
	}, 60_000);

	it("fires checkpoint_created when the checkpoints builtin captures", async () => {
		const fixture = await buildFixture();
		const observationsPath = join(fixture.root, "created.json");
		const observer = `
import { appendFileSync } from "node:fs";

export default function (pi) {
	pi.on("checkpoint_created", (event) => {
		appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify(event.record) + "\\n");
	});
}
`;
		// A third user message with no checkpoint yet: the builtin captures
		// against it on turn_start, which must reach checkpoint_created.
		const u3 = fixture.sessionManager.appendMessage({ role: "user", content: "third", timestamp: 3 });
		write(fixture.repo, "a.txt", "v3");

		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "builtin.ts": builtinReexport, "observer.ts": observer },
		});

		await runner.emit({ type: "turn_start", turnIndex: 2, timestamp: Date.now() });

		expect(existsSync(observationsPath)).toBe(true);
		const records = readFileSync(observationsPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(1);
		expect(records[0].entryId).toBe(u3);
		expect(records[0].ref).toContain(CHECKPOINT_REF_PREFIX);
	}, 60_000);

	// ── R42-RWD.8: session_before_rewind ─────────────────────────────────────

	it("lets an extension cancel a rewind through session_before_rewind, mutating nothing", async () => {
		const fixture = await buildFixture();
		const vetoing = `
export default function (pi) {
	pi.on("session_before_rewind", (event) => {
		if (event.targetEntryId === ${JSON.stringify(fixture.u1)}) return { cancel: true };
	});
}
`;
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "veto.ts": vetoing },
		});

		const refsBefore = listCheckpointRefs(fixture.repo);
		const manager = new CheckpointManager({
			cwd: fixture.repo,
			sessionId: fixture.sessionManager.getSessionId(),
			sessionFile: fixture.sessionFile,
		});
		let navigated = false;

		const result = await performRewind({
			scope: "conversation-and-files",
			targetEntryId: fixture.u1,
			currentEntryId: fixture.u2,
			manager,
			runner,
			navigate: () => {
				navigated = true;
			},
		});

		expect(result.cancelled).toBe(true);
		expect(result.ok).toBe(false);
		expect(result.navigated).toBe(false);
		expect(navigated).toBe(false);
		// Cancelling happens before the safety snapshot, so nothing was written.
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.editedTree);
		expect(listCheckpointRefs(fixture.repo)).toEqual(refsBefore);
	}, 60_000);

	it("runs the rewind when session_before_rewind is not vetoed", async () => {
		const fixture = await buildFixture();
		const observer = `
export default function (pi) {
	pi.on("session_before_rewind", () => {});
}
`;
		const runner = await createRunner({
			repo: fixture.repo,
			extensionsDir: fixture.extensionsDir,
			sessionManager: fixture.sessionManager,
			files: { "observe.ts": observer },
		});

		const manager = new CheckpointManager({
			cwd: fixture.repo,
			sessionId: fixture.sessionManager.getSessionId(),
			sessionFile: fixture.sessionFile,
		});
		let navigated = false;

		const result = await performRewind({
			scope: "conversation-and-files",
			targetEntryId: fixture.u1,
			currentEntryId: fixture.u2,
			manager,
			runner,
			navigate: () => {
				navigated = true;
			},
		});

		expect(result.cancelled).toBeFalsy();
		expect(result.navigated).toBe(true);
		expect(navigated).toBe(true);
		expect(snapshotWorkingTree(fixture.repo)).toEqual(fixture.checkpointedTree);
	}, 60_000);
});
