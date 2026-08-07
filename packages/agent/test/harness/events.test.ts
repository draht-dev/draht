import { describe, expect, it } from "vitest";
import { type HarnessEvent, HarnessEventBus, type RunEndEvent, type RunStartEvent } from "../../src/harness/events.ts";

const runStartEvent: RunStartEvent = {
	type: "run_start",
	lane: "main",
	runId: "run-1",
};

const runEndEvent: RunEndEvent = {
	type: "run_end",
	lane: "main",
	runId: "run-1",
	outcome: "completed",
	leafId: "entry-1",
};

describe("HarnessEventBus", () => {
	it("captures a snapshot without an event gap, then flushes and delivers live events", () => {
		const events = new HarnessEventBus();
		const expectedSnapshot = { leafId: null };
		const watch = events.watch(() => {
			const snapshot = expectedSnapshot;
			events.emit(runStartEvent);
			return snapshot;
		});
		const received: HarnessEvent[] = [];

		expect(watch.snapshot).toBe(expectedSnapshot);
		expect(received).toEqual([]);

		watch.start((event) => {
			received.push(event);
		});
		expect(received).toEqual([runStartEvent]);

		events.emit(runEndEvent);
		expect(received).toEqual([runStartEvent, runEndEvent]);

		watch.unsubscribe();
		events.emit(runStartEvent);
		expect(received).toEqual([runStartEvent, runEndEvent]);
	});
});
