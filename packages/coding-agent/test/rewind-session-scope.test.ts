/**
 * Session-scoped rewind gate — Phase 35 / T1 / R35-ALWAYS.5.
 *
 * `isRewindInProgress()` used to be process-global (`let activeRewinds = 0`).
 * Its only production reader is `confirmRestore` in the checkpoints builtin,
 * which answers `undefined` — indistinguishable from "the user declined" — so a
 * rewind in one session silently suppressed another session's file-restore
 * offer. This suite pins the gate to a session id.
 *
 * ── EVIDENCE: DECLARED CLASS-3 EXCEPTION ─────────────────────────────────────
 * R35-ALWAYS.5's premise does NOT hold for the emitted binary — default-on
 * multiplies attachable PROCESSES, not sessions per process. Two concurrent
 * attachable sessions in one process are constructible ONLY through the SDK.
 * T1 is Phase 35's one declared class-3 exception, evidence class 2, and the
 * exception is written here, in those words, so it is not mistaken for a gap.
 *
 * Why no emitted-binary construct reaches the state the roadmap acceptance
 * names: there is exactly one `new InteractiveMode(` in the tree (main.ts),
 * `performRewind` is reachable only from InteractiveMode, rpc/print modes have
 * no rewind entry point, and subagents / `/duet` are CHILD processes
 * (`core/builtins/subagent.ts` spawns `process.execPath`). The only in-process
 * multi-session host that exists, `packages/draht-acp`, never calls
 * `performRewind`.
 *
 * So the acceptance state is built here the only way it can be built: two
 * sessions created in this process through the package's own SDK
 * (`createAgentSession` twice), each made separately attachable through the
 * real `makeSessionAttachable` — the same call site main.ts uses — so the
 * "two concurrent attachable sessions in one process" of the acceptance text is
 * literally constructed, not stipulated.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Api, Model } from "@draht/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CORE_BUILTIN_EXTENSIONS } from "../src/core/builtins/index.ts";
import type { CheckpointManager, CheckpointRestoreResult } from "../src/core/checkpoints/checkpoint-manager.ts";
import { CheckpointManager as RealCheckpointManager } from "../src/core/checkpoints/checkpoint-manager.ts";
import { isRewindInProgress, performRewind, type RewindScope } from "../src/core/checkpoints/rewind.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionFactory,
	ExtensionUIContext,
	SessionBeforeTreeEvent,
} from "../src/core/extensions/types.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { makeSessionAttachable } from "../src/core/socket-server/session-integration.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

/** A promise plus its resolver; the concurrency in these tests is built on it. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

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

/**
 * A checkpoint manager whose `restore` parks until the returned gate is opened.
 * Everything else on the real class is unreachable from the `files-only` path,
 * which is why the cast is safe: `performRewind` calls exactly `restore`.
 */
function parkingManager(): {
	manager: CheckpointManager;
	entered: Promise<void>;
	open: () => void;
} {
	const entered = deferred();
	const gate = deferred();
	const manager = {
		restore: async (): Promise<CheckpointRestoreResult> => {
			entered.resolve();
			await gate.promise;
			return { status: "unchanged", restored: [], deleted: [] };
		},
	} as unknown as CheckpointManager;
	return { manager, entered: entered.promise, open: () => gate.resolve() };
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

/** UI context that answers the restore prompt with `true` and records the asks. */
function recordingUI(asks: string[]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async (title: string) => {
			asks.push(title);
			return true;
		},
		input: async () => undefined,
		notify: () => {},
	} as unknown as ExtensionUIContext;
}

function stubModel(): Model<Api> {
	return {
		id: "scope-model",
		name: "Scope Model",
		api: "anthropic-messages" as Api,
		provider: "scope-provider",
		baseUrl: "https://scope.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	} as unknown as Model<Api>;
}

/**
 * The slice of `InteractiveMode` that `runRewind` actually touches, so the real
 * writer can be driven without a TUI - the same technique
 * `interactive-mode-rewind-input-gate.test.ts` uses on the same method.
 */
type RewindWriterContext = {
	isRewindRunning: boolean;
	editor: { getText: () => string; setText: (text: string) => void };
	session: {
		isStreaming: boolean;
		extensionRunner: ExtensionRunner;
		navigateTree: (
			targetId: string,
			options: { summarize: boolean },
		) => Promise<{ cancelled: boolean; editorText?: string }>;
	};
	sessionManager: SessionManager;
	chatContainer: { clear: () => void };
	renderInitialMessages: () => void;
	flushCompactionQueue: (options: { willRetry: boolean }) => Promise<void>;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

/** The real `/rewind` writer, reached without constructing the TUI. */
const rewindWriter = InteractiveMode.prototype as unknown as {
	runRewind(
		this: RewindWriterContext,
		targetEntryId: string,
		scope: RewindScope,
		manager: CheckpointManager | undefined,
	): Promise<void>;
};

describe("rewind gate is session-scoped (R35-ALWAYS.5)", () => {
	// Agent dir lives DIRECTLY under /tmp with a short name: the attachable
	// sockets land in <agentDir>/sockets/<uuid>.sock and a sun_path over ~104
	// bytes fails to bind with EINVAL. macOS os.tmpdir() alone burns ~50.
	let root: string;
	let agentDir: string;
	let previousAgentDir: string | undefined;
	const cleanups: Array<() => void | Promise<void>> = [];

	beforeEach(() => {
		root = mkdtempSync("/tmp/p35t1-");
		agentDir = join(root, "a");
		mkdirSync(agentDir, { recursive: true });
		previousAgentDir = process.env.DRAHT_CODING_AGENT_DIR;
		process.env.DRAHT_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		if (previousAgentDir === undefined) delete process.env.DRAHT_CODING_AGENT_DIR;
		else process.env.DRAHT_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	/**
	 * One SDK session in this process, made attachable exactly as main.ts does.
	 *
	 * This scaffolding is the CONSTRUCTION, not the ASSERTION. It exists so the
	 * acceptance sentence ("two concurrent attachable sessions in one process")
	 * is literally built rather than stipulated - that is the declared class-3
	 * exception's evidence, and why it stays. Every gate assertion below would
	 * hold identically with two string literals in place of these ids: the
	 * sockets prove the STATE is reachable, they do not carry the requirement.
	 */
	async function attachableSession(name: string) {
		const cwd = join(root, name);
		mkdirSync(cwd, { recursive: true });
		const sessionsDir = join(root, `${name}-s`);
		mkdirSync(sessionsDir, { recursive: true });

		const authStorage = AuthStorage.create(join(agentDir, `auth-${name}.json`));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, `models-${name}.json`));
		const sessionManager = SessionManager.create(cwd, sessionsDir);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: stubModel(),
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory({}),
			sessionManager,
		});
		const attachable = await makeSessionAttachable({
			session,
			enabled: true,
			cwd,
			onWarning: () => {},
			log: () => {},
		});
		cleanups.push(async () => {
			await attachable.stop();
		});
		return { session, sessionManager, attachable, sessionId: sessionManager.getSessionId() };
	}

	it("holds the flag for the rewinding session only, across two attachable sessions in one process", async () => {
		const a = await attachableSession("pa");
		const b = await attachableSession("pb");

		// The acceptance state, actually constructed: two distinct sessions, two
		// distinct live sockets, one process.
		expect(a.sessionId).not.toBe(b.sessionId);
		expect(a.attachable.socketPath).toBeTruthy();
		expect(b.attachable.socketPath).toBeTruthy();
		expect(a.attachable.socketPath).not.toBe(b.attachable.socketPath);
		expect(a.attachable.sessionId).toBe(a.sessionId);
		expect(b.attachable.sessionId).toBe(b.sessionId);
		// Not just a handle that says yes: both sockets are bound on disk, with
		// their lock files, at the same time.
		for (const socketPath of [a.attachable.socketPath, b.attachable.socketPath]) {
			if (!socketPath) throw new Error("socket path missing");
			expect(existsSync(socketPath)).toBe(true);
			expect(existsSync(socketPath.replace(/\.sock$/, ".lock"))).toBe(true);
		}

		expect(isRewindInProgress(a.sessionId)).toBe(false);
		expect(isRewindInProgress(b.sessionId)).toBe(false);

		const parked = parkingManager();
		const rewind = performRewind({
			sessionId: a.sessionId,
			scope: "files-only",
			targetEntryId: "target",
			currentEntryId: "leaf",
			manager: parked.manager,
			navigate: () => {
				throw new Error("files-only must never navigate");
			},
		});
		await parked.entered;

		// The whole requirement, in two lines.
		expect(isRewindInProgress(a.sessionId)).toBe(true);
		expect(isRewindInProgress(b.sessionId)).toBe(false);

		parked.open();
		const result = await rewind;
		expect(result.ok).toBe(true);

		// And no leak: the key is dropped, not left at a stale count.
		expect(isRewindInProgress(a.sessionId)).toBe(false);
		expect(isRewindInProgress(b.sessionId)).toBe(false);
	}, 60_000);

	it("keeps two concurrent rewinds independent: finishing one does not clear the other", async () => {
		const a = await attachableSession("qa");
		const b = await attachableSession("qb");

		const parkedA = parkingManager();
		const parkedB = parkingManager();
		const common = {
			scope: "files-only",
			targetEntryId: "target",
			currentEntryId: "leaf",
			navigate: () => {
				throw new Error("files-only must never navigate");
			},
		} as const;

		const rewindA = performRewind({ ...common, sessionId: a.sessionId, manager: parkedA.manager });
		const rewindB = performRewind({ ...common, sessionId: b.sessionId, manager: parkedB.manager });
		await parkedA.entered;
		await parkedB.entered;

		expect(isRewindInProgress(a.sessionId)).toBe(true);
		expect(isRewindInProgress(b.sessionId)).toBe(true);

		parkedA.open();
		await rewindA;

		// A shared counter would still read true here for A; a shared counter
		// decremented once would read false for B. Both are wrong.
		expect(isRewindInProgress(a.sessionId)).toBe(false);
		expect(isRewindInProgress(b.sessionId)).toBe(true);

		parkedB.open();
		await rewindB;
		expect(isRewindInProgress(b.sessionId)).toBe(false);
	}, 60_000);

	// ── The real reader ──────────────────────────────────────────────────────
	// The cases above assert the predicate. These two drive the only production
	// consumer, `confirmRestore` in the checkpoints builtin, through the real
	// extension runner and the real `session_before_tree` seam, in both
	// directions: the offer must survive ANOTHER session's rewind, and it must
	// still be suppressed by THIS session's own (R42-RWD.7, which is what the
	// gate was for). Only the pair pins the reader to `ctx`'s session id — the
	// first alone passes even if the reader asks about a session that does not
	// exist.

	/**
	 * Session B: a real git repo with two checkpoints and the always-on
	 * checkpoints builtin loaded as itself, positioned to navigate back to the
	 * first checkpoint.
	 */
	async function treeFixture(name: string) {
		const repo = join(root, name);
		const sessionsDir = join(root, `${name}-s`);
		mkdirSync(repo, { recursive: true });
		mkdirSync(sessionsDir, { recursive: true });

		initRepo(repo);
		write(repo, "a.txt", "v1");
		write(repo, "b.txt", "keep");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-m", "initial"]);

		const sessionManager = SessionManager.create(repo, sessionsDir);
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("session file missing");
		const u1 = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const manager = new RealCheckpointManager({
			cwd: repo,
			sessionId: sessionManager.getSessionId(),
			sessionFile,
		});
		expect((await manager.captureIfChanged(u1)).status).toBe("created");
		const checkpointedTree = snapshotWorkingTree(repo);

		write(repo, "a.txt", "v2");
		rmSync(join(repo, "b.txt"));
		write(repo, "c.txt", "new");
		const u2 = sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		expect((await manager.captureIfChanged(u2)).status).toBe("created");
		const editedTree = snapshotWorkingTree(repo);

		// The builtin is loaded as an INLINE FACTORY, straight out of the
		// always-on `CORE_BUILTIN_EXTENSIONS` list, and NOT through
		// `loadExtensions(path)`. That matters for more than convenience: the
		// path loader gives the extension its own module registry, so its
		// `rewind.ts` would be a SECOND copy with its own counter — the gate
		// would read a map this test never writes to and every assertion here
		// would pass vacuously. Sharing one module instance is what makes this
		// case falsifiable.
		const entry = CORE_BUILTIN_EXTENSIONS.find((e) => typeof e !== "function" && e.name === "checkpoints");
		if (!entry || typeof entry === "function") throw new Error("checkpoints builtin not in CORE_BUILTIN_EXTENSIONS");
		const factory: ExtensionFactory = entry.factory;
		// One runtime and one bus, shared between the load and the runner, as
		// `loadExtensionsInternal` does.
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			factory,
			repo,
			createEventBus(),
			runtime,
			"<inline:checkpoints>",
		);
		const authStorage = AuthStorage.inMemory();
		const modelRegistry = await createModelRegistry(authStorage);
		const runner = new ExtensionRunner([extension], runtime, repo, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, extensionContextActions);
		const asks: string[] = [];
		runner.setUIContext(recordingUI(asks), "tui");

		/** Replays what `navigateTree` emits around a `/tree` move to `u1`. */
		const navigateToFirstCheckpoint = async () => {
			const beforeTree: SessionBeforeTreeEvent = {
				type: "session_before_tree",
				preparation: {
					targetId: u1,
					oldLeafId: u2,
					commonAncestorId: null,
					entriesToSummarize: [],
					userWantsSummary: false,
				},
				signal: new AbortController().signal,
			};
			const result = await runner.emit(beforeTree);
			await runner.emit({ type: "session_tree", newLeafId: u1, oldLeafId: u2 } as never);
			return result;
		};

		return {
			repo,
			sessionManager,
			runner,
			manager,
			u1,
			u2,
			asks,
			checkpointedTree,
			editedTree,
			navigateToFirstCheckpoint,
		};
	}

	/** Parks a rewind for `sessionId` and returns the release. */
	function parkRewindFor(sessionId: string) {
		const parked = parkingManager();
		const rewind = performRewind({
			sessionId,
			scope: "files-only",
			targetEntryId: "target",
			currentEntryId: "leaf",
			manager: parked.manager,
			navigate: () => {
				throw new Error("files-only must never navigate");
			},
		});
		return {
			entered: parked.entered,
			release: async () => {
				parked.open();
				await rewind;
			},
		};
	}

	it("still offers session B's /tree file restore while session A is rewinding", async () => {
		const rewinding = await attachableSession("ra");
		const b = await treeFixture("rb");

		// Session A parks inside its rewind and stays there for the whole of
		// session B's navigation.
		const parked = parkRewindFor(rewinding.sessionId);
		await parked.entered;
		expect(isRewindInProgress(rewinding.sessionId)).toBe(true);
		expect(isRewindInProgress(b.sessionManager.getSessionId())).toBe(false);

		const vetoed = await b.navigateToFirstCheckpoint();

		// The offer reached B's user, and accepting it restored B's tree.
		// `emit` returns undefined when nothing vetoed, so `vetoed?.cancel` being
		// falsy would hold even if no handler had run at all; the ask on the next
		// line is what says the builtin ran, this says it did not cancel.
		expect(vetoed).toBeUndefined();
		expect(b.asks).toEqual(["Restore files?"]);
		expect(snapshotWorkingTree(b.repo)).toEqual(b.checkpointedTree);

		await parked.release();
	}, 120_000);

	it("still suppresses a session's own /tree offer while that session rewinds (R42-RWD.7)", async () => {
		const b = await treeFixture("sb");

		// The gate's original job: `/rewind` already asked for a scope and moves
		// the leaf through navigateTree, so the offer must NOT be asked again.
		// This is what pins the reader to `ctx.sessionManager.getSessionId()`:
		// any other id would leave the offer standing here.
		const parked = parkRewindFor(b.sessionManager.getSessionId());
		await parked.entered;

		const vetoed = await b.navigateToFirstCheckpoint();

		expect(vetoed).toBeUndefined();
		expect(b.asks).toEqual([]);
		expect(snapshotWorkingTree(b.repo)).toEqual(b.editedTree);

		// Silence is only evidence if the handler was live. Release the rewind and
		// replay the SAME navigation on the SAME runner: the offer comes back.
		// Without this, an unloaded builtin, a mis-wired seam, or a second
		// `rewind.ts` module instance would all produce the identical `[]` above.
		await parked.release();
		expect(isRewindInProgress(b.sessionManager.getSessionId())).toBe(false);

		const afterwards = await b.navigateToFirstCheckpoint();
		expect(afterwards).toBeUndefined();
		expect(b.asks).toEqual(["Restore files?"]);
		expect(snapshotWorkingTree(b.repo)).toEqual(b.checkpointedTree);
	}, 120_000);

	// ── The writer's argument ────────────────────────────────────────────────

	/**
	 * The three cases above pin the READER: `confirmRestore` asks the gate about
	 * `ctx.sessionManager.getSessionId()`. None of them pins the WRITER - the
	 * `sessionId:` that `InteractiveMode.runRewind` hands `performRewind` - and
	 * that argument was measured unpinned: replacing it with a constant left all
	 * four rewind suites green.
	 *
	 * What breaks under that constant is not subtle. The user answers the scope
	 * prompt, `runRewind` moves the leaf through `navigateTree`,
	 * `session_before_tree` fires, the gate looks up a key the writer never
	 * wrote, and "Restore files?" is asked a SECOND time in the middle of the
	 * rewind whose scope was just answered (R42-RWD.7).
	 *
	 * There is exactly one `new InteractiveMode(` in the tree (main.ts, behind a
	 * full TUI), so the writer is driven off the prototype over a context whose
	 * `sessionManager` is the REAL one - no seam is added to the source. The id
	 * the writer reads, the map `performRewind` writes and the builtin that reads
	 * it back are all production code sharing one module instance, which is what
	 * makes this falsifiable (see the note in `treeFixture`).
	 */
	it("registers the gate under the session the /rewind writer is rewinding", async () => {
		const b = await treeFixture("wb");
		const statuses: string[] = [];
		const errors: string[] = [];
		let navigatedDuringRewind = false;
		let vetoMidRewind: { cancel?: boolean } | undefined;

		const context: RewindWriterContext = {
			isRewindRunning: false,
			editor: { getText: () => "", setText: () => {} },
			session: {
				isStreaming: false,
				extensionRunner: b.runner,
				// What `AgentSession.navigateTree` does from inside the rewind: fire
				// the very `/tree` seam the checkpoints builtin makes its offer on.
				navigateTree: async () => {
					navigatedDuringRewind = true;
					vetoMidRewind = await b.navigateToFirstCheckpoint();
					return { cancelled: false };
				},
			},
			sessionManager: b.sessionManager,
			chatContainer: { clear: () => {} },
			renderInitialMessages: () => {},
			flushCompactionQueue: async () => {},
			showStatus: (message) => statuses.push(message),
			showError: (message) => errors.push(message),
			ui: { requestRender: () => {} },
		};

		await rewindWriter.runRewind.call(context, b.u1, "conversation-and-files", b.manager);

		// The rewind did its own job: both halves moved, nothing was reported.
		expect(errors).toEqual([]);
		expect(statuses.join("\n")).toContain("Rewound conversation and files");
		expect(snapshotWorkingTree(b.repo)).toEqual(b.checkpointedTree);

		// The navigation happened inside the rewind and nothing vetoed it, so the
		// builtin's `session_before_tree` handler ran while the rewind was live.
		expect(navigatedDuringRewind).toBe(true);
		expect(vetoMidRewind).toBeUndefined();

		// THE POINT: it ran and stayed silent, because the writer registered the
		// gate under THIS session's id. A constant there - or any id that is not
		// `sessionManager.getSessionId()` - puts "Restore files?" right here.
		expect(b.asks).toEqual([]);

		// And the silence was the gate, not a dead wire: once the rewind is over,
		// the same navigation on the same runner asks.
		expect(isRewindInProgress(b.sessionManager.getSessionId())).toBe(false);
		await b.navigateToFirstCheckpoint();
		expect(b.asks).toEqual(["Restore files?"]);
	}, 120_000);
});
