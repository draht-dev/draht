import { describe, expect, it } from "vitest";
import { createChildAgentState } from "../../src/core/polyphase/child-events.ts";
import {
	capHeadTail,
	formatBlockedNote,
	formatPartialStatusText,
	formatSubagentResultText,
	formatWorkflowResultText,
	perAgentResultChars,
	type WorkflowOutcomeSummary,
} from "../../src/core/polyphase/result-text.ts";
import type { AgentStatus, AgentView, CancelReason, ChildAgentState } from "../../src/core/polyphase/types.ts";
import { makeAgentView, makeRunView } from "./helpers/run-views.ts";

function agentWithResult(opts: {
	index: number;
	label: string;
	status: AgentStatus;
	phase?: number;
	step?: number;
	provider?: string;
	id?: string;
	requested?: string;
	output?: string;
	stderr?: string;
	cancelReason?: CancelReason;
	merge?: { success: boolean };
	startedAt?: number;
	endedAt?: number;
	nowLine?: string;
}): AgentView {
	const state = createChildAgentState({
		source: "inherited",
		confirmed: Boolean(opts.provider),
		provider: opts.provider,
		id: opts.id,
		requested: opts.requested,
	});
	state.startedAt = opts.startedAt;
	state.endedAt = opts.endedAt;
	if (opts.nowLine !== undefined) state.nowLine = opts.nowLine;

	const started = opts.status !== "pending" && opts.status !== "queued" && opts.status !== "starting";

	return makeAgentView({
		index: opts.index,
		label: opts.label,
		agentType: "reviewer",
		status: opts.status,
		phase: opts.phase,
		step: opts.step,
		cancelReason: opts.cancelReason,
		state,
		result: started
			? {
					agent: "reviewer",
					task: "review the diff",
					exitCode: opts.status === "done" ? 0 : 1,
					output: opts.output ?? "",
					stderr: opts.stderr ?? "",
					cancelled: opts.status === "cancelled",
					...(opts.merge ? { merge: opts.merge } : {}),
				}
			: undefined,
	});
}

describe("capHeadTail", () => {
	it("keeps the head, the marker and a STATUS line that survives in the tail", () => {
		// 40,000 chars of multi-line text (one line per "line N of text" entry), well over the
		// 16,000-char budget, ending with a STATUS line so line-boundary snapping is exercised.
		const lines: string[] = [];
		let total = 0;
		for (let i = 0; total < 40_000; i++) {
			const line = `line ${i} of text`;
			lines.push(line);
			total += line.length + 1;
		}
		const text = `${lines.join("\n")}\nSTATUS: DONE`;
		expect(text.length).toBeGreaterThan(40_000);

		const result = capHeadTail(text, 16_000);

		expect(result.text.startsWith(text.slice(0, 10))).toBe(true);
		expect(result.text).toContain("characters omitted");
		expect(result.text.trimEnd().endsWith("STATUS: DONE")).toBe(true);
		expect(result.omittedChars).toBeGreaterThan(0);
		// Snapping to line boundaries should not have thrown away most of the budget.
		expect(result.text.length).toBeGreaterThanOrEqual(16_000 * 0.8);

		// The head and tail must themselves be cut at line boundaries, not mid-line: the marker's
		// own surrounding "\n"s don't count, so split on it and check what capHeadTail produced.
		const marker = result.text.match(/\n\[\.\.\. \d+ characters omitted \.\.\.\]\n/);
		expect(marker).not.toBeNull();
		const markerStart = marker?.index as number;
		const head = result.text.slice(0, markerStart);
		const tail = result.text.slice(markerStart + (marker?.[0].length ?? 0));
		expect(head.endsWith("\n")).toBe(true);
		expect(tail.startsWith("line ")).toBe(true);
	});

	it("re-appends a STATUS line that falls in the omitted middle", () => {
		const head = "x".repeat(5000);
		const tail = "y".repeat(5000);
		const text = [head, "STATUS: IN PROGRESS", tail].join("\n");

		const result = capHeadTail(text, 2000);

		expect(result.text).not.toContain("STATUS: IN PROGRESS\n");
		expect(result.text.trimEnd().endsWith("STATUS: IN PROGRESS")).toBe(true);
		expect(result.text).toContain("characters omitted");
	});

	it("returns the text unchanged when it already fits", () => {
		expect(capHeadTail("short", 100)).toEqual({ text: "short", omittedChars: 0 });
	});

	it("keeps most of the budget for a single long final line with a trailing newline", () => {
		// No newline anywhere near the head or tail cut points: naive line-boundary snapping would
		// snap the head back to the start and the tail forward past the end, keeping almost nothing.
		const text = `intro\n${"a".repeat(5000)}\n`;

		const result = capHeadTail(text, 1200);

		expect(result.text.length).toBeGreaterThanOrEqual(1200 * 0.8);
		expect(result.omittedChars).toBeGreaterThan(0);
	});
});

describe("perAgentResultChars", () => {
	it("clamps floor(total/N) to [2000, 16000]", () => {
		expect(perAgentResultChars(64_000, 1)).toBe(16_000);
		expect(perAgentResultChars(64_000, 3)).toBe(16_000);
		expect(perAgentResultChars(64_000, 8)).toBe(8_000);
		expect(perAgentResultChars(64_000, 50)).toBe(2_000);
	});
});

describe("formatSubagentResultText: single", () => {
	it("returns the capped output on success", () => {
		const run = makeRunView({
			mode: "single",
			agents: [agentWithResult({ index: 0, label: "worker", status: "done", output: "all good" })],
		});

		const text = formatSubagentResultText(run, { mode: "single", resultChars: 64_000 });

		expect(text).toBe("all good");
	});

	it("formats a failure with the exit code, model and a stderr tail", () => {
		const run = makeRunView({
			mode: "single",
			agents: [
				agentWithResult({
					index: 0,
					label: "worker",
					status: "failed",
					provider: "anthropic",
					id: "claude-sonnet-5",
					output: "partial output",
					stderr: "boom",
				}),
			],
		});

		const text = formatSubagentResultText(run, { mode: "single", resultChars: 64_000 });

		expect(text).toContain("FAILED (exit 1, model anthropic/claude-sonnet-5)");
		expect(text).toContain("partial output");
		expect(text).toContain("stderr:\nboom");
	});

	it("formats a cancellation with the reason, elapsed time and partial output", () => {
		const now = Date.now();
		const run = makeRunView({
			mode: "single",
			agents: [
				agentWithResult({
					index: 0,
					label: "worker",
					status: "cancelled",
					cancelReason: "budget",
					output: "so far so good",
					startedAt: now - 5000,
					endedAt: now,
				}),
			],
		});

		const text = formatSubagentResultText(run, { mode: "single", resultChars: 64_000 });

		expect(text.startsWith("CANCELLED by budget after 0:0")).toBe(true);
		expect(text).toContain("so far so good");
	});
});

describe("formatSubagentResultText: parallel", () => {
	it("formats the header and a block per agent with ok/FAILED/CANCELLED/merge-failed labels", () => {
		const now = Date.now();
		const agents = [
			agentWithResult({
				index: 0,
				label: "reviewer#1",
				status: "done",
				provider: "anthropic",
				id: "claude-sonnet-5",
				output: "looks fine",
				startedAt: now - 31_000,
				endedAt: now,
			}),
			agentWithResult({
				index: 1,
				label: "reviewer#2",
				status: "failed",
				provider: "anthropic",
				id: "claude-sonnet-5",
				output: "",
				stderr: "boom\nmore detail",
				startedAt: now - 10_000,
				endedAt: now,
			}),
			agentWithResult({
				index: 2,
				label: "reviewer#3",
				status: "cancelled",
				cancelReason: "user",
				startedAt: now - 5_000,
				endedAt: now,
			}),
			agentWithResult({
				index: 3,
				label: "reviewer#4",
				status: "done",
				output: "merged?",
				merge: { success: false },
				startedAt: now - 2_000,
				endedAt: now,
			}),
		];
		const run = makeRunView({ mode: "parallel", agents });

		const text = formatSubagentResultText(run, { mode: "parallel", resultChars: 64_000 });

		// reviewer#4's block reads "merge-failed", so it must not also be counted as succeeded;
		// it is folded into the failed count instead (fix round: merge-failed double-counted as ok).
		expect(text).toContain("Parallel: 1/4 succeeded, 2 failed, 1 cancelled");
		expect(text).toContain("=== [1/4] reviewer#1 (reviewer) — ok · anthropic/claude-sonnet-5 · 0:31 ===");
		expect(text).toContain("— FAILED ·");
		expect(text).toContain("— CANCELLED ·");
		expect(text).toContain("— merge-failed ·");
		expect(text).toContain("stderr:\nboom\nmore detail");
	});
});

describe("formatSubagentResultText: chain", () => {
	it("formats a status line per step plus the final step's output on success", () => {
		const now = Date.now();
		const agents = [
			agentWithResult({
				index: 0,
				label: "investigator",
				step: 1,
				status: "done",
				output: "investigated",
				startedAt: now - 31_000,
				endedAt: now - 20_000,
			}),
			agentWithResult({
				index: 1,
				label: "fixer",
				step: 2,
				status: "done",
				output: "fixed it",
				startedAt: now - 20_000,
				endedAt: now,
			}),
		];
		const run = makeRunView({ mode: "chain", agents });

		const text = formatSubagentResultText(run, { mode: "chain", resultChars: 64_000 });

		expect(text).toContain("1. investigator ok · 0:11");
		expect(text).toContain("2. fixer ok · 0:20");
		expect(text).toContain("fixed it");
	});

	it("formats the failure block at the step that broke the chain", () => {
		const now = Date.now();
		const agents = [
			agentWithResult({
				index: 0,
				label: "investigator",
				step: 1,
				status: "done",
				output: "investigated",
				startedAt: now - 30_000,
				endedAt: now - 20_000,
			}),
			agentWithResult({
				index: 1,
				label: "fixer",
				step: 2,
				status: "failed",
				output: "attempted a fix",
				stderr: "patch failed",
				startedAt: now - 20_000,
				endedAt: now,
			}),
			agentWithResult({ index: 2, label: "verifier", step: 3, status: "skipped" }),
		];
		const run = makeRunView({ mode: "chain", agents });

		const text = formatSubagentResultText(run, { mode: "chain", resultChars: 64_000 });

		expect(text).toContain("1. investigator ok · 0:10");
		expect(text).toContain("2. fixer FAILED · 0:20");
		expect(text).toContain("Chain failed at step 2 (fixer)");
		expect(text).toContain("attempted a fix");
		expect(text).toContain("stderr:\npatch failed");
		// The skipped step after the break is still listed, so the parent model sees where the
		// chain stopped (D3 owner decision), with no elapsed time since it never ran.
		expect(text).toContain("3. verifier skipped");
	});
});

describe("formatSubagentResultText: notices and blocked note order", () => {
	it("appends notices before the blocked note, in that order", () => {
		const agent = agentWithResult({ index: 0, label: "worker", status: "done", output: "all good" });
		agent.state.blocked.push({ toolName: "bash", summary: "npm test", reason: "blocked" });
		(agent.state as ChildAgentState).blockedCount = 1;
		const run = makeRunView({ mode: "single", agents: [agent] });

		const text = formatSubagentResultText(run, {
			mode: "single",
			resultChars: 64_000,
			notices: ["merge conflict in src/index.ts"],
		});

		const indexOfNotice = text.indexOf("merge conflict in src/index.ts");
		const indexOfBlocked = text.indexOf("tool call(s) inside subagents were blocked");
		expect(indexOfNotice).toBeGreaterThanOrEqual(0);
		expect(indexOfBlocked).toBeGreaterThan(indexOfNotice);
	});
});

describe("formatWorkflowResultText", () => {
	it("formats every section, the script error line and the budget notice", () => {
		const now = Date.now();
		const run = makeRunView({
			id: "wf-1",
			kind: "workflow",
			origin: "command",
			title: "/deploy",
			mode: undefined,
			workflow: { name: "deploy", description: "ship it", source: "project", args: "" },
			phases: [
				{ title: "build", dynamic: false },
				{ title: "ship", dynamic: false },
			],
			status: "failed",
			startedAt: now - 42_000,
			endedAt: now,
			agents: [
				agentWithResult({
					index: 0,
					label: "builder",
					status: "done",
					phase: 0,
					output: "built",
					startedAt: now - 42_000,
					endedAt: now - 30_000,
				}),
				agentWithResult({
					index: 1,
					label: "shipper",
					status: "cancelled",
					phase: 1,
					cancelReason: "budget",
					startedAt: now - 30_000,
					endedAt: now,
				}),
			],
			log: [{ at: now, level: "warning", text: "budget of 500000 tokens reached; remaining agents are skipped" }],
			logDropped: 0,
			budget: { totalTokens: 500_000, spentTokens: 500_000, exhausted: true },
		});

		const outcome: WorkflowOutcomeSummary = {
			ok: false,
			errorMessage: "ReferenceError: x is not defined",
			errorLine: 12,
			consoleOutput: ["log line one"],
		};

		const text = formatWorkflowResultText(run, outcome);

		expect(text).toContain("Workflow deploy: failed · 2 agents (1 ok, 0 failed, 1 cancelled)");
		expect(text).toContain("Phases:");
		expect(text).toContain("1. build — 1/1 ok");
		expect(text).toContain("2. ship — 0/1 ok, 1 cancelled");
		expect(text).toContain("Result:");
		expect(text).toContain("Log:");
		expect(text).toContain("budget of 500000 tokens reached");
		expect(text).toContain("Console:");
		expect(text).toContain("log line one");
		expect(text).toContain("Agents:");
		expect(text).toContain("Script error at line 12: ReferenceError: x is not defined");
		expect(text).toContain("Budget exhausted:");

		const indexOfPhases = text.indexOf("Phases:");
		const indexOfResult = text.indexOf("Result:");
		const indexOfLog = text.indexOf("Log:");
		const indexOfConsole = text.indexOf("Console:");
		const indexOfAgents = text.indexOf("Agents:");
		const indexOfBudget = text.indexOf("Budget exhausted:");
		expect(indexOfPhases).toBeLessThan(indexOfResult);
		expect(indexOfResult).toBeLessThan(indexOfLog);
		expect(indexOfLog).toBeLessThan(indexOfConsole);
		expect(indexOfConsole).toBeLessThan(indexOfAgents);
		expect(indexOfAgents).toBeLessThan(indexOfBudget);
	});

	it("omits the Console section when there is no console output", () => {
		const run = makeRunView({ kind: "workflow", phases: [], agents: [] });
		const text = formatWorkflowResultText(run, { ok: true, value: "done", consoleOutput: [] });
		expect(text).not.toContain("Console:");
	});

	it("puts each agent on exactly one line, even with multi-line stderr", () => {
		const run = makeRunView({
			kind: "workflow",
			phases: [],
			agents: [
				agentWithResult({
					index: 0,
					label: "builder",
					status: "failed",
					stderr: Array.from({ length: 3000 }, (_, i) => `stderr line ${i}`).join("\n"),
				}),
			],
		});

		const text = formatWorkflowResultText(run, { ok: true, consoleOutput: [] });
		const agentsSection = text.slice(text.indexOf("Agents:"));
		const agentLines = agentsSection.split("\n").filter((l) => l.length > 0);

		expect(agentLines).toHaveLength(2); // "Agents:" plus exactly one line for the one agent
		expect(agentLines[1]).toContain("stderr line 0");
		expect(agentLines[1]?.length).toBeLessThanOrEqual(200);
	});

	it("falls back to errorMessage when stderr is empty, instead of hiding it", () => {
		const agent = agentWithResult({ index: 0, label: "builder", status: "failed", stderr: "" });
		(agent.state as ChildAgentState).errorMessage = "model not found";
		const run = makeRunView({ kind: "workflow", phases: [], agents: [agent] });

		const text = formatWorkflowResultText(run, { ok: true, consoleOutput: [] });

		expect(text).toContain("model not found");
	});

	it("prefixes the script error with a non-script errorKind", () => {
		const run = makeRunView({ kind: "workflow", phases: [], agents: [] });

		const text = formatWorkflowResultText(run, {
			ok: false,
			errorKind: "timeout",
			errorMessage: "exceeded 60000ms",
			consoleOutput: [],
		});

		expect(text).toContain("Workflow timeout: exceeded 60000ms");
	});
});

describe("formatBlockedNote", () => {
	it("lists samples and the remedies", () => {
		const note = formatBlockedNote(3, ["bash: npm test", "bash: npm run lint"]);

		expect(note).toContain("3 tool call(s) inside subagents were blocked");
		expect(note).toContain("bash: npm test, bash: npm run lint");
		expect(note).toContain("permissions.yml");
		expect(note).toContain("/permissions auto");
		expect(note).toContain("/yolo");
	});

	it("is undefined for a zero count", () => {
		expect(formatBlockedNote(0, [])).toBeUndefined();
	});
});

describe("formatPartialStatusText", () => {
	it("bounds the output to 20 lines of at most 120 chars", () => {
		const agents = Array.from({ length: 30 }, (_, i) =>
			agentWithResult({
				index: i,
				label: `agent-with-a-fairly-long-descriptive-label-${i}`,
				status: "running",
				nowLine: "x".repeat(300),
			}),
		);
		const run = makeRunView({ agents });

		const text = formatPartialStatusText(run);
		const lines = text.split("\n");

		expect(lines.length).toBeLessThanOrEqual(20);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(120);
	});
});
