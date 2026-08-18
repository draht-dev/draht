import { describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_CONTEXT,
	createContextKey,
	TODO_CONTEXT,
	withAbortSignal,
	withCancel,
	withContextValue,
	withoutAbortSignal,
	withTelemetryContext,
} from "../../src/harness/context.ts";
import { InMemoryTelemetryContext } from "../../src/index.ts";

describe("Context", () => {
	it("provides distinct empty root contexts", () => {
		const key = createContextKey<string>("value");

		expect(TODO_CONTEXT).not.toBe(BACKGROUND_CONTEXT);
		expect(TODO_CONTEXT.abortSignal).toBeUndefined();
		expect(TODO_CONTEXT.value(key)).toBeUndefined();
		expect(TODO_CONTEXT.telemetryContext).toBe(BACKGROUND_CONTEXT.telemetryContext);
		expect(String(BACKGROUND_CONTEXT)).toBe("[Context BACKGROUND_CONTEXT]");
		expect(String(TODO_CONTEXT)).toBe("[Context TODO_CONTEXT]");
	});

	it("layers typed values without modifying parents", () => {
		const firstKey = createContextKey<string>("first");
		const secondKey = createContextKey<number>("second");
		const first = withContextValue(firstKey, "one", BACKGROUND_CONTEXT);
		const second = withContextValue(secondKey, 2, first);
		const replaced = withContextValue(firstKey, "updated", second);

		expect(BACKGROUND_CONTEXT.value(firstKey)).toBeUndefined();
		expect(first.value(firstKey)).toBe("one");
		expect(first.value(secondKey)).toBeUndefined();
		expect(second.value(firstKey)).toBe("one");
		expect(second.value(secondKey)).toBe(2);
		expect(replaced.value(firstKey)).toBe("updated");
		expect(second.value(firstKey)).toBe("one");
		expect(String(replaced)).toBe("[Context BACKGROUND_CONTEXT].WithValue(first).WithValue(second).WithValue(first)");
	});

	it("inherits parent cancellation and isolates child cancellation", () => {
		const parentController = new AbortController();
		const parent = withAbortSignal(parentController.signal, BACKGROUND_CONTEXT);
		const child = withCancel(parent);
		const sibling = withCancel(parent);
		const childListener = vi.fn();
		child.context.abortSignal?.addEventListener("abort", childListener);

		child.cancel("child");
		expect(child.context.abortSignal?.aborted).toBe(true);
		expect(child.context.abortSignal?.reason).toBe("child");
		expect(sibling.context.abortSignal?.aborted).toBe(false);
		expect(parent.abortSignal?.aborted).toBe(false);
		expect(childListener).toHaveBeenCalledOnce();

		parentController.abort("parent");
		expect(sibling.context.abortSignal?.aborted).toBe(true);
		expect(sibling.context.abortSignal?.reason).toBe("parent");
	});

	it("masks caller cancellation for mandatory cleanup", () => {
		const controller = new AbortController();
		const key = createContextKey<string>("value");
		const context = withContextValue(key, "preserved", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
		const cleanup = withoutAbortSignal(context);

		controller.abort();
		expect(context.abortSignal?.aborted).toBe(true);
		expect(cleanup.abortSignal).toBeUndefined();
		expect(cleanup.value(key)).toBe("preserved");
	});

	it("carries telemetry as an ordinary context value", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context = withTelemetryContext(telemetry, BACKGROUND_CONTEXT);

		await context.telemetryContext.startSpan({ name: "parent" }, async (span) => {
			const childContext = withTelemetryContext(span, context);
			await childContext.telemetryContext.startSpan({ name: "child" }, () => undefined);
		});

		const spans = telemetry.getSpans();
		expect(spans.map((span) => span.name)).toEqual(["parent", "child"]);
		expect(spans[1]?.parentId).toBe(spans[0]?.id);
	});
});
