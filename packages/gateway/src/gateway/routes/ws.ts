import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import type { Session } from "../../session/session.js";
import type { SessionManager } from "../../session/session-manager.js";

/**
 * Maximum size in bytes accepted for a single WebSocket message forwarded to
 * the session's stdin. Messages exceeding this limit are silently dropped to
 * prevent a misbehaving or malicious client from exhausting the stdin pipe
 * buffer. 64 KiB matches a typical pipe-buffer size and is generous for any
 * interactive command input.
 */
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * Global map of session ID -> Set of connected WebSockets
 * Used to notify WebSockets when a process is lazy-spawned
 */
const sessionWebSockets = new Map<string, Set<WSContext>>();

/**
 * Notify all connected WebSockets for a session that a process has been attached.
 * Called after lazy-spawning a process.
 */
export function notifyWebSocketsProcessAttached(sessionId: string, session: Session): void {
	const sockets = sessionWebSockets.get(sessionId);
	if (!sockets || !session.process) return;

	console.log(`[WS] Notifying ${sockets.size} WebSocket(s) about new process for session ${sessionId}`);

	for (const ws of sockets) {
		// Subscribe this WebSocket to the new process output
		const proc = session.process;

		const unsub = proc.onOutput((data) => {
			try {
				ws.send(data);
			} catch {
				// Socket may be closing — ignore send errors
			}
		});

		// Store unsubscribe function so we can clean up later
		(ws as any).__processUnsub = unsub;

		// Close WebSocket when process exits
		const closeOnExit = () => {
			try {
				ws.close(1001, "Process exited");
			} catch {
				// Socket may already be closed
			}
		};
		proc.exited.then(closeOnExit).catch(closeOnExit);
	}
}

/**
 * Reject a WebSocket connection with a domain-specific close code.
 * Extracted to avoid duplication across guard paths.
 */
function rejectWs(ws: WSContext, code: number, reason: string): void {
	ws.close(code, reason);
}

/**
 * Guard: validate that the session exists.
 * Returns `true` if the guard triggered (i.e., the caller should return early).
 * Returns `false` if the session is valid and the caller may proceed.
 *
 * Note: We no longer require session.status === "running" because:
 * - Adler creates sessions without processes (status: "starting")
 * - WebSocket should connect even if process hasn't spawned yet
 * - This allows lazy spawning or manual process attachment
 */
function guardSession(session: Session | undefined, ws: WSContext): boolean {
	if (!session) {
		rejectWs(ws, 4404, "Session not found");
		return true;
	}
	// Removed status check - allow connections to any session
	return false;
}

/**
 * createWsRoutes — factory for the WebSocket sub-app.
 *
 * Mount with: `app.route('/sessions', createWsRoutes(manager))`
 *
 * Routes:
 *   GET /:id/ws  → WebSocket upgrade; streams session stdout, forwards client input to stdin.
 */
export function createWsRoutes(manager: SessionManager): Hono {
	const app = new Hono();

	app.get(
		"/:id/ws",
		upgradeWebSocket((c) => {
			// c.req.param("id") is string | undefined in general; assert present since
			// the route pattern /:id/ws guarantees the capture exists at match time.
			const id: string = c.req.param("id") ?? "";

			// stdout unsubscribe handle — populated in onOpen, cleaned up in onClose/onError
			let unsub: (() => void) | null = null;

			return {
				onOpen(_evt, ws) {
					console.log(`[WS] WebSocket opened for session ${id}`);
					const session = manager.get(id);
					if (guardSession(session, ws)) return;

					// Track this WebSocket connection
					if (!sessionWebSockets.has(id)) {
						sessionWebSockets.set(id, new Set());
					}
					sessionWebSockets.get(id)!.add(ws);
					console.log(`[WS] Total connections for session ${id}: ${sessionWebSockets.get(id)!.size}`);

					// If session has a process, subscribe to its output
					if (session!.process) {
						console.log(`[WS] Session has process, subscribing to output`);
						const proc = session!.process;

						// Stream stdout to this WebSocket client
						unsub = proc.onOutput((data) => {
							try {
								ws.send(data);
							} catch {
								// Socket may be closing — ignore send errors
							}
						});

						// Store unsub so we can call it later
						(ws as any).__processUnsub = unsub;

						// When the process exits (naturally or via kill), close the WebSocket gracefully.
						// The .catch handles the rare case where exited rejects (e.g. killed with SIGKILL).
						const closeOnExit = () => {
							try {
								ws.close(1001, "Process exited");
							} catch {
								// Socket may already be closed — ignore
							}
						};
						proc.exited.then(closeOnExit).catch(closeOnExit);
					} else {
						console.log(`[WS] Session has no process yet, waiting for lazy spawn...`);
						// No process yet - connection stays open
						// Will be notified via notifyWebSocketsProcessAttached() when process spawns
					}
				},

				onMessage(evt, ws) {
					const session = manager.get(id);
					if (!session?.process) return;

					const raw = String(evt.data);

					// Guard against excessively large stdin payloads
					if (new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) {
						// Close with a policy-violation code rather than silently dropping,
						// so clients can detect the limit and adapt.
						rejectWs(ws, 1009, "Message too large");
						return;
					}

					session.process.write(raw);
				},

				onClose(_evt, ws) {
					console.log(`[WS] WebSocket closed for session ${id}`);

					// Remove from tracking
					const sockets = sessionWebSockets.get(id);
					if (sockets) {
						sockets.delete(ws);
						if (sockets.size === 0) {
							sessionWebSockets.delete(id);
						}
					}

					// Clean up process subscription
					const storedUnsub = (ws as any).__processUnsub;
					if (storedUnsub) {
						storedUnsub();
						(ws as any).__processUnsub = null;
					}
					if (unsub) {
						unsub();
						unsub = null;
					}
				},

				onError(_evt, ws) {
					console.log(`[WS] WebSocket error for session ${id}`);

					// Remove from tracking
					const sockets = sessionWebSockets.get(id);
					if (sockets) {
						sockets.delete(ws);
						if (sockets.size === 0) {
							sessionWebSockets.delete(id);
						}
					}

					// Clean up process subscription
					const storedUnsub = (ws as any).__processUnsub;
					if (storedUnsub) {
						storedUnsub();
						(ws as any).__processUnsub = null;
					}
					if (unsub) {
						unsub();
						unsub = null;
					}
				},
			};
		}),
	);

	return app;
}
