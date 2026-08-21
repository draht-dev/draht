/**
 * T8-FIX — the record must say what actually happened.
 *
 * Two defects, one contract: nothing may fabricate a decision, and nothing may attribute one to a
 * surface that did not act.
 *
 * 1. `withdraw` hardcoded `cancelled`. A local surface approving a bash call ran the command and
 *    then wrote `{decision: "cancelled", chosenOptionId: null}` into the session JSONL and onto the
 *    wire. R34-PERM.2 requires the resolution to be assertable from the JSONL; it asserted a
 *    decision that did not happen.
 * 2. `raise` refused by a BOUND (`too_many_pending`) resolved `undefined` and wrote nothing, so a
 *    resource failure reached the model as "User denied approval" with no record to contradict it.
 *
 * These drive the real {@link PermissionRegistry} and the real {@link PermissionDelivery}; only the
 * socket server and the JSONL writer are doubles, because those are the two edges this module is
 * supposed to write to.
 */

import { describe, expect, it } from "vitest";
import type { PermissionAskDetail } from "../src/core/extensions/types.ts";
import type { RelayAsk, RelayDecider, RelayOutcome } from "../src/core/permission-relay/index.ts";
import type { PermissionResolution } from "../src/core/session-manager.ts";
import { PermissionDelivery } from "../src/core/socket-server/permission-delivery.ts";
import {
	type PermissionEntry,
	PermissionRegistry,
	type TerminalDecision,
} from "../src/core/socket-server/permission-registry.ts";
import {
	createSocketPermissionRelay,
	type PermissionRecorder,
	type PermissionSocketServer,
	type SocketPermissionRelay,
} from "../src/core/socket-server/permission-relay.ts";
import type { PermissionRequestMessage, PermissionResolvedMessage } from "../src/core/socket-server/types.ts";

const SESSION_ID = "session-under-test";

interface Rig {
	relay: SocketPermissionRelay;
	registry: PermissionRegistry;
	/** Every `permission_resolved` the relay broadcast, in order. */
	resolved: PermissionResolvedMessage[];
	/** Every audit row the relay appended, in order. */
	rows: PermissionResolution[];
	requests: PermissionRequestMessage[];
	warnings: string[];
	/** Every `registry.withdraw` the relay made, with the decision it passed. */
	withdrawals: { requestId: string; decidedBy: RelayDecider; decision: TerminalDecision }[];
}

function createRig(options: { maxPending?: number; expiryMs?: number } = {}): Rig {
	const resolved: PermissionResolvedMessage[] = [];
	const rows: PermissionResolution[] = [];
	const requests: PermissionRequestMessage[] = [];
	const warnings: string[] = [];

	const registry = new PermissionRegistry({
		sessionId: SESSION_ID,
		maxPending: options.maxPending,
		expiryMs: options.expiryMs,
	});
	// Every call the relay makes to `registry.withdraw`, exactly as it made it. The registry's own
	// unit test pins what `withdraw` DOES with a decision; nothing pinned that the relay hands it
	// the REAL one, and hardcoding `"cancelled"` here left 141/141 tests green.
	const withdrawals: { requestId: string; decidedBy: RelayDecider; decision: TerminalDecision }[] = [];
	const realWithdraw = registry.withdraw.bind(registry);
	registry.withdraw = (requestId, decidedBy, decision) => {
		withdrawals.push({ requestId, decidedBy, decision });
		return realWithdraw(requestId, decidedBy, decision);
	};
	const delivery = new PermissionDelivery<PermissionEntry>({ pending: () => registry.pending() });

	const server: PermissionSocketServer = {
		permissionCapableClientCount: 1,
		broadcastPermissionRequest(message) {
			requests.push(message);
			return ["phone-1"];
		},
		sendPermissionRequest(_clientId, message) {
			requests.push(message);
		},
		broadcastPermissionResolved(message) {
			resolved.push(message);
		},
		sendErrorToClient() {},
	};

	const recorder: PermissionRecorder = {
		appendPermissionResolution(resolution) {
			rows.push(resolution);
			return "entry-id";
		},
	};

	const relay = createSocketPermissionRelay({
		registry,
		delivery,
		server: () => server,
		recorder: () => recorder,
		sessionId: SESSION_ID,
		cwd: "/tmp/project",
		onWarning: (message) => warnings.push(message),
	});

	return { relay, registry, resolved, rows, requests, warnings, withdrawals };
}

/** The vocabulary T5's tool permission ask supplies: one approval and TWO distinct denials. */
const VOCABULARY: PermissionAskDetail["options"] = [
	{ id: "allow", label: "Allow", decision: "approve" },
	{ id: "deny-once", label: "Deny once", decision: "deny" },
	{ id: "deny-always", label: "Deny always", decision: "deny" },
];

function toolAsk(requestId: string, toolCallId = "call-1"): RelayAsk {
	const detail: PermissionAskDetail = {
		kind: "tool_permission",
		toolCallId,
		toolName: "bash",
		cwd: "/tmp/project",
		command: "touch /tmp/marker",
		reason: "shell command",
		options: VOCABULARY,
	};
	return {
		requestId,
		method: "confirm",
		title: "Approve tool call?",
		message: "bash: touch /tmp/marker",
		detail,
		options: VOCABULARY.map((option) => ({ id: option.id, label: option.label, decision: option.decision })),
		requestedAt: new Date().toISOString(),
		deadline: null,
	};
}

const APPROVED_LOCALLY: RelayOutcome = { kind: "approved", chosenOptionId: null };

describe("socket permission relay — the outcome it is told is the outcome it records", () => {
	it("records an approval the LOCAL surface made as approved, not as cancelled", async () => {
		const rig = createRig();
		const pending = rig.relay.raise(toolAsk("req-approve"));

		// The local surface approved. The command has already run by the time this arrives.
		rig.relay.withdraw("req-approve", { surface: "tui", clientId: null }, APPROVED_LOCALLY);

		await expect(pending).resolves.toBeUndefined();
		expect(rig.resolved).toEqual([
			{
				type: "permission_resolved",
				requestId: "req-approve",
				decision: "approved",
				chosenOptionId: null,
				surface: "tui",
				clientId: null,
			},
		]);
		expect(rig.rows).toHaveLength(1);
		expect(rig.rows[0]).toMatchObject({
			requestId: "req-approve",
			toolCallId: "call-1",
			toolName: "bash",
			decision: "approved",
			chosenOptionId: null,
			decidedBy: { surface: "tui", clientId: null },
			offeredOptionIds: ["allow", "deny-once", "deny-always"],
		});
	});

	it("records a denial as denied, and carries the id when the surface named one", async () => {
		const rig = createRig();
		const pending = rig.relay.raise(toolAsk("req-deny"));

		rig.relay.withdraw(
			"req-deny",
			{ surface: "rpc", clientId: null },
			{ kind: "denied", chosenOptionId: "deny-always" },
		);

		await expect(pending).resolves.toBeUndefined();
		expect(rig.rows[0]).toMatchObject({
			decision: "denied",
			chosenOptionId: "deny-always",
			decidedBy: { surface: "rpc", clientId: null },
		});
	});

	it("still records a genuine cancellation as cancelled with nothing chosen", async () => {
		const rig = createRig();
		const pending = rig.relay.raise(toolAsk("req-cancel"));

		rig.relay.withdraw("req-cancel", { surface: "system", clientId: null }, { kind: "cancelled" });

		await expect(pending).resolves.toBeUndefined();
		expect(rig.rows[0]).toMatchObject({
			decision: "cancelled",
			chosenOptionId: null,
			decidedBy: { surface: "system", clientId: null },
		});
	});

	it("stays silent for an ask a remote answer already settled — no second row, no second echo", async () => {
		const rig = createRig();
		const pending = rig.relay.raise(toolAsk("req-remote"));

		rig.relay.handleResponse({ requestId: "req-remote", optionId: "allow" }, "phone-1");
		await expect(pending).resolves.toMatchObject({ optionId: "allow" });

		// The decorator withdraws EVERY ask it settles, this one included.
		rig.relay.withdraw(
			"req-remote",
			{ surface: "attach", clientId: "phone-1" },
			{ kind: "approved", chosenOptionId: "allow" },
		);

		expect(rig.resolved).toHaveLength(1);
		expect(rig.rows).toHaveLength(1);
		expect(rig.rows[0]).toMatchObject({
			decision: "approved",
			chosenOptionId: "allow",
			decidedBy: { surface: "attach", clientId: "phone-1" },
		});
	});

	it("says nothing at all about an id it never held", () => {
		const rig = createRig();
		rig.relay.withdraw("never-raised", { surface: "tui", clientId: null }, APPROVED_LOCALLY);
		expect(rig.resolved).toEqual([]);
		expect(rig.rows).toEqual([]);
	});
});

describe("socket permission relay — a bound is not a denial", () => {
	it("records a refused raise as cancelled by the system, never as a human's denial", async () => {
		const rig = createRig({ maxPending: 1 });
		const held = rig.relay.raise(toolAsk("req-held", "call-held"));
		const refused = rig.relay.raise(toolAsk("req-refused", "call-refused"));

		// The bound refused it: nothing was registered and nothing was broadcast.
		await expect(refused).resolves.toBeUndefined();
		expect(rig.requests.map((request) => request.requestId)).toEqual(["req-held"]);
		expect(rig.warnings.some((warning) => warning.includes("pending at once"))).toBe(true);

		// The decorator, with no local surface to fall back to, ends it on the method's own
		// fail-closed default attributed to the system — and THAT is what gets written down.
		rig.relay.withdraw("req-refused", { surface: "system", clientId: null }, { kind: "cancelled" });

		expect(rig.rows).toHaveLength(1);
		expect(rig.rows[0]).toMatchObject({
			requestId: "req-refused",
			toolCallId: "call-refused",
			decision: "cancelled",
			chosenOptionId: null,
			decidedBy: { surface: "system", clientId: null },
		});
		// Nothing was ever shown to a client, so nothing may be taken down.
		expect(rig.resolved).toEqual([]);

		rig.relay.cancelAll();
		// The ask is OVER, not merely unanswerable here: the raiser is told so, so its local
		// dialog comes down instead of staying tappable.
		await expect(held).resolves.toMatchObject({
			requestId: "req-held",
			ended: "cancelled",
			decidedBy: { surface: "system", clientId: null },
		});
	});

	it("records the truth when a local human answers an ask the bound refused", async () => {
		const rig = createRig({ maxPending: 1 });
		const held = rig.relay.raise(toolAsk("req-held", "call-held"));
		await expect(rig.relay.raise(toolAsk("req-refused", "call-refused"))).resolves.toBeUndefined();

		rig.relay.withdraw("req-refused", { surface: "tui", clientId: null }, APPROVED_LOCALLY);

		expect(rig.rows).toHaveLength(1);
		expect(rig.rows[0]).toMatchObject({
			requestId: "req-refused",
			decision: "approved",
			decidedBy: { surface: "tui", clientId: null },
		});

		rig.relay.cancelAll();
		// The ask is OVER, not merely unanswerable here: the raiser is told so, so its local
		// dialog comes down instead of staying tappable.
		await expect(held).resolves.toMatchObject({
			requestId: "req-held",
			ended: "cancelled",
			decidedBy: { surface: "system", clientId: null },
		});
	});

	it("records a refused raise exactly once", async () => {
		const rig = createRig({ maxPending: 1 });
		const held = rig.relay.raise(toolAsk("req-held", "call-held"));
		await expect(rig.relay.raise(toolAsk("req-refused", "call-refused"))).resolves.toBeUndefined();

		rig.relay.withdraw("req-refused", { surface: "system", clientId: null }, { kind: "cancelled" });
		rig.relay.withdraw("req-refused", { surface: "system", clientId: null }, { kind: "cancelled" });

		expect(rig.rows).toHaveLength(1);

		rig.relay.cancelAll();
		// The ask is OVER, not merely unanswerable here: the raiser is told so, so its local
		// dialog comes down instead of staying tappable.
		await expect(held).resolves.toMatchObject({
			requestId: "req-held",
			ended: "cancelled",
			decidedBy: { surface: "system", clientId: null },
		});
	});
});

describe("socket permission relay — the registry is told the same thing everybody else is", () => {
	const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	/**
	 * T8-FIX2 (3) — a mutation survivor.
	 *
	 * `registry.withdraw(requestId, decidedBy, decision)` could be changed to a hardcoded
	 * `"cancelled"` and 141/141 tests still passed: the registry's own unit test pins what
	 * `withdraw` does with the decision it is given, and the relay's tests read the broadcast and
	 * the JSONL row — neither of which comes from that argument. The decision the registry
	 * TOMBSTONES is what a late or reconnecting answerer is told, so a hardcode there tells the
	 * human who approved a command that it was cancelled.
	 */
	it("hands the registry the decision it was told, and the tombstone says so", async () => {
		const rig = createRig();
		const pending = rig.relay.raise(toolAsk("req-approve"));

		rig.relay.withdraw(
			"req-approve",
			{ surface: "rpc", clientId: null },
			{ kind: "approved", chosenOptionId: "allow" },
		);
		await expect(pending).resolves.toBeUndefined();

		// The ARGUMENT, pinned directly.
		expect(rig.withdrawals).toEqual([
			{ requestId: "req-approve", decidedBy: { surface: "rpc", clientId: null }, decision: "approved" },
		]);

		// And pinned again through the registry's own observable state: a late answer is told what
		// actually happened, and "cancelled" would be a lie told to the person who approved it.
		expect(
			rig.registry.settle(SESSION_ID, "req-approve", "allow", { surface: "attach", clientId: "phone-2" }),
		).toMatchObject({
			status: "already_resolved",
			decision: "approved",
			decidedBy: { surface: "rpc", clientId: null },
		});
	});

	it("carries a denial through to the registry as a denial", async () => {
		const rig = createRig();
		const pending = rig.relay.raise(toolAsk("req-deny"));

		rig.relay.withdraw(
			"req-deny",
			{ surface: "tui", clientId: null },
			{ kind: "denied", chosenOptionId: "deny-once" },
		);
		await expect(pending).resolves.toBeUndefined();

		expect(rig.withdrawals.map((call) => call.decision)).toEqual(["denied"]);
		expect(
			rig.registry.settle(SESSION_ID, "req-deny", "allow", { surface: "attach", clientId: "phone-2" }),
		).toMatchObject({
			status: "already_resolved",
			decision: "denied",
		});
	});

	/**
	 * T8-FIX2 (4) — the expiry fact had two independent literals.
	 *
	 * The registry's own timer laid the tombstone with one `{surface: "system"}/"expired"` literal
	 * and the relay's `onExpired` listener used another for the broadcast and the audit row. They
	 * agreed, so nothing noticed; a verifier mutated one and the other did not care. This asserts
	 * all THREE readings of the one fact together, so changing either literal alone fails here.
	 */
	it("states the expiry once: tombstone, broadcast and audit row cannot disagree", async () => {
		const rig = createRig({ expiryMs: 40 });
		const pending = rig.relay.raise(toolAsk("req-expire"));

		await delay(250);
		await expect(pending).resolves.toMatchObject({
			requestId: "req-expire",
			ended: "expired",
			decidedBy: { surface: "system", clientId: null },
		});

		expect(rig.resolved).toEqual([
			{
				type: "permission_resolved",
				requestId: "req-expire",
				decision: "expired",
				chosenOptionId: null,
				surface: "system",
				clientId: null,
			},
		]);
		expect(rig.rows).toHaveLength(1);
		expect(rig.rows[0]).toMatchObject({
			decision: "expired",
			chosenOptionId: null,
			decidedBy: { surface: "system", clientId: null },
		});
		// The registry's own memory of the same ending, which is what a late answerer is told.
		expect(
			rig.registry.settle(SESSION_ID, "req-expire", "allow", { surface: "attach", clientId: "phone-1" }),
		).toMatchObject({
			status: "already_resolved",
			decision: "expired",
			decidedBy: { surface: "system", clientId: null },
		});
	});
});
