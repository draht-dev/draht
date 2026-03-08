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
 * Reject a WebSocket connection with a domain-specific close code.
 * Extracted to avoid duplication across guard paths.
 */
function rejectWs(ws: WSContext, code: number, reason: string): void {
	ws.close(code, reason);
}

/**
 * Guard: validate that the session exists and is running.
 * Returns `true` if the guard triggered (i.e., the caller should return early).
 * Returns `false` if the session is valid and the caller may proceed.
 */
function guardSession(session: Session | undefined, ws: WSContext): boolean {
	if (!session) {
		rejectWs(ws, 4404, "Session not found");
		return true;
	}
	if (session.status !== "running") {
		rejectWs(ws, 4403, "Session not running");
		return true;
	}
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
					const session = manager.get(id);
					if (guardSession(session, ws)) return;

					// session is guaranteed running with a process here
					const proc = session!.process!;

					// Stream stdout to this WebSocket client
					unsub = proc.onOutput((data) => {
						try {
							ws.send(data);
						} catch {
							// Socket may be closing — ignore send errors
						}
					});

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

				onClose(_evt, _ws) {
					if (unsub) {
						unsub();
						unsub = null;
					}
				},

				onError(_evt, _ws) {
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
