import { timingSafeEqual } from "node:crypto";
import { AttachBridge, type AttachBridgeOptions, buildFleetFrame, type RendererConnection } from "@draht/geist-core";
import { DEFAULT_TRANSPORT_LIMITS, type TransportLimits } from "@draht/geist-protocol";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import pkg from "../../../package.json" with { type: "json" };
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
	 * The per-device store, on a daemon that has been paired with (R33-REACH.5).
	 *
	 * Its presence changes who the authority is, never whether there is one.
	 */
	devices?: AttachDeviceAuthenticator;
}

/**
 * The device store, named from the bridge's own options rather than re-declared.
 *
 * The gateway is filling a port it does not define; deriving the type from
 * {@link AttachBridgeOptions} means a change to that port is a compile error
 * here instead of a second, drifting copy of the contract.
 */
export type AttachDeviceAuthenticator = NonNullable<AttachBridgeOptions["devices"]>;

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
	options: Pick<FleetRoutesOptions, "authToken" | "devices">,
): AttachAuthentication {
	const devices = options.devices;
	if (devices !== undefined) {
		const presented = credential === undefined ? undefined : parseDeviceCredential(credential);
		return { devices, presentedCredential: presented };
	}
	if (credential !== undefined && tokenMatches(credential, options.authToken)) return {};
	return { devices: NO_DEVICE_EXCHANGE };
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

export function createFleetRoutes(options: FleetRoutesOptions): Hono {
	const app = new Hono();
	const limits = options.limits ?? DEFAULT_TRANSPORT_LIMITS;

	// The same body the `fleet` frame carries, so a renderer parses one shape
	// whether the list arrived over HTTP or was pushed after `hello`.
	app.get("/fleet", (c) => c.json(buildFleetFrame(options.socketDir)));

	app.get(
		"/attach",
		upgradeWebSocket((c) => {
			// Read on the *request*, which is the only place these headers exist:
			// by `onOpen` there is a WebSocket and no request left to ask. The
			// credential is not verified here — the bridge verifies it, so a
			// header-authenticated client and a first-message one are the same
			// client to everything downstream.
			const authentication = attachAuthentication(
				upgradeCredential(c.req.header("Authorization"), c.req.header("Sec-WebSocket-Protocol")),
				options,
			);
			let bridge: AttachBridge | null = null;

			const release = (): void => {
				bridge?.close();
				bridge = null;
			};

			return {
				onOpen(_evt, ws) {
					bridge = new AttachBridge({
						socketDir: options.socketDir,
						connection: rendererConnection(ws),
						limits,
						server: { name: "draht-gateway", version: pkg.version },
						...authentication,
					});
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
