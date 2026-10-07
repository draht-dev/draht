import { KeybindingsManager, setKeybindings, visibleWidth } from "@draht/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolRenderContext } from "../../src/core/extensions/types.ts";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
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
import type { AgentStatus, PolyphaseDetails, TranscriptItem } from "../../src/core/polyphase/types.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";

const NOW = 1_700_000_050_000;
const LONG_MODEL_ID = `claude-${"x".repeat(96)}`;
const CJK_LABEL = "査読者・セキュリティレビュー担当者その一号機";
const EMOJI_LABEL = "reviewer 🎉🚀🔥🧪🎯 extra-long-label";
const LONG_OUTPUT = Array.from({ length: 15 }, (_, i) => `${CJK_LABEL} output line ${i} ${EMOJI_LABEL}`).join("\n");
const LONG_ERROR = `429 rate limited after 3 retries: ${EMOJI_LABEL} ${CJK_LABEL}`;
const LONG_TAIL: TranscriptItem[] = [
	{
		kind: "thinking",
		seq: 1,
		rev: 1,
		text: `${CJK_LABEL} ${EMOJI_LABEL} thinking at great length`,
		droppedChars: 0,
		done: false,
		redacted: false,
	},
	{
		kind: "tool",
		seq: 2,
		rev: 2,
		toolCallId: "call-width",
		name: "bash",
		summary: `npm test -- ${CJK_LABEL} ${EMOJI_LABEL}`,
		status: "ok",
		startedAt: 0,
		endedAt: 1234,
	},
];

function makeRow(
	overrides: Partial<AgentSnapshotRow> & { i: number; label: string; status: AgentStatus },
): AgentSnapshotRow {
	return {
		agentType: "worker",
		provider: "anthropic",
		modelId: LONG_MODEL_ID,
		thinking: "high",
		modelSource: "inherited",
		modelConfirmed: true,
		turns: 2,
		toolCalls: 3,
		tokens: 12_345,
		cost: 0.08,
		blocked: 0,
		task: "review the long running change across many files for correctness and style",
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
		title: CJK_LABEL,
		status: "running",
		live: true,
		startedAt: 0,
		elapsedMs: 42_000,
		tokens: 12_345,
		cost: 0.08,
		phases: [],
		log: ["a very long narrator line that keeps going well past most terminal widths indeed"],
		blockedToolCalls: 0,
		version: 1,
		...overrides,
		counts: overrides.counts ?? countsFrom(overrides.agents),
	};
}

const WIDTHS = [20, 30, 40, 60, 80, 120];

function parallelSnapshot(): RunSnapshot {
	return makeSnapshot({
		agents: [
			makeRow({ i: 0, label: CJK_LABEL, status: "done", statusLine: "STATUS: DONE — long output line goes here" }),
			makeRow({
				i: 1,
				label: EMOJI_LABEL,
				status: "running",
				now: "thinking · a long thought that keeps going",
				tail: LONG_TAIL,
			}),
			makeRow({ i: 2, label: "queued-agent", status: "queued" }),
			makeRow({
				i: 3,
				label: "failing-agent",
				status: "failed",
				error: LONG_ERROR,
				blocked: 1,
				blockedSample: `bash: npm test -- ${CJK_LABEL}`,
			}),
		],
		limiter: { capacity: 4, active: 4, queued: 1 },
	});
}

function parallelFinalSnapshot(): RunSnapshot {
	return makeSnapshot({
		status: "done",
		agents: [
			makeRow({ i: 0, label: CJK_LABEL, status: "done", output: LONG_OUTPUT }),
			makeRow({ i: 1, label: EMOJI_LABEL, status: "cancelled", cancelReason: "user" }),
			makeRow({ i: 2, label: "failing-agent", status: "failed", error: LONG_ERROR }),
		],
	});
}

function parallelOverflowSnapshot(): RunSnapshot {
	return makeSnapshot({
		agents: Array.from({ length: 20 }, (_, i) =>
			makeRow({ i, label: i % 2 === 0 ? `${CJK_LABEL}#${i}` : `${EMOJI_LABEL}#${i}`, status: "running" }),
		),
	});
}

function chainSnapshot(): RunSnapshot {
	return makeSnapshot({
		mode: "chain",
		agents: [
			makeRow({ i: 0, label: CJK_LABEL, status: "done", step: 1 }),
			makeRow({ i: 1, label: EMOJI_LABEL, status: "running", step: 2, tail: LONG_TAIL }),
			makeRow({ i: 2, label: "waits", status: "pending", step: 3 }),
		],
	});
}

function chainFinalFailedSnapshot(): RunSnapshot {
	return makeSnapshot({
		mode: "chain",
		status: "failed",
		agents: [
			makeRow({ i: 0, label: CJK_LABEL, status: "done", step: 1 }),
			makeRow({ i: 1, label: EMOJI_LABEL, status: "failed", step: 2, error: LONG_ERROR }),
			makeRow({ i: 2, label: "waits", status: "skipped", step: 3 }),
		],
	});
}

function singleSnapshot(): RunSnapshot {
	return makeSnapshot({
		mode: "single",
		agents: [makeRow({ i: 0, label: CJK_LABEL, status: "running", now: EMOJI_LABEL, tail: LONG_TAIL })],
	});
}

function singleFinalSnapshot(): RunSnapshot {
	return makeSnapshot({
		mode: "single",
		status: "done",
		agents: [makeRow({ i: 0, label: CJK_LABEL, status: "done", output: LONG_OUTPUT, error: LONG_ERROR })],
	});
}

function workflowSnapshot(): RunSnapshot {
	const agents = [
		makeRow({ i: 0, label: CJK_LABEL, status: "done", phase: 0 }),
		makeRow({ i: 1, label: EMOJI_LABEL, status: "running", phase: 0 }),
	];
	const phases: PhaseSnapshot[] = [
		{ index: 0, title: CJK_LABEL, dynamic: false, status: "running", agentIdx: [0, 1], done: 1, total: 2 },
	];
	return makeSnapshot({
		agents,
		kind: "workflow",
		mode: undefined,
		phases,
		currentPhase: 0,
		budget: { totalTokens: 500_000, spentTokens: 148_000, exhausted: false },
	});
}

function workflowFinalSnapshot(): RunSnapshot {
	const agents = [
		makeRow({ i: 0, label: CJK_LABEL, status: "done", phase: 0 }),
		makeRow({ i: 1, label: EMOJI_LABEL, status: "cancelled", phase: 0, cancelReason: "budget" }),
	];
	const phases: PhaseSnapshot[] = [
		{ index: 0, title: CJK_LABEL, dynamic: false, status: "done", agentIdx: [0, 1], done: 1, total: 2 },
	];
	return makeSnapshot({
		agents,
		kind: "workflow",
		mode: undefined,
		status: "failed",
		phases,
		budget: { totalTokens: 500_000, spentTokens: 503_000, exhausted: true },
		resultPreview: `{"verdict":"${CJK_LABEL}","notes":"${EMOJI_LABEL}"}`,
	});
}

function opts(overrides: Partial<RunLayoutOptions> = {}): RunLayoutOptions {
	return { expanded: false, partial: true, focus: true, maxLines: 12, hints: true, now: NOW, ...overrides };
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager(KEYBINDINGS));
});

describe("layoutRun never exceeds the requested width", () => {
	const cases: Array<[string, () => RunSnapshot]> = [
		["parallel", parallelSnapshot],
		["parallel final (output, cancelled, error)", parallelFinalSnapshot],
		["parallel overflow (20 agents)", parallelOverflowSnapshot],
		["chain", chainSnapshot],
		["chain final (failed)", chainFinalFailedSnapshot],
		["single", singleSnapshot],
		["single final (output, error)", singleFinalSnapshot],
		["workflow", workflowSnapshot],
		["workflow final (budget exhausted, resultPreview)", workflowFinalSnapshot],
	];

	for (const [name, buildSnapshot] of cases) {
		for (const width of WIDTHS) {
			for (const partial of [true, false]) {
				for (const expanded of [true, false]) {
					for (const focus of [true, false]) {
						it(`${name} at width ${width} (partial=${partial}, expanded=${expanded}, focus=${focus})`, () => {
							const snapshot = buildSnapshot();
							const lines = layoutRun(snapshot, width, theme, opts({ partial, expanded, focus }));
							for (const line of lines) {
								expect(visibleWidth(line)).toBeLessThanOrEqual(width);
							}
						});
					}
				}
			}
		}
	}
});

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

const noStoreDeps: PolyphaseRenderDeps = { getStore: () => undefined, viewportRows: () => 24, now: () => NOW };
const LONG_SCRIPT = Array.from({ length: 60 }, (_, i) => `// ${CJK_LABEL} ${EMOJI_LABEL} line ${i}`).join("\n");

describe("renderCall previews and the message/legacy renderers never exceed the requested width", () => {
	for (const width of WIDTHS) {
		it(`subagent call preview at width ${width}`, () => {
			const { renderCall } = createSubagentRenderers(noStoreDeps);
			const context = makeContext<SubagentCallArgs>();
			const component = renderCall(
				{
					tasks: [
						{
							agent: "reviewer",
							task: `review ${CJK_LABEL} ${EMOJI_LABEL}`,
							label: EMOJI_LABEL,
							model: LONG_MODEL_ID,
						},
					],
				},
				theme,
				context,
			);
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});

		it(`workflow call preview (expanded, 60-line script) at width ${width}`, () => {
			const { renderCall } = createWorkflowRenderers(noStoreDeps);
			const script = [
				"export const meta = {",
				`  name: "${CJK_LABEL}",`,
				`  description: "${EMOJI_LABEL}",`,
				'  phases: [{ title: "Scan" }, { title: "Review" }],',
				"};",
				LONG_SCRIPT,
			].join("\n");
			const context = makeContext<WorkflowCallArgs>({ expanded: true });
			const component = renderCall({ script, args: EMOJI_LABEL }, theme, context);
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});

		it(`polyphase-workflow message renderer at width ${width}`, () => {
			const renderer = createPolyphaseMessageRenderer();
			const details: PolyphaseDetails = {
				v: 1,
				runId: "run-cmd",
				kind: "workflow",
				origin: "command",
				title: `/release ${EMOJI_LABEL}`,
				status: "done",
				startedAt: 0,
				endedAt: 1000,
				workflow: { name: CJK_LABEL, description: EMOJI_LABEL, source: "project", args: EMOJI_LABEL },
				agents: [{ i: 0, label: CJK_LABEL, agent: "worker", status: "done", task: "do work", output: LONG_OUTPUT }],
				totals: { agents: 1, tokens: 0, cost: 0, byStatus: { done: 1 }, blockedToolCalls: 0 },
			};
			const message: CustomMessage<PolyphaseDetails> = {
				role: "custom",
				customType: "polyphase-workflow",
				content: "",
				display: true,
				details,
				timestamp: Date.now(),
			};
			const component = renderer(message, { expanded: true, outputPad: 0 }, theme);
			for (const line of component?.render(width) ?? []) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});

		it(`legacy subagent result renderer at width ${width}`, () => {
			const component = renderLegacySubagentResult(
				{
					content: [{ type: "text", text: `${LONG_OUTPUT}\n${EMOJI_LABEL} ${CJK_LABEL}` }],
					details: { status: `${CJK_LABEL} working… ${EMOJI_LABEL}` },
					isError: false,
				},
				{ expanded: true, isPartial: false },
				theme,
			);
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		});
	}
});

const TAB_CR_ANSI_OUTPUT = "func main() {\r\n\t\tif x {\n\t\t\treturn\n\t\t}\n\t}\n}\x1b[31mred\x1b[0m\rclobbered";
const TAB_CR_ANSI_ERROR = "exit 1\t\x1b[33mwarn:\x1b[0m\tretrying\r\n\t\tagain";
const TAB_CR_ANSI_SCRIPT = [
	"export const meta = {\r",
	'\tname: "review-pr",\x1b[32m\r',
	'\tphases: [{ title: "Scan" }],\r',
	"};\r",
].join("\n");
const TAB_CR_ANSI_PHASE_TITLE = "Re\tview\x1b[31mX\x1b[0m\r\nstage";
const TAB_CR_ANSI_RUN_ERROR = "script error\t\x1b[31mfailed\x1b[0m\r\nat line 14";

describe("tab/CR/ANSI inputs never widen a line or leak a raw tab/CR (§0 width safety)", () => {
	const widths = [20, 40, 80];

	for (const width of widths) {
		it(`agent output/error/task with tabs, CR and ANSI at width ${width}`, () => {
			const agents: AgentSnapshotRow[] = [
				makeRow({
					i: 0,
					label: "reviewer#1",
					status: "done",
					output: TAB_CR_ANSI_OUTPUT,
					task: "line one\tcol\rtwo",
				}),
				makeRow({ i: 1, label: "reviewer#2", status: "failed", error: TAB_CR_ANSI_ERROR }),
			];
			const snapshot = makeSnapshot({ agents, status: "done" });
			for (const expanded of [true, false]) {
				const lines = layoutRun(snapshot, width, theme, opts({ partial: false, expanded, focus: true }));
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(line).not.toContain("\t");
					expect(line).not.toContain("\r");
				}
			}
		});

		it(`workflow script preview with tabs, CR and ANSI at width ${width}`, () => {
			const { renderCall } = createWorkflowRenderers(noStoreDeps);
			const context = makeContext<WorkflowCallArgs>({ expanded: true });
			const component = renderCall({ script: TAB_CR_ANSI_SCRIPT }, theme, context);
			const lines = component.render(width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line).not.toContain("\t");
				expect(line).not.toContain("\r");
			}
		});

		it(`workflow phase title and run error with tabs, CR and ANSI at width ${width}`, () => {
			const agents: AgentSnapshotRow[] = [makeRow({ i: 0, label: "reviewer#1", status: "done", phase: 0 })];
			const phases: PhaseSnapshot[] = [
				{
					index: 0,
					title: TAB_CR_ANSI_PHASE_TITLE,
					dynamic: false,
					status: "done",
					agentIdx: [0],
					done: 1,
					total: 1,
				},
			];
			const snapshot = makeSnapshot({
				agents,
				kind: "workflow",
				mode: undefined,
				status: "failed",
				phases,
				error: TAB_CR_ANSI_RUN_ERROR,
			});
			for (const expanded of [true, false]) {
				const lines = layoutRun(snapshot, width, theme, opts({ partial: false, expanded, focus: true }));
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(line).not.toContain("\t");
					expect(line).not.toContain("\r");
				}
			}
		});
	}
});
