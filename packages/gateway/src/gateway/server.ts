import { type FleetObserver, resolveSessionsDir, resolveSocketDir } from "@draht/geist-core";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { except } from "hono/combine";
import { cors } from "hono/cors";
import pkg from "../../package.json" with { type: "json" };
import { attachKeepaliveIntervalMs, DEFAULT_CONFIG, type GatewaySettings } from "../config/config";
import { EventBus } from "../session/event-bus";
import { SessionManager } from "../session/session-manager";
import { assertBindHostAllowed, isLoopbackPeer, nonLoopbackPeerRefusal } from "./bind-host";
import { bearerAuthMiddleware } from "./middleware/auth";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { tailnetIdentityMiddleware } from "./middleware/tailnet-identity";
import { createConsoleRoutes } from "./routes/console";
import { type AttachDeviceAuthenticator, type AttachDeviceProvider, createFleetRoutes } from "./routes/fleet";
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
	 * Directory the machine's recorded sessions live in, served by `GET /history`.
	 *
	 * Defaults to the same `<agent dir>/sessions` the `draht` binary writes, off
	 * the same `DRAHT_CODING_AGENT_DIR` that relocates {@link socketDir} — so a
	 * test that points a spawned draht and a daemon at one throwaway directory
	 * gets the live fleet and the history from that one directory, and a
	 * developer's real store is never read by a test daemon.
	 */
	sessionsDir?: string;
	/**
	 * The per-device credential store `/attach` authenticates against
	 * (R33-REACH.5).
	 *
	 * Optional because a daemon that nobody has paired with has none, and that
	 * daemon is not thereby open: `/attach` refuses on the wire instead. See
	 * `attachAuthentication` in `routes/fleet.ts` for the three cases.
	 *
	 * Either a store, for an embedder that has one already, or an
	 * {@link AttachDeviceProvider} for a host whose store may appear *after* the
	 * server does — which is every machine `geist pair` has not been run on yet.
	 * The route only takes the provider; a plain store is lifted into a constant
	 * one below, so "my store never changes" stays a value and does not have to
	 * be spelled `() => store` at every call site.
	 */
	devices?: AttachDeviceAuthenticator | AttachDeviceProvider;
	/**
	 * Sink for the bind-posture notices — the non-loopback opt-in warning, and
	 * the first refusal of an off-box request. Defaults to `console.warn`.
	 */
	warn?: (message: string) => void;
	/**
	 * Idle timeout in seconds (max 255). Defaults to the config value.
	 *
	 * It reaches `Bun.serve` twice — once at the top level for HTTP, once under
	 * `websocket` — because those are two independent timers and only the second
	 * one has ever governed `/attach`. See {@link GatewaySettings.idleTimeout}.
	 */
	idleTimeout?: number;
	/**
	 * How often an idle `/attach` socket is pinged, in ms.
	 *
	 * Defaults to {@link attachKeepaliveIntervalMs} of the effective idle timeout,
	 * which is the only value that is correct by construction. `0` turns the
	 * keepalive off, leaving the connection to live or die by whether the peer
	 * answers Bun's own end-of-window PING in time — the behaviour before this
	 * option existed. It is spelled out as an option rather than hidden because a
	 * host that genuinely wants idle attach sockets reaped needs a way to say so,
	 * and because a keepalive nothing can switch off is a keepalive nothing can
	 * prove is load-bearing.
	 */
	attachKeepaliveMs?: number;
	/**
	 * The fleet observer this daemon reads its fleet through (R35-ALWAYS.10).
	 *
	 * ONE PER DAEMON PROCESS, and that is not a convenience — it is what the
	 * `epoch` on `fleet` and `fleet_delta` means. `GET /fleet` and every open
	 * `/attach` socket answer from the same observer, so they share an `epoch`
	 * and an ordered `seq`; a second observer in one process would hand two
	 * clients two unrelated numberings of one machine, and neither could tell.
	 *
	 * Optional because the fleet surface builds one over the history index and
	 * status cache it already owns. Passing one here is for an embedder or a test
	 * that needs to drive the ticks itself.
	 */
	fleet?: FleetObserver;
}

/**
 * The idle window this server will actually enforce, in seconds.
 *
 * One resolution used by both `createServer` and `startGateway`, so the HTTP
 * timer and the WebSocket timer cannot be handed different numbers — which is
 * the drift that let the configured value govern one of them and not the other.
 */
function resolveIdleTimeout(config: GatewayConfig): number {
	return config.idleTimeout ?? config.config?.idleTimeout ?? DEFAULT_CONFIG.idleTimeout;
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
	websocket: GatewayWebSocketHandler;
	eventBus: EventBus;
	hostname: string;
}

/**
 * Hono's Bun WebSocket handler, carrying the idle window this daemon chose.
 *
 * `idleTimeout` is a required property rather than an optional one so that a
 * caller assembling `Bun.serve` by hand cannot quietly drop it and fall back to
 * Bun's unset default — which is the state `/attach` was in.
 */
export type GatewayWebSocketHandler = typeof websocket & { idleTimeout: number };

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

/**
 * Lift the `devices` option into the per-connection provider `/attach` takes.
 *
 * A store is a value; *whether this machine has one* is not, and the daemon is
 * the caller for which that distinction is the whole point — its store is
 * written by `geist pair`, in another process, after it started. So the route
 * asks per connection and this is where "I already have one, it never changes"
 * is turned into that question's answer.
 *
 * `typeof === "function"` is the discriminator, and it is sound in both
 * directions: `AttachDeviceAuthenticator` is an object with `pair` and
 * `authenticate` *properties*, never a callable itself.
 */
function deviceProvider(devices: GatewayConfig["devices"]): AttachDeviceProvider {
	if (typeof devices === "function") return devices;
	return () => devices;
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
	const idleTimeout = resolveIdleTimeout(config);

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

	// The tailnet identity check, ahead of the bearer middleware (R33-REACH.8).
	//
	// It is registered here — before auth, before any route — because it can only
	// subtract: a fronted deployment refuses a request whose identity header
	// names somebody other than the configured owner, and every other outcome is
	// "carry on to the credential check". It never grants, never marks the
	// context, and is never the only check; the header is forgeable by anything
	// that can reach the loopback listener, which is exactly why it may not be
	// treated as a credential. See `middleware/tailnet-identity.ts`.
	app.use("*", tailnetIdentityMiddleware(config.config?.tailnet));

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
	// console is a console nobody can open. That carve-out is for static bytes
	// only — `/fleet`, the other route that carries session data, is not in the
	// list and still 401s an unauthenticated caller.
	//
	// `/attach` is in the list for a different reason, and it is not a hole
	// (R33-REACH.3, R33-REACH.5). A device authenticates with a *frame*, and a
	// frame needs the 101 this middleware would have refused. So `/attach`
	// upgrades first and authenticates on the wire: the bridge answers `hello`
	// with `server_hello` and refuses every other frame — `attach` included, and
	// the fleet listing along with it — until a credential has been presented, so
	// no Unix socket is dialled for a connection that has not proved who it is.
	// The reasoning, and the three cases the upgrade handler decides between,
	// are written out at the top of `routes/fleet.ts`.
	app.use("*", except(["/health", "/ui", "/ui/*", "/attach"], bearerAuthMiddleware(config.authToken)));

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
	app.route(
		"/",
		createFleetRoutes({
			socketDir: config.socketDir ?? resolveSocketDir(),
			sessionsDir: config.sessionsDir ?? resolveSessionsDir(),
			authToken: config.authToken,
			devices: deviceProvider(config.devices),
			// Mounted exactly once per `createServer`, so the observer this surface
			// builds — or the one handed in here — is the process's only one.
			fleet: config.fleet,
			// Derived from the same window the handler above enforces, so the two
			// cannot be configured apart: the period is a function of the timeout,
			// never a second setting an operator can put out of step with it.
			keepaliveMs: config.attachKeepaliveMs ?? attachKeepaliveIntervalMs(idleTimeout),
		}),
	);
	app.route("/sessions", createSessionRoutes(manager, config.config));
	app.route("/sessions", createSessionStreamRoutes(manager));
	app.route("/sessions", createWsRoutes(manager));
	app.route("/events", createSseRoutes(eventBus));

	app.onError(errorHandler);
	app.notFound(notFoundHandler);

	// The WebSocket idle window is set here, explicitly, rather than left to
	// Bun's default. It is a *different timer* from `Bun.serve`'s top-level
	// `idleTimeout` — measured on Bun 1.4.0, the top-level value does not govern
	// WebSocket connections at all — so leaving this unset ran every attach and
	// session socket on an unset 120s default that no configuration could move.
	// Spread rather than mutated: `websocket` is the shared handler object hono
	// exports, and writing a per-server field onto it would make the last server
	// constructed decide the window for every other one in the process.
	return { app, websocket: { ...websocket, idleTimeout }, eventBus, hostname };
}

/**
 * Options for {@link startGateway}.
 *
 * `idleTimeout` and `attachKeepaliveMs` live on {@link GatewayConfig} itself:
 * `createServer` needs both — one for the WebSocket handler it returns, one for
 * the attach route it mounts — and a knob that only the bind wrapper could see
 * was a knob the socket never heard about.
 */
export type StartGatewayOptions = GatewayConfig;

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
		// The HTTP idle timer. The WebSocket one rides on `ws` itself, set by
		// `createServer` from this same resolution — see `resolveIdleTimeout`.
		idleTimeout: resolveIdleTimeout(options),
	});

	return { server, eventBus };
}
