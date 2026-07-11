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

	const server = Bun.serve({ port: options.port ?? 0, fetch: app.fetch, websocket });

	return {
		server,
		url: `ws://localhost:${server.port}${path}`,
		state,
		sessionBridge,
		close() {
			unsubscribeSessionBridge();
			server.stop(true);
		},
	};
}
