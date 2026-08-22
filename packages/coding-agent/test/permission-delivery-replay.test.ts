/**
 * HC — the REPLAY BURST BOUND, which until now had no witness at all.
 *
 * `PermissionDelivery.pendingFor` applies two caps — {@link DEFAULT_MAX_REPLAY_ASKS} and
 * {@link DEFAULT_MAX_REPLAY_BYTES} — and neither of them could ever bind in any existing test,
 * because every existing test has exactly ONE pending ask. Deleting the entire cap loop (returning
 * `undelivered` whole) left the suite green: 4 passing files, 51 satisfied expects, and a bound
 * that is the only thing standing between a reconnecting phone and the registry's whole 32-ask,
 * 4 MiB backlog written at it in one loop.
 *
 * The e2e harness cannot produce this state. The permission gate serialises tool calls, so a live
 * session parks on ONE ask at a time and 17 concurrent pending asks is not a thing an end-to-end
 * client can drive. The bound is therefore pinned here, at the unit, against the REAL
 * `PermissionRegistry` — because "truncating is not dropping" is a claim about the registry, and a
 * test that asked the delivery bookkeeping whether the ask survived would be asking the wrong
 * object. Every case below ends by proving the untruncated remainder is still pending and still
 * answerable.
 *
 * ORDERING IS PART OF THE BOUND, not decoration. A cap only means something against an order: the
 * asks that get through are the OLDEST, because insertion order is deadline order and the ask
 * closest to expiring is the one a human has least time left to answer. Truncating from the wrong
 * end would starve exactly the asks about to fail closed. Nothing observed that before this file.
 *
 * THE GAP THIS FILE RECORDS RATHER THAN CLOSES: nothing re-drives the remainder. `pendingFor` is
 * called once per attach, so a client sitting at the cap is shown the same first 16 on every
 * reconnect and cannot reach asks 17+ until an earlier one ends. The unit-level drain below
 * ("a second call yields the remainder") is a property of this class that production never
 * exercises. See the note above that test.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_DELIVERED_PER_CLIENT,
	DEFAULT_MAX_REPLAY_ASKS,
	DEFAULT_MAX_REPLAY_BYTES,
	type DeliverableAsk,
	PermissionDelivery,
} from "../src/core/socket-server/permission-delivery.ts";
import {
	DEFAULT_MAX_ENTRY_BYTES,
	DEFAULT_MAX_PENDING,
	type PermissionEntry,
	PermissionRegistry,
} from "../src/core/socket-server/permission-registry.ts";
import type { PermissionRequestMessage } from "../src/core/socket-server/types.ts";

const SESSION_ID = "session-under-test";

/** The offered set every ask below carries. Frozen by the registry on insert. */
const OPTIONS = [
	{ id: "approve", label: "Approve", decision: "approve" as const },
	{ id: "deny", label: "Deny", decision: "deny" as const },
];

/**
 * Ids are FIXED WIDTH so that every frame differs only by its padding.
 *
 * The byte cases below compute a padding length from a measured base frame; a variable-length id
 * would make that base a lie by a few bytes per ask and the arithmetic silently approximate.
 */
function idFor(index: number): string {
	return `req-${String(index).padStart(3, "0")}`;
}

/** A real `permission_request` frame — the thing the registry weighs and the relay replays. */
function frameFor(requestId: string, padding: number): PermissionRequestMessage {
	return {
		type: "permission_request",
		requestId,
		method: "confirm",
		toolCallId: `call-${requestId}`,
		toolName: "bash",
		cwd: "/tmp/project",
		title: "Approve tool call?",
		message: "bash",
		command: `echo ${"x".repeat(padding)}`,
		truncated: false,
		options: OPTIONS.map((option) => ({ id: option.id, label: option.label })),
		requestedAt: "2026-01-01T00:00:00.000Z",
		deadline: null,
	};
}

/** Encoded size of a frame with no padding — the fixed cost every ask pays. */
const BASE_FRAME_BYTES = Buffer.byteLength(JSON.stringify(frameFor(idFor(0), 0)), "utf8");

interface Rig {
	registry: PermissionRegistry;
	delivery: PermissionDelivery<PermissionEntry>;
	/** Raise one ask that encodes to `bytes` in total. Returns the registered entry. */
	raise: (index: number, bytes?: number) => PermissionEntry;
	/** Raise `count` asks, oldest first, each of `bytes`. */
	raiseMany: (count: number, bytes?: number) => PermissionEntry[];
	ids: (asks: readonly DeliverableAsk[]) => string[];
}

/**
 * A real registry and a real delivery over it.
 *
 * `now` is a hand-cranked clock that advances one second per ask, so every entry's `deadlineAt` is
 * strictly later than the one before it. That is what makes "oldest first" an assertion about
 * DEADLINES rather than about the order the test happened to build a list in.
 */
function createRig(options: { maxReplayAsks?: number; maxReplayBytes?: number; maxPerClient?: number } = {}): Rig {
	let clock = 1_700_000_000_000;
	const registry = new PermissionRegistry({ sessionId: SESSION_ID, now: () => clock });
	const delivery = new PermissionDelivery<PermissionEntry>({
		pending: () => registry.pending(),
		...options,
	});

	const raise = (index: number, bytes = BASE_FRAME_BYTES): PermissionEntry => {
		const requestId = idFor(index);
		const result = registry.insert({
			requestId,
			method: "confirm",
			options: OPTIONS,
			frame: frameFor(requestId, bytes - BASE_FRAME_BYTES),
			requestedAt: new Date(clock).toISOString(),
			resolve: () => {},
		});
		if (!result.ok) throw new Error(`the fixture could not raise ${requestId}: ${result.message}`);
		clock += 1_000;
		return result.entry;
	};

	return {
		registry,
		delivery,
		raise,
		raiseMany: (count, bytes) => Array.from({ length: count }, (_, index) => raise(index, bytes)),
		ids: (asks) => asks.map((ask) => ask.requestId),
	};
}

/** Every registry the test raised into, so its expiry timers die with the test. */
const rigs: Rig[] = [];

function rig(options?: { maxReplayAsks?: number; maxReplayBytes?: number; maxPerClient?: number }): Rig {
	const created = createRig(options);
	rigs.push(created);
	return created;
}

afterEach(() => {
	// Every insert arms a real (unref'd) one-hour timer. Cancelling is also the cheapest proof
	// available that nothing above left the registry in a state `cancelAll` cannot walk.
	while (rigs.length > 0) rigs.pop()?.registry.cancelAll();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// the COUNT cap
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionDelivery.pendingFor — at most DEFAULT_MAX_REPLAY_ASKS in one burst", () => {
	it("replays exactly the cap when more than the cap is pending, and truncates the NEWEST away", () => {
		const over = DEFAULT_MAX_REPLAY_ASKS + 4;
		const active = rig();
		const raised = active.raiseMany(over);
		expect(active.registry.pendingCount).toBe(over);

		const replayed = active.delivery.pendingFor("phone");

		// The number, stated: without the loop this is `over`, which is the whole defect.
		expect(replayed).toHaveLength(DEFAULT_MAX_REPLAY_ASKS);
		expect(active.ids(replayed)).toEqual(active.ids(raised.slice(0, DEFAULT_MAX_REPLAY_ASKS)));
		// The ones that did NOT go are the newest — the ones with the most time left.
		expect(active.ids(replayed)).not.toContain(idFor(DEFAULT_MAX_REPLAY_ASKS));
	});

	it("TRUNCATING IS NOT DROPPING: an ask left out is still pending and still answerable", () => {
		const active = rig();
		active.raiseMany(DEFAULT_MAX_REPLAY_ASKS + 4);
		const omitted = idFor(DEFAULT_MAX_REPLAY_ASKS + 2);

		const replayed = active.delivery.pendingFor("phone");
		expect(active.ids(replayed)).not.toContain(omitted);

		// Untouched in the registry — not merely absent from one client's burst.
		expect(active.registry.pendingCount).toBe(DEFAULT_MAX_REPLAY_ASKS + 4);
		expect(active.registry.get(omitted)).toBeDefined();

		// And the only thing that can end it is still an answer.
		const settled = active.registry.settle(SESSION_ID, omitted, "approve", { surface: "attach", clientId: "phone" });
		expect(settled.status).toBe("resolved");
	});

	it("replays everything, uncapped, while the pending count sits AT the cap", () => {
		// The bound must not bite one ask early: at exactly the cap, nothing is held back.
		const active = rig();
		const raised = active.raiseMany(DEFAULT_MAX_REPLAY_ASKS);
		expect(active.ids(active.delivery.pendingFor("phone"))).toEqual(active.ids(raised));
	});

	it("counts UNDELIVERED asks against the cap, not pending ones", () => {
		// A client that has already been shown some of the backlog gets a full burst of what is
		// left, rather than a burst reduced by asks that are already on its screen.
		const active = rig(); // defaults
		active.raiseMany(DEFAULT_MAX_REPLAY_ASKS + 4);
		for (let index = 0; index < 4; index++) active.delivery.markDelivered("phone", idFor(index));

		const replayed = active.delivery.pendingFor("phone");
		expect(replayed).toHaveLength(DEFAULT_MAX_REPLAY_ASKS);
		expect(active.ids(replayed)[0]).toBe(idFor(4));
		expect(active.ids(replayed).at(-1)).toBe(idFor(DEFAULT_MAX_REPLAY_ASKS + 3));
	});

	it("the cap is HALF the registry's own pending bound, so a full backlog takes two bursts", () => {
		// The RELATIONSHIP is the contract, not the number. `toBe(16)` was here first and a reviewer
		// was right to call it a naked pin: retuning the cap to 12 breaks no behaviour and no caller
		// but fails that assertion, while halving DEFAULT_MAX_PENDING to 24 — which genuinely would
		// break "a full backlog takes two bursts" — passes it. The assertion moved to the property
		// the test is named after.
		expect(DEFAULT_MAX_REPLAY_ASKS * 2).toBe(DEFAULT_MAX_PENDING);
		expect(DEFAULT_MAX_REPLAY_ASKS).toBeLessThan(DEFAULT_MAX_PENDING);
		// A burst can never evict its own bookkeeping: if the per-client memory were the smaller
		// number, one replay would forget its own first frames and re-send them next time.
		expect(DEFAULT_MAX_DELIVERED_PER_CLIENT).toBeGreaterThan(DEFAULT_MAX_REPLAY_ASKS);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// the BYTE cap
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionDelivery.pendingFor — at most DEFAULT_MAX_REPLAY_BYTES in one burst", () => {
	it("stops on BYTES before it ever reaches the count cap", () => {
		// 50 KB each: well under the registry's 60 KB per-entry ceiling, so these are asks the
		// registry genuinely accepts, and five of them already fill the 256 KiB burst budget.
		const each = 50_000;
		const active = rig();
		const raised = active.raiseMany(DEFAULT_MAX_REPLAY_ASKS, each);
		expect(raised[0]?.bytes).toBe(each);
		expect(each).toBeLessThan(DEFAULT_MAX_ENTRY_BYTES);

		// The fixture states its own arithmetic, so a change to either constant fails HERE with a
		// readable message rather than by quietly making the expected count wrong.
		const fits = Math.floor(DEFAULT_MAX_REPLAY_BYTES / each);
		expect(fits * each).toBeLessThanOrEqual(DEFAULT_MAX_REPLAY_BYTES);
		expect((fits + 1) * each).toBeGreaterThan(DEFAULT_MAX_REPLAY_BYTES);
		expect(fits).toBeLessThan(DEFAULT_MAX_REPLAY_ASKS);

		const replayed = active.delivery.pendingFor("phone");
		expect(replayed).toHaveLength(fits);
		expect(replayed.reduce((sum, ask) => sum + ask.bytes, 0)).toBeLessThanOrEqual(DEFAULT_MAX_REPLAY_BYTES);
		// Which cap bound is the point: the count cap would have allowed sixteen of these.
		expect(replayed.length).toBeLessThan(DEFAULT_MAX_REPLAY_ASKS);
		expect(active.ids(replayed)).toEqual(active.ids(raised.slice(0, fits)));

		// Every ask the byte budget refused is still pending.
		expect(active.registry.pendingCount).toBe(DEFAULT_MAX_REPLAY_ASKS);
	});

	it("sends the FIRST ask whatever it weighs, even alone over budget", () => {
		// Refusing to replay the only outstanding ask because it is large would leave the agent
		// parked in `beforeToolCall` with no surface able to see why. One oversized frame is a
		// worse outcome than none only if you are not the person waiting on it.
		const each = 50_000;
		const active = rig({ maxReplayBytes: 1_000 });
		active.raiseMany(3, each);

		const replayed = active.delivery.pendingFor("phone");
		expect(replayed).toHaveLength(1);
		expect(replayed[0]?.requestId).toBe(idFor(0));
		expect(replayed[0]?.bytes).toBeGreaterThan(1_000);
	});

	it("bounds an ask that states NO size by the count cap alone", () => {
		// `DeliverableAsk.bytes` is optional on purpose — this module's contract is "the least it
		// needs to know". An ask with no size contributes nothing to the byte budget, so a byte
		// cap of one byte must still let the count cap do its job rather than truncating to one.
		const sizeless: DeliverableAsk[] = Array.from({ length: DEFAULT_MAX_REPLAY_ASKS + 4 }, (_, index) => ({
			requestId: idFor(index),
		}));
		const delivery = new PermissionDelivery({ pending: () => sizeless, maxReplayBytes: 1 });

		expect(delivery.pendingFor("phone")).toHaveLength(DEFAULT_MAX_REPLAY_ASKS);
	});

	it("the byte cap is four full-sized registry entries, and far above a real ask", () => {
		expect(DEFAULT_MAX_REPLAY_BYTES).toBe(256 * 1024);
		expect(DEFAULT_MAX_REPLAY_BYTES).toBeGreaterThan(4 * DEFAULT_MAX_ENTRY_BYTES);
		// Sixteen ordinary asks — the count cap's worth — never come near it, which is why the
		// byte cap is a backstop for the pathological case and not a limit on normal traffic.
		expect(DEFAULT_MAX_REPLAY_ASKS * BASE_FRAME_BYTES).toBeLessThan(DEFAULT_MAX_REPLAY_BYTES);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ORDERING — what the caps truncate against
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionDelivery.pendingFor — oldest first, because insertion order is deadline order", () => {
	it("replays in insertion order, and every ask it sends is closer to expiring than every ask it holds back", () => {
		const active = rig();
		active.raiseMany(DEFAULT_MAX_REPLAY_ASKS + 4);

		const replayed = active.delivery.pendingFor("phone");
		expect(active.ids(replayed)).toEqual(Array.from({ length: DEFAULT_MAX_REPLAY_ASKS }, (_, index) => idFor(index)));

		// Deadlines strictly ascending — the clock moved between every raise, so this is a fact
		// about time and not about array order.
		const deadlines = replayed.map((ask) => ask.deadlineAt);
		for (let index = 1; index < deadlines.length; index++) {
			expect(deadlines[index]).toBeGreaterThan(deadlines[index - 1] as number);
		}

		// THE PROPERTY: truncation takes from the end with the most time left. Sending the newest
		// asks and holding back the oldest would starve exactly the ones about to fail closed.
		const sent = new Set(active.ids(replayed));
		const held = active.registry.pending().filter((entry) => !sent.has(entry.requestId));
		expect(held.length).toBe(4);
		const latestSent = Math.max(...deadlines);
		for (const entry of held) expect(entry.deadlineAt).toBeGreaterThan(latestSent);
	});

	it("keeps oldest-first after the oldest ask is answered", () => {
		// The pending list is read LIVE, so the head moves when an ask ends. The burst has to
		// follow it rather than replay a settled ask or skip the new oldest.
		const active = rig();
		active.raiseMany(DEFAULT_MAX_REPLAY_ASKS + 2);
		active.registry.settle(SESSION_ID, idFor(0), "approve", { surface: "attach", clientId: "desktop" });

		const replayed = active.delivery.pendingFor("phone");
		expect(active.ids(replayed)[0]).toBe(idFor(1));
		expect(active.ids(replayed)).toHaveLength(DEFAULT_MAX_REPLAY_ASKS);
		expect(active.ids(replayed)).not.toContain(idFor(0));
	});

	it("a SECOND call yields the remainder — the class can drain, even though nothing drives it", () => {
		// KNOWN GAP, recorded here rather than closed. `pendingFor` is called once per attach and
		// nothing re-drives the truncated remainder, so in production a client sitting at the cap
		// is shown the same first 16 on every reconnect and cannot reach asks 17+ until an earlier
		// one ends. That is a property of the CALL SITE, not of this class: given a second call,
		// the class hands over exactly what it held back.
		const active = rig();
		active.raiseMany(DEFAULT_MAX_REPLAY_ASKS + 4);

		const first = active.delivery.pendingFor("phone");
		for (const ask of first) active.delivery.markDelivered("phone", ask.requestId);

		const second = active.delivery.pendingFor("phone");
		expect(active.ids(second)).toEqual([
			idFor(DEFAULT_MAX_REPLAY_ASKS),
			idFor(DEFAULT_MAX_REPLAY_ASKS + 1),
			idFor(DEFAULT_MAX_REPLAY_ASKS + 2),
			idFor(DEFAULT_MAX_REPLAY_ASKS + 3),
		]);
		expect(active.delivery.pendingFor("phone")).toEqual(second);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// markDelivered — the per-client bound, and which way it fails
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionDelivery.markDelivered — the per-client record is bounded, and forgetting re-shows", () => {
	it("evicts the OLDEST remembered id, and the consequence is a duplicate dialog rather than a lost ask", () => {
		const active = rig({ maxPerClient: 2 });
		active.raiseMany(3);
		for (let index = 0; index < 3; index++) active.delivery.markDelivered("phone", idFor(index));

		// The record holds the last two. Observed through the REPLAY, not just `hasDelivered`:
		// the evicted ask comes back into the burst, which is what a client actually experiences.
		expect(active.delivery.hasDelivered("phone", idFor(0))).toBe(false);
		expect(active.ids(active.delivery.pendingFor("phone"))).toEqual([idFor(0)]);

		// Forgetting an id is bookkeeping about a CONNECTION. It is not a state transition: the
		// ask never moved, and all three are still pending and still answerable.
		expect(active.registry.pendingCount).toBe(3);
		const settled = active.registry.settle(SESSION_ID, idFor(0), "deny", { surface: "attach", clientId: "phone" });
		expect(settled.status).toBe("resolved");
	});

	it("bounds each client's record independently", () => {
		const active = rig({ maxPerClient: 2 });
		active.raiseMany(3);
		for (let index = 0; index < 3; index++) active.delivery.markDelivered("phone", idFor(index));
		active.delivery.markDelivered("desktop", idFor(0));

		// The phone overflowed; the desktop did not, and one client's overflow says nothing about
		// what is on another client's screen.
		expect(active.ids(active.delivery.pendingFor("phone"))).toEqual([idFor(0)]);
		expect(active.ids(active.delivery.pendingFor("desktop"))).toEqual([idFor(1), idFor(2)]);
	});

	it("holds a full replay burst without evicting any of it, at the defaults", () => {
		// The two bounds have to be ordered this way round: if a burst could overflow the record
		// it just wrote, the next replay on the SAME connection would re-send frames the client is
		// already looking at, and "exactly once per connection" would be false by construction.
		const active = rig();
		active.raiseMany(DEFAULT_MAX_REPLAY_ASKS);
		for (const ask of active.delivery.pendingFor("phone")) active.delivery.markDelivered("phone", ask.requestId);

		expect(active.delivery.pendingFor("phone")).toEqual([]);
		expect(active.delivery.hasDelivered("phone", idFor(0))).toBe(true);
	});
});
