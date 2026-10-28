import type { JsonValue } from "@draht/ai";
import { describe, expect, it, vi } from "vitest";
import {
	buildDetails,
	collectArchivedRuns,
	isPolyphaseDetails,
	sumRunUsage,
} from "../../src/core/polyphase/details.ts";
import type { PolyphaseDetails } from "../../src/core/polyphase/types.ts";
import { SUBAGENT_TOOL_NAME, WORKFLOW_TOOL_NAME } from "../../src/core/polyphase/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { makeAgentView, makeRunView } from "./helpers/run-views.ts";
import { assistantEnd, assistantStart, usage } from "./helpers/wire.ts";

function withOutput(index: number, output: string, status: "done" | "failed" = "done") {
	return makeAgentView({
		index,
		status,
		result: {
			agent: "reviewer",
			task: "review the diff",
			exitCode: status === "done" ? 0 : 1,
			output,
			stderr: status === "failed" ? "boom" : "",
		},
	});
}

describe("buildDetails", () => {
	it("round-trips through JSON and satisfies the guard", () => {
		const run = makeRunView({ agents: [withOutput(0, "all good\nSTATUS: DONE")] });
		const details = buildDetails(run, { final: true });

		const roundTripped = JSON.parse(JSON.stringify(details));
		expect(roundTripped).toEqual(details);
		expect(isPolyphaseDetails(roundTripped)).toBe(true);
	});

	it("includes now only in partial details", () => {
		const agent = makeAgentView({
			status: "running",
			records: [
				{ type: "agent_start" },
				{
					type: "message_update",
					usage: usage(0, 0, 0),
					assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
				},
				{
					type: "message_update",
					usage: usage(0, 0, 0),
					assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "checking the diff" },
				},
			],
		});
		const run = makeRunView({ agents: [agent] });

		const partial = buildDetails(run, { final: false });
		const final = buildDetails(run, { final: true });

		expect(partial.agents[0]?.now).toBe(agent.state.nowLine);
		expect(final.agents[0]?.now).toBeUndefined();
	});

	it("extracts the last STATUS line into statusLine", () => {
		const output = "step one\nSTATUS: halfway\nstep two\nSTATUS: done";
		const run = makeRunView({ agents: [withOutput(0, output)] });

		const details = buildDetails(run, { final: true });

		expect(details.agents[0]?.statusLine).toBe("STATUS: done");
	});

	it("reports agentsOmitted counts once degraded to L3/L4", () => {
		const agents = Array.from({ length: 200 }, (_, i) => withOutput(i, "x".repeat(500), i < 5 ? "failed" : "done"));
		const run = makeRunView({ agents });

		const details = buildDetails(run, { final: true, maxBytes: 4000 });

		expect(details.degraded).toBeGreaterThanOrEqual(3);
		expect(details.totals.agents).toBe(200);
		expect(details.agentsOmitted?.count).toBeGreaterThan(0);
		const omittedByStatus = details.agentsOmitted?.byStatus ?? {};
		const totalOmitted = Object.values(omittedByStatus).reduce((sum, n) => sum + (n ?? 0), 0);
		expect(totalOmitted).toBe(details.agentsOmitted?.count);
	});

	it("fits the default byte budgets for 1, 8 and 1000 agents with 1 MB CJK outputs, with degraded rising", () => {
		const cjkOutput = "あ".repeat(1_000_000);
		const degradedByCount: number[] = [];

		for (const count of [1, 8, 1000]) {
			const run = makeRunView({
				agents: Array.from({ length: count }, (_, i) => withOutput(i, cjkOutput, i % 7 === 0 ? "failed" : "done")),
			});
			let finalDegraded = 0;
			for (const final of [true, false]) {
				const details = buildDetails(run, { final });
				const bytes = Buffer.byteLength(JSON.stringify(details), "utf8");
				expect(bytes).toBeLessThanOrEqual(final ? 16_384 : 8_192);
				expect(isPolyphaseDetails(details)).toBe(true);
				if (final) finalDegraded = details.degraded ?? 0;
			}
			degradedByCount.push(finalDegraded);
		}

		expect(degradedByCount[0]).toBeLessThanOrEqual(degradedByCount[1] ?? 0);
		expect(degradedByCount[1]).toBeLessThanOrEqual(degradedByCount[2] ?? 0);
		expect(degradedByCount[2]).toBeGreaterThanOrEqual(3);
	});

	it("L4 always fits, even with 1000 agents and 1 MB outputs and an unreachable byte budget", () => {
		const cjkOutput = "あ".repeat(1_000_000);
		const run = makeRunView({
			agents: Array.from({ length: 1000 }, (_, i) => withOutput(i, cjkOutput, i % 7 === 0 ? "failed" : "done")),
		});

		const details = buildDetails(run, { final: true, maxBytes: 1 });

		expect(details.degraded).toBe(4);
		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(16_384);
		expect(isPolyphaseDetails(details)).toBe(true);
	});

	it("fits the partial budget with long CJK labels and agent types across many agents", () => {
		const agents = Array.from({ length: 30 }, (_, i) =>
			makeAgentView({ index: i, label: "ラベル".repeat(100), agentType: "タイプ".repeat(100), status: "running" }),
		);
		const run = makeRunView({ agents });

		const details = buildDetails(run, { final: false });

		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(8_192);
		expect(isPolyphaseDetails(details)).toBe(true);
	});

	it("fits the final budget when run.error is huge", () => {
		const run = makeRunView({ agents: [withOutput(0, "ok")], error: "x".repeat(100_000) });

		const details = buildDetails(run, { final: true });

		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(16_384);
		expect(details.error).toBeDefined();
	});

	it("fits the final budget with many dynamic phases", () => {
		const phases = Array.from({ length: 2000 }, (_, i) => ({
			title: `phase ${i} with a fairly long descriptive title`,
			dynamic: true,
		}));
		const run = makeRunView({ agents: [withOutput(0, "ok")], phases });

		const details = buildDetails(run, { final: true });

		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(16_384);
	});

	it("fits even with a huge workflow description, args and phase count together", () => {
		const run = makeRunView({
			kind: "workflow",
			agents: Array.from({ length: 50 }, (_, i) => withOutput(i, "x".repeat(2000))),
			workflow: { name: "big", description: "d".repeat(50_000), source: "project", args: "a".repeat(50_000) },
			phases: Array.from({ length: 500 }, (_, i) => ({ title: `phase ${i}`, dynamic: true })),
		});

		const details = buildDetails(run, { final: true });

		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(16_384);
		expect(isPolyphaseDetails(details)).toBe(true);
	});

	it("copies toolCounts instead of keeping a live reference to the reducer state", () => {
		const agent = makeAgentView({ index: 0, status: "running" });
		agent.state.toolCounts.bash = 1;
		const run = makeRunView({ agents: [agent] });

		const details = buildDetails(run, { final: false });
		agent.state.toolCounts.bash = 99;

		expect(details.agents[0]?.tools?.bash).toBe(1);
	});

	it("keeps a failed agent through forceFit instead of dropping it for lower-priority done agents", () => {
		const cjk = "ラベル".repeat(100);
		const agents = Array.from({ length: 31 }, (_, i) =>
			makeAgentView({ index: i, label: cjk, agentType: cjk, task: cjk, status: i === 30 ? "failed" : "done" }),
		);
		const run = makeRunView({ agents });

		const details = buildDetails(run, { final: false });

		expect(details.degraded).toBe(4);
		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(8_192);
		expect(details.agents.some((a) => a.status === "failed")).toBe(true);
	});

	it("caps phase.detail at L0-L3 so one huge phase detail cannot force the run to L4", () => {
		const run = makeRunView({
			agents: [withOutput(0, "ok")],
			phases: [{ title: "big phase", detail: "x".repeat(100_000), dynamic: false }],
		});

		const details = buildDetails(run, { final: true });

		expect(details.degraded).toBeLessThan(4);
		expect(details.phases?.[0]?.detail?.length).toBeLessThanOrEqual(200);
		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(16_384);
	});

	it("drops phase, step, cancelReason and thinking at L4", () => {
		const agent = makeAgentView({ index: 0, phase: 1, step: 2, cancelReason: "budget", status: "cancelled" });
		const run = makeRunView({ agents: [agent] });

		const details = buildDetails(run, { final: true, maxBytes: 1 });

		expect(details.degraded).toBe(4);
		const a = details.agents[0];
		expect(a?.phase).toBeUndefined();
		expect(a?.step).toBeUndefined();
		expect(a?.cancelReason).toBeUndefined();
		expect(a?.thinking).toBeUndefined();
	});
});

describe("isPolyphaseDetails", () => {
	it("rejects shapes missing required fields", () => {
		expect(isPolyphaseDetails({})).toBe(false);
		expect(isPolyphaseDetails({ v: 2 })).toBe(false);
		expect(
			isPolyphaseDetails({
				v: 1,
				runId: "r",
				kind: "subagent",
				origin: "tool",
				title: "t",
				status: "done",
				startedAt: 0,
				totals: {},
				// agents is missing
			}),
		).toBe(false);
	});

	it("accepts a built details object", () => {
		const details = buildDetails(makeRunView({ agents: [withOutput(0, "ok")] }), { final: true });
		expect(isPolyphaseDetails(details)).toBe(true);
	});

	it("rejects non-array phases/log and totals missing numeric fields", () => {
		const base = buildDetails(makeRunView({ agents: [withOutput(0, "ok")] }), { final: true });

		expect(isPolyphaseDetails({ ...base, phases: "nope" })).toBe(false);
		expect(isPolyphaseDetails({ ...base, log: "nope" })).toBe(false);
		expect(isPolyphaseDetails({ ...base, totals: { agents: 1 } })).toBe(false);
	});
});

describe("sumRunUsage", () => {
	it("combines usage across agents, skipping agents with none", () => {
		const earned = (input: number, output: number, cost: number) => [
			assistantStart("anthropic", "claude-sonnet-5"),
			assistantEnd({ usage: usage(input, output, cost) }),
		];
		const a = makeAgentView({ index: 0, records: earned(10, 5, 0.01) });
		const b = makeAgentView({ index: 1, records: earned(3, 2, 0.002) });
		const c = makeAgentView({ index: 2, records: [] });

		const run = makeRunView({ agents: [a, b, c] });
		const total = sumRunUsage(run);

		expect(total?.input).toBe(13);
		expect(total?.output).toBe(7);
	});

	it("returns undefined when no agent has usage", () => {
		const run = makeRunView({ agents: [makeAgentView({ index: 0 })] });
		expect(sumRunUsage(run)).toBeUndefined();
	});
});

/** `ToolResultMessage.details` and `CustomMessageEntry.details` are typed as `JsonValue`; this
 * is the same cast a real caller persisting a `PolyphaseDetails` would need. */
function asJson(details: PolyphaseDetails): JsonValue {
	return details as unknown as JsonValue;
}

describe("collectArchivedRuns", () => {
	it("collects valid toolResult and custom_message entries, dedupes by runId, and skips live/non-polyphase entries", () => {
		const session = SessionManager.inMemory();
		const detailsFor = (runId: string) =>
			asJson(buildDetails(makeRunView({ id: runId, agents: [withOutput(0, "ok")] }), { final: true }));

		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: SUBAGENT_TOOL_NAME,
			content: [],
			details: detailsFor("run-a"),
			isError: false,
			timestamp: Date.now(),
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: [],
			details: { path: "x" },
			isError: false,
			timestamp: Date.now(),
		});
		session.appendCustomMessageEntry("polyphase-workflow", "ran /deploy", true, detailsFor("run-b"));
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-3",
			toolName: WORKFLOW_TOOL_NAME,
			content: [],
			details: detailsFor("run-a"),
			isError: false,
			timestamp: Date.now(),
		});
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-4",
			toolName: SUBAGENT_TOOL_NAME,
			content: [],
			details: detailsFor("run-live"),
			isError: false,
			timestamp: Date.now(),
		});

		const archived = collectArchivedRuns(session.getBranch(), new Set(["run-live"]));

		expect(archived.map((a) => a.runId).sort()).toEqual(["run-a", "run-b"]);
		const runA = archived.find((a) => a.runId === "run-a");
		expect(runA?.source).toBe("toolResult");
		expect(runA?.toolName).toBe(WORKFLOW_TOOL_NAME);
		const runB = archived.find((a) => a.runId === "run-b");
		expect(runB?.source).toBe("message");
	});

	it("orders newest first and respects limit", () => {
		vi.useFakeTimers();
		try {
			const session = SessionManager.inMemory();
			const detailsFor = (runId: string) =>
				asJson(buildDetails(makeRunView({ id: runId, agents: [withOutput(0, "ok")] }), { final: true }));

			for (const runId of ["run-1", "run-2", "run-3"]) {
				session.appendMessage({
					role: "toolResult",
					toolCallId: `call-${runId}`,
					toolName: SUBAGENT_TOOL_NAME,
					content: [],
					details: detailsFor(runId),
					isError: false,
					timestamp: Date.now(),
				});
				vi.advanceTimersByTime(10);
			}

			const archived = collectArchivedRuns(session.getBranch(), new Set(), 2);

			expect(archived).toHaveLength(2);
			expect(archived[0]?.runId).toBe("run-3");
			expect(archived[1]?.runId).toBe("run-2");
		} finally {
			vi.useRealTimers();
		}
	});
});
