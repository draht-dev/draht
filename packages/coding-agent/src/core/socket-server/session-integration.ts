/**
 * Integration layer between AgentSession and SocketServer
 *
 * Wires up socket server to broadcast agent output and forward client input.
 */

import path from "node:path";
import { APP_NAME, getAgentDir } from "../../config.js";
import type { AgentSession } from "../agent-session.js";
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

		// Forward input from socket clients to session
		next.onInput((data: string, clientId: string) => {
			// AgentSession.prompt() rejects for ordinary reasons - most commonly a prompt sent
			// while the agent is already streaming. An unhandled rejection here would take the
			// whole agent down under Node's default --unhandled-rejections=throw, so remote
			// input must never be left floating: report the failure to the client that sent it
			// and keep the session running.
			void Promise.resolve()
				.then(() => session.prompt(data))
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					next.sendErrorToClient(clientId, `Prompt failed: ${message}`, "PROMPT_FAILED");
				});
		});

		return next;
	};

	server = await bind(options.session, options.cwd);

	log(`\n🔗 Attachable session started: ${server.sessionId}`);
	log(`   Socket: ${server.socketPath}`);
	log(`   Attach: ${APP_NAME} --attach ${server.sessionId}\n`);

	return {
		get socketPath(): string | null {
			return server?.socketPath ?? null;
		},
		get sessionId(): string | null {
			return server?.sessionId ?? null;
		},

		async rebind(nextSession: AgentSession, nextCwd: string): Promise<void> {
			if (stopped) return;
			try {
				unsubscribe?.();
				unsubscribe = null;

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
				const message = error instanceof Error ? error.message : String(error);
				warn(`Attachable session could not follow the session switch: ${message}`);
			}
		},

		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			unsubscribe?.();
			unsubscribe = null;
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
		const handler = (): void => {
			// Another listener owns this signal (interactive/print/rpc mode's graceful
			// shutdown, or the Ctrl+Z SIGINT guard). Those paths either end in process.exit(),
			// where the "exit" listener above removes the files, or deliberately keep the
			// process alive - in which case deleting the socket here would be wrong.
			if (process.listenerCount(signal) > 1) return;
			handle.stopSync();
			// Nobody else handles this signal: restore the default disposition and re-raise it
			// so the process still dies from the signal it was sent.
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
