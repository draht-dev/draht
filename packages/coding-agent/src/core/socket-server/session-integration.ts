/**
 * Integration layer between AgentSession and SocketServer
 *
 * Wires up socket server to broadcast agent output and forward client input.
 */

import path from "node:path";
import { APP_NAME, getAgentDir } from "../../config.js";
import type { AgentSession } from "../agent-session.js";
import type { PermissionRelay } from "../permission-relay/types.js";
import { getSoakLog, SOAK_EVENTS, type SoakLog, startupDeltaMs } from "../soak/soak-log.js";
import { PermissionDelivery } from "./permission-delivery.js";
import { type PermissionEntry, PermissionRegistry } from "./permission-registry.js";
import { createSocketPermissionRelay, type SocketPermissionRelay } from "./permission-relay.js";
import { SocketServer } from "./socket-server.js";

/**
 * SOAK RECORDING (R35-ALWAYS.11). Every seam below hands the process-wide soak log
 * one line and returns; nothing here may do anything else.
 *
 * THE THREE RULES, and they are the whole contract of this helper:
 *   • NEVER stdout, NEVER stderr. The TUI owns the terminal and a default-on
 *     session's streams are asserted identical to a feature-off run, so one stray
 *     byte from here surfaces as somebody else's regression.
 *   • NEVER throw into a caller. `SoakLog` swallows its own failures; this wrapper
 *     covers the one thing it cannot, which is failing to be constructed at all.
 *   • NEVER build a record any other way than `log.record()` / `log.heartbeat()`.
 *     Those stamp the mandatory fields (wall, pid, rss, sessionId…) LAST, over the
 *     caller's, which is what keeps a seam field innocently named `pid` — the lock
 *     files carry one — from shadowing the record's own and getting the whole line
 *     dropped by the reader as malformed.
 *
 * SCOPE LIMIT, stated rather than implied: this records what the SESSION PROCESS
 * observes. A tailnet drop, a daemon restart, a gateway-side refusal — none of
 * those are visible from here, and Phase 35 does not cover them. The daemon half
 * is a SEPARATE writer implementing the file-format contract documented at the top
 * of `soak/soak-log.ts`; it must not import this module or share one with it,
 * because Phase 38's boundary gate forbids a module spanning that line. The two
 * halves are joined at verdict time by `sessionId` and `wall`.
 */
function soak(use: (log: SoakLog) => void): void {
	try {
		use(getSoakLog());
	} catch {
		// Deliberately empty, and deliberately not logged anywhere.
	}
}

/**
 * A prompt that arrived over the socket and did not simply run.
 *
 * The prompt TEXT is never recorded — only how long it was. This file writes into
 * a log that is kept for weeks and read by a verdict tool; "what did the operator
 * type from their phone" is not a question a resilience soak needs answered, and a
 * log that could answer it is one more place a secret can end up.
 */
function recordPromptRejected(code: string, clientId: string, prompt: string, reason?: string): void {
	soak((log) =>
		log.record(
			SOAK_EVENTS.PROMPT_REJECTED,
			{
				code,
				clientId,
				promptChars: prompt.length,
				...(reason === undefined ? {} : { reason }),
			},
			code === "PROMPT_FAILED" ? "error" : "info",
		),
	);
}

export interface AttachableSessionOptions {
	session: AgentSession;
	enabled: boolean;
	/**
	 * Working directory of the session, recorded in the lock file so discovery can
	 * report which project a session belongs to. This is the session's resolved cwd,
	 * which differs from `process.cwd()` when a session from another project is
	 * selected via --session/--resume.
	 */
	cwd: string;
	/** Reports non-fatal problems (default: stderr). */
	onWarning?: (message: string) => void;
	/** Prints the startup banner (default: stdout). */
	log?: (message: string) => void;
	/**
	 * Whether to print the three-line "Attachable session started" banner (default: true).
	 *
	 * Interactive mode does NOT take over stdout (main.ts only calls `takeOverStdout()` for
	 * non-interactive modes), so under default-on this banner would print a socket path into
	 * every session's scrollback in the instant before the TUI claims the terminal. Measured,
	 * it is the ENTIRE stdout delta of default-on. The implicit path passes `announce: false`;
	 * an explicit `--attachable` keeps the banner, because someone who typed the flag is
	 * entitled to be told the socket exists and where.
	 */
	announce?: boolean;
}

/**
 * Handle for a session exposed on a Unix socket.
 *
 * The socket is bound to one session at a time. When the runtime replaces the session
 * (/new, /resume, /fork, /import) the old session object is disposed, so the handle has
 * to follow along via {@link AttachableSession.rebind}.
 */
export interface AttachableSession {
	/** Path of the socket currently bound, or null when attachable mode is off or stopped. */
	readonly socketPath: string | null;
	/** Session id the socket currently advertises, or null when nothing is bound. */
	readonly sessionId: string | null;
	/**
	 * The pending-ask registry's public face, or null when nothing is bound.
	 *
	 * Hand this to {@link AgentSession.setPermissionRelay} — and hand the CURRENT one over again
	 * after every {@link AttachableSession.rebind}, because a rebind builds a new registry for the
	 * new session and the old handle is dead. The relay lives here, in this closure, and NOT in the
	 * UI decorator: a new `ExtensionRunner` (and therefore a new decorator) is built on every
	 * extension reload, which would orphan every ask raised before it with the agent still parked
	 * on the answer.
	 */
	readonly relay: PermissionRelay | null;
	/** Follow a session replacement: close the old socket and bind one for the new session. */
	rebind(session: AgentSession, cwd: string): Promise<void>;
	/** Close the socket and remove the .sock/.lock files. */
	stop(): Promise<void>;
	/** Same as {@link stop}, for synchronous exit paths (`process.on("exit")`, signals). */
	stopSync(): void;
}

const DISABLED_SESSION: AttachableSession = {
	socketPath: null,
	sessionId: null,
	// No socket, so nobody can be asked anything remotely. Handing this to a session would make
	// `hasUI()` claim a surface that does not exist.
	relay: null,
	rebind: async () => {},
	stop: async () => {},
	stopSync: () => {},
};

/**
 * Wrap an agent session with a socket server if attachable mode is enabled.
 *
 * Returns a handle that owns the socket's lifetime.
 */
export async function makeSessionAttachable(options: AttachableSessionOptions): Promise<AttachableSession> {
	if (!options.enabled) {
		return DISABLED_SESSION;
	}

	const agentDir = getAgentDir();
	const socketDir = path.join(agentDir, "sockets");
	const warn = options.onWarning ?? ((message: string) => console.error(message));
	const log = options.log ?? ((message: string) => console.log(message));

	let server: SocketServer | null = null;
	let unsubscribe: (() => void) | null = null;
	let stopped = false;
	/**
	 * The relay for the session currently bound.
	 *
	 * It lives HERE, in the bind closure, for one reason each way: it must die with the session
	 * (an ask belongs to the session that raised it and may not survive into its replacement), and
	 * it must survive CLIENT CHURN (`#handleClientDisconnect` only removes a client, so a phone
	 * that drops its connection mid-ask must be able to reconnect and be shown the same ask). A
	 * relay in the UI decorator would satisfy neither: that object is rebuilt on every extension
	 * reload.
	 */
	let relay: SocketPermissionRelay | null = null;
	/** Ends every pending ask fail-closed. Set alongside {@link relay}; null when nothing is bound. */
	let cancelPending: (() => void) | null = null;

	/**
	 * The last thing this handle records, from whichever exit path reached it.
	 *
	 * Both callers are guarded by `stopped`, so exactly one `socket_teardown` is
	 * written per handle — which is what makes "every bind has a teardown" a claim a
	 * verdict can check rather than a hope. The heartbeat is stopped here and the
	 * client-count provider dropped with it: it closes over a server that is about to
	 * be gone.
	 */
	const recordTeardown = (exitPath: "stop" | "stopSync"): void => {
		soak((log) => {
			log.record(SOAK_EVENTS.SOCKET_TEARDOWN, {
				exitPath,
				socketPath: server?.socketPath ?? null,
				clients: server?.clientCount ?? 0,
			});
			log.stopHeartbeat();
			log.setClientCountProvider(undefined);
		});
	};

	/**
	 * `previousSessionId` is null for the FIRST bind of this process and carries the
	 * outgoing session's id for every later one, which is the only thing that tells a
	 * `socket_bind` from a `socket_rebind` in the log: both end with a live socket,
	 * but only one of them means a client that was attached has been dropped.
	 */
	const bind = async (session: AgentSession, cwd: string, previousSessionId: string | null): Promise<SocketServer> => {
		// Get session ID from the session manager header
		const header = session.sessionManager.getHeader();
		if (!header) {
			throw new Error("Cannot make session attachable: no session header found");
		}

		// Stamped BEFORE start(), so a bind that is REFUSED — the socket cap, a busy
		// twin — still records under the session it was refused for. Everything the
		// writer stamps from here on carries this id, which is what lets Phase 39 join
		// this stream against the session's own durable rows.
		soak((log) => log.setSessionId(header.id));

		const next = new SocketServer({
			sessionId: header.id,
			socketDir,
			cwd,
			maxClients: 10,
			broadcastInputEcho: true,
		});

		await next.start();
		unsubscribe = subscribeToSession(session, next);

		soak((log) => {
			// The live client count for the heartbeat comes from the server itself, so a
			// gauge never disagrees with the thing it measures.
			log.setClientCountProvider(() => next.clientCount);
			log.record(previousSessionId === null ? SOAK_EVENTS.SOCKET_BIND : SOAK_EVENTS.SOCKET_REBIND, {
				socketPath: next.socketPath,
				cwd,
				// R39-RESIL.6 wants the startup delta by name. It equals the `uptimeMs` the
				// writer stamps on every record; carrying it explicitly means a verdict tool
				// can ask a bind for "how long did this session take to publish itself" without
				// knowing that the two are the same number.
				startupDeltaMs: startupDeltaMs(),
				...(previousSessionId === null ? {} : { previousSessionId, outcome: "bound" }),
			});
			// ONE heartbeat right now, before the interval's first tick. A session shorter
			// than the heartbeat period would otherwise contribute no gauge at all, and the
			// fd/socket gauges at bind are the baseline every later heartbeat is read
			// against. `startHeartbeat` is idempotent and its timer is unref'd, so a rebind
			// neither starts a second one nor keeps the process alive.
			log.heartbeat();
			log.startHeartbeat();
		});

		// ── the permission relay for THIS session ──────────────────────────────────────────────
		const registry = new PermissionRegistry({ sessionId: header.id });
		const delivery = new PermissionDelivery<PermissionEntry>({ pending: () => registry.pending() });
		/**
		 * Whether THIS bind still owns the socket. A relay whose session was replaced or stopped
		 * must write nothing: a late timer or a straggling socket callback would otherwise reach a
		 * server that has already been torn down.
		 */
		let boundLive = true;
		const bound = createSocketPermissionRelay({
			registry,
			delivery,
			server: () => (boundLive ? next : null),
			recorder: () => session.sessionManager,
			sessionId: header.id,
			cwd,
			onWarning: warn,
		});
		relay = bound;
		cancelPending = () => {
			// Cancel FIRST — the announcement has to go out while the socket is still up — and only
			// then close the door behind it.
			bound.cancelAll();
			boundLive = false;
		};

		// An answer is NOT input. It must never reach the `onInput` funnel below, which hands
		// everything it receives to `session.prompt(...)` — that is exactly how a "Yes" tapped on
		// a phone became a queued chat message while the agent sat waiting for a decision nobody
		// could deliver.
		next.onPermissionResponse((message, clientId) => {
			bound.handleResponse(message, clientId);
		});
		// Fired right after `session_metadata`, so a client that attached mid-ask is shown it on a
		// surface that already knows which session it is looking at. Replay is a SEND, not a state
		// transition: the ask stays pending until somebody actually answers it.
		//
		// NOT the `client_attach` soak seam, though it is the obvious candidate and the
		// plan named it: this callback is gated by `#mayReceivePermissionFrames`, so a
		// read-only peer, or any client built before geist/0.3 that declares no
		// capabilities, attaches WITHOUT reaching it. Recording here would have paired
		// every such client's `client_detach` — which is ungated — with no attach at all,
		// and Phase 39 counts attaches against detaches. Both records are therefore made
		// one layer down, at the connection bookkeeping in `socket-server.ts`, where the
		// two seams are symmetric by construction.
		next.onAttachReplay((clientId) => {
			bound.replayTo(clientId);
		});
		// Per-connection bookkeeping only. The ask itself is untouched: a client that was shown an
		// ask and then died must not take that ask with it.
		// The matching half of the note above: `client_detach` is recorded in
		// `socket-server.ts`, not here.
		next.onClientDisconnect((clientId) => {
			bound.forgetClient(clientId);
		});

		// Forward input from socket clients to session
		next.onInput((data: string, clientId: string) => {
			// Concurrent-writer policy (R32-FLEET.7): QUEUE, and say so.
			//
			// Without a `streamingBehavior`, AgentSession.prompt() refuses outright while the
			// agent is mid-turn. Over a socket that refusal reached only the sender, while every
			// OTHER attached client had already been shown the prompt as an `input_echo` - so on
			// a second screen the message appeared, was never answered, and was never explained.
			// That is precisely the "vanished message" a phone must never be shown.
			//
			// `followUp` is the queueing mode chosen over `steer`: the running turn finishes
			// exactly as it would have (steering rewrites what the agent is currently doing,
			// which no remote client can see well enough to intend), the queued prompt runs next,
			// and its output streams to every attached client like any other turn. Order is
			// preserved, and nothing is dropped.
			//
			// Queuing silently would trade a vanished message for an unexplained pause, so the
			// client that sent it is told on the relayed error channel, under a code a renderer
			// can switch on rather than prose it would have to match.
			const queueing = session.isStreaming;
			// An unhandled rejection here would take the whole agent down under Node's default
			// --unhandled-rejections=throw, so remote input is never left floating: genuine
			// failures (no model, no credentials) are reported to the client that sent them and
			// the session keeps running.
			void Promise.resolve()
				.then(() => session.prompt(data, { streamingBehavior: "followUp" }))
				.then(() => {
					// `queueing` is sampled before the call and confirmed after it: a prompt that
					// was accepted immediately must not be announced as deferred, and a turn that
					// ended in between needs no notice because nothing is waiting.
					if (!queueing || !session.isStreaming) return;
					next.sendErrorToClient(
						clientId,
						"The agent is mid-turn. Your prompt was queued and runs when the current turn finishes.",
						"PROMPT_QUEUED",
					);
					// NO `requestId` here, and that is not an omission. A prompt over the
					// socket is not a permission ask: it creates no `PermissionResolutionEntry`
					// and there is nothing on the durable side to join it to. The records that
					// DO carry one are the permission refusals in `socket-server.ts`.
					recordPromptRejected("PROMPT_QUEUED", clientId, data);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					next.sendErrorToClient(clientId, `Prompt failed: ${message}`, "PROMPT_FAILED");
					recordPromptRejected("PROMPT_FAILED", clientId, data, message);
				});
		});

		return next;
	};

	server = await bind(options.session, options.cwd, null);

	if (options.announce !== false) {
		log(`\n🔗 Attachable session started: ${server.sessionId}`);
		log(`   Socket: ${server.socketPath}`);
		log(`   Attach: ${APP_NAME} --attach ${server.sessionId}\n`);
	}

	return {
		get socketPath(): string | null {
			return server?.socketPath ?? null;
		},
		get sessionId(): string | null {
			return server?.sessionId ?? null;
		},
		get relay(): PermissionRelay | null {
			return relay;
		},

		async rebind(nextSession: AgentSession, nextCwd: string): Promise<void> {
			if (stopped) return;
			// Read before anything is torn down: after the swap there is nothing left that
			// remembers which session the socket used to carry.
			const previousSessionId = server?.sessionId ?? null;
			try {
				unsubscribe?.();
				unsubscribe = null;

				// FAIL CLOSED FIRST, while the old socket is still open. These asks gate tool calls
				// in a session that is being replaced: nothing they authorise may proceed, the
				// agent arm holding each one has to be released rather than left dangling, and the
				// clients watching them have to be told — which is only possible before the server
				// they are attached to is stopped.
				cancelPending?.();
				cancelPending = null;
				relay = null;

				const previous = server;
				server = null;
				if (previous) {
					// Attached clients are watching a session that no longer exists; tell them
					// before the socket goes away so they can re-attach to the new one.
					previous.broadcastError(
						`Session replaced. Re-attach with: ${APP_NAME} --list-sessions`,
						"SESSION_REPLACED",
					);
					await previous.stop();
				}

				server = await bind(nextSession, nextCwd, previousSessionId);
			} catch (error) {
				// A failed rebind must not break the session switch itself. The socket stays
				// closed, so the session simply stops being attachable.
				server = null;
				relay = null;
				cancelPending = null;
				const message = error instanceof Error ? error.message : String(error);
				// A session that quietly stopped being attachable is exactly the kind of
				// disappearance a week-long soak is run to catch, and the notice above goes
				// to a terminal nobody will be reading in six days.
				soak((log) => {
					log.record(
						SOAK_EVENTS.SOCKET_REBIND,
						{ outcome: "failed", previousSessionId, reason: message },
						"error",
					);
					// The provider closes over a server that no longer exists. The heartbeat
					// itself keeps running: fd, rss and the directory gauges stay meaningful,
					// and a gap in them would look like the process died.
					log.setClientCountProvider(undefined);
				});
				warn(`Attachable session could not follow the session switch: ${message}`);
			}
		},

		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			// Recorded on ENTRY, not after the awaits below: `SocketServer.stop()` waits on
			// peers that may take the full close grace period, and a teardown nobody
			// recorded because the process was killed while waiting is a teardown Phase 39
			// reads as a session that vanished.
			recordTeardown("stop");
			unsubscribe?.();
			unsubscribe = null;
			// Before the socket goes away: an unanswered ask fails closed, is announced, and is
			// recorded. Anything still parked on one gets its `undefined` instead of hanging.
			cancelPending?.();
			cancelPending = null;
			relay = null;
			const current = server;
			server = null;
			await current?.stop();
		},

		stopSync(): void {
			if (stopped) return;
			stopped = true;
			// Synchronous, like everything else on this path: the writer appends with
			// `writeSync`, so this record survives `process.on("exit")` and a signal handler.
			recordTeardown("stopSync");
			try {
				unsubscribe?.();
			} catch {}
			unsubscribe = null;
			// Synchronous by construction — settle, announce and append are all synchronous — so
			// this works from `process.on("exit")` and from a signal handler.
			try {
				cancelPending?.();
			} catch {}
			cancelPending = null;
			relay = null;
			const current = server;
			server = null;
			current?.stopSync();
		},
	};
}

/**
 * Remove the socket on process exit and on signals.
 *
 * The mode run loops (interactive, print, rpc) end in `process.exit()` and never return
 * to their caller, so a `finally` around them is not enough: without this the .sock and
 * .lock files outlive the process and keep showing up in `--list-sessions`.
 *
 * @returns unregister function
 */
export function registerAttachableSessionCleanup(handle: Pick<AttachableSession, "stopSync">): () => void {
	const onExit = (): void => {
		handle.stopSync();
	};
	process.on("exit", onExit);

	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}

	const handlers = new Map<NodeJS.Signals, () => void>();
	for (const signal of signals) {
		/**
		 * Listeners that were ALREADY on this signal when the socket was registered.
		 *
		 * The guard below used to be `process.listenerCount(signal) > 1`, and under default-on
		 * that turned SIGINT into a no-op for every interactive session. Measured against the
		 * emitted binary: `proper-lockfile` pulls in `signal-exit`, which installs its own
		 * SIGINT/SIGTERM listener at import time — long before this function runs. That listener
		 * is a BOOKKEEPER, not an owner: it only acts when it is the sole listener
		 * (`listeners.length === emitter.count`) and otherwise assumes somebody else will end the
		 * process. So a plain `kill -INT` found two listeners, each of which deferred to the
		 * other, and the session survived a signal that killed it before the socket existed
		 * (control run: signal 2; default-on run: still alive at the 60 s deadline, socket and
		 * lock left on disk). Node applies the default disposition only when a signal has NO
		 * listener, so one polite listener is enough to make Ctrl+C stop working.
		 *
		 * The snapshot is the discriminator, and it is exact rather than heuristic because of
		 * WHERE this runs: `registerAttachableSessionCleanup` is called once, after the socket is
		 * bound and before any mode installs shutdown handling. Anything present at that instant
		 * came from a library that was already coping without us. Anything added AFTER is draht's
		 * own — interactive mode's graceful SIGTERM/SIGHUP shutdown, or the Ctrl+Z SIGINT guard —
		 * and those really do own the signal: the first ends in `process.exit()` (where the
		 * "exit" listener above removes the files) and the second deliberately keeps the process
		 * alive, where deleting the socket would be wrong.
		 */
		const preexisting = new Set<unknown>(process.listeners(signal));
		const handler = (): void => {
			const owners = (process.listeners(signal) as unknown[]).filter(
				(listener) => listener !== handler && !preexisting.has(listener),
			);
			if (owners.length > 0) return;
			handle.stopSync();
			// Nobody else owns this signal: drop out of the way and re-raise it so the process
			// still dies from the signal it was sent. The pre-existing bookkeeper now finds
			// itself alone and does its own re-raise, which reaches the default disposition.
			process.off(signal, handler);
			process.kill(process.pid, signal);
		};
		process.on(signal, handler);
		handlers.set(signal, handler);
	}

	return () => {
		process.off("exit", onExit);
		for (const [signal, handler] of handlers) {
			process.off(signal, handler);
		}
		handlers.clear();
	};
}

/**
 * Mirror session output onto the socket.
 *
 * @returns unsubscribe function
 */
function subscribeToSession(session: AgentSession, socketServer: SocketServer): () => void {
	return session.subscribe((event) => {
		// Broadcast different event types
		if (event.type === "message_update") {
			// Handle streaming updates (text and thinking deltas)
			const assistantEvent = event.assistantMessageEvent;
			if (assistantEvent.type === "text_delta") {
				socketServer.broadcastOutput(assistantEvent.delta, "stdout");
			} else if (assistantEvent.type === "thinking_delta") {
				socketServer.broadcastOutput(`[Thinking] ${assistantEvent.delta}\n`, "stdout");
			}
		} else if (event.type === "tool_execution_start") {
			socketServer.broadcastOutput(`\n[Tool: ${event.toolName}]\n`, "stdout");
		} else if (event.type === "tool_execution_end") {
			// Broadcast tool result
			const result = event.result;
			if (result?.content) {
				for (const content of result.content) {
					if (content.type === "text") {
						socketServer.broadcastOutput(`${content.text}\n`, "stdout");
					}
				}
			}
		}
	});
}
