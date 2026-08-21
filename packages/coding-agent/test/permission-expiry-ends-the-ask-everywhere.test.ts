/**
 * T8-FIX2 (1) — an expiry must take the ask down EVERYWHERE, not just remotely.
 *
 * THE DEFECT THIS FILE EXISTS FOR WAS FAIL-OPEN, which is the one direction this whole phase is
 * supposed to make impossible. With a phone attached and a live local surface, the registry's
 * fail-closed timer fired: the relay broadcast `{decision: "expired", surface: "system"}` and
 * appended a matching JSONL row — and then the human answered the still-open LOCAL dialog with
 * "approve" and THE COMMAND RAN. The durable record said the ask expired and was refused; the
 * command executed anyway.
 *
 * The hole was that `registry.onExpired` resolved the raise() promise with `undefined`, which the
 * decorator reads as "the relay is spent, keep waiting on the local surface" — a state that is
 * correct for a refused raise and catastrophic for an ENDED ask. The two are now different values.
 *
 * These drive the REAL registry, the REAL relay and the REAL decorator against a live base spy;
 * only the socket server and the JSONL writer are doubles, because those are the two edges the
 * relay is supposed to write to.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../src/core/extensions/index.ts";
import type { PermissionAskDetail } from "../src/core/extensions/types.ts";
import { createRelayUIContext } from "../src/core/permission-relay/index.ts";
import type { PermissionResolution } from "../src/core/session-manager.ts";
import { PermissionDelivery } from "../src/core/socket-server/permission-delivery.ts";
import { type PermissionEntry, PermissionRegistry } from "../src/core/socket-server/permission-registry.ts";
import {
	createSocketPermissionRelay,
	type PermissionRecorder,
	type PermissionSocketServer,
	type SocketPermissionRelay,
} from "../src/core/socket-server/permission-relay.ts";
import type { PermissionRequestMessage, PermissionResolvedMessage } from "../src/core/socket-server/types.ts";
import { theme } from "../src/modes/interactive/theme/theme.ts";

const SESSION_ID = "expiry-session";

/** The vocabulary the tool permission gate supplies. */
const VOCABULARY: PermissionAskDetail["options"] = [
	{ id: "approve", label: "Yes", decision: "approve" },
	{ id: "deny", label: "No", decision: "deny" },
];

function permissionDetail(): PermissionAskDetail {
	return {
		kind: "tool_permission",
		toolCallId: "call-1",
		toolName: "bash",
		cwd: "/tmp/project",
		command: "touch /tmp/marker",
		reason: "shell command",
		options: VOCABULARY,
	};
}

/** A live local surface whose `confirm` stays open until this test answers it — or it is aborted. */
interface LocalSurface {
	context: ExtensionUIContext;
	events: string[];
	/** Answer the still-open local dialog, as a human at the terminal would. */
	answerConfirm(value: boolean): void;
	aborted(): boolean;
}

function createLocalSurface(): LocalSurface {
	const events: string[] = [];
	let settleConfirm: ((value: boolean) => void) | undefined;
	let sawAbort = false;

	const context = {
		select: async () => undefined,
		confirm: (_title: string, _message: string, opts?: ExtensionUIDialogOptions) => {
			events.push("local-open");
			return new Promise<boolean>((resolve) => {
				settleConfirm = resolve;
				opts?.signal?.addEventListener("abort", () => {
					sawAbort = true;
					events.push("local-abort");
					// Exactly what interactive mode and rpc-mode both do: an aborted dialog
					// resolves to its negative default.
					resolve(false);
				});
			});
		},
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	} as unknown as ExtensionUIContext;

	return {
		context,
		events,
		answerConfirm: (value) => settleConfirm?.(value),
		aborted: () => sawAbort,
	};
}

interface Rig {
	ui: ExtensionUIContext;
	relay: SocketPermissionRelay;
	registry: PermissionRegistry;
	local: LocalSurface;
	resolved: PermissionResolvedMessage[];
	rows: PermissionResolution[];
	requests: PermissionRequestMessage[];
}

function createRig(options: { expiryMs?: number } = {}): Rig {
	const resolved: PermissionResolvedMessage[] = [];
	const rows: PermissionResolution[] = [];
	const requests: PermissionRequestMessage[] = [];

	const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs: options.expiryMs ?? 60 });
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
		onWarning: () => {},
	});

	const local = createLocalSurface();
	// A live local surface AND an attached client: the exact shape the defect needed.
	const ui = createRelayUIContext(local.context, relay, true, "rpc");

	return { ui, relay, registry, local, resolved, rows, requests };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("an expiry ends the ask on every surface", () => {
	it("stops the LOCAL dialog too, so a late local approval cannot run the command", async () => {
		const rig = createRig({ expiryMs: 60 });

		const pending = rig.ui.confirm("Approve tool call?", "bash: touch /tmp/marker", {
			detail: permissionDetail(),
		});
		await tick();
		expect(rig.requests).toHaveLength(1);
		expect(rig.local.events).toContain("local-open");

		// Nobody answers. The registry's own clock ends it.
		await delay(200);

		// The relay did its half: one frame, one row, attributed to nobody.
		expect(rig.resolved).toHaveLength(1);
		expect(rig.resolved[0]).toMatchObject({ decision: "expired", surface: "system", clientId: null });
		expect(rig.rows).toHaveLength(1);
		expect(rig.rows[0]).toMatchObject({ decision: "expired", decidedBy: { surface: "system", clientId: null } });

		// THE FIX: the caller is released on its fail-closed default, and the local dialog is down.
		await expect(pending).resolves.toBe(false);
		expect(rig.local.aborted()).toBe(true);

		// THE FAIL-OPEN: the human answers the dialog that used to still be on screen.
		rig.local.answerConfirm(true);
		await delay(50);

		// The command must NOT run: the caller already has its `false` and nothing can revise it.
		await expect(pending).resolves.toBe(false);
		// And the ending is written down ONCE. A second frame or a second row would mean the ask
		// was settled twice.
		expect(rig.resolved).toHaveLength(1);
		expect(rig.rows).toHaveLength(1);
	});

	it("ends the local dialog when the session is stopped mid-ask (cancel-on-stop)", async () => {
		const rig = createRig({ expiryMs: 60_000 });

		const pending = rig.ui.confirm("Approve tool call?", "bash: touch /tmp/marker", {
			detail: permissionDetail(),
		});
		await tick();

		// The session is replaced or stopped: every pending ask ends fail-closed.
		rig.relay.cancelAll();
		await delay(20);

		await expect(pending).resolves.toBe(false);
		expect(rig.local.aborted()).toBe(true);
		expect(rig.resolved).toHaveLength(1);
		expect(rig.resolved[0]).toMatchObject({ decision: "cancelled", surface: "system" });
		expect(rig.rows).toHaveLength(1);
		expect(rig.rows[0]).toMatchObject({ decision: "cancelled", decidedBy: { surface: "system", clientId: null } });

		// A late local answer changes nothing, and writes nothing.
		rig.local.answerConfirm(true);
		await delay(20);
		await expect(pending).resolves.toBe(false);
		expect(rig.resolved).toHaveLength(1);
		expect(rig.rows).toHaveLength(1);
	});

	it("still leaves a REFUSED raise to the local surface — a bound is not an ending", async () => {
		// A registry with exactly one slot, already occupied, refuses the next raise. That is a
		// resource BOUND, not a decision: the live local human must still get to answer. This is
		// the case the fix must not eat — `undefined` from a spent relay still means "keep waiting".
		const rigLimited = createRigWithMaxPending();
		const pending = rigLimited.ui.confirm("Approve tool call?", "bash: touch /tmp/marker", {
			detail: permissionDetail(),
		});
		await tick();
		// Nothing was broadcast for the refused ask — only the one holding the slot.
		expect(rigLimited.requests).toHaveLength(1);
		// ...and the local dialog is still open and still answerable.
		expect(rigLimited.local.aborted()).toBe(false);

		rigLimited.local.answerConfirm(true);
		await expect(pending).resolves.toBe(true);
	});
});

/** A rig whose registry has exactly one slot, already occupied — so the next raise is refused. */
function createRigWithMaxPending(): Rig {
	const resolved: PermissionResolvedMessage[] = [];
	const rows: PermissionResolution[] = [];
	const requests: PermissionRequestMessage[] = [];

	const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs: 60_000, maxPending: 1 });
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
		onWarning: () => {},
	});
	const local = createLocalSurface();
	const ui = createRelayUIContext(local.context, relay, true, "rpc");
	// Occupy the only slot with an ask nothing will ever answer.
	void relay.raise({
		requestId: "hold-the-slot",
		method: "confirm",
		title: "held",
		options: [],
		requestedAt: new Date().toISOString(),
		deadline: null,
	});
	return { ui, relay, registry, local, resolved, rows, requests };
}
