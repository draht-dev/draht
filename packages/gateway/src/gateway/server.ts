import { resolveSocketDir } from "@draht/geist-core";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { except } from "hono/combine";
import { cors } from "hono/cors";
import pkg from "../../package.json" with { type: "json" };
import { DEFAULT_CONFIG, type GatewaySettings } from "../config/config";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";
import { assertBindHostAllowed, isLoopbackPeer, nonLoopbackPeerRefusal } from "./bind-host";
import { bearerAuthMiddleware } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { createConsoleRoutes } from "./routes/console";
import { createFleetRoutes } from "./routes/fleet";
import { createSessionStreamRoutes } from "./routes/session-stream";
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
	/**
	 * Optional gateway settings (from config file).
	 * Used for path validation, etc.
	 */
	config?: GatewaySettings;
	/**
	 * Interface to bind.
	 *
	 * Defaults to `config.host`, then to the loopback default. A non-loopback
	 * value is refused unless {@link GatewayConfig.allowNonLoopback} is set —
	 * the guard lives here, not only in argv parsing, so a programmatic embedder
	 * gets the same refusal an operator does.
	 */
	host?: string;
	/**
	 * Explicit opt-in to a non-loopback bind.
	 *
	 * `POST /sessions` spawns an arbitrary `command` array, so a reachable bind
	 * is remote code execution for any bearer-token holder. Setting this is the
	 * programmatic equivalent of the CLI's `--allow-non-loopback`.
	 */
	allowNonLoopback?: boolean;
	/**
	 * Directory the machine's attachable draht sessions publish themselves in.
	 *
	 * Defaults to the same `<agent dir>/sockets` the `draht` binary writes, so
	 * the daemon and the sessions agree without configuration. Tests point both
	 * at one throwaway directory through `DRAHT_CODING_AGENT_DIR`.
	 */
	socketDir?: string;
	/**
	 * Sink for the bind-posture notices — the non-loopback opt-in warning, and
	 * the first refusal of an off-box request. Defaults to `console.warn`.
	 */
	warn?: (message: string) => void;
}

/**
 * The value returned by createServer.
 *
 * `app`       — Hono application for HTTP request handling (use as `fetch` in Bun.serve)
 * `websocket` — Bun WebSocket handler object; must be passed to Bun.serve as `websocket`
 * `eventBus`  — The domain event bus; subscribe to session lifecycle events
 * `hostname`  — The bind host the guard approved; pass this to Bun.serve
 *
 * Returning all four together keeps the caller's Bun.serve wiring simple, ensures
 * the websocket handler is always the one that matches the app's upgrade path, and
 * makes the approved bind host the obvious thing to bind.
 *
 * `hostname` is a convenience, not the enforcement point: a caller who binds
 * something else does not escape the posture, because `app` itself refuses any
 * request from a peer that is not on this machine unless `allowNonLoopback` was
 * set. Prefer {@link startGateway}, which owns the bind and needs no such
 * back-stop.
 */
export interface ServerHandle {
	app: Hono;
	websocket: typeof websocket;
	eventBus: EventBus;
	hostname: string;
}

/**
 * The parts of a listening server that describe what is actually exposed.
 *
 * Both fields are optional because `Bun.serve` leaves them undefined for a unix
 * socket — reporting nothing is honest there; inventing a host would not be.
 */
export interface BoundServer {
	readonly hostname?: string;
	readonly port?: number;
}

/**
 * The peer address of an in-flight request, when the runtime can report one.
 *
 * `undefined` means "not observable" — a unix-socket listener, a direct
 * `app.fetch(request)` call with no server, or a non-Bun host. That is reported
 * honestly rather than guessed at; the caller treats it as "nothing to check".
 *
 * @param env - Hono's `c.env`, which under `Bun.serve` is the `Server` object.
 * @param request - The raw request, needed to look its connection up.
 */
function peerAddress(env: unknown, request: Request): string | undefined {
	const requestIP = (env as { requestIP?: unknown } | undefined)?.requestIP;
	if (typeof requestIP !== "function") return undefined;
	try {
		const peer = (requestIP as (r: Request) => { address?: unknown } | null).call(env, request);
		return typeof peer?.address === "string" ? peer.address : undefined;
	} catch {
		return undefined;
	}
}

export function createServer(config: GatewayConfig): ServerHandle {
	// Bind policy first: refuse before building anything that could be served.
	const hostname = assertBindHostAllowed({
		host: config.host ?? config.config?.host ?? DEFAULT_CONFIG.host,
		allowNonLoopback: config.allowNonLoopback,
		warn: config.warn,
	});

	const app = new Hono();
	const startedAt = Date.now();

	// The host guard above cannot stand on its own: `createServer` hands back an
	// `app` that the *caller* binds, so an embedder can ignore the vetted
	// hostname — or call `Bun.serve` with no `hostname` at all, which binds every
	// interface while still reporting `server.hostname === "localhost"`. The
	// posture is therefore also enforced where a caller cannot route around it:
	// on the request. Anything arriving from a peer that is not provably on this
	// machine is refused unless the caller gave the same explicit opt-in that
	// would have allowed a non-loopback bind.
	//
	// Registered before CORS and before auth so it also covers `/health` and the
	// WebSocket upgrade, and so a refusal never reveals which routes exist.
	if (!config.allowNonLoopback) {
		const warn = config.warn ?? ((message: string) => console.warn(message));
		let refusalLogged = false;
		app.use("*", async (c, next) => {
			const address = peerAddress(c.env, c.req.raw);
			if (address !== undefined && !isLoopbackPeer(address)) {
				// Once per server, not once per request: a port scan must not become
				// a log-flooding primitive.
				if (!refusalLogged) {
					refusalLogged = true;
					warn(nonLoopbackPeerRefusal(address));
				}
				return c.json({ error: "Forbidden: gateway is bound loopback-only" }, 403);
			}
			await next();
		});
	}

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
	//      protected by default. The `except` wrapper carves out /health and the
	//      served console only.
	//   2. Public routes (e.g. /health) follow the middleware registration.
	//   3. Protected sub-apps (e.g. /sessions) are mounted last so the auth
	//      middleware has already run before any session handler is invoked.
	//
	// `/ui` and its assets are public on purpose (R32-FLEET.10): a browser cannot
	// put an `Authorization` header on a document navigation, so an authenticated
	// console is a console nobody can open. The carve-out is for static bytes
	// only — `/fleet` and `/attach`, the routes that carry session data, are not
	// in the list and still refuse an unauthenticated caller.
	app.use("*", except(["/health", "/ui", "/ui/*"], bearerAuthMiddleware(config.authToken)));

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
	// The console the daemon serves. Mounted before the protected sub-apps so its
	// public carve-out reads next to the middleware that grants it.
	app.route("/", createConsoleRoutes());
	// Mounted at the root: the fleet is a property of the machine, not of one
	// session, and `/attach` fronts the whole fleet over one wire.
	app.route("/", createFleetRoutes({ socketDir: config.socketDir ?? resolveSocketDir() }));
	app.route("/sessions", createSessionRoutes(manager, config.config));
	app.route("/sessions", createSessionStreamRoutes(manager));
	app.route("/sessions", createWsRoutes(manager));
	app.route("/events", createSseRoutes(eventBus));

	app.onError(errorHandler);
	app.notFound(notFoundHandler);

	return { app, websocket, eventBus, hostname };
}

/** Options for {@link startGateway}. */
export interface StartGatewayOptions extends GatewayConfig {
	/** Idle timeout in seconds (max 255). Defaults to the config value. */
	idleTimeout?: number;
}

/** The result of {@link startGateway}. */
export interface StartedGateway {
	server: ReturnType<typeof Bun.serve>;
	eventBus: EventBus;
}

/**
 * Build the app and bind it — the supported programmatic entry point.
 *
 * Because this function owns the `Bun.serve` call, the loopback-by-default bind
 * posture is enforced on the path that actually opens the socket: the refusal
 * happens before any listener exists. The CLI uses this same function, so the
 * operator and library behaviours cannot drift.
 *
 * @throws Error when the requested host is non-loopback and `allowNonLoopback`
 *         was not set.
 */
export function startGateway(options: StartGatewayOptions): StartedGateway {
	const { app, websocket: ws, eventBus, hostname } = createServer(options);

	const server = Bun.serve({
		port: options.port,
		hostname,
		fetch: app.fetch,
		websocket: ws,
		idleTimeout: options.idleTimeout ?? options.config?.idleTimeout ?? DEFAULT_CONFIG.idleTimeout,
	});

	return { server, eventBus };
}
