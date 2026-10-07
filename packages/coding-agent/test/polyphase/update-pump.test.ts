import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpdatePump, type UpdatePump } from "../../src/core/polyphase/update-pump.ts";

describe("createUpdatePump", () => {
	let pump: UpdatePump | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		pump?.dispose();
		pump = undefined;
		vi.useRealTimers();
	});

	it("coalesces many fine schedules within intervalMs into one flush", () => {
		pump = createUpdatePump({ intervalMs: 300 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		for (let i = 0; i < 50; i++) {
			pump.schedule("run-1", "fine");
			vi.advanceTimersByTime(5);
		}

		expect(handler).not.toHaveBeenCalled();
		vi.advanceTimersByTime(49);
		expect(handler).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0]?.[0]).toEqual(new Map([["run-1", false]]));
	});

	it("flushes a coarse change within coarseDelayMs and preserves the coarse flag", () => {
		pump = createUpdatePump({ intervalMs: 300, coarseDelayMs: 50 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		pump.schedule("run-1", "coarse");
		vi.advanceTimersByTime(49);
		expect(handler).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0]?.[0]).toEqual(new Map([["run-1", true]]));
	});

	it("flushes a coarse change within intervalMs when intervalMs is smaller than coarseDelayMs", () => {
		pump = createUpdatePump({ intervalMs: 20, coarseDelayMs: 50 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		pump.schedule("run-1", "coarse");
		vi.advanceTimersByTime(19);
		expect(handler).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0]?.[0]).toEqual(new Map([["run-1", true]]));
	});

	it("preserves the coarse flag when a fine change precedes and follows a coarse change", () => {
		pump = createUpdatePump({ intervalMs: 300, coarseDelayMs: 50 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		pump.schedule("run-1", "fine");
		pump.schedule("run-1", "coarse");
		pump.schedule("run-1", "fine");
		vi.advanceTimersByTime(50);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0]?.[0]).toEqual(new Map([["run-1", true]]));
	});

	it("flushes the heartbeat every heartbeatMs until stopped", () => {
		pump = createUpdatePump({ intervalMs: 50, heartbeatMs: 1000 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		pump.startHeartbeat("run-1");
		vi.advanceTimersByTime(1050);
		expect(handler).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		expect(handler).toHaveBeenCalledTimes(2);

		pump.stopHeartbeat("run-1");
		handler.mockClear();
		vi.advanceTimersByTime(3000);
		expect(handler).not.toHaveBeenCalled();
	});

	it("reports zero active timers when idle and after dispose", () => {
		pump = createUpdatePump({ intervalMs: 100 });
		expect(pump.activeTimers).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		pump.schedule("run-1", "fine");
		expect(pump.activeTimers).toBe(1);
		expect(vi.getTimerCount()).toBe(1);

		pump.startHeartbeat("run-1");
		expect(pump.activeTimers).toBe(2);
		expect(vi.getTimerCount()).toBe(2);

		vi.advanceTimersByTime(100);
		expect(pump.activeTimers).toBe(1);
		expect(vi.getTimerCount()).toBe(1);

		pump.stopHeartbeat("run-1");
		expect(pump.activeTimers).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		pump.dispose();
		expect(pump.activeTimers).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("dispose clears a live flush timer and a live heartbeat interval", () => {
		pump = createUpdatePump({ intervalMs: 300, heartbeatMs: 1000 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		pump.schedule("run-1", "fine");
		pump.startHeartbeat("run-1");
		expect(pump.activeTimers).toBe(2);
		expect(vi.getTimerCount()).toBe(2);

		pump.dispose();
		expect(pump.activeTimers).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		vi.advanceTimersByTime(5000);
		expect(handler).not.toHaveBeenCalled();
	});

	it("ignores startHeartbeat after dispose", () => {
		pump = createUpdatePump({ intervalMs: 100 });
		pump.dispose();
		pump.startHeartbeat("run-1");
		expect(pump.activeTimers).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a throwing flush handler does not prevent the next flush", () => {
		pump = createUpdatePump({ intervalMs: 100 });
		const handler = vi.fn(() => {
			throw new Error("boom");
		});
		pump.setFlushHandler(handler);

		pump.schedule("run-1", "fine");
		expect(() => vi.advanceTimersByTime(100)).not.toThrow();
		expect(handler).toHaveBeenCalledTimes(1);

		pump.schedule("run-1", "fine");
		vi.advanceTimersByTime(100);
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it("flushNow flushes immediately and clears the dirty set", () => {
		pump = createUpdatePump({ intervalMs: 300 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		pump.schedule("run-1", "coarse");
		pump.flushNow();
		expect(handler).toHaveBeenCalledTimes(1);
		expect(pump.activeTimers).toBe(0);

		vi.advanceTimersByTime(1000);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("setIntervalMs re-arms a pending fine flush to fire within the new, shorter interval", () => {
		pump = createUpdatePump({ intervalMs: 2000 });
		const handler = vi.fn();
		pump.setFlushHandler(handler);

		pump.schedule("run-1", "fine");
		pump.setIntervalMs(100);

		vi.advanceTimersByTime(99);
		expect(handler).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("setIntervalMs with nothing dirty does not arm a timer", () => {
		pump = createUpdatePump({ intervalMs: 2000 });
		pump.setFlushHandler(vi.fn());
		pump.setIntervalMs(100);
		expect(pump.activeTimers).toBe(0);
	});

	it("keeps dirty entries when no flush handler is installed, and flushes them once a handler is set", () => {
		pump = createUpdatePump({ intervalMs: 100 });

		pump.schedule("run-1", "coarse");
		vi.advanceTimersByTime(100);
		expect(pump.activeTimers).toBe(0);

		const handler = vi.fn();
		pump.setFlushHandler(handler);
		expect(pump.activeTimers).toBe(1);

		vi.advanceTimersByTime(100);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler.mock.calls[0]?.[0]).toEqual(new Map([["run-1", true]]));
	});
});
