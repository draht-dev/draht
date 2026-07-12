import { describe, expect, test } from "bun:test";
import type { AcpHarnessSession, PermissionRequestEvent as AcpPermissionRequestEvent } from "@draht/geist-acp";
import {
	adaptAcpHarnessSessionForRelay,
	createSessionBridge,
	type PermissionRelaySession,
	type PermissionRequestEvent,
	UnknownSessionError,
} from "../src/session-bridge.js";

/**
 * Unit tests for the transport-agnostic session registry (spec §9.2,
 * R35-M3.5). The real-WS end-to-end proof of the relay lives in
 * `test/pairing/server.test.ts`; these cover the registry's own routing
 * semantics in isolation with a minimal fake session.
 */

/** A minimal `PermissionRelaySession`-shaped fake — no ACP subprocess needed to prove routing logic. */
function fakeSession(id: string) {
	const listeners = new Set<(event: PermissionRequestEvent) => void>();
	const answered: Array<{ requestId: string; optionId: string }> = [];

	const session: PermissionRelaySession = {
		id,
		onPermissionRequest(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async answerPermission(requestId, optionId) {
			answered.push({ requestId, optionId });
		},
	};

	return {
		session,
		answered,
		raise(event: PermissionRequestEvent) {
			for (const listener of listeners) listener(event);
		},
		listenerCount: () => listeners.size,
	};
}

/**
 * A minimal `AcpHarnessSession`-shaped fake — no real ACP subprocess needed
 * to prove the adapter's pure translation logic. Only
 * `onPermissionRequest`/`answerPermission` are ever exercised by
 * {@link adaptAcpHarnessSessionForRelay}; every other member throws if
 * called, so a test accidentally depending on unadapted behaviour fails
 * loudly instead of silently returning `undefined`.
 */
function fakeAcpSession(id: string) {
	const listeners = new Set<(event: AcpPermissionRequestEvent) => void>();
	const answered: Array<{ requestId: string; optionId: string }> = [];
	const notUsedByAdapter = (): never => {
		throw new Error("not exercised by adaptAcpHarnessSessionForRelay");
	};

	const session: AcpHarnessSession = {
		id,
		harness: "claude",
		capabilities: { images: false, commands: false, modes: false, resume: false },
		status: "running",
		pid: 4242,
		dispatch: notUsedByAdapter,
		cancel: notUsedByAdapter,
		stop: notUsedByAdapter,
		onToolCall: notUsedByAdapter,
		onPlanUpdate: notUsedByAdapter,
		async answerPermission(requestId, optionId) {
			answered.push({ requestId, optionId });
		},
		onPermissionRequest(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};

	return {
		session,
		answered,
		raise(event: AcpPermissionRequestEvent) {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("SessionBridge", () => {
	test("relays a registered session's permission_request as a WS-shaped message", () => {
		const bridge = createSessionBridge();
		const fake = fakeSession("session-1");
		bridge.registerSession(fake.session);

		const received: unknown[] = [];
		bridge.onPermissionRequest((message) => received.push(message));

		fake.raise({
			requestId: "perm-1",
			title: "Allow write to config.yaml?",
			options: [
				{ id: "allow", label: "Allow", kind: "allow_once" },
				{ id: "deny", label: "Deny", kind: "reject_once" },
			],
		});

		expect(received).toEqual([
			{
				type: "permission_request",
				payload: {
					sessionId: "session-1",
					requestId: "perm-1",
					title: "Allow write to config.yaml?",
					options: [
						{ id: "allow", label: "Allow", kind: "allow_once" },
						{ id: "deny", label: "Deny", kind: "reject_once" },
					],
				},
			},
		]);
	});

	test("answerPermission routes to the matching session's answerPermission", async () => {
		const bridge = createSessionBridge();
		const fake = fakeSession("session-1");
		bridge.registerSession(fake.session);

		await bridge.answerPermission("session-1", "perm-1", "allow");

		expect(fake.answered).toEqual([{ requestId: "perm-1", optionId: "allow" }]);
	});

	test("answerPermission for an unregistered session throws UnknownSessionError", async () => {
		const bridge = createSessionBridge();

		await expect(bridge.answerPermission("no-such-session", "perm-1", "allow")).rejects.toBeInstanceOf(
			UnknownSessionError,
		);
	});

	test("unregisterSession stops relaying that session's events and unsubscribes from it", () => {
		const bridge = createSessionBridge();
		const fake = fakeSession("session-1");
		bridge.registerSession(fake.session);
		expect(fake.listenerCount()).toBe(1);

		bridge.unregisterSession("session-1");
		expect(fake.listenerCount()).toBe(0);
		expect(bridge.hasSession("session-1")).toBe(false);

		const received: unknown[] = [];
		bridge.onPermissionRequest((message) => received.push(message));
		fake.raise({ requestId: "perm-1", title: "ignored", options: [] });
		expect(received).toEqual([]);
	});

	test("registering a session twice with the same id throws", () => {
		const bridge = createSessionBridge();
		const fake = fakeSession("session-1");
		bridge.registerSession(fake.session);

		expect(() => bridge.registerSession(fake.session)).toThrow();
	});

	test("unregistering an unknown session id is a no-op", () => {
		const bridge = createSessionBridge();
		expect(() => bridge.unregisterSession("no-such-session")).not.toThrow();
	});
});

describe("adaptAcpHarnessSessionForRelay", () => {
	test("translates an ACP-flavored permission_request event into the wire-shaped PermissionRequestEvent", () => {
		const fake = fakeAcpSession("acp-session-1");
		const relaySession = adaptAcpHarnessSessionForRelay(fake.session);
		expect(relaySession.id).toBe("acp-session-1");

		const received: PermissionRequestEvent[] = [];
		relaySession.onPermissionRequest((event) => received.push(event));

		fake.raise({
			requestId: "perm-1",
			toolCall: { toolCallId: "tc-1", title: "Apply mock edit", kind: "edit", status: "pending" },
			options: [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			],
		});

		expect(received).toEqual([
			{
				requestId: "perm-1",
				title: "Apply mock edit",
				options: [
					{ id: "allow", label: "Allow", kind: "allow_once" },
					{ id: "reject", label: "Reject", kind: "reject_once" },
				],
			},
		]);
	});

	test("falls back to a tool-call-id-derived title when the ACP tool call carries none", () => {
		const fake = fakeAcpSession("acp-session-2");
		const relaySession = adaptAcpHarnessSessionForRelay(fake.session);

		const received: PermissionRequestEvent[] = [];
		relaySession.onPermissionRequest((event) => received.push(event));

		fake.raise({ requestId: "perm-1", toolCall: { toolCallId: "tc-42" }, options: [] });

		expect(received).toHaveLength(1);
		expect(received[0]?.title).toContain("tc-42");
	});

	test("answerPermission delegates to the underlying ACP session's answerPermission", async () => {
		const fake = fakeAcpSession("acp-session-3");
		const relaySession = adaptAcpHarnessSessionForRelay(fake.session);

		await relaySession.answerPermission("perm-1", "allow");

		expect(fake.answered).toEqual([{ requestId: "perm-1", optionId: "allow" }]);
	});

	test("an adapted ACP session registers with SessionBridge and relays a WS-shaped permission_request", () => {
		const bridge = createSessionBridge();
		const fake = fakeAcpSession("acp-session-4");
		bridge.registerSession(adaptAcpHarnessSessionForRelay(fake.session));

		const received: unknown[] = [];
		bridge.onPermissionRequest((message) => received.push(message));

		fake.raise({
			requestId: "perm-1",
			toolCall: { toolCallId: "tc-1", title: "Write config.yaml" },
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		});

		expect(received).toEqual([
			{
				type: "permission_request",
				payload: {
					sessionId: "acp-session-4",
					requestId: "perm-1",
					title: "Write config.yaml",
					options: [{ id: "allow", label: "Allow", kind: "allow_once" }],
				},
			},
		]);
	});
});
