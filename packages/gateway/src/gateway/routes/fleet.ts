import { AttachBridge, buildFleetFrame, type RendererConnection } from "@draht/geist-core";
import { DEFAULT_TRANSPORT_LIMITS, type TransportLimits } from "@draht/geist-protocol";
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import pkg from "../../../package.json" with { type: "json" };

/**
 * The fleet and attach surface (R32-FLEET.2, R32-FLEET.3).
 *
 *   GET /fleet    every live attachable draht session on this machine
 *   GET /attach   WebSocket; the geist wire, bridged to one session's socket
 *
 * This file is wiring and nothing else. The projection and the bridge live in
 * `@draht/geist-core`, which imports no kernel package — so when Phase 38 moves
 * the daemon host, the product logic does not move with it
 * (`scripts/check-geist-boundary.mjs`, R32-FLEET.1). What is genuinely
 * host-specific stays here: how a Bun WebSocket reports its unflushed bytes,
 * and how it is closed.
 *
 * Authentication is deliberately NOT re-implemented here. Both routes sit
 * behind the bearer middleware `createServer` registers for everything except
 * `/health`, and that middleware runs on the upgrade *request* — so an
 * unauthenticated attach is answered with 401 before a WebSocket exists, which
 * is before any frame can arrive, which is before any Unix socket can be dialled
 * (R32-FLEET.3).
 */
export interface FleetRoutesOptions {
	/** Directory the fleet publishes itself in (`<agent dir>/sockets`). */
	socketDir: string;
	/** Transport caps to advertise and enforce. Defaults to the protocol's. */
	limits?: TransportLimits;
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
		upgradeWebSocket(() => {
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
