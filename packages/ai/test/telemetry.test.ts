import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderTelemetrySchemaMarkdown } from "../scripts/generate-telemetry-docs.ts";
import {
	AI_TELEMETRY_SCHEMA,
	type AiSpanEndAttributes,
	type AiSpanStartAttributes,
	NOOP_TELEMETRY_CONTEXT,
	startAiSpan,
	type TelemetryContext,
	type TelemetrySpan,
} from "../src/telemetry.ts";

function unreadable<T extends object>(value: T): T {
	return new Proxy(value, {
		get: () => {
			throw new Error("read");
		},
		getOwnPropertyDescriptor: () => {
			throw new Error("inspect");
		},
		ownKeys: () => {
			throw new Error("enumerate");
		},
	});
}

describe("NOOP_TELEMETRY_CONTEXT", () => {
	it("admits callbacks synchronously and reuses one inert span", async () => {
		let admitted = false;
		let firstSpan: TelemetrySpan | undefined;
		const result = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "first" }, async (span) => {
			admitted = true;
			firstSpan = span;
			const child = await span.startSpan({ name: "child" }, (childSpan) => childSpan);
			expect(child).toBe(span);
			return 42;
		});

		expect(admitted).toBe(true);
		expect(await result).toBe(42);
		expect(Object.isFrozen(firstSpan)).toBe(true);
	});

	it("preserves synchronous and asynchronous rejection values", async () => {
		const syncError = { kind: "sync" };
		const sync = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "sync" }, () => {
			throw syncError;
		});
		await expect(sync).rejects.toBe(syncError);

		const asyncError = { kind: "async" };
		const asyncResult = NOOP_TELEMETRY_CONTEXT.startSpan({ name: "async" }, async () => {
			throw asyncError;
		});
		await expect(asyncResult).rejects.toBe(asyncError);
	});

	it("does not inspect or retain telemetry payloads", async () => {
		const options = unreadable({ name: "operation", attributes: { secret: "prompt content" } });
		await NOOP_TELEMETRY_CONTEXT.startSpan(options, (span) => {
			expect(() => span.addEvent("event", unreadable({ secret: "content" }))).not.toThrow();
			expect(() => span.setAttributes(unreadable({ secret: "content" }))).not.toThrow();
			expect(() => span.setStatus(unreadable({ status: "ok" as const }))).not.toThrow();
		});
	});
});

describe("AI_TELEMETRY_SCHEMA", () => {
	it("is serializable and generates the checked-in reference", () => {
		expect(() => JSON.stringify(AI_TELEMETRY_SCHEMA)).not.toThrow();
		const expected = renderTelemetrySchemaMarkdown(AI_TELEMETRY_SCHEMA, "Pi AI Telemetry Schema");
		const actual = readFileSync(resolve(import.meta.dirname, "../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(expected);
	});

	it("infers exact start and optional end attributes", async () => {
		type Start = AiSpanStartAttributes<"pi.ai.request">;
		type End = AiSpanEndAttributes<"pi.ai.request">;
		expectTypeOf<Start>().toMatchTypeOf<{
			"pi.ai.operation": "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";
			"pi.ai.provider": string;
			"pi.ai.model": string;
			"pi.ai.api": string;
			"pi.ai.streaming": boolean;
			"pi.ai.deferred"?: boolean;
		}>();
		expectTypeOf<End["pi.ai.response.stop_reason"]>().toEqualTypeOf<
			"stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" | undefined
		>();

		const context: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startAiSpan(
			context,
			"pi.ai.request",
			{
				"pi.ai.operation": "stream",
				"pi.ai.provider": "provider",
				"pi.ai.model": "model",
				"pi.ai.api": "api",
				"pi.ai.streaming": true,
			},
			(span) => {
				span.setAttributes({ "pi.ai.response.stop_reason": "tool_use" });
				// @ts-expect-error pi.ai.request declares no span events
				span.addEvent("chunk");
			},
		);

		const compileTimeFailures = () => {
			const extraAttributes = {
				"pi.ai.operation": "stream",
				"pi.ai.provider": "provider",
				"pi.ai.model": "model",
				"pi.ai.api": "api",
				"pi.ai.streaming": true,
				"pi.ai.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startAiSpan(context, "pi.ai.request", extraAttributes, () => {});
			// @ts-expect-error missing required start attributes
			void startAiSpan(context, "pi.ai.request", { "pi.ai.operation": "stream" }, () => {});
			void startAiSpan(
				context,
				"pi.ai.request",
				{
					"pi.ai.operation": "stream",
					"pi.ai.provider": "provider",
					"pi.ai.model": "model",
					"pi.ai.api": "api",
					"pi.ai.streaming": true,
					// @ts-expect-error unknown start attribute
					"pi.ai.unknown": true,
				},
				() => {},
			);
			void startAiSpan(
				context,
				"pi.ai.request",
				{
					// @ts-expect-error invalid closed-set value
					"pi.ai.operation": "invalid",
					"pi.ai.provider": "provider",
					"pi.ai.model": "model",
					"pi.ai.api": "api",
					"pi.ai.streaming": true,
				},
				() => {},
			);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
