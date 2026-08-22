/**
 * Integration layer between AgentSession and SocketServer
 *
 * Wires up socket server to broadcast agent output and forward client input.
 */

import path from "node:path";
import { APP_NAME, getAgentDir } from "../../config.js";
import type { AgentSession } from "../agent-session.js";
import type { PermissionRelay } from "../permission-relay/types.js";
import { PermissionDelivery } from "./permission-delivery.js";
import { type PermissionEntry, PermissionRegistry } from "./permission-registry.js";
import { createSocketPermissionRelay, type SocketPermissionRelay } from "./permission-relay.js";
import { SocketServer } from "./socket-server.js";

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

	const bind = async (session: AgentSession, cwd: string): Promise<SocketServer> => {
		// Get session ID from the session manager header
		const header = session.sessionManager.getHeader();
		if (!header) {
			throw new Error("Cannot make session attachable: no session header found");
		}

		const next = new SocketServer({
			sessionId: header.id,
			socketDir,
			cwd,
			maxClients: 10,
			broadcastInputEcho: true,
		});

		await next.start();
		unsubscribe = subscribeToSession(session, next);

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
		next.onAttachReplay((clientId) => {
			bound.replayTo(clientId);
		});
		// Per-connection bookkeeping only. The ask itself is untouched: a client that was shown an
		// ask and then died must not take that ask with it.
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
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					next.sendErrorToClient(clientId, `Prompt failed: ${message}`, "PROMPT_FAILED");
				});
		});

		return next;
	};

	server = await bind(options.session, options.cwd);

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

				server = await bind(nextSession, nextCwd);
			} catch (error) {
				// A failed rebind must not break the session switch itself. The socket stays
				// closed, so the session simply stops being attachable.
				server = null;
				relay = null;
				cancelPending = null;
				const message = error instanceof Error ? error.message : String(error);
				warn(`Attachable session could not follow the session switch: ${message}`);
			}
		},

		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
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
