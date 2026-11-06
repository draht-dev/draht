import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { SessionManager } from "../../session/session-manager.js";

/**
 * createWsRoutes — factory for the WebSocket sub-app.
 *
 * Mount with: `app.route('/sessions', createWsRoutes(manager))`
 *
 * Routes:
 *   GET /:id/ws  → WebSocket upgrade. Closes 4404 for an unknown id, otherwise
 *                  stays open and sends nothing: a session record has no process
 *                  to stream from, so client messages are ignored.
 */
export function createWsRoutes(manager: SessionManager): Hono {
	const app = new Hono();

	app.get(
		"/:id/ws",
		upgradeWebSocket((c) => {
			// c.req.param("id") is string | undefined in general; assert present since
			// the route pattern /:id/ws guarantees the capture exists at match time.
			const id: string = c.req.param("id") ?? "";

			return {
				onOpen(_evt, ws) {
					console.log(`[WS] WebSocket opened for session ${id}`);
					if (!manager.get(id)) ws.close(4404, "Session not found");
				},

				onClose() {
					console.log(`[WS] WebSocket closed for session ${id}`);
				},

				onError() {
					console.log(`[WS] WebSocket error for session ${id}`);
				},
			};
		}),
	);

	return app;
}
