import { timingSafeEqual } from "node:crypto";
import {
	AttachBridge,
	type AttachBridgeOptions,
	type AuthorizationRequest,
	type AuthorizationVerdict,
	buildFleetFrame,
	HistoryCursorError,
	HistoryIndex,
	type RendererConnection,
} from "@draht/geist-core";
import { DEFAULT_TRANSPORT_LIMITS, type TransportLimits } from "@draht/geist-protocol";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import pkg from "../../../package.json" with { type: "json" };
import { logger } from "../logger";
import { decodeWsBearerSubprotocol } from "../ws-bearer";

/**
 * The fleet and attach surface (R32-FLEET.2, R32-FLEET.3, R33-REACH.3).
 *
 *   GET /fleet    every live attachable draht session on this machine
 *   GET /attach   WebSocket; the geist wire, bridged to one session's socket
 *
 * This file is wiring and nothing else. The projection and the bridge live in
 * `@draht/geist-core`, which imports no kernel package — so when Phase 38 moves
 * the daemon host, the product logic does not move with it
 * (`scripts/check-geist-boundary.mjs`, R32-FLEET.1). What is genuinely
 * host-specific stays here: how a Bun WebSocket reports its unflushed bytes,
 * how it is closed, and how a credential is read off an upgrade request.
 *
 * ## Where `/attach` is authenticated, and why it is not where `/fleet` is
 *
 * `/fleet` sits behind the bearer middleware `createServer` registers, and an
 * unauthenticated `GET /fleet` is still answered with 401 before the handler
 * runs. `/attach` no longer does: it is in that middleware's `except([...])`
 * list, alongside `/health` and the `/ui` assets.
 *
 * It has to be. R33-REACH.5 authenticates a device with a *frame* —
 * `pair_device` on its first connect, `authenticate` on every one after — and a
 * frame needs a WebSocket, which needs a 101. A middleware that refuses the
 * upgrade refuses the only channel the credential has. So the 101 now happens
 * before authentication.
 *
 * **The invariant that mattered did not move.** It was never "the upgrade is
 * 401'd"; that was the mechanism. It was: *no Unix socket is dialled for a
 * connection that has not proved who it is* (R32-FLEET.3). That is now held one
 * layer in, by {@link AttachBridge}: given a device store it answers `hello`
 * with `server_hello` and nothing else — not even the fleet listing, which is
 * session data — and refuses every other frame, `attach` included, with a typed
 * `not_authenticated` `protocol_error` before the switch that would look a
 * session up. An unauthenticated peer gets a socket to the daemon and two
 * frames; it does not get a session, a session's output, or the knowledge that
 * a session exists.
 *
 * ## Where a revocation catches a connection that already exists
 *
 * R33-REACH.6 says a revoked device is "refused at its next frame, not merely at
 * its next connect". Taken literally that is inbound-only, and inbound-only is
 * not a control: the device this exists to cut off is a phone in somebody else's
 * hands, and it has no reason to send anything. It reads. So this route arms two
 * things at once, and the second is the one that matters:
 *
 *  - the bridge's `authorize` hook ({@link revocationPolicy}), asked on every
 *    inbound frame *and before every outbound emit*, so the session's own output
 *    is what trips over the revocation and the connection dies with a typed
 *    `not_authenticated` rather than quietly continuing;
 *  - a subscription to the store, so a connection with no traffic in either
 *    direction — attached to a session that happens to be idle — is dropped
 *    anyway, within the store's observation latency of the revocation landing on
 *    disk.
 *
 * A store that can do neither is not silently tolerated; `createFleetRoutes`
 * says which half is missing, once, when the surface is built.
 *
 * What this route does own is the *upgrade-request* half of R33-REACH.3: a
 * credential may arrive on `Authorization: Bearer` or on the
 * `geist.bearer.<base64url>` subprotocol — the only two sources left standing,
 * and the only one a browser can produce — and is handed to the bridge, which
 * spends it down the same path an `authenticate` frame takes. The query string
 * is not read here and is not read anywhere (spec §6.4).
 */
export interface FleetRoutesOptions {
	/** Directory the fleet publishes itself in (`<agent dir>/sockets`). */
	socketDir: string;
	/**
	 * Directory the machine's recorded sessions live in (`<agent dir>/sessions`),
	 * served by `GET /history` (R35-ALWAYS.6).
	 *
	 * A sibling of {@link socketDir} and not derived from it, because the two are
	 * genuinely different stores: one holds ephemeral socket/lock pairs for
	 * processes alive right now, the other holds every session this machine has
	 * ever recorded. They share only the agent directory and the environment
	 * variable that relocates it.
	 */
	sessionsDir: string;
	/** Transport caps to advertise and enforce. Defaults to the protocol's. */
	limits?: TransportLimits;
	/**
	 * The daemon's shared operator token — the one `--auth` sets and the bearer
	 * middleware compares every other route against.
	 *
	 * `/attach` needs it because it left that middleware: on a daemon with no
	 * device store this token is still the credential, and something has to
	 * check it. See {@link attachAuthentication}.
	 */
	authToken: string;
	/**
	 * How this daemon obtains its per-device store, asked once per `/attach`
	 * connection (R33-REACH.5).
	 *
	 * A provider rather than a value, because *when* the store exists is not the
	 * daemon's decision. `geist pair` writes it, from another process, at
	 * whatever moment Oskar decides to point a phone at this machine — which on
	 * a fresh machine is always after the daemon started. Reading the store once
	 * while the routes were built froze the answer at that moment and made the
	 * first-ever pairing wait for a restart; asking per connection is what makes
	 * the daemon notice the store appearing underneath it.
	 *
	 * `undefined` from the provider means the same thing it meant when this was a
	 * value: no store, so the operator token is still the credential. Its
	 * presence changes who the authority is, never whether there is one.
	 */
	devices?: AttachDeviceProvider;
	/**
	 * How often an idle `/attach` socket is sent a WebSocket protocol PING, in ms.
	 *
	 * `0` or absent means no keepalive, which is the pre-Phase-33 behaviour and
	 * is only correct for a host that wants idle attach sockets reaped. See
	 * {@link keepAlive} for what the pings are defending against and why the
	 * period has to be a fraction of the idle window rather than a free setting.
	 */
	keepaliveMs?: number;
}

/**
 * The device store, named from the bridge's own options rather than re-declared.
 *
 * The gateway is filling a port it does not define; deriving the type from
 * {@link AttachBridgeOptions} means a change to that port is a compile error
 * here instead of a second, drifting copy of the contract.
 */
export type AttachDeviceAuthenticator = NonNullable<AttachBridgeOptions["devices"]>;

/**
 * How the route asks, per connection, what this daemon's device posture is.
 *
 * Implementations are expected to be cheap — this is on the upgrade path — and
 * to strengthen in one direction only: once a store exists, a later call must
 * not answer `undefined` again. Weakening from device posture back to operator
 * posture at runtime would turn a paired daemon into an unpaired one without
 * anybody typing anything, which is a downgrade nothing should be able to
 * trigger remotely. See `createDeviceAuthenticator` in `cli.ts`.
 */
export type AttachDeviceProvider = () => AttachDeviceAuthenticator | undefined;

/** A credential read off the upgrade request, in the shape the bridge verifies. */
export type AttachPresentedCredential = NonNullable<AttachBridgeOptions["presentedCredential"]>;

/** The two bridge options that decide who this connection is allowed to be. */
type AttachAuthentication = Pick<AttachBridgeOptions, "devices" | "presentedCredential">;

/**
 * A store that issues nothing and verifies nothing.
 *
 * Handed to the bridge when the upgrade presented no acceptable credential on a
 * daemon that has no device store either. Its *presence* is what arms the
 * bridge's gate — a bridge given no store at all is one whose host vouched for
 * the connection — so this is how "the host could not vouch for you" is said in
 * the only vocabulary the bridge has. Both halves fail, which is true: this
 * daemon exchanges no device credentials.
 */
const NO_DEVICE_EXCHANGE: AttachDeviceAuthenticator = {
	pair: () => ({ ok: false, reason: "this daemon exchanges no device credentials" }),
	authenticate: () => ({ ok: false, reason: "this daemon exchanges no device credentials" }),
};

/**
 * Constant-time comparison of a presented token against the configured one.
 *
 * The wrong-length case still runs a comparison before answering, so the two
 * ways of being wrong cost the same and a length is not leaked by a timer.
 */
function tokenMatches(presented: string, expected: string): boolean {
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) {
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

/**
 * The credential on an upgrade request, from the two sources R33-REACH.3 leaves.
 *
 * `Authorization: Bearer` for a native client; `Sec-WebSocket-Protocol` for a
 * browser, whose `new WebSocket(url)` takes no headers of its own (see
 * `ws-bearer.ts`). The query string is deliberately not a third source.
 */
function upgradeCredential(authorization: string | undefined, subprotocol: string | undefined): string | undefined {
	const bearer = authorization === undefined ? null : /^Bearer (.+)$/i.exec(authorization);
	if (bearer) return bearer[1];
	return decodeWsBearerSubprotocol(subprotocol);
}

/**
 * Split a device credential out of one bearer value.
 *
 * `<deviceId>:<credential>` — the device id is minted as `dev_<hex>` and can
 * contain no colon, so the first one is the separator and the credential keeps
 * every byte after it. Anything not of this shape is reported as *no*
 * credential rather than as a half-parsed one, exactly as a malformed
 * subprotocol is: a value that cannot be a device credential must not be
 * presented as a guess at one, because presenting it spends the connection's
 * single attempt.
 */
function parseDeviceCredential(value: string): AttachPresentedCredential | undefined {
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return { deviceId: value.slice(0, separator), credential: value.slice(separator + 1) };
}

/**
 * Decide, from one upgrade request, what the bridge is allowed to assume.
 *
 * Three outcomes, and every one of them ends with something checking a
 * credential:
 *
 *  1. **A device store is configured.** It is the authority. Whatever the
 *     upgrade carried is handed over as a presented credential to be verified
 *     at `hello`; a request that carried nothing usable simply authenticates
 *     with its first frame instead, which is the normal path for a browser that
 *     has just scanned a QR and has only a bootstrap token.
 *  2. **No device store, and the upgrade carried the operator token.** The host
 *     has vouched for this connection exactly as the bearer middleware used to,
 *     so the bridge is given no store and behaves as it did before the gate
 *     existed. This is the pre-pairing posture the daemon ships in today.
 *  3. **No device store, and no acceptable token.** {@link NO_DEVICE_EXCHANGE}
 *     arms the gate. The connection is upgraded and then refused on the wire.
 *
 * Note what is *absent*: a branch that returns `{}` because nothing was
 * presented. Falling through to "no store" is precisely the shape of the bug
 * this function exists to make unwritable — it would upgrade an anonymous peer
 * into a vouched-for one.
 */
export function attachAuthentication(
	credential: string | undefined,
	options: { authToken: string; devices?: AttachDeviceAuthenticator },
): AttachAuthentication {
	const devices = options.devices;
	if (devices !== undefined) {
		const presented = credential === undefined ? undefined : parseDeviceCredential(credential);
		return { devices, presentedCredential: presented };
	}
	if (credential !== undefined && tokenMatches(credential, options.authToken)) return {};
	return { devices: NO_DEVICE_EXCHANGE };
}

/**
 * The per-frame revocation policy, or undefined when the store cannot answer.
 *
 * Handed to the bridge as its `authorize` hook, which is asked on every inbound
 * frame **and before every outbound emit**. That second half is the one
 * R33-REACH.6 actually needs: "refused at its next frame" is inbound-only, and
 * the device this control exists to stop — a phone somebody else is holding —
 * has no reason to send a next frame. It sits there reading. The pre-emit check
 * is what makes the session's own output the thing that trips over the
 * revocation, and the identity, not a credential, is what it asks about, because
 * a connection that is merely receiving presents no credential to check.
 *
 * A connection with no identity is left alone: it is either still
 * pre-authentication, where the bridge's own gate is the policy, or it is a
 * host-vouched connection on a daemon with no device store, where there is no
 * device to revoke.
 *
 * The store is asked every time rather than cached. Each call is a `stat(2)`
 * that reloads only when the file changed, and a cache here would be a second
 * opinion about the credential file — which is exactly the thing
 * `DeviceRegistry` refuses to be. A policy that could not answer, because the
 * store threw, is refused by the bridge: see its `#allowed`.
 */
function revocationPolicy(
	devices: AttachDeviceAuthenticator | undefined,
): ((request: AuthorizationRequest) => AuthorizationVerdict) | undefined {
	if (devices?.isRevoked === undefined) return undefined;
	return (request: AuthorizationRequest): AuthorizationVerdict => {
		const deviceId = request.identity?.deviceId;
		if (deviceId === undefined) return { allow: true };
		if (devices.isRevoked?.(deviceId) !== true) return { allow: true };
		// No device id in the message: it reaches a phone, and naming the id it
		// authenticated as tells a holder of a stolen credential which one it is.
		return { allow: false, code: "not_authenticated", message: "this device has been revoked" };
	};
}

/** Bun hands binary frames through as an ArrayBuffer; text arrives as a string. */
function frameText(data: unknown): string {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data as ArrayBufferView);
	return String(data);
}

/**
 * Adapt one Bun WebSocket to the bridge's renderer port.
 *
 * `getBufferedAmount()` is the whole reason this adapter exists: it is the only
 * honest answer to "how far behind is this client", and it is the number
 * R32-FLEET.6's buffered-output cap is measured against. A host that cannot
 * report it reports zero — a bound that cannot be measured must not silently
 * become a bound that fires at random.
 */
function rendererConnection(ws: WSContext): RendererConnection {
	const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
	return {
		bufferedBytes: () => (typeof raw?.getBufferedAmount === "function" ? raw.getBufferedAmount() : 0),
		send: (text: string) => {
			try {
				ws.send(text);
			} catch {
				// The socket is already closing; the bridge's close path still runs.
			}
		},
		close: (code: number, reason: string) => {
			try {
				ws.close(code, reason);
			} catch {
				// Already closed.
			}
		},
	};
}

/**
 * Hold one `/attach` socket open across a stretch with nothing to say.
 *
 * ## What this is defending against
 *
 * A pending permission ask is, by definition, a period with no session output,
 * and `/attach` traffic is purely output-driven. So the instant an ask is raised
 * the phone's socket goes silent — for as long as it takes somebody to pick the
 * phone up. The agent core waits for that answer indefinitely (measured to 25
 * minutes with no degradation). The transport did not.
 *
 * Not for the reason it looked like, though, and the difference decided the fix.
 * `GatewaySettings.idleTimeout` reaches `Bun.serve`'s *top-level* timer, and
 * that timer was measured not to govern WebSocket connections at all. The window
 * that governs them is `Bun.serve({ websocket: { idleTimeout } })`, which this
 * package never set — so `/attach` ran on Bun's unset default of 120s, and Bun's
 * reaper is a liveness probe: it emits one PING near the end of the window
 * (measured t=104s) and closes at the window (t=120.00s) unless a PONG comes
 * back. A peer that answered survived indefinitely; a peer whose answer did not
 * arrive inside that ~16s grace was dropped. The connection's life rested
 * entirely on a phone on a radio being prompt — during the one interval where
 * nothing else is travelling to keep the path warm.
 *
 * ## Why a protocol ping, and not a frame
 *
 * A **server-initiated** ping resets the window on send and needs no answer at
 * all: measured, a socket with a 2s window pinged every 1000ms survived 20s —
 * ten windows — against a client that never ponged once. That is the whole
 * mechanism, and it is the cheap one. These are RFC 6455 control frames, so
 * nothing is added to the geist wire: no new frame type, no
 * `GEIST_PROTOCOL_VERSION` bump, no conformance corpus to regenerate, nothing
 * for `MIRRORED_FRAMES` to argue about. And unlike an application-level
 * heartbeat driven from page script, it keeps working when the phone's tab is
 * backgrounded, because a browser answers protocol pings in its network stack
 * rather than on a JS timer that a backgrounded tab has had throttled — which is
 * precisely the walk-away case this feature exists for.
 *
 * ## What it does not fix
 *
 * Both ends still have to be awake. This holds a connection whose *server* is
 * alive and whose path is intact; it cannot help a phone that is asleep, in a
 * tunnel, or handed off between networks, where the socket genuinely dies. That
 * case needs a durable pending ask that a reconnecting client re-reads, which
 * waits on the Phase 34 decision about which seam relays permissions.
 *
 * @param ws - The connection to keep warm.
 * @param intervalMs - Period between pings. `0` or less arms nothing.
 * @returns A function that stops the keepalive. Always safe to call twice.
 */
function keepAlive(ws: WSContext, intervalMs: number): () => void {
	// A host that cannot ping is not a host this can pretend to defend. Reporting
	// "nothing armed" is honest; a no-op interval would look identical to a
	// working keepalive in every log and every test.
	const raw = ws.raw as { ping?: () => unknown } | undefined;
	if (intervalMs <= 0 || typeof raw?.ping !== "function") return () => {};

	const timer = setInterval(() => {
		try {
			raw.ping?.();
		} catch {
			// The socket is closing; the close path clears this timer.
		}
	}, intervalMs);
	// A keepalive must never be the reason the process cannot exit: it exists to
	// outlive silence, not to outlive the server.
	timer.unref?.();

	return () => clearInterval(timer);
}

export function createFleetRoutes(options: FleetRoutesOptions): Hono {
	const app = new Hono();
	const limits = options.limits ?? DEFAULT_TRANSPORT_LIMITS;

	/** Whether the store this daemon ended up with has already been described. */
	let describedStore = false;

	/**
	 * The device posture for one connection, plus the one-time notice about it.
	 *
	 * A configured store that can neither be asked about revocation nor observed
	 * is a daemon where `geist devices revoke` reaches the next *connect* and
	 * nothing sooner. That is a real posture — a store can be an adapter over
	 * something that genuinely cannot answer — but it is not one an operator
	 * should have to infer from a requirement id, so it is said once.
	 *
	 * "Once" is pinned to the first connection that actually *sees* a store
	 * rather than to the moment the surface was built. On a fresh machine there
	 * is no store when the routes exist, so a build-time check had nothing to
	 * inspect and said nothing at all; saying it when the store appears is both
	 * the first moment the answer is knowable and the moment it starts to matter.
	 */
	const devicesFor = (): AttachDeviceAuthenticator | undefined => {
		const devices = options.devices?.();
		if (devices === undefined || describedStore) return devices;
		describedStore = true;
		if (devices.isRevoked === undefined) {
			logger.warn({
				message:
					"the /attach device store cannot report revocation; a revoked device keeps any live connection until it reconnects",
				requirement: "R33-REACH.6",
			});
		} else if (devices.subscribe === undefined) {
			logger.warn({
				message:
					"the /attach device store cannot be observed; a revoked device keeps a silent connection until its next frame in either direction",
				requirement: "R33-REACH.6",
			});
		}
		return devices;
	};

	// The same body the `fleet` frame carries, so a renderer parses one shape
	// whether the list arrived over HTTP or was pushed after `hello`.
	app.get("/fleet", (c) => c.json(buildFleetFrame(options.socketDir)));

	/**
	 * One index per surface, and therefore one per daemon process.
	 *
	 * Its caches are in memory and are never written to disk (R35-ALWAYS.3): a
	 * persisted index under `~/.draht` would be a second unbounded artifact
	 * needing its own ownership and hygiene story, to save a rebuild that costs
	 * roughly 0.5–2 s once, at daemon start.
	 */
	const history = new HistoryIndex(options.sessionsDir);

	/**
	 * `GET /history` — every session this machine has recorded (R35-ALWAYS.6).
	 *
	 * Behind the bearer middleware for free: `createServer`'s `except([...])`
	 * list is `/health`, `/ui`, `/ui/*` and `/attach`, and this is none of them.
	 * Session paths and project directories are exactly as private as the fleet
	 * listing next to it.
	 *
	 * Query: `project` (an ABSOLUTE path, matched against each header's `cwd` —
	 * never against the slug directory, which is lossy enough that two different
	 * projects can share one), `limit` (default 50, clamped to 500) and `cursor`
	 * (opaque, from a previous page's `nextCursor`). Newest file first.
	 *
	 * The body carries RAW history rows and nothing else. `origin`, `attachable`,
	 * `resumable` and `status` are deliberately absent: merging these rows
	 * against the live socket fleet, and the wire schema that carries the merged
	 * shape, are owned by a later task (R35-ALWAYS.7, R35-ALWAYS.8). Adding them
	 * here would put two owners on one shape.
	 *
	 * `counters` is not decoration. R35-ALWAYS.6's budget is stated as a per-file
	 * invariant — ≤1 open, ≤4,096 bytes, ≤2 stats — precisely because warm
	 * milliseconds are a page-cache measurement that rots as the store grows, and
	 * these counters are how the acceptance reads that invariant off a real
	 * daemon over the wire instead of asserting a stopwatch.
	 */
	app.get("/history", (c) => {
		const limitParam = c.req.query("limit");
		let limit: number | undefined;
		if (limitParam !== undefined && limitParam !== "") {
			limit = Number(limitParam);
			if (!Number.isFinite(limit) || limit < 1) {
				return c.json({ error: `limit must be a positive integer, got ${limitParam}` }, 400);
			}
		}

		const project = c.req.query("project");
		if (project !== undefined && project !== "" && !project.startsWith("/")) {
			// A relative project would be resolved against the DAEMON's cwd, which
			// is not the cwd of anything the caller can see. Refused rather than
			// silently answered with the wrong project's history.
			return c.json({ error: `project must be an absolute path, got ${project}` }, 400);
		}

		try {
			const page = history.page({
				project: project === "" ? undefined : project,
				limit,
				cursor: c.req.query("cursor"),
			});
			return c.json({
				type: "history",
				total: page.total,
				nextCursor: page.nextCursor,
				sessions: page.sessions.map((session) => ({
					id: session.id,
					cwd: session.cwd,
					startedAt: session.startedAt,
					path: session.path,
				})),
				counters: page.counters,
			});
		} catch (error) {
			if (error instanceof HistoryCursorError) return c.json({ error: error.message }, 400);
			throw error;
		}
	});

	app.get(
		"/attach",
		upgradeWebSocket((c) => {
			// Read on the *request*, which is the only place these headers exist:
			// by `onOpen` there is a WebSocket and no request left to ask. The
			// credential is not verified here — the bridge verifies it, so a
			// header-authenticated client and a first-message one are the same
			// client to everything downstream.
			//
			// The posture is decided here too, per connection, and then held for
			// the life of this one: a store that appears while a host-vouched
			// operator connection is open does not retroactively unauthenticate
			// it. That connection keeps the authority it was admitted under until
			// it closes, and the next connection gets the new one. Re-deciding
			// mid-connection would cut a live session off because a pairing
			// happened somewhere else, and `geist devices revoke` — which this
			// route already arms both halves of — is the control for ending a
			// connection on purpose.
			const authentication = attachAuthentication(
				upgradeCredential(c.req.header("Authorization"), c.req.header("Sec-WebSocket-Protocol")),
				{ authToken: options.authToken, devices: devicesFor() },
			);
			let bridge: AttachBridge | null = null;
			let unobserve: (() => void) | null = null;
			let stopKeepalive: (() => void) | null = null;

			const stopObserving = (): void => {
				const stop = unobserve;
				unobserve = null;
				try {
					stop?.();
				} catch {
					// A store that cannot be unsubscribed from is not a reason to fail a close.
				}
			};

			/**
			 * The store changed. If it changed to say this connection's device is
			 * revoked, the connection ends now — not when it next speaks, and not
			 * when its session next prints.
			 *
			 * This is the half the `authorize` hook cannot cover: the hook fires on
			 * frames, and the connection this exists to cut is the one with no
			 * frames in either direction.
			 */
			const enforceRevocation = (): void => {
				const deviceId = bridge?.identity?.deviceId;
				if (deviceId === undefined) return;
				if (authentication.devices?.isRevoked?.(deviceId) !== true) return;
				stopObserving();
				bridge?.refuse("not_authenticated", "this device has been revoked");
			};

			const release = (): void => {
				stopObserving();
				stopKeepalive?.();
				stopKeepalive = null;
				bridge?.close();
				bridge = null;
			};

			return {
				onOpen(_evt, ws) {
					// Armed before the bridge, and for the whole connection rather than
					// from the moment it authenticates: the transport's window starts at
					// the 101, so a keepalive that waited for `hello` would leave the
					// pre-authentication stretch — the one a phone spends on a cold
					// radio — defended by nothing.
					stopKeepalive = keepAlive(ws, options.keepaliveMs ?? 0);
					bridge = new AttachBridge({
						socketDir: options.socketDir,
						connection: rendererConnection(ws),
						limits,
						server: { name: "draht-gateway", version: pkg.version },
						authorize: revocationPolicy(authentication.devices),
						...authentication,
					});
					// Subscribed for the whole connection rather than from the moment
					// it authenticates: the identity is read inside the callback, so a
					// notification that arrives before there is one costs nothing, and
					// there is no window between "authenticated" and "observed".
					unobserve = authentication.devices?.subscribe?.(enforceRevocation) ?? null;
				},
				onMessage(evt) {
					bridge?.receive(frameText(evt.data));
				},
				onClose: release,
				onError: release,
			};
		}),
	);

	return app;
}
