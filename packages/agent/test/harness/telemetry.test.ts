import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@draht/ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import { renderTelemetrySchemaMarkdown } from "../../../ai/scripts/generate-telemetry-docs.ts";
import {
	HARNESS_TELEMETRY_SCHEMA,
	type HarnessSpanEndAttributes,
	type HarnessSpanStartAttributes,
	startHarnessSpan,
} from "../../src/harness/telemetry.ts";

describe("HARNESS_TELEMETRY_SCHEMA", () => {
	it("is serializable, exhaustive, and generates the checked-in reference", () => {
		expect(Object.keys(HARNESS_TELEMETRY_SCHEMA.spans)).toEqual([
			"pi.harness.run",
			"pi.harness.compaction",
			"pi.harness.navigation",
			"pi.harness.checkpoint",
			"pi.harness.turn",
			"pi.harness.step",
			"pi.harness.tool",
			"pi.harness.hook",
			"pi.harness.sleep",
			"pi.harness.event_handler",
			"pi.session.write",
		]);
		expect(() => JSON.stringify(HARNESS_TELEMETRY_SCHEMA)).not.toThrow();
		const expected = renderTelemetrySchemaMarkdown(HARNESS_TELEMETRY_SCHEMA, "Pi Agent Harness Telemetry Schema");
		const actual = readFileSync(resolve(import.meta.dirname, "../../docs/telemetry-schema.md"), "utf8");
		expect(actual).toBe(expected);
	});

	it("infers per-span literals and optional completion enrichment", async () => {
		type RunStart = HarnessSpanStartAttributes<"pi.harness.run">;
		type RunEnd = HarnessSpanEndAttributes<"pi.harness.run">;
		expectTypeOf<RunStart["pi.operation.kind"]>().toEqualTypeOf<"run">();
		expectTypeOf<RunEnd["pi.operation.outcome"]>().toEqualTypeOf<
			"completed" | "aborted" | "failed" | "suspended" | undefined
		>();

		const telemetryContext: TelemetryContext = NOOP_TELEMETRY_CONTEXT;
		await startHarnessSpan(
			telemetryContext,
			"pi.harness.run",
			{
				"pi.session.id": "session",
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"pi.operation.kind": "run",
				"pi.operation.recovery": false,
			},
			(span) => {
				span.setAttributes({ "pi.operation.outcome": "completed" });
				span.setAttributes({});
				// @ts-expect-error the harness schema declares no span events
				span.addEvent("result");
			},
		);

		const compileTimeFailures = () => {
			const extraRunAttributes = {
				"pi.session.id": "session",
				"pi.lane.name": "main",
				"pi.operation.id": "operation",
				"pi.operation.kind": "run",
				"pi.operation.recovery": false,
				"pi.unknown": true,
			} as const;
			// @ts-expect-error variables with unknown attributes are rejected
			void startHarnessSpan(telemetryContext, "pi.harness.run", extraRunAttributes, () => {});
			void startHarnessSpan(
				telemetryContext,
				"pi.harness.checkpoint",
				{
					"pi.lane.name": "main",
					"pi.operation.id": "operation",
					"pi.checkpoint.kind": "normal",
				},
				(span) => {
					// @ts-expect-error empty end schemas reject every attribute
					span.setAttributes({ "pi.unknown": true });
				},
			);
			void startHarnessSpan(
				telemetryContext,
				"pi.harness.run",
				{
					"pi.session.id": "session",
					"pi.lane.name": "main",
					"pi.operation.id": "operation",
					// @ts-expect-error run spans accept only the run operation kind
					"pi.operation.kind": "navigation",
					"pi.operation.recovery": false,
				},
				() => {},
			);
			// @ts-expect-error missing required run start attributes
			void startHarnessSpan(telemetryContext, "pi.harness.run", {}, () => {});
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
