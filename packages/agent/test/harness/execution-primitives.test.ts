import { fauxProvider } from "@draht/ai";
import { describe, expect, it, vi } from "vitest";
import { HarnessEventBus } from "../../src/harness/events.ts";
import { BreakpointBarrier } from "../../src/harness/execution/breakpoint.ts";
import { AbortRequested, OperationEffectGate } from "../../src/harness/execution/effect-gate.ts";
import { HookRegistry } from "../../src/harness/hooks.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

describe("BreakpointBarrier", () => {
	it("parks before work, publishes JSON-safe action data, and releases exactly once", async () => {
		const barrier = new BreakpointBarrier("manual");
		let worked = false;
		const task = (async () => {
			await barrier.hit({ kind: "test.effect", description: "Run effect", details: { attempt: 1 } });
			worked = true;
		})();

		expect(barrier.peek()).toEqual({
			kind: "test.effect",
			description: "Run effect",
			details: { attempt: 1 },
		});
		expect(JSON.parse(JSON.stringify(barrier.peek()))).toEqual(barrier.peek());
		expect(worked).toBe(false);
		expect(barrier.release()?.kind).toBe("test.effect");
		expect(barrier.release()).toBeUndefined();
		await task;
		expect(worked).toBe(true);
	});

	it("interrupts ordinary barriers but not cancellation-reconciliation barriers", async () => {
		const ordinary = new BreakpointBarrier("manual");
		const cancellation = deferred();
		const parked = ordinary.hit({ kind: "ordinary", description: "ordinary" });
		ordinary.interrupt(cancellation.promise);
		await expect(parked).rejects.toBeInstanceOf(AbortRequested);

		const reconciliation = new BreakpointBarrier("manual");
		const protectedPark = reconciliation.hit(
			{ kind: "cancel.reconcile", description: "reconcile" },
			{ interruptOnAbort: false },
		);
		reconciliation.interrupt(cancellation.promise);
		expect(reconciliation.peek()?.kind).toBe("cancel.reconcile");
		reconciliation.release();
		await protectedPark;
	});

	it("publishes sequential nested boundaries without conflating them", async () => {
		const barrier = new BreakpointBarrier("manual");
		const task = (async () => {
			await barrier.hit({ kind: "outer", description: "outer" });
			await barrier.hit({ kind: "inner", description: "inner" });
		})();
		expect(barrier.peek()?.kind).toBe("outer");
		barrier.release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(barrier.peek()?.kind).toBe("inner");
		barrier.release();
		await task;
	});

	it("has equivalent non-parking automatic behavior", async () => {
		const barrier = new BreakpointBarrier("automatic");
		await barrier.hit({ kind: "automatic", description: "automatic" });
		expect(barrier.peek()).toBeUndefined();
	});
});

describe("OperationEffectGate", () => {
	it("closes starts synchronously and signals only after cancellation commits", async () => {
		const gate = new OperationEffectGate();
		const cancellation = deferred();
		gate.beginAbort(cancellation.promise);

		let refusal: unknown;
		try {
			gate.assertOpen();
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(AbortRequested);
		expect((refusal as AbortRequested).cancellation).toBe(cancellation.promise);
		expect(gate.signal.aborted).toBe(false);
		cancellation.resolve();
		await cancellation.promise;
		gate.signalAbort();
		expect(gate.signal.aborted).toBe(true);
	});

	it("permanently closes and signals admitted work", () => {
		const gate = new OperationEffectGate();
		const error = new Error("closed");
		gate.close(error);
		expect(() => gate.assertOpen()).toThrow(error);
		expect(gate.signal.aborted).toBe(true);
	});
});

describe("HookRegistry", () => {
	it("aggregates before_run messages in registration order with each handler seeing prior output", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const second = vi.fn((event: { prompt: Array<{ role: string }> }) => {
			expect(event.prompt).toHaveLength(2);
			return { messages: [{ role: "user" as const, content: "second", timestamp: 3 }] };
		});
		hooks.on("before_run", () => ({ messages: [{ role: "user", content: "first", timestamp: 2 }] }));
		hooks.on("before_run", second);

		const result = await hooks.runWithGate(
			"before_run",
			{
				lane: "main",
				runId: "run",
				prompt: [{ role: "user", content: "prompt", timestamp: 1 }],
				resources: {},
			},
			new OperationEffectGate(),
		);

		expect(result).toMatchObject({
			messages: [
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			],
		});
		expect(second).toHaveBeenCalledOnce();
		expect(errors).toEqual([]);
	});

	it("checks the effect gate immediately before the complete before_run pipeline", async () => {
		const hooks = new HookRegistry(() => {});
		const calls: string[] = [];
		const release = deferred();
		hooks.on("before_run", async () => {
			calls.push("first:start");
			await release.promise;
			calls.push("first:end");
			return undefined;
		});
		hooks.on("before_run", () => {
			calls.push("second");
			return undefined;
		});
		const event = { lane: "main", runId: "run", prompt: [], resources: {} };
		const closed = new Error("closed");
		const closedGate = new OperationEffectGate();
		closedGate.close(closed);
		expect(() => hooks.runWithGate("before_run", event, closedGate)).toThrow(closed);
		expect(calls).toEqual([]);

		const running = hooks.runWithGate("before_run", event, new OperationEffectGate());
		expect(calls).toEqual(["first:start"]);
		hooks.on("before_run", () => {
			calls.push("late");
			return undefined;
		});
		hooks.close(closed);
		release.resolve();
		await running;
		expect(calls).toEqual(["first:start", "first:end", "second"]);
	});

	it("treats registration ids as optional metadata and fails before_drive closed", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const failure = new Error("prerequisite failed");
		const later = vi.fn();
		hooks.on(
			"before_drive",
			() => {
				throw failure;
			},
			{ id: "duplicate" },
		);
		hooks.on("before_drive", later, { id: "duplicate" });

		await expect(
			hooks.runWithGate("before_drive", { lane: "main", runId: "run", operation: "run" }, new OperationEffectGate()),
		).rejects.toBe(failure);
		expect(later).not.toHaveBeenCalled();
		expect(errors).toEqual([failure]);
	});

	it("chains transform_context output and isolates handler failures", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const messages = [{ role: "user" as const, content: "transformed", timestamp: 2 }];
		hooks.on("transform_context", () => ({ messages, systemPrompt: "first" }));
		hooks.on("transform_context", (event) => {
			expect(event.messages).toBe(messages);
			expect(event.systemPrompt).toBe("first");
			throw new Error("ignored transform failure");
		});
		hooks.on("transform_context", (event) => {
			expect(event.messages).toBe(messages);
			expect(event.systemPrompt).toBe("first");
			return { systemPrompt: "final" };
		});

		const result = await hooks.runWithGate(
			"transform_context",
			{
				lane: "main",
				runId: "run",
				messages: [{ role: "user", content: "original", timestamp: 1 }],
				systemPrompt: "base",
			},
			new OperationEffectGate(),
		);

		expect(result).toEqual({ messages, systemPrompt: "final" });
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("ignored transform failure");
	});

	it("preserves clear-all before_request patches across later handlers", async () => {
		const hooks = new HookRegistry(() => {});
		hooks.on("before_request", () => ({ streamOptions: { headers: undefined, metadata: undefined } }));
		hooks.on("before_request", (event) => {
			expect(event.streamOptions.headers).toBeUndefined();
			expect(event.streamOptions.metadata).toBeUndefined();
			return { streamOptions: { headers: { c: "3" }, metadata: { y: 2 } } };
		});
		const result = await hooks.runWithGate(
			"before_request",
			{
				lane: "main",
				runId: "run",
				model: fauxProvider().getModel(),
				step: "assistant",
				attempt: 1,
				streamOptions: { headers: { a: "1", b: "2" }, metadata: { x: 1 } },
			},
			new OperationEffectGate(),
		);
		expect(result).toEqual({
			streamOptions: {
				headers: { a: undefined, b: undefined, c: "3" },
				metadata: { x: undefined, y: 2 },
			},
		});
	});

	it("preserves earlier after_tool fields when a later patch returns undefined", async () => {
		const hooks = new HookRegistry(() => {});
		hooks.on("after_tool", () => ({ content: [{ type: "text", text: "patched" }] }));
		hooks.on("after_tool", () => ({ content: undefined, isError: false }));
		const result = await hooks.runWithGate(
			"after_tool",
			{
				lane: "main",
				runId: "run",
				toolCallId: "call",
				toolName: "tool",
				args: {},
				content: [{ type: "text", text: "raw" }],
				isError: true,
			},
			new OperationEffectGate(),
		);
		expect(result).toEqual({ content: [{ type: "text", text: "patched" }], isError: false });
	});

	it("accepts explicit false structural declines and rejects true conflicts", async () => {
		const errors: Error[] = [];
		const hooks = new HookRegistry((error) => {
			errors.push(error);
		});
		const ignored = { summary: "ignored", readFiles: [], modifiedFiles: [] };
		const selected = { summary: "selected", readFiles: [], modifiedFiles: [] };
		hooks.on("before_navigation", () => ({ decline: true, summary: ignored }));
		hooks.on("before_navigation", () => ({ decline: false, summary: selected }));

		const result = await hooks.runWithGate(
			"before_navigation",
			{
				lane: "main",
				runId: "run",
				targetId: "target",
				preparation: {
					messages: [],
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					totalTokens: 0,
				},
			},
			new OperationEffectGate(),
		);
		expect(result).toEqual({ decline: false, summary: selected });
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toMatch(/cannot return both decline and summary/);
	});

	it("admits the complete before_drive pipeline as one gated effect", async () => {
		const hooks = new HookRegistry(() => {});
		const calls: string[] = [];
		const release = deferred();
		hooks.on("before_drive", async () => {
			calls.push("first:start");
			await release.promise;
			calls.push("first:end");
		});
		hooks.on("before_drive", () => {
			calls.push("second");
		});
		const event = { operation: "run" as const, lane: "main", runId: "run" };

		const abortFirstGate = new OperationEffectGate();
		const cancellation = Promise.resolve();
		abortFirstGate.beginAbort(cancellation);
		expect(() => hooks.runWithGate("before_drive", event, abortFirstGate)).toThrow(AbortRequested);
		expect(calls).toEqual([]);

		const startFirstGate = new OperationEffectGate();
		const running = hooks.runWithGate("before_drive", event, startFirstGate);
		expect(calls).toEqual(["first:start"]);
		startFirstGate.beginAbort(cancellation);
		startFirstGate.signalAbort();
		release.resolve();
		await running;
		expect(calls).toEqual(["first:start", "first:end", "second"]);
	});
});

describe("HarnessEventBus", () => {
	it("buffers between snapshot and start, then delivers each event once in order", async () => {
		const bus = new HarnessEventBus();
		const watcher = bus.watch({ leafId: null }, () => true);
		await bus.emit({ type: "run_start", runId: "one", lane: "main" });
		const seen: string[] = [];
		watcher.start((event) => {
			seen.push(`${event.type}:${"runId" in event ? event.runId : ""}`);
		});
		await bus.emit({ type: "run_start", runId: "two", lane: "main" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(watcher.snapshot).toEqual({ leafId: null });
		expect(seen).toEqual(["run_start:one", "run_start:two"]);
		watcher.unsubscribe();
		await bus.emit({ type: "run_start", runId: "three", lane: "main" });
		expect(seen).toHaveLength(2);
	});

	it("isolates each listener from payload mutation", async () => {
		const bus = new HarnessEventBus();
		let observed: string[] = [];
		bus.on("config_update", (event) => {
			if (event.property === "activeTools") event.value.push("mutated");
		});
		bus.on("config_update", (event) => {
			if (event.property === "activeTools") observed = event.value;
		});
		await bus.emit({
			type: "config_update",
			property: "activeTools",
			value: ["read"],
			previous: [],
			lane: "main",
		});
		expect(observed).toEqual(["read"]);
	});

	it("serializes concurrent publications in process order", async () => {
		const bus = new HarnessEventBus();
		const started = deferred();
		const release = deferred();
		const seen: string[] = [];
		bus.on("run_start", async (event) => {
			seen.push(`${event.runId}:start`);
			if (event.runId === "one") {
				started.resolve();
				await release.promise;
			}
			seen.push(`${event.runId}:end`);
		});

		const one = bus.emit({ type: "run_start", runId: "one", lane: "main" });
		await started.promise;
		const two = bus.emit({ type: "run_start", runId: "two", lane: "main" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual(["one:start"]);
		release.resolve();
		await Promise.all([one, two]);
		expect(seen).toEqual(["one:start", "one:end", "two:start", "two:end"]);
	});

	it("continues watcher delivery after listener failure and reports it", async () => {
		const bus = new HarnessEventBus();
		const failures: string[] = [];
		bus.on("handler_error", (event) => {
			failures.push(event.error);
		});
		const watcher = bus.watch({}, (event) => event.type === "run_start");
		const seen: string[] = [];
		watcher.start((event) => {
			if (event.type !== "run_start") return;
			if (event.runId === "one") throw new Error("watcher failed");
			seen.push(event.runId);
		});

		await bus.emit({ type: "run_start", runId: "one", lane: "main" });
		await bus.emit({ type: "run_start", runId: "two", lane: "main" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual(["two"]);
		expect(failures).toEqual(["watcher failed"]);
	});

	it("isolates listener failures and emits handler_error", async () => {
		const bus = new HarnessEventBus();
		const failures: string[] = [];
		bus.on("run_start", () => {
			throw new Error("listener failed");
		});
		bus.on("handler_error", (event) => {
			failures.push(event.error);
		});
		await bus.emit({ type: "run_start", runId: "run", lane: "main" });
		expect(failures).toEqual(["listener failed"]);
	});
});
