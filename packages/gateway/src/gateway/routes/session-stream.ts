/**
 * Session streaming routes (SSE).
 *
 * GET /sessions/:id/stream — text/event-stream for one session record
 */

import { Hono } from "hono";
import type { SessionManager } from "../../session/session-manager.js";

/**
 * Format a single SSE frame.
 */
function sseFrame(event: string, data: unknown): Uint8Array {
	const json = JSON.stringify(data);
	const frame = `event: ${event}\ndata: ${json}\n\n`;
	return new TextEncoder().encode(frame);
}

/**
 * createSessionStreamRoutes — factory for session-specific SSE streams.
 *
 * Mount with: `app.route('/sessions', createSessionStreamRoutes(manager))`
 *
 * Routes:
 *   GET /:id/stream → text/event-stream: a `ready` event, then nothing until the client disconnects
 */
export function createSessionStreamRoutes(manager: SessionManager): Hono {
	const app = new Hono();

	app.get("/:id/stream", (c) => {
		const sessionId = c.req.param("id");
		const session = manager.get(sessionId);

		// 404 if session doesn't exist
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}

		const { signal } = c.req.raw;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// A session record has no process, so there is no output to stream:
				// send a "ready" event and keep the connection open until the client leaves.
				try {
					controller.enqueue(sseFrame("ready", { sessionId, status: session.status }));
				} catch {
					// Stream closed
				}

				signal.addEventListener(
					"abort",
					() => {
						try {
							controller.close();
						} catch {
							// Already closed
						}
					},
					{ once: true },
				);
			},
		});

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				"X-Accel-Buffering": "no",
				Connection: "keep-alive",
			},
		});
	});

	return app;
}
