import { Hono } from "hono";
import type { DomainEvent, EventBus, EventMap } from "../../session/event-bus.js";

/** All session domain events forwarded over SSE. */
const ALL_EVENTS: DomainEvent[] = ["session:created", "session:started", "session:stopped", "session:destroyed"];

/**
 * Format a single SSE frame.
 *
 * Follows the EventSource protocol:
 * ```
 * event: <name>\ndata: <json>\n\n
 * ```
 *
 * @param event - The SSE event name.
 * @param data  - Any JSON-serialisable payload.
 * @returns A UTF-8 encoded SSE frame.
 */
function sseFrame(event: string, data: unknown): Uint8Array {
	const json = JSON.stringify(data);
	const frame = `event: ${event}\ndata: ${json}\n\n`;
	return new TextEncoder().encode(frame);
}

/**
 * createSseRoutes — factory that builds a Hono sub-app for the SSE event stream.
 *
 * Mount with: `app.route('/events', createSseRoutes(bus))`
 *
 * Routes:
 *   GET / → text/event-stream; emits all four session lifecycle events in real time.
 *
 * The stream stays open indefinitely. When the client disconnects (abort signal),
 * all four event listeners are removed from the bus and the stream is closed cleanly.
 *
 * @param bus - The domain EventBus to subscribe to.
 * @returns A Hono sub-app with a single GET / route.
 */
export function createSseRoutes(bus: EventBus): Hono {
	const app = new Hono();

	app.get("/", (c) => {
		const { signal } = c.req.raw;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// Subscribe to all domain events and forward as SSE frames
				const unsubscribers = ALL_EVENTS.map((event) => {
					return bus.on(event, (payload: EventMap[typeof event]) => {
						try {
							controller.enqueue(sseFrame(event, payload));
						} catch {
							// Stream already closed (race between abort and emit); ignore
						}
					});
				});

				// Cleanup on client disconnect
				const cleanup = (): void => {
					for (const unsub of unsubscribers) unsub();
					try {
						controller.close();
					} catch {
						// Already closed; ignore
					}
				};

				signal.addEventListener("abort", cleanup, { once: true });
			},
		});

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				// Instruct nginx and other reverse proxies not to buffer the SSE stream.
				// Without this, events may be held in the proxy buffer and never reach
				// the client until the buffer flushes.
				"X-Accel-Buffering": "no",
				Connection: "keep-alive",
			},
		});
	});

	return app;
}
