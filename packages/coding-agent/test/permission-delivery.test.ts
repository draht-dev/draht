/**
 * T8-PIN — `PermissionDelivery`, the per-connection bookkeeping, pinned.
 *
 * Nothing in the repo imported this class before this file existed. Its two bounds (64 client
 * records, 256 delivered ids per client) and its one non-negotiable property — DELIVERY IS NEVER A
 * STATE TRANSITION — were reachable only through a live socket session.
 *
 * The defect the class exists to make unrepresentable: if being SHOWN an ask consumed it, a client
 * that was shown the ask and then died would take it with it, and the agent would still be parked
 * in `beforeToolCall` waiting for an answer nobody can give. So the tests below assert the
 * negative as hard as the positive — after every delivery, replay and eviction, the ask is still
 * pending and still answerable.
 *
 * The replay half is driven through the REAL `PermissionRegistry` and the REAL relay, because
 * "still answerable" is a claim about the registry, and a delivery test that only asked delivery
 * whether the ask survived would be asking the wrong object.
 */

import { describe, expect, it } from "vitest";
import type { RelayAsk } from "../src/core/permission-relay/index.ts";
import {
	DEFAULT_MAX_DELIVERED_PER_CLIENT,
	DEFAULT_MAX_DELIVERY_CLIENTS,
	type DeliverableAsk,
	PermissionDelivery,
} from "../src/core/socket-server/permission-delivery.ts";
import {
	DEFAULT_MAX_PENDING,
	type PermissionEntry,
	PermissionRegistry,
} from "../src/core/socket-server/permission-registry.ts";
import {
	createSocketPermissionRelay,
	type PermissionRecorder,
	type PermissionSocketServer,
	type SocketPermissionRelay,
} from "../src/core/socket-server/permission-relay.ts";
import type { PermissionRequestMessage } from "../src/core/socket-server/types.ts";

const SESSION_ID = "session-under-test";

/** The least a delivery record needs. Nothing here is a permission fact — that is the point. */
function ask(requestId: string): DeliverableAsk {
	return { requestId };
}

/** A delivery over a pending list the test owns outright. */
function deliveryOver(
	pending: DeliverableAsk[],
	options: { maxClients?: number; maxPerClient?: number } = {},
): PermissionDelivery {
	return new PermissionDelivery({ pending: () => pending, ...options });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// exactly once per connection
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionDelivery — exactly once per connection, and idempotent", () => {
	it("shows a client every pending ask once and then stops offering it", () => {
		const pending = [ask("req-1"), ask("req-2")];
		const delivery = deliveryOver(pending);

		expect(delivery.pendingFor("phone").map((entry) => entry.requestId)).toEqual(["req-1", "req-2"]);

		delivery.markDelivered("phone", "req-1");
		expect(delivery.pendingFor("phone").map((entry) => entry.requestId)).toEqual(["req-2"]);
		delivery.markDelivered("phone", "req-2");
		expect(delivery.pendingFor("phone")).toEqual([]);
	});

	it("treats a repeated delivery as the same delivery", () => {
		const delivery = deliveryOver([ask("req-1")]);
		delivery.markDelivered("phone", "req-1");
		delivery.markDelivered("phone", "req-1");
		delivery.markDelivered("phone", "req-1");

		expect(delivery.hasDelivered("phone", "req-1")).toBe(true);
		expect(delivery.pendingFor("phone")).toEqual([]);
	});

	it("keeps clients apart — one client's screen says nothing about another's", () => {
		const delivery = deliveryOver([ask("req-1")]);
		delivery.markDelivered("phone", "req-1");

		expect(delivery.hasDelivered("phone", "req-1")).toBe(true);
		expect(delivery.hasDelivered("desktop", "req-1")).toBe(false);
		expect(delivery.pendingFor("desktop").map((entry) => entry.requestId)).toEqual(["req-1"]);
	});

	it("reads the pending list LIVE, so an ask answered mid-connect is never replayed", () => {
		// The race this closes: a client attaches while an ask is being answered. Replaying a
		// settled ask puts a dialog on a phone that can only ever be refused.
		const pending = [ask("req-1"), ask("req-2")];
		const delivery = deliveryOver(pending);

		pending.splice(0, 1); // req-1 was just answered
		expect(delivery.pendingFor("phone").map((entry) => entry.requestId)).toEqual(["req-2"]);
	});

	it("reports nothing for a client it has never heard of, rather than throwing", () => {
		const delivery = deliveryOver([]);
		expect(delivery.hasDelivered("stranger", "req-1")).toBe(false);
		expect(delivery.pendingFor("stranger")).toEqual([]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// forgetting — the reconnect case, T8-PIN behaviour (2) at the unit level
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionDelivery — a reconnecting client is a NEW connection with nothing on its screen", () => {
	it("shows the same client every pending ask again after its connection ended", () => {
		const pending = [ask("req-1"), ask("req-2")];
		const delivery = deliveryOver(pending);
		delivery.markDelivered("phone", "req-1");
		delivery.markDelivered("phone", "req-2");
		expect(delivery.pendingFor("phone")).toEqual([]);

		delivery.forgetClient("phone");

		// Same id, new connection: it may be a fresh process that has never seen any of them.
		// Remembering across the gap leaves a phone that dropped its WebSocket staring at a
		// session whose ask it can no longer see or answer.
		expect(delivery.pendingFor("phone").map((entry) => entry.requestId)).toEqual(["req-1", "req-2"]);
	});

	it("forgetting one client leaves every other client's record intact", () => {
		const delivery = deliveryOver([ask("req-1")]);
		delivery.markDelivered("phone", "req-1");
		delivery.markDelivered("desktop", "req-1");

		delivery.forgetClient("phone");

		expect(delivery.pendingFor("phone").map((entry) => entry.requestId)).toEqual(["req-1"]);
		expect(delivery.pendingFor("desktop")).toEqual([]);
	});

	it("forgetting a client that was never seen is a no-op", () => {
		const delivery = deliveryOver([ask("req-1")]);
		delivery.markDelivered("phone", "req-1");
		delivery.forgetClient("someone-else");
		expect(delivery.hasDelivered("phone", "req-1")).toBe(true);
	});

	it("drops a finished ask from EVERY client's record", () => {
		const delivery = deliveryOver([ask("req-1"), ask("req-2")]);
		for (const client of ["phone", "desktop", "watch"]) {
			delivery.markDelivered(client, "req-1");
			delivery.markDelivered(client, "req-2");
		}

		delivery.forgetRequest("req-1");

		for (const client of ["phone", "desktop", "watch"]) {
			expect(delivery.hasDelivered(client, "req-1"), client).toBe(false);
			expect(delivery.hasDelivered(client, "req-2"), client).toBe(true);
		}
	});

	it("clear() forgets every client at once", () => {
		const delivery = deliveryOver([ask("req-1")]);
		delivery.markDelivered("phone", "req-1");
		delivery.markDelivered("desktop", "req-1");

		delivery.clear();

		expect(delivery.pendingFor("phone").map((entry) => entry.requestId)).toEqual(["req-1"]);
		expect(delivery.pendingFor("desktop").map((entry) => entry.requestId)).toEqual(["req-1"]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// the bounds
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionDelivery — the bounds, and which way they fail", () => {
	it("keeps at most maxClients records, evicting the least recently ADDED", () => {
		const delivery = deliveryOver([ask("req-1")], { maxClients: 2 });
		delivery.markDelivered("first", "req-1");
		delivery.markDelivered("second", "req-1");
		delivery.markDelivered("third", "req-1");

		// The evicted client is simply shown the ask again on its next replay — the failure mode
		// is a duplicate dialog, never a lost one.
		expect(delivery.hasDelivered("first", "req-1")).toBe(false);
		expect(delivery.hasDelivered("second", "req-1")).toBe(true);
		expect(delivery.hasDelivered("third", "req-1")).toBe(true);
	});

	it("holds DEFAULT_MAX_DELIVERY_CLIENTS records before evicting anything", () => {
		const delivery = deliveryOver([ask("req-1")]);
		for (let index = 0; index < DEFAULT_MAX_DELIVERY_CLIENTS; index++) {
			delivery.markDelivered(`client-${index}`, "req-1");
		}
		expect(delivery.hasDelivered("client-0", "req-1")).toBe(true);

		delivery.markDelivered("one-too-many", "req-1");
		expect(delivery.hasDelivered("client-0", "req-1")).toBe(false);
		expect(delivery.hasDelivered("client-1", "req-1")).toBe(true);

		// Well above the socket server's own maxClients of 10, so a normally-sized fleet never
		// reaches this bound at all.
		expect(DEFAULT_MAX_DELIVERY_CLIENTS).toBe(64);
		expect(DEFAULT_MAX_DELIVERY_CLIENTS).toBeGreaterThan(10);
	});

	it("remembers at most maxPerClient ids for one client, dropping the oldest", () => {
		const delivery = deliveryOver([], { maxPerClient: 2 });
		delivery.markDelivered("phone", "req-1");
		delivery.markDelivered("phone", "req-2");
		delivery.markDelivered("phone", "req-3");

		expect(delivery.hasDelivered("phone", "req-1")).toBe(false);
		expect(delivery.hasDelivered("phone", "req-2")).toBe(true);
		expect(delivery.hasDelivered("phone", "req-3")).toBe(true);
	});

	it("holds DEFAULT_MAX_DELIVERED_PER_CLIENT ids, and that bound can never bind before the registry's", () => {
		const delivery = deliveryOver([]);
		for (let index = 0; index < DEFAULT_MAX_DELIVERED_PER_CLIENT; index++) {
			delivery.markDelivered("phone", `req-${index}`);
		}
		expect(delivery.hasDelivered("phone", "req-0")).toBe(true);
		delivery.markDelivered("phone", "req-overflow");
		expect(delivery.hasDelivered("phone", "req-0")).toBe(false);

		expect(DEFAULT_MAX_DELIVERED_PER_CLIENT).toBe(256);
		// THE ORDERING IS THE POINT, not the numbers. At most 32 asks can be pending at once, so a
		// client can never be shown enough of them to forget one that is still live. If either
		// constant ever moves past the other, a client would start being re-shown asks it is
		// already looking at — this assertion is what stops that landing silently.
		expect(DEFAULT_MAX_DELIVERED_PER_CLIENT).toBeGreaterThan(DEFAULT_MAX_PENDING);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// delivery is NEVER a state transition — proved against the real registry and the real relay
// ══════════════════════════════════════════════════════════════════════════════════════════════

interface Rig {
	relay: SocketPermissionRelay;
	registry: PermissionRegistry;
	delivery: PermissionDelivery<PermissionEntry>;
	/** Every frame sent to one named client, in order. */
	sentTo: Map<string, PermissionRequestMessage[]>;
	broadcast: PermissionRequestMessage[];
	/** Client ids the fake server reports as reached by a broadcast. */
	attached: string[];
	/** Take the socket away, exactly as a session replacement or a stop does. */
	dropServer: () => void;
}

function createRig(): Rig {
	const sentTo = new Map<string, PermissionRequestMessage[]>();
	const broadcast: PermissionRequestMessage[] = [];
	const attached: string[] = [];

	const registry = new PermissionRegistry({ sessionId: SESSION_ID });
	const delivery = new PermissionDelivery<PermissionEntry>({ pending: () => registry.pending() });

	const server: PermissionSocketServer = {
		get permissionCapableClientCount() {
			return attached.length;
		},
		broadcastPermissionRequest(message) {
			broadcast.push(message);
			return [...attached];
		},
		sendPermissionRequest(clientId, message) {
			const seen = sentTo.get(clientId) ?? [];
			seen.push(message);
			sentTo.set(clientId, seen);
		},
		broadcastPermissionResolved() {},
		sendErrorToClient() {},
	};
	const recorder: PermissionRecorder = { appendPermissionResolution: () => "entry-id" };

	let live: PermissionSocketServer | null = server;
	const relay = createSocketPermissionRelay({
		registry,
		delivery,
		server: () => live,
		recorder: () => recorder,
		sessionId: SESSION_ID,
		cwd: "/tmp/project",
		onWarning: () => {},
	});

	return {
		relay,
		registry,
		delivery,
		sentTo,
		broadcast,
		attached,
		dropServer: () => {
			live = null;
		},
	};
}

function toolAsk(requestId: string): RelayAsk {
	return {
		requestId,
		method: "confirm",
		title: "Approve tool call?",
		message: "bash: touch /tmp/marker",
		options: [
			{ id: "allow", label: "Allow", decision: "approve" },
			{ id: "deny", label: "Deny", decision: "deny" },
		],
		requestedAt: new Date().toISOString(),
		deadline: null,
	};
}

describe("replay through the real relay — being shown an ask never consumes it", () => {
	it("replays a still-pending ask to a client that attached late, and it stays answerable", async () => {
		const rig = createRig();
		rig.attached.push("desktop");
		const pending = rig.relay.raise(toolAsk("req-1"));

		// The client that was connected already has it, exactly once.
		expect(rig.broadcast.map((frame) => frame.requestId)).toEqual(["req-1"]);
		expect(rig.delivery.hasDelivered("desktop", "req-1")).toBe(true);

		rig.relay.replayTo("phone");
		expect(rig.sentTo.get("phone")?.map((frame) => frame.requestId)).toEqual(["req-1"]);

		// THE NEGATIVE: after two surfaces have been shown it, the ask is untouched.
		expect(rig.registry.pendingCount).toBe(1);
		rig.relay.handleResponse({ requestId: "req-1", optionId: "allow" }, "phone");
		await expect(pending).resolves.toMatchObject({ optionId: "allow", decidedBy: { clientId: "phone" } });
	});

	it("does not replay the same ask twice on one connection", () => {
		const rig = createRig();
		void rig.relay.raise(toolAsk("req-1"));

		rig.relay.replayTo("phone");
		rig.relay.replayTo("phone");
		rig.relay.replayTo("phone");

		expect(rig.sentTo.get("phone")).toHaveLength(1);
		rig.relay.cancelAll();
	});

	it("replays the SAME ask to a client that reconnects under the same id", () => {
		// T8-PIN behaviour (2): destroy the connection mid-ask, come back as the same client, get
		// the same requestId. The socket server drives this through `forgetClient` on disconnect.
		const rig = createRig();
		void rig.relay.raise(toolAsk("req-1"));
		rig.relay.replayTo("phone");
		expect(rig.sentTo.get("phone")).toHaveLength(1);

		rig.relay.forgetClient("phone");
		rig.relay.replayTo("phone");

		const seen = rig.sentTo.get("phone") ?? [];
		expect(seen).toHaveLength(2);
		// The same ask, replayed — not a second one raised for the reconnecting client.
		expect(seen[1]?.requestId).toBe("req-1");
		expect(seen[1]).toEqual(seen[0]);
		expect(rig.registry.pendingCount).toBe(1);
		rig.relay.cancelAll();
	});

	it("stops replaying an ask that has been answered", async () => {
		const rig = createRig();
		rig.attached.push("desktop");
		const pending = rig.relay.raise(toolAsk("req-1"));
		rig.relay.handleResponse({ requestId: "req-1", optionId: "deny" }, "desktop");
		await expect(pending).resolves.toMatchObject({ optionId: "deny" });

		rig.relay.replayTo("phone");
		expect(rig.sentTo.get("phone")).toBeUndefined();
	});

	it("replays nothing at all once the socket is gone", () => {
		// A relay whose session was replaced or stopped must write nothing: a straggling attach
		// callback would otherwise reach a server that has already been torn down. The ask is
		// still in the registry here, so the silence has to come from the socket check and not
		// from an empty pending list.
		const rig = createRig();
		void rig.relay.raise(toolAsk("req-1"));
		rig.dropServer();

		expect(rig.registry.pendingCount).toBe(1);
		rig.relay.replayTo("phone");
		expect(rig.sentTo.get("phone")).toBeUndefined();
	});
});
