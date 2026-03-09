/**
 * Session streaming routes (SSE) for individual session output.
 *
 * GET /sessions/:id/stream — text/event-stream of session stdout/stderr
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
 *   GET /:id/stream → text/event-stream of session output
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
				// If session has a process, subscribe to its output
				if (session.process) {
					const unsubscribe = session.process.onOutput((data) => {
						try {
							controller.enqueue(
								sseFrame("output", {
									sessionId,
									data,
									stream: "stdout",
								}),
							);
						} catch {
							// Stream closed
						}
					});

					// Cleanup on disconnect or process exit
					const cleanup = () => {
						unsubscribe();
						try {
							controller.close();
						} catch {
							// Already closed
						}
					};

					signal.addEventListener("abort", cleanup, { once: true });

					// Also close stream when process exits
					session.process.exited
						.then(() => {
							try {
								controller.enqueue(sseFrame("ended", { sessionId }));
								controller.close();
							} catch {
								// Already closed
							}
						})
						.catch(() => {
							try {
								controller.close();
							} catch {
								// Already closed
							}
						});
				} else {
					// No process - send a "ready" event and keep connection open
					// This allows clients to connect even if session hasn't spawned yet
					try {
						controller.enqueue(sseFrame("ready", { sessionId, status: session.status }));
					} catch {
						// Stream closed
					}

					// Close on client disconnect
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
				}
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
