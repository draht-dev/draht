import { afterEach, describe, expect, it, vi } from "vitest";
import {
	disposePolyphaseSession,
	getPolyphaseSession,
	peekPolyphaseSession,
} from "../../src/core/polyphase/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const sessionKeys: object[] = [];

/** `{}` keys are fine for identity-only tests; registered so `afterEach` can dispose their session. */
function trackedKey(): object {
	const key = {};
	sessionKeys.push(key);
	return key;
}

afterEach(() => {
	for (const key of sessionKeys.splice(0)) {
		disposePolyphaseSession(key, "test");
	}
	vi.useRealTimers();
});

describe("getPolyphaseSession", () => {
	it("gives distinct stores and limiters for distinct keys", () => {
		const keyA = SessionManager.inMemory();
		const keyB = SessionManager.inMemory();
		sessionKeys.push(keyA, keyB);
		const sessionA = getPolyphaseSession(keyA, undefined);
		const sessionB = getPolyphaseSession(keyB, undefined);

		expect(sessionA).not.toBe(sessionB);
		expect(sessionA.store).not.toBe(sessionB.store);
		expect(sessionA.limiter).not.toBe(sessionB.limiter);
	});

	it("returns the same session for the same key", () => {
		const key = trackedKey();
		const first = getPolyphaseSession(key, undefined);
		const second = getPolyphaseSession(key, { maxConcurrency: 5 });
		expect(first).toBe(second);
	});

	it("replaces a session disposed directly (not through disposePolyphaseSession) instead of returning the dead one", () => {
		const key = trackedKey();
		const first = getPolyphaseSession(key, undefined);
		first.dispose("direct");
		expect(first.disposed).toBe(true);

		const second = getPolyphaseSession(key, undefined);
		expect(second).not.toBe(first);
		expect(second.disposed).toBe(false);
		expect(peekPolyphaseSession(key)).toBe(second);
	});

	it("resolves settings from the raw PolyphaseSettings passed in", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, { maxConcurrency: 3, keyword: "orchestrate" });
		expect(session.settings().maxConcurrency).toBe(3);
		expect(session.settings().keyword).toBe("orchestrate");
	});
});

describe("peekPolyphaseSession", () => {
	it("returns undefined for a key that was never created", () => {
		expect(peekPolyphaseSession({})).toBeUndefined();
	});

	it("returns undefined for non-object keys", () => {
		expect(peekPolyphaseSession(undefined)).toBeUndefined();
		expect(peekPolyphaseSession(null)).toBeUndefined();
		expect(peekPolyphaseSession(42)).toBeUndefined();
		expect(peekPolyphaseSession("key")).toBeUndefined();
	});

	it("returns the session created for an object key without creating one", () => {
		const key = trackedKey();
		const created = getPolyphaseSession(key, undefined);
		expect(peekPolyphaseSession(key)).toBe(created);

		const neverCreated = {};
		expect(peekPolyphaseSession(neverCreated)).toBeUndefined();
	});
});

describe("refreshSettings", () => {
	it("updates the limiter's capacity", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, { maxConcurrency: 2 });
		expect(session.limiter.capacity).toBe(2);

		session.refreshSettings({ maxConcurrency: 7 });
		expect(session.limiter.capacity).toBe(7);
		expect(session.settings().maxConcurrency).toBe(7);
	});

	it("is also applied by getPolyphaseSession on every call", () => {
		const key = trackedKey();
		getPolyphaseSession(key, { maxConcurrency: 2 });
		const session = getPolyphaseSession(key, { maxConcurrency: 9 });
		expect(session.limiter.capacity).toBe(9);
	});
});

describe("permissionMode", () => {
	it("defaults to 'default' until a provider is set", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, undefined);
		expect(session.permissionMode()).toBe("default");
	});

	it("reflects the provider once set", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, undefined);
		session.setPermissionModeProvider(() => "yolo");
		expect(session.permissionMode()).toBe("yolo");
	});
});

describe("notifyParentPrompt", () => {
	it("calls every onParentPrompt listener", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, undefined);
		const listener = vi.fn();
		session.onParentPrompt(listener);

		session.notifyParentPrompt();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("unsubscribes via the returned callback", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, undefined);
		const listener = vi.fn();
		const unsubscribe = session.onParentPrompt(listener);
		unsubscribe();

		session.notifyParentPrompt();
		expect(listener).not.toHaveBeenCalled();
	});

	it("isolates a throwing listener from the rest", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, undefined);
		session.onParentPrompt(() => {
			throw new Error("boom");
		});
		const second = vi.fn();
		session.onParentPrompt(second);

		expect(() => session.notifyParentPrompt()).not.toThrow();
		expect(second).toHaveBeenCalledTimes(1);
	});
});

describe("disposePolyphaseSession", () => {
	it("is idempotent and removes the entry", () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, undefined);
		expect(session.disposed).toBe(false);

		disposePolyphaseSession(key, "session_shutdown");
		expect(session.disposed).toBe(true);
		expect(peekPolyphaseSession(key)).toBeUndefined();

		expect(() => disposePolyphaseSession(key, "session_shutdown")).not.toThrow();
	});

	it("does nothing for non-object or never-created keys", () => {
		expect(() => disposePolyphaseSession(undefined, "x")).not.toThrow();
		expect(() => disposePolyphaseSession({}, "x")).not.toThrow();
	});

	it("rejects queued limiter acquires and cancels every run", async () => {
		const key = trackedKey();
		const session = getPolyphaseSession(key, { maxConcurrency: 1 });
		const run = session.store.createRun({
			id: "run-1",
			kind: "subagent",
			origin: "tool",
			title: "t",
			budgetTokens: null,
		});
		const lease = await session.limiter.acquire();
		const queued = session.limiter.acquire();

		disposePolyphaseSession(key, "session_shutdown");

		await expect(queued).rejects.toThrow("session_shutdown");
		expect(run.signal.aborted).toBe(true);
		lease.release();
	});
});

describe("setInspectorOpen", () => {
	it("caps the pump interval to min(100, liveUpdateMs) once the inspector opens", () => {
		vi.useFakeTimers();
		try {
			const key = trackedKey();
			const session = getPolyphaseSession(key, { liveUpdateMs: 250 });
			const run = session.store.createRun({
				id: "run-1",
				kind: "subagent",
				origin: "tool",
				title: "t",
				budgetTokens: null,
			});

			session.setInspectorOpen(true);
			const flushed = vi.fn();
			session.store.subscribe(flushed);

			run.markDirty("fine");
			vi.advanceTimersByTime(99);
			expect(flushed).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(flushed).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("restores liveUpdateMs once the inspector closes", () => {
		vi.useFakeTimers();
		try {
			const key = trackedKey();
			const session = getPolyphaseSession(key, { liveUpdateMs: 250 });
			const run = session.store.createRun({
				id: "run-1",
				kind: "subagent",
				origin: "tool",
				title: "t",
				budgetTokens: null,
			});

			session.setInspectorOpen(true);
			session.setInspectorOpen(false);
			const flushed = vi.fn();
			session.store.subscribe(flushed);

			run.markDirty("fine");
			vi.advanceTimersByTime(100);
			expect(flushed).not.toHaveBeenCalled();
			vi.advanceTimersByTime(150);
			expect(flushed).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
