import { PairingState, type PairingStateOptions } from "@draht/geist-core";
import { PermissionAnswerMessageSchema } from "@draht/geist-protocol";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { createSessionBridge, type SessionBridge } from "../session-bridge.js";

/**
 * The bridge's pairing endpoint (spec §6 Bridge row: "Hono + WS · bin geist";
 * spec §7 "geist-core: pairing"). Drives the framework-free `PairingState`
 * machine from `@draht/geist-core` over a real WS connection so a headset
 * can pair once, survive an app restart (disconnect/reconnect), and resume
 * without re-pairing inside the grace window (spec §16 M1 "pairing survives
 * restart").
 *
 * Also relays spec §9.2's `permission_request` / `permission_answer`
 * messages (R35-M3.5) between the paired connection and whatever sessions
 * are registered on this server's `sessionBridge` — see `session-bridge.ts`
 * for the registration side. Only one headset is ever paired at a time
 * (spec §16 M1), so a `permission_request` raised while nobody is currently
 * connected is simply dropped; there is no queue/redelivery yet.
 *
 * Wire protocol (`pair`/`reconnect`/`paired`/etc. are this package's own
 * call — not yet in spec §9.2's table; `permission_request`/`permission_answer`
 * ARE spec §9.2, schemas owned by `@draht/geist-protocol`):
 *   client -> server  {"type":"pair","token":"<lan-pairing-token>"}
 *   client -> server  {"type":"reconnect","token":"<lan-pairing-token>"}
 *   server -> client  {"type":"paired"}
 *   server -> client  {"type":"pair_rejected","reason":"invalid_token"}
 *   server -> client  {"type":"reconnected"}
 *   server -> client  {"type":"reconnect_rejected","reason":"invalid_token"|"grace_expired"|"not_paired"}
 *   server -> client  {"type":"permission_request","payload":{sessionId,requestId,title,options:[{id,label,kind}]}}
 *   client -> server  {"type":"permission_answer","payload":{sessionId,requestId,optionId}}
 *   server -> client  {"type":"error","reason":"invalid_message"|"not_paired"|"permission_answer_failed"}
 */

export interface PairingServerOptions {
	/** Port to listen on. Defaults to 0 (OS-assigned ephemeral port — matches this monorepo's test convention, e.g. `packages/gateway`). */
	port?: number;
	/**
	 * Interface to bind. Defaults to `127.0.0.1` (R32-FLEET.9, GSEC-04 bind
	 * half). Anything non-loopback is refused unless {@link
	 * PairingServerOptions.allowNonLoopback} is also set.
	 */
	hostname?: string;
	/** Explicitly accept a non-loopback bind. Off by default; see {@link assertBindHostAllowed}. */
	allowNonLoopback?: boolean;
	/** Sink for the non-loopback opt-in warning. Defaults to `console.warn`. */
	warn?: (message: string) => void;
	/** Reconnect grace window in ms (spec §16 M1). Defaults to `PairingState`'s own default (60s). */
	graceWindowMs?: PairingStateOptions["graceWindowMs"];
	/** Fixed pairing token, for deterministic tests/provisioning. Defaults to a fresh random LAN pairing token. */
	token?: PairingStateOptions["token"];
	/** Clock injection, for deterministic tests. Defaults to `Date.now`. */
	now?: PairingStateOptions["now"];
	/** WS upgrade path. Defaults to `/pair`. */
	path?: string;
	/**
	 * Session registry driving the `permission_request`/`permission_answer`
	 * relay (spec §9.2, R35-M3.5). Defaults to a fresh, empty
	 * {@link SessionBridge}. Pass one in to register sessions before the
	 * server starts, or to share a single bridge across a longer-lived
	 * composition root.
	 */
	sessionBridge?: SessionBridge;
}

export interface PairingServerHandle {
	/** The underlying Bun server instance. */
	server: ReturnType<typeof Bun.serve>;
	/** `ws://` URL a client should connect to for the pairing handshake. */
	url: string;
	/** The pairing state machine driving this server — inspect directly in tests. */
	state: PairingState;
	/**
	 * The session registry driving the `permission_request`/`permission_answer`
	 * relay — register/unregister live sessions here (spec §9.2, R35-M3.5).
	 * Either the `sessionBridge` passed in via options, or the fresh one
	 * created when none was given.
	 */
	sessionBridge: SessionBridge;
	/** Stops the server. */
	close(): void;
}

/**
 * The only hostnames treated as loopback.
 *
 * An exact set rather than a `127.0.0.0/8` range check: for a *bind* target,
 * anything we are not certain is loopback must fall into the guarded path.
 *
 * Deliberately a local copy rather than an import of the identically-named
 * guard in `@draht/gateway`: the geist family may import only its non-privileged
 * geist siblings (R31-FOUND.4, enforced by `scripts/check-geist-boundary.mjs`),
 * and a security guard is not worth re-privileging the package for. The
 * repo-wide `check:bun-serve-hostname` gate is what keeps both copies honest —
 * it fails on any `Bun.serve` that does not name its interface, wherever it is.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Pure predicate — is `host` a loopback bind target?
 *
 * `0.0.0.0`, `::`, LAN addresses and Tailscale `100.x` addresses are all
 * non-loopback and therefore require an explicit opt-in.
 */
export function isLoopbackHost(host: string): boolean {
	if (typeof host !== "string") {
		throw new TypeError(`bind host must be a string, got ${host === null ? "null" : typeof host}`);
	}
	// Normalize the shapes a human or a config file may legitimately produce:
	// surrounding whitespace, mixed case, and bracketed IPv6 (`[::1]`).
	const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
	return LOOPBACK_HOSTS.has(normalized);
}

/** Inputs to {@link assertBindHostAllowed}. */
export interface BindHostPolicy {
	/** The interface the caller wants to bind. */
	host: string;
	/** True when the caller explicitly accepted a non-loopback bind. */
	allowNonLoopback?: boolean;
	/** Sink for the opt-in warning. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

/**
 * Enforce the loopback-by-default bind posture for the pairing listener.
 *
 * This exists because `createPairingServer` used to call `Bun.serve({ port })`
 * with no `hostname` — which binds every interface — putting the pairing token
 * and the permission relay behind it on the LAN. That is GSEC-04's named
 * subject.
 *
 * @returns The host, unchanged, once it is allowed to be bound.
 * @throws Error when `host` is non-loopback and `allowNonLoopback` is not set.
 */
export function assertBindHostAllowed({ host, allowNonLoopback = false, warn }: BindHostPolicy): string {
	if (isLoopbackHost(host)) {
		return host;
	}
	if (!allowNonLoopback) {
		throw new Error(
			[
				`Refusing to bind non-loopback host '${host}'.`,
				"",
				"This listener carries the pairing token and the permission relay: a headset",
				"that reaches it can answer permission prompts on your behalf. Binding it to an",
				"interface another machine can route to hands that to anyone on the network.",
				"",
				"Supported remote access path: leave the listener on loopback and put Tailscale",
				"in front of it:",
				"",
				"    tailscale serve --bg http://127.0.0.1:<port>",
				"",
				"That terminates TLS with a real certificate on a stable MagicDNS name, which",
				"the Quest browser and iOS clients require. Never use `tailscale funnel`.",
				"",
				"If you understand the risk and still want a raw non-loopback bind, pass",
				"allowNonLoopback: true explicitly.",
			].join("\n"),
		);
	}
	(warn ?? ((message: string) => console.warn(message)))(
		[
			"",
			"!!! ============================================================== !!!",
			`!!! Binding NON-LOOPBACK host '${host}' for the pairing listener.`,
			"!!! Anyone who can route to this interface can attempt to pair and",
			"!!! answer permission prompts as you.",
			"!!! Prefer: bind 127.0.0.1 and expose it with `tailscale serve`.",
			"!!! ============================================================== !!!",
			"",
		].join("\n"),
	);
	return host;
}

/** Render a bound host for use inside a URL (IPv6 needs brackets). */
function urlHost(host: string): string {
	return host.includes(":") ? `[${host}]` : host;
}

type InboundPairMessage = { type: "pair" | "reconnect"; token: string };

function isInboundPairMessage(value: unknown): value is InboundPairMessage {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (record.type === "pair" || record.type === "reconnect") && typeof record.token === "string";
}

/**
 * Starts the bridge's pairing WS server. Startable/stoppable — call `close()`
 * to tear it down (e.g. in a test's `afterEach`).
 */
export function createPairingServer(options: PairingServerOptions = {}): PairingServerHandle {
	// Bind policy first, before anything that would have to be torn down: a
	// refusal must mean nothing was ever wired and nothing was ever listening
	// (R32-FLEET.9). In particular the `sessionBridge.onPermissionRequest`
	// subscription below has no owner to unsubscribe it if we throw past it.
	const hostname = assertBindHostAllowed({
		host: options.hostname ?? "127.0.0.1",
		allowNonLoopback: options.allowNonLoopback,
		warn: options.warn,
	});

	const path = options.path ?? "/pair";
	const state = new PairingState({
		graceWindowMs: options.graceWindowMs,
		token: options.token,
		now: options.now,
	});
	const sessionBridge = options.sessionBridge ?? createSessionBridge();

	const app = new Hono();

	// The single socket that has actually completed a successful `pair` or
	// `reconnect` — the authenticated session holder (spec §16 M1: only one
	// headset is ever paired at a time). Authorization is bound to THIS
	// connection, not to the global `state.status`: a second socket that merely
	// opens `/pair` without presenting a valid token never becomes
	// `authenticatedWs`, so it neither receives `permission_request` messages
	// (which leak tool titles / file paths) nor can send an accepted
	// `permission_answer`. Set only on a successful pair/reconnect below,
	// cleared when that same socket closes.
	//
	// hono's Bun adapter builds a FRESH `WSContext` wrapper on every event
	// (open/message/close all call `createWSContext(ws)`), so wrapper identity is
	// NOT stable across a connection's events — only the underlying raw Bun
	// socket (`ws.raw`) is. Authorization is therefore keyed on `ws.raw`
	// identity; `authenticatedWs` just holds a live wrapper to `send()` through.
	let authenticatedWs: WSContext | undefined;
	let authenticatedRaw: unknown;
	const unsubscribeSessionBridge = sessionBridge.onPermissionRequest((message) => {
		if (state.status === "paired" && authenticatedWs !== undefined) {
			authenticatedWs.send(JSON.stringify(message));
		}
	});

	app.get(
		path,
		upgradeWebSocket(() => ({
			onOpen(_evt, _ws) {
				// A fresh socket opening is a pairing attempt UNLESS a paired
				// session is already resuming from a disconnect — beginPairingAttempt()
				// is a no-op in that case (unpaired -> pairing only). The socket is
				// NOT bound as the authenticated connection here: that only happens
				// once it presents a valid token (see the pair/reconnect handling
				// below), so merely opening `/pair` grants no permission access.
				state.beginPairingAttempt();
			},

			onMessage(evt, ws) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(String(evt.data));
				} catch {
					ws.send(JSON.stringify({ type: "error", reason: "invalid_message" }));
					return;
				}

				if (isInboundPairMessage(parsed)) {
					if (parsed.type === "pair") {
						const result = state.completePairing(parsed.token);
						// Bind authorization to THIS socket only on a successful pair.
						if (result.ok) {
							authenticatedWs = ws;
							authenticatedRaw = ws.raw;
						}
						ws.send(
							JSON.stringify(result.ok ? { type: "paired" } : { type: "pair_rejected", reason: result.reason }),
						);
						return;
					}

					const result = state.reconnect(parsed.token);
					// A successful reconnect makes THIS (new) socket the authenticated one.
					if (result.ok) {
						authenticatedWs = ws;
						authenticatedRaw = ws.raw;
					}
					ws.send(
						JSON.stringify(
							result.ok ? { type: "reconnected" } : { type: "reconnect_rejected", reason: result.reason },
						),
					);
					return;
				}

				const permissionAnswer = PermissionAnswerMessageSchema.safeParse(parsed);
				if (permissionAnswer.success) {
					// Only the socket currently holding the authenticated session may
					// answer permissions. A socket that never paired (or a stale one
					// after the real headset reconnected on a new socket) is rejected,
					// so its answer never reaches `answerPermission`. Keyed on the raw
					// Bun socket because the WSContext wrapper is re-created per event.
					if (authenticatedRaw === undefined || ws.raw !== authenticatedRaw) {
						ws.send(JSON.stringify({ type: "error", reason: "not_paired" }));
						return;
					}

					const { sessionId, requestId, optionId } = permissionAnswer.data.payload;
					// No ack on success (spec §9.2's table has no reply for permission_answer);
					// on failure (unknown session, or the session rejects the requestId/optionId)
					// the headset needs to know its answer didn't land.
					sessionBridge.answerPermission(sessionId, requestId, optionId).catch(() => {
						ws.send(JSON.stringify({ type: "error", reason: "permission_answer_failed" }));
					});
					return;
				}

				ws.send(JSON.stringify({ type: "error", reason: "invalid_message" }));
			},

			onClose(_evt, ws) {
				// Only the authenticated socket closing opens the reconnect grace
				// window. A never-paired socket (or a superseded one) closing must
				// NOT knock the real, still-connected headset into a disconnect it
				// never asked for. Keyed on the raw Bun socket (see above).
				if (authenticatedRaw !== undefined && ws.raw === authenticatedRaw) {
					authenticatedWs = undefined;
					authenticatedRaw = undefined;
					state.disconnect();
				}
			},
		})),
	);

	const server = Bun.serve({ port: options.port ?? 0, hostname, fetch: app.fetch, websocket });

	return {
		server,
		// Built from the host that was actually bound, not from `localhost`:
		// `localhost` can resolve to `::1` first, which a `127.0.0.1` listener
		// does not answer.
		url: `ws://${urlHost(server.hostname ?? hostname)}:${server.port}${path}`,
		state,
		sessionBridge,
		close() {
			unsubscribeSessionBridge();
			server.stop(true);
		},
	};
}
