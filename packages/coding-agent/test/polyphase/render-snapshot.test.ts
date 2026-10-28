import { describe, expect, it } from "vitest";
import { createChildAgentState } from "../../src/core/polyphase/child-events.ts";
import { buildDetails } from "../../src/core/polyphase/details.ts";
import type { LimiterStats } from "../../src/core/polyphase/limiter.ts";
import { snapshotFromDetails, snapshotFromRun } from "../../src/core/polyphase/render/snapshot.ts";
import type {
	AgentModelInfo,
	AgentView,
	ChildAgentState,
	PolyphaseDetails,
	RunView,
} from "../../src/core/polyphase/types.ts";
import { applyWire } from "./helpers/run-views.ts";
import * as wire from "./helpers/wire.ts";

function stateFor(model: AgentModelInfo, overrides: Partial<ChildAgentState> = {}): ChildAgentState {
	return { ...createChildAgentState(model), ...overrides };
}

describe("snapshotFromRun and snapshotFromDetails agree", () => {
	function buildRun(): RunView {
		const agentA: AgentView = {
			key: "run-1#0",
			index: 0,
			label: "scan",
			agentType: "researcher",
			task: "scan the repo",
			phase: 0,
			status: "done",
			state: stateFor(
				{
					source: "inherited",
					provider: "anthropic",
					id: "claude-sonnet-5",
					thinkingLevel: "high",
					confirmed: true,
				},
				{
					turns: 2,
					toolCalls: 1,
					toolCounts: { bash: 1 },
					usage: wire.usage(100, 50, 0.01),
					finalText: "STATUS: DONE output",
					lifecycle: "exited",
				},
			),
			result: {
				agent: "researcher",
				task: "scan the repo",
				exitCode: 0,
				output: "STATUS: DONE output",
				stderr: "",
				usage: wire.usage(100, 50, 0.01),
				model: { provider: "anthropic", id: "claude-sonnet-5" },
				thinkingLevel: "high",
				turns: 2,
				toolCalls: 1,
				blockedToolCalls: 0,
			},
			createdAt: 0,
		};
		const agentB: AgentView = {
			key: "run-1#1",
			index: 1,
			label: "review#1",
			agentType: "reviewer",
			task: "review the diff",
			phase: 1,
			status: "running",
			state: stateFor({
				source: "inherited",
				provider: "anthropic",
				id: "claude-opus-5-5",
				requestedThinking: "high",
				confirmed: false,
			}),
			createdAt: 0,
		};
		return {
			id: "run-1",
			kind: "workflow",
			origin: "command",
			title: "workflow demo",
			workflow: { name: "demo", description: "Demo workflow", source: "inline", args: "" },
			phases: [
				{ title: "Scan", dynamic: false },
				{ title: "Review", dynamic: false },
			],
			currentPhase: 1,
			status: "running",
			startedAt: 0,
			agents: [agentA, agentB],
			log: [{ at: 0, level: "info", text: "16 findings so far" }],
			logDropped: 0,
			budget: { totalTokens: 500_000, spentTokens: 150, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
	}

	function buildMatchingDetails(): PolyphaseDetails {
		return {
			v: 1,
			runId: "run-1",
			kind: "workflow",
			origin: "command",
			title: "workflow demo",
			status: "running",
			startedAt: 0,
			workflow: { name: "demo", description: "Demo workflow", source: "inline", args: "" },
			phases: [
				{ title: "Scan", dynamic: false },
				{ title: "Review", dynamic: false },
			],
			currentPhase: 1,
			agents: [
				{
					i: 0,
					label: "scan",
					agent: "researcher",
					phase: 0,
					status: "done",
					model: "anthropic/claude-sonnet-5",
					thinking: "high",
					modelSource: "inherited",
					modelConfirmed: true,
					turns: 2,
					toolCalls: 1,
					tools: { bash: 1 },
					tokens: 150,
					cost: 0.01,
					blocked: 0,
					task: "scan the repo",
					statusLine: "STATUS: DONE output",
					output: "STATUS: DONE output",
				},
				{
					i: 1,
					label: "review#1",
					agent: "reviewer",
					phase: 1,
					status: "running",
					// No `thinking`: details.ts only writes it from the confirmed thinkingLevel, never
					// from requestedThinking, so an unconfirmed agent's details carry no thinking field.
					model: "anthropic/claude-opus-5-5",
					modelSource: "inherited",
					modelConfirmed: false,
					turns: 0,
					toolCalls: 0,
					tokens: 0,
					cost: 0,
					blocked: 0,
					task: "review the diff",
				},
			],
			log: ["16 findings so far"],
			totals: { agents: 2, tokens: 150, cost: 0.01, byStatus: { done: 1, running: 1 }, blockedToolCalls: 0 },
			budget: { totalTokens: 500_000, spentTokens: 150, exhausted: false },
		};
	}

	it("agree on counts, tokens and cost", () => {
		const live = snapshotFromRun(buildRun(), { now: 1000, tailItems: 4 });
		const archived = snapshotFromDetails(buildMatchingDetails(), { now: 1000 });

		expect(live.counts).toEqual(archived.counts);
		expect(live.tokens).toBe(archived.tokens);
		expect(live.cost).toBe(archived.cost);
		expect(live.blockedToolCalls).toBe(archived.blockedToolCalls);
		expect(live.title).toBe(archived.title);
		expect(live.workflow).toEqual(archived.workflow);
	});

	it("agree on agent labels and models", () => {
		const live = snapshotFromRun(buildRun(), { now: 1000, tailItems: 4 });
		const archived = snapshotFromDetails(buildMatchingDetails(), { now: 1000 });

		for (let i = 0; i < 2; i++) {
			const liveRow = live.agents[i];
			const archivedRow = archived.agents[i];
			expect(liveRow?.label).toBe(archivedRow?.label);
			expect(liveRow?.agentType).toBe(archivedRow?.agentType);
			expect(liveRow?.status).toBe(archivedRow?.status);
			expect(liveRow?.provider).toBe(archivedRow?.provider);
			expect(liveRow?.modelId).toBe(archivedRow?.modelId);
			expect(liveRow?.modelText).toBe(archivedRow?.modelText);
			expect(liveRow?.thinking).toBe(archivedRow?.thinking);
			expect(liveRow?.task).toBe(archivedRow?.task);
			expect(liveRow?.tokens).toBe(archivedRow?.tokens);
			expect(liveRow?.cost).toBe(archivedRow?.cost);
		}
	});

	it("agree on phase status and composition", () => {
		const live = snapshotFromRun(buildRun(), { now: 1000, tailItems: 4 });
		const archived = snapshotFromDetails(buildMatchingDetails(), { now: 1000 });

		expect(live.phases.map((p) => p.status)).toEqual(["done", "running"]);
		expect(archived.phases.map((p) => p.status)).toEqual(["done", "running"]);
		expect(live.phases.map((p) => p.agentIdx)).toEqual(archived.phases.map((p) => p.agentIdx));
		expect(live.phases.map((p) => p.done)).toEqual(archived.phases.map((p) => p.done));
		expect(live.phases.map((p) => p.total)).toEqual(archived.phases.map((p) => p.total));
	});
});

describe("phase status rules", () => {
	function agentAt(index: number, phase: number, status: AgentView["status"]): AgentView {
		return {
			key: `run-2#${index}`,
			index,
			label: `agent#${index}`,
			agentType: "worker",
			task: "do work",
			phase,
			status,
			state: stateFor({ source: "inherited", confirmed: false }),
			createdAt: 0,
		};
	}

	it("maps done, running, failed and pending phases", () => {
		const run: RunView = {
			id: "run-2",
			kind: "workflow",
			origin: "command",
			title: "workflow phases",
			phases: [
				{ title: "P0", dynamic: false },
				{ title: "P1", dynamic: false },
				{ title: "P2", dynamic: false },
				{ title: "P3", dynamic: false },
			],
			currentPhase: 1,
			status: "running",
			startedAt: 0,
			agents: [agentAt(0, 0, "done"), agentAt(1, 1, "running"), agentAt(2, 2, "failed")],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};

		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 4 });
		expect(snapshot.phases.map((p) => p.status)).toEqual(["done", "running", "failed", "pending"]);
	});

	it("marks the current phase failed when its only agent failed and none are active (§11.1)", () => {
		const run: RunView = {
			id: "run-2b",
			kind: "workflow",
			origin: "command",
			title: "workflow phases",
			phases: [{ title: "P0", dynamic: false }],
			currentPhase: 0,
			status: "running",
			startedAt: 0,
			agents: [agentAt(0, 0, "failed")],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};

		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 4 });
		expect(snapshot.phases.map((p) => p.status)).toEqual(["failed"]);
	});
});

describe("finished run phase status", () => {
	function agentAt(index: number, phase: number, status: AgentView["status"]): AgentView {
		return {
			key: `run-2f#${index}`,
			index,
			label: `agent#${index}`,
			agentType: "worker",
			task: "do work",
			phase,
			status,
			state: stateFor({ source: "inherited", confirmed: false }),
			createdAt: 0,
		};
	}

	function finishedRun(status: RunView["status"], agents: AgentView[]): RunView {
		return {
			id: "run-2f",
			kind: "workflow",
			origin: "command",
			title: "workflow phases",
			phases: [
				{ title: "P0", dynamic: false },
				{ title: "P1", dynamic: false },
			],
			currentPhase: 1,
			status,
			startedAt: 0,
			endedAt: 1000,
			agents,
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
	}

	it("does not leave the last phase 'running' once the run has finished", () => {
		const run = finishedRun("done", [agentAt(0, 0, "done"), agentAt(1, 1, "done")]);
		const snapshot = snapshotFromRun(run, { now: 2000, tailItems: 4 });
		expect(snapshot.phases.map((p) => p.status)).toEqual(["done", "done"]);
	});

	it("reports 'failed' for the current phase of a finished run with a failed agent", () => {
		const run = finishedRun("failed", [agentAt(0, 0, "done"), agentAt(1, 1, "failed")]);
		const snapshot = snapshotFromRun(run, { now: 2000, tailItems: 4 });
		expect(snapshot.phases.map((p) => p.status)).toEqual(["done", "failed"]);
	});
});

describe("tail length bound", () => {
	it("keeps only the newest tailItems transcript items", () => {
		const records = [];
		for (let i = 0; i < 5; i++) {
			records.push(wire.toolStart(`t${i}`, "bash", { command: `step ${i}` }));
			records.push(wire.toolEnd(`t${i}`, "bash", "ok", false));
		}
		const state = applyWire(records);
		expect(state.transcript.length).toBe(5);

		const run: RunView = {
			id: "run-3",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent reviewer",
			phases: [],
			status: "running",
			startedAt: 0,
			agents: [
				{
					key: "run-3#0",
					index: 0,
					label: "reviewer",
					agentType: "reviewer",
					task: "review",
					status: "running",
					state,
					createdAt: 0,
				},
			],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};

		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 3 });
		expect(snapshot.agents[0]?.tail?.length).toBe(3);

		const wideSnapshot = snapshotFromRun(run, { now: 1000, tailItems: 10 });
		expect(wideSnapshot.agents[0]?.tail?.length).toBe(5);

		const noTailSnapshot = snapshotFromRun(run, { now: 1000, tailItems: 0 });
		expect(noTailSnapshot.agents[0]?.tail?.length).toBe(0);
	});
});

describe("model label fallbacks", () => {
	function runWith(agent: AgentView): RunView {
		return {
			id: "run-model",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			phases: [],
			status: "running",
			startedAt: 0,
			agents: [agent],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
	}

	it("falls back to 'default model' for an unconfirmed child-default agent, live and archived agree", () => {
		const agent: AgentView = {
			key: "run-model#0",
			index: 0,
			label: "worker",
			agentType: "worker",
			task: "do work",
			status: "starting",
			state: stateFor({ source: "child-default", confirmed: false }),
			createdAt: 0,
		};
		const live = snapshotFromRun(runWith(agent), { now: 1000, tailItems: 0 });
		expect(live.agents[0]?.modelText).toBe("default model");

		const details: PolyphaseDetails = {
			v: 1,
			runId: "run-model",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			status: "running",
			startedAt: 0,
			agents: [
				{
					i: 0,
					label: "worker",
					agent: "worker",
					status: "starting",
					modelSource: "child-default",
					modelConfirmed: false,
					task: "do work",
				},
			],
			totals: { agents: 1, tokens: 0, cost: 0, byStatus: { starting: 1 }, blockedToolCalls: 0 },
		};
		const archived = snapshotFromDetails(details, { now: 1000 });
		expect(archived.agents[0]?.modelText).toBe("default model");
	});

	it("keeps the pre-resolved provider/id for an unconfirmed inherited agent (no requested pattern)", () => {
		const agent: AgentView = {
			key: "run-model#0",
			index: 0,
			label: "worker",
			agentType: "worker",
			task: "do work",
			status: "starting",
			state: stateFor({ source: "inherited", provider: "anthropic", id: "claude-sonnet-5", confirmed: false }),
			createdAt: 0,
		};
		const snapshot = snapshotFromRun(runWith(agent), { now: 1000, tailItems: 0 });
		expect(snapshot.agents[0]?.provider).toBe("anthropic");
		expect(snapshot.agents[0]?.modelId).toBe("claude-sonnet-5");
		expect(snapshot.agents[0]?.modelText).toBeUndefined();
	});

	it("agrees on provider, modelId and modelText for a pre-resolved, unconfirmed, never-started agent", () => {
		const agent: AgentView = {
			key: "run-pre#0",
			index: 0,
			label: "worker",
			agentType: "worker",
			task: "do work",
			status: "skipped",
			state: stateFor({
				source: "inherited",
				provider: "anthropic",
				id: "claude-sonnet-5",
				requestedThinking: "high",
				confirmed: false,
			}),
			createdAt: 0,
		};
		const run: RunView = {
			id: "run-pre",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			phases: [],
			status: "done",
			startedAt: 0,
			endedAt: 1000,
			agents: [agent],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};

		const live = snapshotFromRun(run, { now: 1000, tailItems: 0 });
		const archived = snapshotFromDetails(buildDetails(run, { final: true }), { now: 1000 });

		const liveRow = live.agents[0];
		const archivedRow = archived.agents[0];
		expect(liveRow?.provider).toBe("anthropic");
		expect(liveRow?.modelId).toBe("claude-sonnet-5");
		expect(liveRow?.modelText).toBeUndefined();
		expect(archivedRow?.provider).toBe(liveRow?.provider);
		expect(archivedRow?.modelId).toBe(liveRow?.modelId);
		expect(archivedRow?.modelText).toBe(liveRow?.modelText);
		expect(archivedRow?.thinking).toBe(liveRow?.thinking);
	});
});

describe("model resolution is not inferred from a slash in an unconfirmed pattern (fix round 3)", () => {
	function detailsWithAgentModel(overrides: Partial<PolyphaseDetails["agents"][number]>): PolyphaseDetails {
		return {
			v: 1,
			runId: "run-slash",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			status: "running",
			startedAt: 0,
			agents: [{ i: 0, label: "worker", agent: "worker", status: "running", task: "do work", ...overrides }],
			totals: { agents: 1, tokens: 0, cost: 0, byStatus: { running: 1 }, blockedToolCalls: 0 },
		};
	}

	it("keeps an unresolved frontmatter pattern containing a slash as modelText, not split into provider/id", () => {
		const details = detailsWithAgentModel({
			model: "anthropic/claude-opus",
			modelSource: "frontmatter",
			modelConfirmed: false,
		});
		const snapshot = snapshotFromDetails(details, { now: 1000 });
		expect(snapshot.agents[0]?.provider).toBeUndefined();
		expect(snapshot.agents[0]?.modelId).toBeUndefined();
		expect(snapshot.agents[0]?.modelText).toBe("anthropic/claude-opus");
	});

	it("still splits a resolved provider/id pair once the model is confirmed", () => {
		const details = detailsWithAgentModel({
			model: "anthropic/claude-opus",
			modelSource: "frontmatter",
			modelConfirmed: true,
		});
		const snapshot = snapshotFromDetails(details, { now: 1000 });
		expect(snapshot.agents[0]?.provider).toBe("anthropic");
		expect(snapshot.agents[0]?.modelId).toBe("claude-opus");
		expect(snapshot.agents[0]?.modelText).toBeUndefined();
	});

	it("treats override/phase/inherited models as resolved before confirmation", () => {
		for (const modelSource of ["override", "phase", "inherited"] as const) {
			const details = detailsWithAgentModel({
				model: "anthropic/claude-sonnet-5",
				modelSource,
				modelConfirmed: false,
			});
			const snapshot = snapshotFromDetails(details, { now: 1000 });
			expect(snapshot.agents[0]?.provider).toBe("anthropic");
			expect(snapshot.agents[0]?.modelId).toBe("claude-sonnet-5");
			expect(snapshot.agents[0]?.modelText).toBeUndefined();
		}
	});
});

describe("error source matches details.ts semantics (fix round 3)", () => {
	function runWith(agent: AgentView): RunView {
		return {
			id: "run-err-live",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			phases: [],
			status: "running",
			startedAt: 0,
			agents: [agent],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
	}

	it("prefers stderr over errorMessage, matching buildAgentDetails' `result?.stderr || errorMessage`", () => {
		const agent: AgentView = {
			key: "run-err-live#0",
			index: 0,
			label: "worker",
			agentType: "worker",
			task: "do work",
			status: "failed",
			state: stateFor({ source: "inherited", confirmed: false }, { errorMessage: "429 rate limited" }),
			result: { agent: "worker", task: "do work", exitCode: 1, output: "", stderr: "npm warn deprecated\nmore" },
			createdAt: 0,
		};
		const snapshot = snapshotFromRun(runWith(agent), { now: 1000, tailItems: 0 });
		expect(snapshot.agents[0]?.error).toBe("npm warn deprecated");
	});

	it("falls back to errorMessage when stderr is empty", () => {
		const agent: AgentView = {
			key: "run-err-live#0",
			index: 0,
			label: "worker",
			agentType: "worker",
			task: "do work",
			status: "failed",
			state: stateFor({ source: "inherited", confirmed: false }, { errorMessage: "429 rate limited" }),
			result: { agent: "worker", task: "do work", exitCode: 1, output: "", stderr: "" },
			createdAt: 0,
		};
		const snapshot = snapshotFromRun(runWith(agent), { now: 1000, tailItems: 0 });
		expect(snapshot.agents[0]?.error).toBe("429 rate limited");
	});

	it("shows no error for a non-failed, non-cancelled agent even with a non-zero result.exitCode", () => {
		const agent: AgentView = {
			key: "run-err-live#0",
			index: 0,
			label: "worker",
			agentType: "worker",
			task: "do work",
			status: "done",
			state: stateFor({ source: "inherited", confirmed: false }, { errorMessage: "ignored" }),
			result: { agent: "worker", task: "do work", exitCode: 1, output: "", stderr: "" },
			createdAt: 0,
		};
		const snapshot = snapshotFromRun(runWith(agent), { now: 1000, tailItems: 0 });
		expect(snapshot.agents[0]?.error).toBeUndefined();
	});
});

describe("error only shown for failed/cancelled agents (fix round 2)", () => {
	function detailsWith(status: "done" | "failed", error: string): PolyphaseDetails {
		return {
			v: 1,
			runId: "run-err",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			status,
			startedAt: 0,
			endedAt: 1000,
			agents: [{ i: 0, label: "worker", agent: "worker", status, task: "do work", error }],
			totals: { agents: 1, tokens: 0, cost: 0, byStatus: { [status]: 1 }, blockedToolCalls: 0 },
		};
	}

	it("drops stderr for a successful agent", () => {
		const snapshot = snapshotFromDetails(detailsWith("done", "npm warn deprecated"), { now: 2000 });
		expect(snapshot.agents[0]?.error).toBeUndefined();
	});

	it("keeps the error for a failed agent", () => {
		const snapshot = snapshotFromDetails(detailsWith("failed", "boom"), { now: 2000 });
		expect(snapshot.agents[0]?.error).toBe("boom");
	});
});

describe("phase status: partially finished non-current phase (fix round 2)", () => {
	function agentAt(index: number, phase: number, status: AgentView["status"]): AgentView {
		return {
			key: `run-partial#${index}`,
			index,
			label: `agent#${index}`,
			agentType: "worker",
			task: "do work",
			phase,
			status,
			state: stateFor({ source: "inherited", confirmed: false }),
			createdAt: 0,
		};
	}

	it("reports running for a non-current phase with both finished and queued agents", () => {
		const run: RunView = {
			id: "run-partial",
			kind: "workflow",
			origin: "command",
			title: "workflow partial",
			phases: [
				{ title: "P0", dynamic: false },
				{ title: "P1", dynamic: false },
			],
			currentPhase: 1,
			status: "running",
			startedAt: 0,
			agents: [agentAt(0, 0, "done"), agentAt(1, 0, "queued"), agentAt(2, 1, "running")],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};

		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 0 });
		expect(snapshot.phases[0]?.status).toBe("running");
	});
});

describe("elapsed time is clamped to zero (fix round 2)", () => {
	it("clamps a run-level elapsedMs that would be negative", () => {
		const run: RunView = {
			id: "run-clock",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			phases: [],
			status: "running",
			startedAt: 1000,
			agents: [],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
		const snapshot = snapshotFromRun(run, { now: 500, tailItems: 0 });
		expect(snapshot.elapsedMs).toBe(0);
	});

	it("clamps a details-sourced elapsedMs that would be negative", () => {
		const details: PolyphaseDetails = {
			v: 1,
			runId: "run-clock-d",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			status: "running",
			startedAt: 1000,
			agents: [],
			totals: { agents: 0, tokens: 0, cost: 0, byStatus: {}, blockedToolCalls: 0 },
		};
		const snapshot = snapshotFromDetails(details, { now: 500 });
		expect(snapshot.elapsedMs).toBe(0);
	});
});

describe("snapshotFromDetails version changes with content (fix round 2)", () => {
	it("differs between a running and a finished snapshot of the same run", () => {
		const running: PolyphaseDetails = {
			v: 1,
			runId: "run-ver",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			status: "running",
			startedAt: 0,
			agents: [],
			totals: { agents: 0, tokens: 0, cost: 0, byStatus: { running: 1 }, blockedToolCalls: 0 },
		};
		const done: PolyphaseDetails = {
			...running,
			status: "done",
			endedAt: 1000,
			totals: { agents: 0, tokens: 0, cost: 0, byStatus: { done: 1 }, blockedToolCalls: 0 },
		};

		const v1 = snapshotFromDetails(running, { now: 1000 }).version;
		const v2 = snapshotFromDetails(done, { now: 1000 }).version;
		expect(v1).not.toBe(v2);
	});
});

describe("blocked sample ordering", () => {
	it("uses the first blocked call, not the newest", () => {
		const records = [
			wire.toolStart("t0", "bash", { command: "first" }),
			wire.blockedToolEnd("t0", "bash", "first blocked"),
			wire.toolStart("t1", "bash", { command: "second" }),
			wire.blockedToolEnd("t1", "bash", "second blocked"),
		];
		const state = applyWire(records);
		const run: RunView = {
			id: "run-blocked",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			phases: [],
			status: "running",
			startedAt: 0,
			agents: [
				{
					key: "run-blocked#0",
					index: 0,
					label: "worker",
					agentType: "worker",
					task: "do work",
					status: "running",
					state,
					createdAt: 0,
				},
			],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 0 });
		expect(snapshot.agents[0]?.blockedSample).toBe("bash: first");
	});
});

describe("snapshotFromDetails elapsed time", () => {
	it("uses options.now, not startedAt, for a still-running agent", () => {
		const details: PolyphaseDetails = {
			v: 1,
			runId: "run-elapsed",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			status: "running",
			startedAt: 0,
			agents: [
				{
					i: 0,
					label: "worker",
					agent: "worker",
					status: "running",
					startedAt: 0,
					task: "do work",
				},
			],
			totals: { agents: 1, tokens: 0, cost: 0, byStatus: { running: 1 }, blockedToolCalls: 0 },
		};
		const snapshot = snapshotFromDetails(details, { now: 5000 });
		expect(snapshot.agents[0]?.elapsedMs).toBe(5000);
	});
});

describe("limiter stats", () => {
	it("are carried through unchanged", () => {
		const run: RunView = {
			id: "run-4",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent reviewer",
			phases: [],
			status: "running",
			startedAt: 0,
			agents: [],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
		const limiter: LimiterStats = { capacity: 4, active: 2, queued: 1 };
		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 4, limiter });
		expect(snapshot.limiter).toEqual(limiter);
	});

	it("is undefined when no limiter is given", () => {
		const run: RunView = {
			id: "run-5",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent reviewer",
			phases: [],
			status: "running",
			startedAt: 0,
			agents: [],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 4 });
		expect(snapshot.limiter).toBeUndefined();
	});
});

describe("phase tallies under agentsOmitted (fix round 3)", () => {
	function detailsWithOmission(agentsOmitted: PolyphaseDetails["agentsOmitted"]): PolyphaseDetails {
		return {
			v: 1,
			runId: "run-omitted",
			kind: "workflow",
			origin: "command",
			title: "workflow large",
			status: "running",
			startedAt: 0,
			phases: [{ title: "P0", dynamic: false }],
			currentPhase: 0,
			agents: [{ i: 0, label: "agent#0", agent: "worker", phase: 0, status: "done", task: "do work" }],
			agentsOmitted,
			totals: { agents: 41, tokens: 0, cost: 0, byStatus: { done: 40, running: 1 }, blockedToolCalls: 0 },
		};
	}

	it("marks every phase incomplete when agents were omitted from the archived details", () => {
		const details = detailsWithOmission({ count: 40, byStatus: { done: 39, running: 1 } });
		const snapshot = snapshotFromDetails(details, { now: 1000 });
		expect(snapshot.phases[0]?.incomplete).toBe(true);
		// The phase's own done/total reflects only the agents that details kept, not the true
		// run-wide totals carried by RunSnapshot.agentsOmitted; callers must not read it as complete.
		expect(snapshot.phases[0]?.total).toBe(1);
		expect(snapshot.agentsOmitted).toEqual({ count: 40, byStatus: { done: 39, running: 1 } });
	});

	it("leaves phases marked complete when no agents were omitted", () => {
		const details = detailsWithOmission(undefined);
		const snapshot = snapshotFromDetails(details, { now: 1000 });
		expect(snapshot.phases[0]?.incomplete).toBeUndefined();
	});

	it("never marks a live run's phases incomplete (the store never omits agents)", () => {
		const run: RunView = {
			id: "run-live-complete",
			kind: "workflow",
			origin: "command",
			title: "workflow live",
			phases: [{ title: "P0", dynamic: false }],
			currentPhase: 0,
			status: "running",
			startedAt: 0,
			agents: [],
			log: [],
			logDropped: 0,
			budget: { totalTokens: null, spentTokens: 0, exhausted: false },
			version: 1,
			coarseVersion: 1,
		};
		const snapshot = snapshotFromRun(run, { now: 1000, tailItems: 0 });
		expect(snapshot.phases[0]?.incomplete).toBeUndefined();
	});
});

describe("detailsVersion changes for every field a renderer shows (fix round 3)", () => {
	function baseDetails(model: string, modelConfirmed: boolean): PolyphaseDetails {
		return {
			v: 1,
			runId: "run-ver2",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "subagent",
			status: "running",
			startedAt: 0,
			agents: [
				{
					i: 0,
					label: "worker",
					agent: "worker",
					status: "running",
					model,
					modelConfirmed,
					modelSource: "frontmatter",
					task: "do work",
				},
			],
			totals: { agents: 1, tokens: 0, cost: 0, byStatus: { running: 1 }, blockedToolCalls: 0 },
		};
	}

	it("differs when only an agent's model goes from unconfirmed to confirmed", () => {
		const unconfirmed = baseDetails("claude-opus-5-5", false);
		const confirmed = baseDetails("anthropic/claude-opus-5-5", true);

		const v1 = snapshotFromDetails(unconfirmed, { now: 1000 }).version;
		const v2 = snapshotFromDetails(confirmed, { now: 1000 }).version;
		expect(v1).not.toBe(v2);
	});
});
