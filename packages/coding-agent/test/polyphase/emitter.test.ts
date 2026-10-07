import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/core/extensions/types.ts";
import { createPartialUpdateEmitter } from "../../src/core/polyphase/emitter.ts";
import { PARTIAL_DETAILS_MAX_BYTES, type PolyphaseDetails } from "../../src/core/polyphase/types.ts";
import { largeRun, type SampleRun, singleRun } from "./helpers/sample-runs.ts";

describe("createPartialUpdateEmitter", () => {
	let sample: SampleRun | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		sample?.dispose();
		sample = undefined;
		vi.useRealTimers();
	});

	it("emits immediately on creation", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own markDirty calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 100,
		});

		expect(updates).toHaveLength(1);
		expect(updates[0].details.runId).toBe(sample.run.id);
		expect(updates[0].details.status).toBe("running");

		emitter.dispose();
	});

	it("throttles a fine flush to liveUpdateMs in tui mode", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own markDirty calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		// 400ms: distinct from the non-TUI 1000ms interval below, and larger than the sample pump's
		// 250ms fine delay, so this test can actually distinguish "liveUpdateMs" from "always 1000ms".
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 400,
		});
		expect(updates).toHaveLength(1);

		sample.run.markDirty("fine");
		// The sample store's pump flushes fine changes after 250ms; the emitter then schedules a
		// trailing timer for the remainder of its own 400ms throttle window.
		vi.advanceTimersByTime(250);
		expect(updates).toHaveLength(1);
		vi.advanceTimersByTime(400 - 250 - 1);
		expect(updates).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(updates).toHaveLength(2);

		emitter.dispose();
	});

	it("throttles to 1000ms outside tui mode", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own markDirty calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "print",
			liveUpdateMs: 50,
		});
		expect(updates).toHaveLength(1);

		sample.run.markDirty("fine");
		vi.advanceTimersByTime(250);
		expect(updates).toHaveLength(1);
		vi.advanceTimersByTime(1000 - 250 - 1);
		expect(updates).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(updates).toHaveLength(2);

		emitter.dispose();
	});

	it("emits a coarse flush on the fast path once 50ms have passed, without waiting out the full throttle", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own markDirty calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 1000,
		});
		expect(updates).toHaveLength(1);

		sample.run.markDirty("coarse");
		// The pump's coarse delay is min(coarseDelayMs, intervalMs) = 50ms for the sample store.
		vi.advanceTimersByTime(50);
		expect(updates).toHaveLength(2);

		emitter.dispose();
	});

	it("schedules only one trailing timer across repeated fine flushes", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own markDirty calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 1000,
		});
		expect(updates).toHaveLength(1);

		// First flush (at the pump's 250ms fine delay) arms a trailing timer for t=1000.
		sample.run.markDirty("fine");
		vi.advanceTimersByTime(250);
		expect(updates).toHaveLength(1);

		// A second flush (at t=500) must not replace or add to that trailing timer.
		sample.run.markDirty("fine");
		vi.advanceTimersByTime(250);
		expect(updates).toHaveLength(1);

		vi.advanceTimersByTime(499);
		expect(updates).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(updates).toHaveLength(2);

		emitter.dispose();
	});

	it("keeps partial details at or below PARTIAL_DETAILS_MAX_BYTES", () => {
		sample = largeRun(60);
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 100,
		});

		expect(updates).toHaveLength(1);
		const bytes = Buffer.byteLength(JSON.stringify(updates[0].details), "utf8");
		expect(bytes).toBeLessThanOrEqual(PARTIAL_DETAILS_MAX_BYTES);
		expect(updates[0].details.status).toBe("running");

		emitter.dispose();
	});

	it("emits nothing after dispose and leaves no pending timers", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own markDirty calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 1000,
		});
		expect(updates).toHaveLength(1);

		sample.run.markDirty("fine");
		vi.advanceTimersByTime(250);
		expect(updates).toHaveLength(1);

		const timersBeforeDispose = vi.getTimerCount();
		emitter.dispose();
		// dispose() must clear its own trailing timer synchronously. Advancing straight past the
		// deadline (as below) would let a dangling timer fire as a no-op and hide a leak, so check
		// the count drops by exactly one right away instead.
		expect(vi.getTimerCount()).toBe(timersBeforeDispose - 1);

		// Past the deadline the (now-cleared) trailing timer would have fired at.
		vi.advanceTimersByTime(750);
		expect(updates).toHaveLength(1);

		sample.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a coarse flush arriving less than 50ms after the last emission shortens a pending fine trailing timer instead of adding a second one", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own flush calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 1000,
		});
		expect(updates).toHaveLength(1);

		// t0: baseline emission.
		emitter.flush();
		expect(updates).toHaveLength(2);

		// A fine flush right at t0 arms a trailing timer for t0+liveUpdateMs (1000ms).
		sample.run.emitFlush(false);
		expect(updates).toHaveLength(2);
		const timersAfterFine = vi.getTimerCount();

		// A coarse flush 10ms later is still inside the 50ms fast-path window (elapsed=10 < 50), so
		// it must replace the long fine deadline with a short one (t0+50) rather than add a timer.
		vi.advanceTimersByTime(10);
		sample.run.emitFlush(true);
		expect(updates).toHaveLength(2);
		expect(vi.getTimerCount()).toBe(timersAfterFine);

		// t0+49: still short of the shortened deadline.
		vi.advanceTimersByTime(39);
		expect(updates).toHaveLength(2);
		// t0+50: the shortened deadline fires, not the original t0+1000.
		vi.advanceTimersByTime(1);
		expect(updates).toHaveLength(3);

		emitter.dispose();
	});

	it("a throwing onUpdate inside the trailing timer does not escape as an uncaught exception", () => {
		sample = singleRun();
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		let calls = 0;
		const emitter = createPartialUpdateEmitter(
			sample.run,
			(update) => {
				calls++;
				if (calls === 2) throw new Error("onUpdate exploded");
				updates.push(update);
			},
			{ mode: "tui", liveUpdateMs: 400 },
		);
		expect(updates).toHaveLength(1);

		sample.run.markDirty("fine");
		vi.advanceTimersByTime(250);
		expect(() => vi.advanceTimersByTime(150)).not.toThrow();
		expect(calls).toBe(2);
		expect(updates).toHaveLength(1);

		emitter.dispose();
	});

	it("flush() emits immediately, bypassing the throttle", () => {
		sample = singleRun();
		// Settle setup-time dirty state (addAgent/drive/settle markDirty calls) before the emitter
		// subscribes, so only the test's own markDirty calls below are observed.
		vi.advanceTimersByTime(300);
		const updates: AgentToolResult<PolyphaseDetails>[] = [];
		const emitter = createPartialUpdateEmitter(sample.run, (update) => updates.push(update), {
			mode: "tui",
			liveUpdateMs: 1000,
		});
		expect(updates).toHaveLength(1);

		emitter.flush();
		expect(updates).toHaveLength(2);

		emitter.dispose();
	});
});
