import { Hono } from "hono";
import { websocket } from "hono/bun";
import { except } from "hono/combine";
import { cors } from "hono/cors";
import pkg from "../../package.json" with { type: "json" };
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";
import { bearerAuthMiddleware } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { createSessionRoutes } from "./routes/sessions";
import { createSseRoutes } from "./routes/sse";
import { createWsRoutes } from "./routes/ws";

export interface GatewayConfig {
	port: number;
	authToken: string;
	/**
	 * Optional pre-constructed SessionManager.
	 * Primarily used in tests so callers can seed sessions before the server starts.
	 * When omitted, a fresh SessionManager is created internally.
	 */
	manager?: SessionManager;
}

/**
 * The value returned by createServer.
 *
 * `app`       — Hono application for HTTP request handling (use as `fetch` in Bun.serve)
 * `websocket` — Bun WebSocket handler object; must be passed to Bun.serve as `websocket`
 * `eventBus`  — The domain event bus; subscribe to session lifecycle events
 *
 * Returning all three together keeps the caller's Bun.serve wiring simple and ensures
 * the websocket handler is always the one that matches the app's upgrade path.
 */
export interface ServerHandle {
	app: Hono;
	websocket: typeof websocket;
	eventBus: EventBus;
}

export function createServer(config: GatewayConfig): ServerHandle {
	const app = new Hono();
	const startedAt = Date.now();

	// CORS — allow any origin so browser-based clients (Quest browser, web dev)
	// can reach the gateway. Credentials are not used (we rely on the Bearer
	// token in the Authorization header, which CORS allowedHeaders must include).
	app.use(
		"*",
		cors({
			origin: "*",
			allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
			allowHeaders: ["Authorization", "Content-Type"],
			exposeHeaders: ["Content-Type"],
		}),
	);

	// Middleware ordering constraint:
	//   1. Auth middleware must be registered first so every subsequent route is
	//      protected by default. The `except` wrapper carves out /health only.
	//   2. Public routes (e.g. /health) follow the middleware registration.
	//   3. Protected sub-apps (e.g. /sessions) are mounted last so the auth
	//      middleware has already run before any session handler is invoked.
	app.use("*", except("/health", bearerAuthMiddleware(config.authToken)));

	const eventBus = new EventBus();
	const manager = config.manager ?? new SessionManager(eventBus);

	app.get("/health", (c) => {
		const uptime = (Date.now() - startedAt) / 1000;
		return c.json({
			status: "ok",
			sessions: manager.list().length,
			uptime,
			version: pkg.version,
		});
	});
	app.route("/sessions", createSessionRoutes(manager));
	app.route("/sessions", createWsRoutes(manager));
	app.route("/events", createSseRoutes(eventBus));

	app.onError(errorHandler);
	app.notFound(notFoundHandler);

	return { app, websocket, eventBus };
}
