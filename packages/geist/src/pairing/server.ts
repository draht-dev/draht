import { PairingState, type PairingStateOptions } from "@draht/geist-core";
import { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";

/**
 * The bridge's pairing endpoint (spec §6 Bridge row: "Hono + WS · bin geist";
 * spec §7 "geist-core: pairing"). Drives the framework-free `PairingState`
 * machine from `@draht/geist-core` over a real WS connection so a headset
 * can pair once, survive an app restart (disconnect/reconnect), and resume
 * without re-pairing inside the grace window (spec §16 M1 "pairing survives
 * restart").
 *
 * Wire protocol (this package's own call — not yet in spec §9.2's table):
 *   client -> server  {"type":"pair","token":"<lan-pairing-token>"}
 *   client -> server  {"type":"reconnect","token":"<lan-pairing-token>"}
 *   server -> client  {"type":"paired"}
 *   server -> client  {"type":"pair_rejected","reason":"invalid_token"}
 *   server -> client  {"type":"reconnected"}
 *   server -> client  {"type":"reconnect_rejected","reason":"invalid_token"|"grace_expired"|"not_paired"}
 *   server -> client  {"type":"error","reason":"invalid_message"}
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
}

export interface PairingServerHandle {
	/** The underlying Bun server instance. */
	server: ReturnType<typeof Bun.serve>;
	/** `ws://` URL a client should connect to for the pairing handshake. */
	url: string;
	/** The pairing state machine driving this server — inspect directly in tests. */
	state: PairingState;
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

	const app = new Hono();

	app.get(
		path,
		upgradeWebSocket(() => ({
			onOpen() {
				// A fresh socket opening is a pairing attempt UNLESS a paired
				// session is already resuming from a disconnect — beginPairingAttempt()
				// is a no-op in that case (unpaired -> pairing only).
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

				if (!isInboundPairMessage(parsed)) {
					ws.send(JSON.stringify({ type: "error", reason: "invalid_message" }));
					return;
				}

				if (parsed.type === "pair") {
					const result = state.completePairing(parsed.token);
					ws.send(
						JSON.stringify(result.ok ? { type: "paired" } : { type: "pair_rejected", reason: result.reason }),
					);
					return;
				}

				const result = state.reconnect(parsed.token);
				ws.send(
					JSON.stringify(
						result.ok ? { type: "reconnected" } : { type: "reconnect_rejected", reason: result.reason },
					),
				);
			},

			onClose() {
				state.disconnect();
			},
		})),
	);

	const server = Bun.serve({ port: options.port ?? 0, fetch: app.fetch, websocket });

	return {
		server,
		url: `ws://localhost:${server.port}${path}`,
		state,
		close() {
			server.stop(true);
		},
	};
}
