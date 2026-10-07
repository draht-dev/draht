import { KeybindingsManager, setKeybindings, type TUI } from "@draht/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import { toRunResult } from "../../src/core/polyphase/child-events.ts";
import { buildDetails } from "../../src/core/polyphase/details.ts";
import {
	createPolyphaseMessageRenderer,
	createSubagentRenderers,
	createWorkflowRenderers,
	type PolyphaseRenderDeps,
	type PolyphaseRowState,
	renderLegacySubagentResult,
	type SubagentCallArgs,
	type WorkflowCallArgs,
} from "../../src/core/polyphase/render/renderers.ts";
import { layoutRun, type RunLayoutOptions } from "../../src/core/polyphase/render/run-block.ts";
import type { AgentSnapshotRow, PhaseSnapshot, RunSnapshot } from "../../src/core/polyphase/render/snapshot.ts";
import { snapshotFromRun } from "../../src/core/polyphase/render/snapshot.ts";
import { PolyphaseStore } from "../../src/core/polyphase/store.ts";
import type { AgentStatus, PolyphaseDetails, TranscriptItem } from "../../src/core/polyphase/types.ts";
import { NO_UI_APPROVAL_SUFFIX } from "../../src/core/polyphase/types.ts";
import { createUpdatePump } from "../../src/core/polyphase/update-pump.ts";
import { keyText } from "../../src/modes/interactive/components/keybinding-hints.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { chainRun, largeRun, parallelRun, singleRun, workflowRun } from "./helpers/sample-runs.ts";
import {
	agentStart,
	assistantEnd,
	assistantStart,
	sessionHeader,
	textDelta,
	textEnd,
	textStart,
	thinkingDelta,
	thinkingStart,
} from "./helpers/wire.ts";

const NOW = 1_700_000_050_000;

function makeRow(
	overrides: Partial<AgentSnapshotRow> & { i: number; label: string; status: AgentStatus },
): AgentSnapshotRow {
	return {
		agentType: "worker",
		provider: "anthropic",
		modelId: "claude-sonnet-5",
		thinking: "high",
		modelSource: "inherited",
		modelConfirmed: true,
		turns: 1,
		toolCalls: 0,
		tokens: 0,
		cost: 0,
		blocked: 0,
		task: "do work",
		...overrides,
	};
}

function countsFrom(agents: readonly AgentSnapshotRow[]): Record<AgentStatus, number> {
	const counts: Record<AgentStatus, number> = {
		pending: 0,
		queued: 0,
		starting: 0,
		running: 0,
		done: 0,
		failed: 0,
		cancelled: 0,
		skipped: 0,
	};
	for (const agent of agents) counts[agent.status]++;
	return counts;
}

function makeSnapshot(overrides: Partial<RunSnapshot> & { agents: AgentSnapshotRow[] }): RunSnapshot {
	return {
		runId: "run-1",
		kind: "subagent",
		origin: "tool",
		mode: "parallel",
		title: "review the diff",
		status: "running",
		live: true,
		startedAt: 0,
		elapsedMs: 42_000,
		tokens: 0,
		cost: 0,
		phases: [],
		log: [],
		blockedToolCalls: 0,
		version: 1,
		...overrides,
		counts: overrides.counts ?? countsFrom(overrides.agents),
	};
}

function opts(overrides: Partial<RunLayoutOptions> = {}): RunLayoutOptions {
	return { expanded: false, partial: true, focus: true, maxLines: 12, hints: true, now: NOW, ...overrides };
}

function makeContext<TArgs>(
	overrides: Partial<ToolRenderContext<PolyphaseRowState, TArgs>> = {},
): ToolRenderContext<PolyphaseRowState, TArgs> {
	return {
		args: {} as TArgs,
		toolCallId: "tool-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		...overrides,
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

const noStoreDeps: PolyphaseRenderDeps = { getStore: () => undefined, viewportRows: () => 24, now: () => NOW };

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager(KEYBINDINGS));
});

describe("layoutRun fragments (§11.4)", () => {
	it("parallel partial collapsed shows agent labels, model/thinking, and slots-busy", () => {
		const agents: AgentSnapshotRow[] = [
			makeRow({
				i: 0,
				label: "investigator",
				status: "done",
				statusLine: "STATUS: DONE — 3 candidate files",
				elapsedMs: 31_000,
			}),
			makeRow({
				i: 1,
				label: "reviewer#1",
				status: "running",
				now: "thinking · checking the diff",
				elapsedMs: 12_000,
			}),
			makeRow({ i: 2, label: "reviewer#2", status: "queued" }),
		];
		const snapshot = makeSnapshot({ agents, limiter: { capacity: 4, active: 4, queued: 1 } });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain("reviewer#1");
		expect(text).toContain("reviewer#2");
		expect(text).toContain("claude-sonnet-5 high");
		expect(text).toContain("4/4 slots busy");
	});

	it("expanded agent block shows the model source", () => {
		const agents = [makeRow({ i: 0, label: "reviewer#1", status: "running", elapsedMs: 12_000 })];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ expanded: true })).join("\n"));
		expect(text).toContain("(inherited)");
	});

	it("a blocked tool call always shows the fixed approval wording, never the raw gate reason", () => {
		const blockedItem: TranscriptItem = {
			kind: "tool",
			seq: 1,
			rev: 1,
			toolCallId: "call-2",
			name: "bash",
			summary: "npm test -- auth",
			status: "blocked",
			blockedReason: `no rule matched; bash commands require approval by default ${NO_UI_APPROVAL_SUFFIX}`,
		};
		const agents = [makeRow({ i: 0, label: "reviewer#1", status: "running", tail: [blockedItem] })];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ expanded: true })).join("\n"));
		expect(text).toContain("⚠");
		expect(text).toContain("blocked: needs approval (subagents cannot ask)");
		expect(text).not.toContain("no rule matched");
	});

	it("a queued agent row reads 'queued'", () => {
		const agents = [makeRow({ i: 0, label: "reviewer#2", status: "queued" })];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain("queued");
	});

	it("a pending chain step waits for the running step", () => {
		const agents = [
			makeRow({ i: 0, label: "step 1", status: "done", step: 1 }),
			makeRow({ i: 1, label: "step 2", status: "running", step: 2, elapsedMs: 34_000 }),
			makeRow({ i: 2, label: "step 3", status: "pending", step: 3 }),
		];
		const snapshot = makeSnapshot({ agents, mode: "chain" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain("waits for step 2");
	});

	it("a skipped chain step reads 'not run'", () => {
		const agents = [
			makeRow({ i: 0, label: "step 1", status: "failed", step: 1, error: "patch failed" }),
			makeRow({ i: 1, label: "step 2", status: "skipped", step: 2 }),
		];
		const snapshot = makeSnapshot({ agents, mode: "chain", status: "failed" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("not run");
	});

	it("a workflow phase tally shows done/total", () => {
		const agents = [
			makeRow({ i: 0, label: "api#1", status: "done", phase: 0 }),
			makeRow({ i: 1, label: "api#2", status: "running", phase: 0 }),
			makeRow({ i: 2, label: "ui#1", status: "running", phase: 0 }),
			makeRow({ i: 3, label: "ui#2", status: "queued", phase: 0 }),
		];
		const phases: PhaseSnapshot[] = [
			{ index: 0, title: "Review", dynamic: false, status: "running", agentIdx: [0, 1, 2, 3], done: 1, total: 4 },
		];
		const snapshot = makeSnapshot({ agents, kind: "workflow", mode: undefined, phases, currentPhase: 0 });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain("1/4");
	});

	it("a running workflow shows the last narrator log line prefixed with »", () => {
		const snapshot = makeSnapshot({
			agents: [],
			kind: "workflow",
			mode: undefined,
			phases: [],
			log: ["16 findings so far"],
		});
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain("»");
		expect(text).toContain("16 findings so far");
	});

	it("a finished workflow shows the result preview with →", () => {
		const snapshot = makeSnapshot({
			agents: [],
			kind: "workflow",
			mode: undefined,
			phases: [],
			status: "done",
			resultPreview: '{"verdict":"changes-requested"}',
		});
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false, focus: true })).join("\n"));
		expect(text).toContain("→");
		expect(text).toContain("changes-requested");
	});

	it("a long final output shows the omitted-lines marker", () => {
		const output = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
		const agents = [makeRow({ i: 0, label: "investigator", status: "done", output, elapsedMs: 31_000 })];
		const snapshot = makeSnapshot({ agents, mode: "single" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false, expanded: true })).join("\n"));
		expect(text).toMatch(/… \d+ lines omitted …/);
	});

	it("the hint line uses the configured keybindings", () => {
		const snapshot = makeSnapshot({ agents: [] });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain(keyText("app.polyphase.inspector"));
		expect(text).toContain(keyText("app.tools.expand"));
	});

	it("a non-focus partial row shows no elapsed or now text", () => {
		const agents = [
			makeRow({ i: 0, label: "reviewer#1", status: "running", now: "thinking · something", elapsedMs: 12_000 }),
		];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ focus: false })).join("\n"));
		expect(text).not.toContain("thinking · something");
		expect(text).not.toContain("0:12");
		expect(text).toContain("live view on the newest run");
	});
});

describe("renderCall/renderResult wiring", () => {
	it("a resumed row's renderCall shows only the title line", () => {
		const { renderCall, renderResult } = createSubagentRenderers(noStoreDeps);
		const toolDefinition = { renderCall, renderResult, renderShell: "default" as const };
		const component = new ToolExecutionComponent(
			"subagent",
			"resumed-1",
			{ agent: "reviewer", task: "review the diff" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const details: PolyphaseDetails = {
			v: 1,
			runId: "resumed-1",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent reviewer",
			status: "done",
			startedAt: 0,
			endedAt: 1000,
			agents: [
				{
					i: 0,
					label: "reviewer",
					agent: "reviewer",
					status: "done",
					task: "review the diff",
					output: "STATUS: DONE",
				},
			],
			totals: { agents: 1, tokens: 0, cost: 0, byStatus: { done: 1 }, blockedToolCalls: 0 },
		};
		component.updateResult({ content: [{ type: "text", text: "STATUS: DONE" }], details, isError: false }, false);

		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("subagent reviewer");
		expect(text).not.toContain("(reviewer)");
	});

	it("a resumed legacy row (old session, details={}) still shows the call preview with its task text", () => {
		const { renderCall, renderResult } = createSubagentRenderers(noStoreDeps);
		const toolDefinition = { renderCall, renderResult, renderShell: "default" as const };
		const component = new ToolExecutionComponent(
			"subagent",
			"resumed-legacy-1",
			{ agent: "reviewer", task: "review the diff" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult({ content: [{ type: "text", text: "STATUS: DONE" }], details: {}, isError: false }, false);

		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("review the diff");
		expect(text).toContain("(reviewer)");
	});

	it("falls back to the legacy renderer for details={}", () => {
		const { renderResult } = createSubagentRenderers(noStoreDeps);
		const context = makeContext<SubagentCallArgs>();
		const component = renderResult(
			{ content: [{ type: "text", text: "hello" }], details: {}, isError: false },
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("hello");
	});

	it("falls back to the legacy renderer for details={status}", () => {
		const { renderResult } = createSubagentRenderers(noStoreDeps);
		const context = makeContext<SubagentCallArgs>();
		const component = renderResult(
			{ content: [{ type: "text", text: "hello" }], details: { status: "reviewer: working..." }, isError: false },
			{ expanded: false, isPartial: true },
			theme,
			context,
		);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("reviewer: working...");
	});

	it("renderLegacySubagentResult is reused directly for details missing the shared shape", () => {
		const component = renderLegacySubagentResult(
			{ content: [{ type: "text", text: "a\nb\nc" }], details: undefined, isError: false },
			{ expanded: true, isPartial: false },
			theme,
		);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("a");
		expect(text).toContain("c");
	});

	it("the workflow call preview shows a streaming placeholder before meta parses", () => {
		const { renderCall } = createWorkflowRenderers(noStoreDeps);
		const context = makeContext<WorkflowCallArgs>();
		const component = renderCall({ script: "export const policy = {\nfoo: 1,\n" }, theme, context);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toMatch(/writing script… \d+ lines/);
	});

	it("the workflow call preview shows phases once meta parses", () => {
		const { renderCall } = createWorkflowRenderers(noStoreDeps);
		const context = makeContext<WorkflowCallArgs>();
		const script = [
			"export const meta = {",
			'  name: "review-pr",',
			'  description: "Review a change",',
			'  phases: [{ title: "Scan" }, { title: "Review" }, { title: "Synthesize" }],',
			"};",
		].join("\n");
		const component = renderCall({ script, args: "#1234" }, theme, context);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("review-pr");
		expect(text).toContain("Scan");
	});

	it("caches the call preview by args identity, re-scanning the script only when args changes", () => {
		const { renderCall } = createWorkflowRenderers(noStoreDeps);
		const context = makeContext<WorkflowCallArgs>();
		let scriptReads = 0;
		const scriptText = ["export const meta = {", '  name: "review-pr",', '  phases: [{ title: "Scan" }],', "};"].join(
			"\n",
		);
		const args: WorkflowCallArgs = {
			get script() {
				scriptReads++;
				return scriptText;
			},
		};

		context.lastComponent = renderCall(args, theme, context);
		context.lastComponent.render(80);
		const readsAfterFirstRender = scriptReads;
		expect(readsAfterFirstRender).toBeGreaterThan(0);

		context.lastComponent = renderCall(args, theme, context);
		context.lastComponent.render(40);
		context.lastComponent = renderCall(args, theme, context);
		context.lastComponent.render(120);
		expect(scriptReads).toBe(readsAfterFirstRender);

		const args2: WorkflowCallArgs = {
			get script() {
				scriptReads++;
				return scriptText;
			},
		};
		context.lastComponent = renderCall(args2, theme, context);
		context.lastComponent.render(80);
		expect(scriptReads).toBeGreaterThan(readsAfterFirstRender);
	});

	it("renders a polyphase-workflow custom message with the ▶ prefix", () => {
		const renderer = createPolyphaseMessageRenderer();
		const details: PolyphaseDetails = {
			v: 1,
			runId: "run-cmd",
			kind: "workflow",
			origin: "command",
			title: "/release v1.2.3",
			status: "done",
			startedAt: 0,
			endedAt: 1000,
			workflow: { name: "release", description: "Ship a release", source: "project", args: "v1.2.3" },
			agents: [],
			totals: { agents: 0, tokens: 0, cost: 0, byStatus: {}, blockedToolCalls: 0 },
		};
		const message: CustomMessage<PolyphaseDetails> = {
			role: "custom",
			customType: "polyphase-workflow",
			content: "",
			display: true,
			details,
			timestamp: Date.now(),
		};
		const component = renderer(message, { expanded: false, outputPad: 0 }, theme);
		expect(component).toBeDefined();
		const text = stripAnsi(component?.render(80).join("\n") ?? "");
		expect(text).toContain("▶");
		expect(text).toContain("/release");
	});
});

function runningAgentsWithBigBlocks(n: number): AgentSnapshotRow[] {
	return Array.from({ length: n }, (_, i) =>
		makeRow({
			i,
			label: `agent#${i}`,
			status: "running",
			elapsedMs: 5_000,
			tools: { read: 3, grep: 2 },
			tail: [
				{
					kind: "thinking",
					seq: 1,
					rev: 1,
					text: "thinking about this for a while",
					droppedChars: 0,
					done: false,
					redacted: false,
				},
				{
					kind: "tool",
					seq: 2,
					rev: 2,
					toolCallId: `c${i}`,
					name: "bash",
					summary: "run tests",
					status: "ok",
					startedAt: 0,
					endedAt: 500,
				},
			],
		}),
	);
}

function doneAgentsWithLongOutput(n: number): AgentSnapshotRow[] {
	const output = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
	return Array.from({ length: n }, (_, i) =>
		makeRow({ i, label: `agent#${i}`, status: "done", elapsedMs: 5_000, output, tools: { read: 3 } }),
	);
}

describe("maxLines bounds the row budget, not the agent count (§11.2.3, §20.4)", () => {
	it("parallel, expanded, partial: many agents with tail content stay within maxLines", () => {
		const snapshot = makeSnapshot({ agents: runningAgentsWithBigBlocks(20) });
		const lines = layoutRun(snapshot, 78, theme, opts({ expanded: true, maxLines: 12 }));
		expect(lines.length).toBeLessThanOrEqual(12 + 2);
		expect(stripAnsi(lines.join("\n"))).toContain("more");
	});

	it("parallel, expanded, final: many agents with long output stay within maxLines", () => {
		const snapshot = makeSnapshot({ agents: doneAgentsWithLongOutput(20), status: "done" });
		const lines = layoutRun(snapshot, 78, theme, opts({ expanded: true, partial: false, maxLines: 12 }));
		expect(lines.length).toBeLessThanOrEqual(12 + 2);
	});

	it("workflow, expanded, partial: every phase's agents stay within maxLines", () => {
		const agents = runningAgentsWithBigBlocks(20).map((row, i) => ({ ...row, phase: i % 3 }));
		const phases: PhaseSnapshot[] = [
			{ index: 0, title: "Scan", dynamic: false, status: "running", agentIdx: [], done: 0, total: 7 },
			{ index: 1, title: "Review", dynamic: false, status: "running", agentIdx: [], done: 0, total: 7 },
			{ index: 2, title: "Synthesize", dynamic: false, status: "pending", agentIdx: [], done: 0, total: 6 },
		];
		const snapshot = makeSnapshot({ agents, kind: "workflow", mode: undefined, phases, currentPhase: 0 });
		const lines = layoutRun(snapshot, 78, theme, opts({ expanded: true, maxLines: 12 }));
		expect(lines.length).toBeLessThanOrEqual(12 + 2);
	});

	it("parallel, expanded, partial: a done agent's long output does not crowd out the other agents' rows", () => {
		const longOutput = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
		const agents = [
			makeRow({ i: 0, label: "investigator", status: "done", output: longOutput, elapsedMs: 31_000 }),
			makeRow({ i: 1, label: "reviewer#1", status: "running", now: "thinking · checking", elapsedMs: 12_000 }),
			makeRow({ i: 2, label: "reviewer#2", status: "running", now: "writing · draft", elapsedMs: 8_000 }),
		];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ expanded: true, maxLines: 12 })).join("\n"));
		expect(text).toContain("investigator");
		expect(text).toContain("reviewer#1");
		expect(text).toContain("reviewer#2");
	});
});

describe("workflow final summary (§11.4 alternatives)", () => {
	function workflowSnapshot(overrides: Partial<RunSnapshot>): RunSnapshot {
		return makeSnapshot({
			agents: [],
			kind: "workflow",
			mode: undefined,
			phases: [],
			status: "done",
			...overrides,
		});
	}

	it("a script-error failure shows the error, not a green done", () => {
		const snapshot = workflowSnapshot({ status: "failed", error: "script error at line 14: TypeError" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("script error at line 14");
		expect(text).not.toContain("✓ done");
	});

	it("a failure with no error message falls back to the k-of-N form", () => {
		const agents = [
			makeRow({ i: 0, label: "a", status: "done" }),
			makeRow({ i: 1, label: "b", status: "failed", error: "boom" }),
		];
		const snapshot = workflowSnapshot({ agents, status: "failed" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("1 of 2 succeeded");
		expect(text).toContain("1 failed");
	});

	it("a cancelled workflow reads 'cancelled by you after N agents'", () => {
		const agents = [makeRow({ i: 0, label: "a", status: "cancelled", cancelReason: "user" })];
		const snapshot = workflowSnapshot({ agents, status: "cancelled" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("cancelled by you after 1 agent");
		expect(text).not.toContain("✓ done");
	});

	it("a budget-exhausted run shows the budget summary with the cancelled-agent count", () => {
		const agents = [
			makeRow({ i: 0, label: "a", status: "cancelled", cancelReason: "budget" }),
			makeRow({ i: 1, label: "b", status: "cancelled", cancelReason: "budget" }),
		];
		const snapshot = workflowSnapshot({
			agents,
			status: "failed",
			budget: { totalTokens: 500_000, spentTokens: 503_000, exhausted: true },
		});
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("budget of 500k tokens reached");
		expect(text).toContain("2 agents cancelled");
	});

	it("a plain done run with one cancelled agent still shows the done glyph (workflow-specific)", () => {
		const agents = [
			makeRow({ i: 0, label: "a", status: "done" }),
			makeRow({ i: 1, label: "b", status: "cancelled", cancelReason: "user" }),
		];
		const snapshot = workflowSnapshot({ agents, status: "done" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("done · 2 agents · 1 ok · 1 cancelled");
	});
});

describe("static non-focus rows render content that is stable until a status transition (§11.2.2)", () => {
	it("a non-focus parallel row ignores turns/tools/tail changes", () => {
		const before = makeSnapshot({
			agents: [makeRow({ i: 0, label: "reviewer#1", status: "running", turns: 1, tools: { read: 1 }, blocked: 0 })],
		});
		const after = makeSnapshot({
			agents: [
				makeRow({
					i: 0,
					label: "reviewer#1",
					status: "running",
					turns: 4,
					tools: { read: 9, bash: 2 },
					blocked: 1,
					blockedSample: "bash: npm test",
				}),
			],
		});
		const textBefore = layoutRun(before, 78, theme, opts({ focus: false, expanded: true }));
		const textAfter = layoutRun(after, 78, theme, opts({ focus: false, expanded: true }));
		expect(textAfter).toEqual(textBefore);
	});

	it("a non-focus workflow row suppresses the narrator line", () => {
		const snapshot = makeSnapshot({
			agents: [],
			kind: "workflow",
			mode: undefined,
			phases: [],
			log: ["something happened"],
		});
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ focus: false })).join("\n"));
		expect(text).not.toContain("something happened");
		expect(text).not.toContain("»");
	});
});

describe("collapsed rows share one label column width (§11.3)", () => {
	it("short and long labels line up at the same model column", () => {
		const agents = [
			makeRow({ i: 0, label: "rev#0", status: "done" }),
			makeRow({ i: 1, label: "investigator", status: "done" }),
		];
		const snapshot = makeSnapshot({ agents });
		const lines = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n")).split("\n");
		const shortLine = lines.find((l) => l.includes("rev#0"));
		const longLine = lines.find((l) => l.includes("investigator"));
		expect(shortLine).toBeDefined();
		expect(longLine).toBeDefined();
		expect(shortLine?.indexOf("claude-sonnet-5")).toBe(longLine?.indexOf("claude-sonnet-5"));
	});
});

describe("expanded tools line (§11.3)", () => {
	it("always shows the blocked sample when row.blocked > 0, even without tool counts", () => {
		const agents = [
			makeRow({ i: 0, label: "reviewer#1", status: "running", blocked: 1, blockedSample: "bash: npm test" }),
		];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ expanded: true })).join("\n"));
		expect(text).toContain("⚠ 1 blocked (bash: npm test)");
	});
});

describe("hint line order (§11.4)", () => {
	it("partial rows show the inspector hint first", () => {
		const snapshot = makeSnapshot({ agents: [] });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text.indexOf(keyText("app.polyphase.inspector"))).toBeLessThan(text.indexOf(keyText("app.tools.expand")));
	});

	it("final rows show the expand hint first", () => {
		const snapshot = makeSnapshot({ agents: [], status: "done" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text.indexOf(keyText("app.tools.expand"))).toBeLessThan(text.indexOf(keyText("app.polyphase.inspector")));
	});
});

describe("chain overflow reports done/queued among the omitted steps", () => {
	it("counts only the steps that did not fit", () => {
		const agents = Array.from({ length: 10 }, (_, i) =>
			makeRow({
				i,
				label: `step ${i + 1}`,
				status: i < 2 ? "done" : i === 2 ? "running" : i < 6 ? "queued" : "pending",
				step: i + 1,
			}),
		);
		const snapshot = makeSnapshot({ agents, mode: "chain" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ maxLines: 3 })).join("\n"));
		expect(text).toMatch(/… \+\d+ more \(\d+ done, \d+ queued\)/);
		expect(text).not.toContain("(0 done)");
	});
});

describe("failed-row text (§11.3)", () => {
	it("shows the raw error without an invented 'exit 1 ·' prefix", () => {
		const agents = [
			makeRow({ i: 0, label: "reviewer#1", status: "failed", error: "429 rate limited after 3 retries" }),
		];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain("429 rate limited after 3 retries");
		expect(text).not.toContain("exit 1");
	});
});

describe("cancelled-by-you wording (§11.3)", () => {
	it("a budget cancel does not claim it was cancelled by the user", () => {
		const agents = [makeRow({ i: 0, label: "reviewer#1", status: "cancelled", cancelReason: "budget" })];
		const snapshot = makeSnapshot({ agents, status: "cancelled" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("cancelled after 1 agent");
		expect(text).not.toContain("cancelled by you");
	});

	it("a user cancel says 'cancelled by you'", () => {
		const agents = [makeRow({ i: 0, label: "reviewer#1", status: "cancelled", cancelReason: "user" })];
		const snapshot = makeSnapshot({ agents, status: "cancelled" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("cancelled by you after 1 agent");
	});
});

describe("final/archived summaries account for agentsOmitted (§11.3)", () => {
	it("a parallel run's total includes agents dropped from a degraded archived snapshot", () => {
		const agents = [makeRow({ i: 0, label: "a", status: "done" })];
		const snapshot = makeSnapshot({
			agents,
			status: "done",
			agentsOmitted: { count: 49, byStatus: { done: 49 } },
			counts: { pending: 0, queued: 0, starting: 0, running: 0, done: 50, failed: 0, cancelled: 0, skipped: 0 },
		});
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("50/50 succeeded");
		expect(text).toContain("49 agents omitted");
	});

	it("a workflow phase tally marks itself incomplete instead of claiming 'ok'", () => {
		const agents = [makeRow({ i: 0, label: "a", status: "done", phase: 0 })];
		const phases: PhaseSnapshot[] = [
			{
				index: 0,
				title: "Review",
				dynamic: false,
				status: "done",
				agentIdx: [0],
				done: 1,
				total: 1,
				incomplete: true,
			},
		];
		const snapshot = makeSnapshot({
			agents,
			kind: "workflow",
			mode: undefined,
			status: "done",
			phases,
			agentsOmitted: { count: 39, byStatus: { done: 39 } },
			counts: { pending: 0, queued: 0, starting: 0, running: 0, done: 40, failed: 0, cancelled: 0, skipped: 0 },
		});
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n"));
		expect(text).toContain("1/1+");
		expect(text).not.toContain("1/1 ok");
	});
});

describe("chain current step counts queued/pending agents (§11.3)", () => {
	it("a queued current step counts as the current step, not 'step N of N'", () => {
		const agents = [
			makeRow({ i: 0, label: "step 1", status: "done", step: 1 }),
			makeRow({ i: 1, label: "step 2", status: "queued", step: 2 }),
			makeRow({ i: 2, label: "step 3", status: "pending", step: 3 }),
		];
		const snapshot = makeSnapshot({ agents, mode: "chain" });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts()).join("\n"));
		expect(text).toContain("step 2 of 3");
		expect(text).toContain("waits for step 2");
		expect(text).not.toContain("step 3 of 3");
	});
});

describe("the workflow phase tree never drops the active phase (§11.3)", () => {
	it("keeps the active phase and its running agent when there are more phases than maxLines", () => {
		const phases: PhaseSnapshot[] = Array.from({ length: 16 }, (_, i) => ({
			index: i,
			title: `P${i}`,
			dynamic: false,
			status: i < 15 ? "done" : "running",
			agentIdx: [],
			done: i < 15 ? 1 : 0,
			total: 1,
		}));
		const agents = [
			...Array.from({ length: 15 }, (_, i) => makeRow({ i, label: `p${i}-agent`, status: "done", phase: i })),
			makeRow({ i: 15, label: "p15-agent", status: "running", phase: 15 }),
		];
		const snapshot = makeSnapshot({ agents, kind: "workflow", mode: undefined, phases, currentPhase: 15 });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ maxLines: 12 })).join("\n"));
		expect(text).toContain("P15");
		expect(text).toContain("p15-agent");
		expect(text).toMatch(/\+\d+ phases?/);
	});

	it("never overruns maxLines when the sequential pass reaches the active phase with only one line left", () => {
		const phases: PhaseSnapshot[] = Array.from({ length: 12 }, (_, i) => ({
			index: i,
			title: `P${i}`,
			dynamic: false,
			status: i < 11 ? "done" : "running",
			agentIdx: [],
			done: i < 11 ? 1 : 0,
			total: i < 11 ? 1 : 6,
		}));
		const agents = [
			...Array.from({ length: 11 }, (_, i) => makeRow({ i, label: `p${i}-agent`, status: "done", phase: i })),
			...Array.from({ length: 6 }, (_, i) => makeRow({ i: 11 + i, label: `run${i}`, status: "running", phase: 11 })),
		];
		const snapshot = makeSnapshot({ agents, kind: "workflow", mode: undefined, phases, currentPhase: 11 });
		const lines = stripAnsi(layoutRun(snapshot, 60, theme, opts({ maxLines: 12, hints: false })).join("\n")).split(
			"\n",
		);
		// `lines[0]` is the workflow summary line, which is not counted against `maxLines` (§11.2.3).
		const phaseTreeLines = lines.slice(1);
		expect(phaseTreeLines.length).toBeLessThanOrEqual(12);
		const hasActiveAgentLine = phaseTreeLines.some((line) => line.includes("run0"));
		const hasOverflowMarker = phaseTreeLines.some((line) => /\+\d+ more/.test(line));
		expect(hasActiveAgentLine || hasOverflowMarker).toBe(true);
	});
});

describe("a dangling separator never appears for an empty model label (§11.3)", () => {
	function noModelRow(overrides: Partial<AgentSnapshotRow> & { i: number; label: string; status: AgentStatus }) {
		return makeRow({
			provider: undefined,
			modelId: undefined,
			thinking: undefined,
			modelSource: undefined,
			turns: 0,
			...overrides,
		});
	}

	it("a single collapsed row with no model info has no trailing ' · '", () => {
		const agents = [noModelRow({ i: 0, label: "reviewer#1", status: "done" })];
		const snapshot = makeSnapshot({ agents, mode: "single" });
		const headerLine = stripAnsi(layoutRun(snapshot, 78, theme, opts({ partial: false })).join("\n")).split("\n")[0];
		expect(headerLine.trimEnd().endsWith("·")).toBe(false);
		expect(headerLine).not.toContain("· ·");
	});

	it("an expanded agent block with no model info has no trailing ' · '", () => {
		const agents = [noModelRow({ i: 0, label: "reviewer#1", status: "done" })];
		const snapshot = makeSnapshot({ agents });
		const text = stripAnsi(layoutRun(snapshot, 78, theme, opts({ expanded: true })).join("\n"));
		const headerLine = text.split("\n").find((line) => line.includes("reviewer#1"));
		expect(headerLine).toBeDefined();
		expect(headerLine?.trimEnd().endsWith("·")).toBe(false);
		expect(headerLine).not.toContain("· ·");
	});
});

describe("child-supplied text is sanitized before layout (§0 width safety)", () => {
	it("strips tabs, CR and ANSI from output/error/task so no rendered line carries them", () => {
		const agents = [
			makeRow({
				i: 0,
				label: "investigator",
				status: "failed",
				task: "line one\tcol\rtwo",
				error: "boom\t\x1b[31mred\x1b[0m\r",
			}),
		];
		const snapshot = makeSnapshot({ agents, mode: "single" });
		for (const width of [20, 40, 80]) {
			const lines = layoutRun(snapshot, width, theme, opts({ expanded: true, partial: false }));
			for (const line of lines) {
				expect(line).not.toContain("\t");
				expect(line).not.toContain("\r");
			}
		}
		const text = layoutRun(snapshot, 80, theme, opts({ expanded: true, partial: false })).join("\n");
		expect(stripAnsi(text)).toContain("boom");
		expect(stripAnsi(text)).not.toContain("\x1b[31m");
	});

	it("strips tabs and ANSI from a tool tail item's summary", () => {
		const blockedItem: TranscriptItem = {
			kind: "tool",
			seq: 1,
			rev: 1,
			toolCallId: "call-3",
			name: "bash",
			summary: "npm\ttest\x1b[32m -- auth\x1b[0m",
			status: "ok",
			startedAt: 0,
			endedAt: 100,
		};
		const agents = [makeRow({ i: 0, label: "reviewer#1", status: "running", tail: [blockedItem] })];
		const snapshot = makeSnapshot({ agents });
		const lines = layoutRun(snapshot, 40, theme, opts({ expanded: true }));
		for (const line of lines) {
			expect(line).not.toContain("\t");
		}
	});
});

describe("ToolExecutionComponent driven by sample runs (§11.4)", () => {
	it("parallel run, partial, focus: renders the live store's agent rows", () => {
		const sample = parallelRun();
		const deps: PolyphaseRenderDeps = { getStore: () => sample.store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const component = new ToolExecutionComponent(
			"subagent",
			sample.run.id,
			{ tasks: [] },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("reviewer#1");
		expect(text).toContain("reviewer#2");
		sample.dispose();
	});

	it("parallel run, partial, focus, expanded: shows the model source only when expanded", () => {
		const sample = parallelRun();
		const deps: PolyphaseRenderDeps = { getStore: () => sample.store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const component = new ToolExecutionComponent(
			"subagent",
			sample.run.id,
			{ tasks: [] },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const collapsed = stripAnsi(component.render(80).join("\n"));
		expect(collapsed).not.toContain("(inherited)");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("(inherited)");
		sample.dispose();
	});

	it("a non-focus parallel row renders static content that is stable across a fine change the focus row would show", () => {
		const pump = createUpdatePump({ intervalMs: 250 });
		const store = new PolyphaseStore({ pump, retainRuns: 20, now: () => NOW });
		const run = store.createRun({
			id: "run-static",
			kind: "subagent",
			origin: "tool",
			mode: "parallel",
			title: "review the diff",
			budgetTokens: null,
		});
		const reviewer = run.addAgent({
			label: "reviewer#1",
			agentType: "reviewer",
			task: "review for correctness",
			model: { source: "inherited", provider: "anthropic", id: "claude-sonnet-5", confirmed: true },
		});
		const ctx = reviewer.createRunContext();
		ctx.onStart?.({ pid: 1, argv: [] });
		for (const record of [
			sessionHeader(),
			agentStart(),
			assistantStart("anthropic", "claude-sonnet-5"),
			thinkingStart(0),
		]) {
			const change = reviewer.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		}
		pump.flushNow();

		const focusRun = store.createRun({
			id: "run-newer",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent other",
			budgetTokens: null,
		});
		expect(store.focusRunId()).toBe(focusRun.id);

		const deps: PolyphaseRenderDeps = { getStore: () => store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const component = new ToolExecutionComponent(
			"subagent",
			run.id,
			{ tasks: [] },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const before = stripAnsi(component.render(80).join("\n"));
		expect(before).toContain("live view on the newest run");

		const change = reviewer.reducer.apply(thinkingDelta(0, "checking the diff for edge cases"));
		if (change !== "none") ctx.onChange?.(change);
		pump.flushNow();
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const after = stripAnsi(component.render(80).join("\n"));
		expect(after).toBe(before);
		expect(after).not.toContain("checking the diff for edge cases");

		// The same fine change, rendered focused, does show up: the static row above is really
		// stable despite the change, not stable because the renderer never saw it.
		const focusedSnapshot = snapshotFromRun(run, { now: NOW, tailItems: 4 });
		const focusedText = stripAnsi(
			layoutRun(focusedSnapshot, 78, theme, opts({ focus: true, expanded: true })).join("\n"),
		);
		expect(focusedText).toContain("checking the diff for edge cases");

		store.dispose();
	});

	it("chain run, final (failed): shows the real error, not an invented exit code", () => {
		const sample = chainRun({ failed: true });
		const deps: PolyphaseRenderDeps = { getStore: () => sample.store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const component = new ToolExecutionComponent(
			"subagent",
			sample.run.id,
			{ chain: [] },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		const details = buildDetails(sample.run, { final: true });
		component.updateResult({ content: [], details, isError: true }, false);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("failed at step 1 of 2");
		expect(text).toContain("patch failed");
		expect(text).not.toContain("exit 1");
		sample.dispose();
	});

	it("single run, final (done): shows the turn count on the collapsed header", () => {
		const sample = singleRun({ final: true });
		const deps: PolyphaseRenderDeps = { getStore: () => sample.store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const component = new ToolExecutionComponent(
			"subagent",
			sample.run.id,
			{ agent: "investigator" },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		const details = buildDetails(sample.run, { final: true });
		component.updateResult({ content: [], details, isError: false }, false);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toMatch(/\d+ turns?/);
		sample.dispose();
	});

	it("workflow run, partial, focus: renders the phase tree and narrator log from the live store", () => {
		// `workflowRun()` builds an `origin: "command"` run (never the tool-row focus, by design:
		// `focusRunId()` only considers `origin: "tool"`). The live `workflow` tool renderer is only
		// ever wired to a tool-origin run, so build one directly here.
		const pump = createUpdatePump({ intervalMs: 250 });
		const store = new PolyphaseStore({ pump, retainRuns: 20, now: () => NOW });
		const run = store.createRun({
			id: "run-workflow-tool",
			kind: "workflow",
			origin: "tool",
			title: "workflow release-pr",
			workflow: {
				name: "release-pr",
				description: "Ship a release",
				source: "project",
				path: "release-pr.js",
				args: "",
			},
			phases: [{ title: "plan" }, { title: "implement" }],
			budgetTokens: null,
		});
		run.enterPhase("plan");
		const planner = run.addAgent({
			label: "planner",
			agentType: "planner",
			task: "plan the release",
			phase: 0,
			model: { source: "inherited", provider: "anthropic", id: "claude-sonnet-5", confirmed: true },
		});
		planner.createRunContext().onStart?.({ pid: 1, argv: [] });
		run.appendLog("planning the release");

		const deps: PolyphaseRenderDeps = { getStore: () => store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createWorkflowRenderers(deps);
		const component = new ToolExecutionComponent(
			"workflow",
			run.id,
			{ name: "release-pr" },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("plan");
		expect(text).toContain("implement");
		expect(text).toContain("planning the release");
		store.dispose();
	});

	it("workflow run with agents started before any phase() call still shows their rows", () => {
		const pump = createUpdatePump({ intervalMs: 250 });
		const store = new PolyphaseStore({ pump, retainRuns: 20, now: () => NOW });
		const run = store.createRun({
			id: "run-workflow-unphased",
			kind: "workflow",
			origin: "tool",
			title: "workflow scan",
			workflow: { name: "scan", description: "Scan the repo", source: "inline", args: "" },
			phases: [],
			budgetTokens: null,
		});
		const scanner = run.addAgent({
			label: "scanner",
			agentType: "scanner",
			task: "scan the repo for issues",
			model: { source: "inherited", provider: "anthropic", id: "claude-sonnet-5", confirmed: true },
		});
		scanner.createRunContext().onStart?.({ pid: 1, argv: [] });
		run.appendLog("hello");

		const deps: PolyphaseRenderDeps = { getStore: () => store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createWorkflowRenderers(deps);
		const component = new ToolExecutionComponent(
			"workflow",
			run.id,
			{ name: "scan" },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("scanner");
		store.dispose();
	});

	it("largeRun overflow: a run with more agents than maxLines shows the overflow marker", () => {
		const sample = largeRun(20);
		const deps: PolyphaseRenderDeps = { getStore: () => sample.store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const component = new ToolExecutionComponent(
			"subagent",
			sample.run.id,
			{ tasks: [] },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: {}, isError: false }, true);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("more");
		expect(text).toContain(keyText("app.polyphase.inspector"));
		sample.dispose();
	});

	it("single run, final, expanded: shows the omitted-lines marker for long output through renderResult", () => {
		const pump = createUpdatePump({ intervalMs: 250 });
		const store = new PolyphaseStore({ pump, retainRuns: 20, now: () => NOW });
		const run = store.createRun({
			id: "run-single-final-expanded",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent investigator",
			budgetTokens: null,
		});
		const agent = run.addAgent({
			label: "investigator",
			agentType: "investigator",
			task: "investigate the flake",
			model: { source: "inherited", provider: "anthropic", id: "claude-sonnet-5", confirmed: true },
		});
		const ctx = agent.createRunContext();
		ctx.onStart?.({ pid: 1, argv: [] });
		const longText = Array.from({ length: 15 }, (_, i) => `finding ${i}`).join("\n");
		for (const record of [
			sessionHeader(),
			agentStart(),
			assistantStart("anthropic", "claude-sonnet-5"),
			textStart(0),
			textDelta(0, longText),
			textEnd(0, longText),
			assistantEnd({ provider: "anthropic", model: "claude-sonnet-5", text: longText }),
		]) {
			const change = agent.reducer.apply(record);
			if (change !== "none") ctx.onChange?.(change);
		}
		const finish = agent.reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(agent.reducer.state, { agent: agent.agentType, task: agent.task }, finish, {
			cancelled: false,
			structured: agent.reducer.state.structured,
			durationMs: 1000,
		});
		ctx.onFinish?.(result);
		run.finish("done");

		const details = buildDetails(run, { final: true });
		const deps: PolyphaseRenderDeps = { getStore: () => store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createSubagentRenderers(deps);
		const component = new ToolExecutionComponent(
			"subagent",
			run.id,
			{ agent: "investigator" },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [], details, isError: false }, false);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toMatch(/… \d+ lines omitted …/);
		store.dispose();
	});

	it("workflow run, final: shows the result preview with → through renderResult", () => {
		const sample = workflowRun();
		sample.run.setResultPreview('{"verdict":"changes-requested"}');
		sample.finish("done");
		const details = buildDetails(sample.run, { final: true });
		const deps: PolyphaseRenderDeps = { getStore: () => sample.store, viewportRows: () => 24, now: () => NOW };
		const { renderCall, renderResult } = createWorkflowRenderers(deps);
		const component = new ToolExecutionComponent(
			"workflow",
			sample.run.id,
			{ name: "release" },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details, isError: false }, false);
		const text = stripAnsi(component.render(80).join("\n"));
		expect(text).toContain("→");
		expect(text).toContain("changes-requested");
		sample.dispose();
	});
});
