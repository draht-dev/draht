import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import type { ToolResultMessage } from "@draht/ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { type AgentRunner, createSubagentExtension } from "../../src/core/builtins/subagent.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "../../src/core/extensions/types.ts";
import { isPolyphaseDetails } from "../../src/core/polyphase/details.ts";
import { peekPolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { AgentStatus, PolyphaseDetails } from "../../src/core/polyphase/types.ts";
import { POLYPHASE_DEPTH_ENV } from "../../src/core/polyphase/types.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "../suite/harness.ts";
import { createScriptedRunner, type RecordedCall } from "./helpers/scripted-runner.ts";
import * as wire from "./helpers/wire.ts";

const AGENT_STATUSES: readonly AgentStatus[] = [
	"pending",
	"queued",
	"starting",
	"running",
	"done",
	"failed",
	"cancelled",
	"skipped",
];

function reviewerScript(call: RecordedCall) {
	return {
		records: [
			wire.sessionHeader(),
			wire.agentStart(),
			wire.assistantStart("faux", "faux-1"),
			wire.textStart(),
			wire.textDelta(0, `looking at ${call.task}`),
			wire.textEnd(0, `looking at ${call.task}`),
			wire.assistantEnd({ text: `STATUS: DONE — ${call.agent.name}`, usage: wire.usage(10, 5, 0.001) }),
			wire.settled(),
		],
	};
}

/** Succeeds every step but reports a failed worktree merge-back on chain step 1. */
function createMergeFailureRunner(): AgentRunner {
	return async (_cwd, agent, task, _signal, step) => {
		const base = { agent: agent.name, task, step, exitCode: 0, output: `done: ${task}`, stderr: "" };
		if (step === 1) return { ...base, merge: { success: false, branch: "agent/chain-0" } };
		return base;
	};
}

/** Exits 0 but always reports a failed worktree merge-back. */
function createSingleMergeFailureRunner(): AgentRunner {
	return async (_cwd, agent, task) => ({
		agent: agent.name,
		task,
		exitCode: 0,
		output: `done: ${task}`,
		stderr: "",
		merge: { success: false, branch: "agent/single-0" },
	});
}

/** Captures the `subagent` `ToolDefinition` from a fake `pi` exposing only `registerTool`,
 * `registerCommand` and `on` - the contract `project-agents-trust.test.ts`/
 * `project-permissions-trust.test.ts` hold the factory body to (DESIGN.md §2). */
function captureSubagentTool(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	createSubagentExtension()({
		registerTool: (def: ToolDefinition) => {
			tool = def;
		},
		registerCommand: () => {},
		on: () => {},
	} as unknown as ExtensionAPI);
	if (!tool) throw new Error("subagent registered no tool");
	return tool;
}

function rawPartialDetails(harness: Harness, toolCallId: string): unknown[] {
	return harness
		.eventsOfType("tool_execution_update")
		.filter((event) => event.toolCallId === toolCallId)
		.map((event) => (event.partialResult as AgentToolResult<unknown>).details);
}

function partialDetails(harness: Harness, toolCallId: string): PolyphaseDetails[] {
	return rawPartialDetails(harness, toolCallId).filter(isPolyphaseDetails);
}

function subagentResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "subagent",
	);
}

describe("subagent tool on polyphase", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "polyphase-subagent-"));
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv(POLYPHASE_DEPTH_ENV, "");
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("runs two reviewer tasks in parallel with distinct labels and valid partial/final details", async () => {
		const scripted = createScriptedRunner(reviewerScript);
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						tasks: [
							{ agent: "reviewer", task: "look at auth.ts" },
							{ agent: "reviewer", task: "look at session.ts" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		const result = getToolResult(harness, "subagent");
		if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
		const details = result.details;
		expect(details.agents.map((a) => a.label).sort()).toEqual(["reviewer#1", "reviewer#2"]);
		expect(details.agents.every((a) => a.status === "done")).toBe(true);

		const rawPartials = rawPartialDetails(harness, result.toolCallId);
		expect(rawPartials.length).toBeGreaterThan(0);
		for (const raw of rawPartials) {
			expect(isPolyphaseDetails(raw)).toBe(true);
			if (!isPolyphaseDetails(raw)) continue;
			expect(raw.agents).toHaveLength(2);
			for (const agent of raw.agents) {
				expect(agent.label === "reviewer#1" || agent.label === "reviewer#2").toBe(true);
				expect(AGENT_STATUSES).toContain(agent.status);
			}
		}

		expect(result.usage?.input).toBe(20);
		expect(result.usage?.output).toBe(10);

		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(16_384);
	});

	it("keeps a large output's trailing STATUS line through the head/tail cap", async () => {
		const bigOutput = `${"x".repeat(60_000)}\nSTATUS: DONE — big output`;
		const scripted = createScriptedRunner(() => ({
			records: [
				wire.sessionHeader(),
				wire.agentStart(),
				wire.assistantStart("faux", "faux-1"),
				wire.assistantEnd({ text: bigOutput, usage: wire.usage(1, 1, 0) }),
				wire.settled(),
			],
		}));
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		const result = getToolResult(harness, "subagent");
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("STATUS: DONE — big output");
		expect(text).toContain("characters omitted");

		expect(isPolyphaseDetails(result.details)).toBe(true);
		if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
		expect(Buffer.byteLength(JSON.stringify(result.details), "utf8")).toBeLessThanOrEqual(16_384);
	});

	it("includes a stderr tail on a failed single-mode call", async () => {
		const scripted = createScriptedRunner(() => ({
			records: [wire.sessionHeader(), wire.agentStart(), wire.assistantStart("faux", "faux-1")],
			exitCode: 1,
			stderr: "boom",
		}));
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("boom");
	});

	it("gives an agent without a frontmatter model the inherited model, with fallbackToChildDefaultModel true", async () => {
		const scripted = createScriptedRunner(reviewerScript);
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(1);
		const call = scripted.calls[0];
		expect(call.run?.model).toBe(`${harness.getModel().provider}/${harness.getModel().id}`);
		expect(call.run?.thinking).toBe(harness.session.thinkingLevel);
		expect(call.run?.modelInfo?.source).toBe("inherited");
		expect(call.run?.fallbackToChildDefaultModel).toBe(true);
	});

	it("passes a frontmatter model pattern verbatim", async () => {
		writeFileSync(
			join(agentDir, "agents", "modeled.md"),
			"---\nname: modeled\ndescription: has a model\nmodel: anthropic/claude-sonnet-5\n---\nBe helpful.\n",
		);
		const scripted = createScriptedRunner(reviewerScript);
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "modeled", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		expect(scripted.calls).toHaveLength(1);
		expect(scripted.calls[0].run?.model).toBe("anthropic/claude-sonnet-5");
		expect(scripted.calls[0].run?.modelInfo?.source).toBe("frontmatter");
	});

	it("queues an agent when polyphase.maxConcurrency is 1", async () => {
		const scripted = createScriptedRunner(() => ({
			records: [wire.sessionHeader(), wire.agentStart(), wire.assistantStart("faux", "faux-1")],
			hangUntilAbort: true,
		}));
		const harness = await createHarness({
			settings: { polyphase: { maxConcurrency: 1 } },
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						tasks: [
							{ agent: "reviewer", task: "task one" },
							{ agent: "reviewer", task: "task two" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);

		const prompt = harness.session.prompt("review please");
		await vi.waitFor(() => expect(scripted.calls.length).toBeGreaterThanOrEqual(1));

		const toolCallId = harness.eventsOfType("tool_execution_start")[0]?.toolCallId;
		await vi.waitFor(() => {
			const partials = toolCallId ? partialDetails(harness, toolCallId) : [];
			expect(partials.some((d) => d.agents.some((a) => a.status === "queued"))).toBe(true);
		});

		const session = peekPolyphaseSession(harness.sessionManager);
		expect(session).toBeDefined();
		session?.store.cancelRun(toolCallId as string, "user");
		await prompt;
	});

	it("bounds concurrency to 1 across two subagent calls in one assistant message", async () => {
		const scripted = createScriptedRunner(reviewerScript);
		const harness = await createHarness({
			settings: { polyphase: { maxConcurrency: 1 } },
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", { agent: "reviewer", task: "task one" }),
					fauxToolCall("subagent", { agent: "reviewer", task: "task two" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		expect(scripted.maxConcurrent()).toBe(1);
		expect(scripted.calls).toHaveLength(2);
		const results = subagentResults(harness);
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result.isError).toBeFalsy();
			if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
			expect(result.details.agents.every((a) => a.status === "done")).toBe(true);
		}
	});

	it("cancels one agent of a parallel run, leaving the others to finish", async () => {
		const scripted = createScriptedRunner((call) => {
			if (call.task.includes("slow")) return { records: reviewerScript(call).records, hangUntilAbort: true };
			return reviewerScript(call);
		});
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						tasks: [
							{ agent: "reviewer", task: "slow task" },
							{ agent: "reviewer", task: "fast task" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("review please");

		await vi.waitFor(() => {
			const toolCallId = harness.eventsOfType("tool_execution_start")[0]?.toolCallId;
			expect(toolCallId).toBeDefined();
		});
		const toolCallId = harness.eventsOfType("tool_execution_start")[0]?.toolCallId as string;

		await vi.waitFor(() => {
			const session = peekPolyphaseSession(harness.sessionManager);
			const run = session?.store.getRun(toolCallId);
			expect(run?.agents.length).toBe(2);
		});

		const session = peekPolyphaseSession(harness.sessionManager);
		session?.store.cancelAgent(toolCallId, 0, "user");

		await prompt;

		const result = getToolResult(harness, "subagent");
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("CANCELLED");
		expect(result.isError).toBeFalsy();
		if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
		expect(result.details.agents[0]?.status).toBe("cancelled");
		expect(result.details.agents[1]?.status).toBe("done");
	});

	it("cancels step one of a chain, stopping the chain with later steps skipped", async () => {
		const scripted = createScriptedRunner((call) => {
			if (call.step === 1) return { records: reviewerScript(call).records, hangUntilAbort: true };
			return reviewerScript(call);
		});
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						chain: [
							{ agent: "reviewer", task: "step one" },
							{ agent: "reviewer", task: "step two" },
							{ agent: "reviewer", task: "step three" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("review please");

		await vi.waitFor(() => {
			const toolCallId = harness.eventsOfType("tool_execution_start")[0]?.toolCallId;
			expect(toolCallId).toBeDefined();
		});
		const toolCallId = harness.eventsOfType("tool_execution_start")[0]?.toolCallId as string;

		await vi.waitFor(() => expect(scripted.calls.length).toBeGreaterThanOrEqual(1));

		const session = peekPolyphaseSession(harness.sessionManager);
		session?.store.cancelAgent(toolCallId, 0, "user");

		await prompt;

		expect(scripted.calls).toHaveLength(1);

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
		expect(result.details.agents.map((a) => a.status)).toEqual(["cancelled", "skipped", "skipped"]);
	});

	it("cancels a single-mode run, returning isError with CANCELLED text", async () => {
		const scripted = createScriptedRunner(() => ({
			records: [wire.sessionHeader(), wire.agentStart(), wire.assistantStart("faux", "faux-1")],
			hangUntilAbort: true,
		}));
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("review please");

		await vi.waitFor(() => expect(scripted.calls.length).toBeGreaterThanOrEqual(1));

		const toolCallId = harness.eventsOfType("tool_execution_start")[0]?.toolCallId as string;
		const session = peekPolyphaseSession(harness.sessionManager);
		session?.store.cancelAgent(toolCallId, 0, "user");

		await prompt;

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("CANCELLED");
	});

	it("reports isError when an earlier chain step's worktree merge-back failed, even though every step exited 0", async () => {
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: createMergeFailureRunner() })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						chain: [
							{ agent: "reviewer", task: "step one" },
							{ agent: "reviewer", task: "step two" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("merge-back FAILED");
	});

	it("marks a single-mode run failed, not done, on a worktree merge-back failure, matching chain/parallel", async () => {
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: createSingleMergeFailureRunner() })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
		expect(result.details.status).toBe("failed");
		expect(result.details.agents[0]?.merge).toBe("failed");
	});

	it("normalizes a blank single-mode label to the agent name, like parallel/chain", async () => {
		const scripted = createScriptedRunner(reviewerScript);
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts", label: "   " })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		const result = getToolResult(harness, "subagent");
		if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
		expect(result.details.agents[0]?.label).toBe("reviewer");
	});

	it("returns a depth error when the delegation depth limit is reached", async () => {
		vi.stubEnv(POLYPHASE_DEPTH_ENV, "2");
		const scripted = createScriptedRunner(reviewerScript);
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner: scripted.runner })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("review please");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Delegation depth limit reached");
		expect(scripted.calls).toHaveLength(0);
	});

	it("reports isError instead of throwing when ctx has no sessionManager", async () => {
		const tool = captureSubagentTool();
		const ctx = {
			cwd: process.cwd(),
			isProjectTrusted: () => false,
		} as unknown as ExtensionToolContext;

		const result = await tool.execute(
			"call-1",
			{ agent: "reviewer", task: "look at auth.ts" },
			undefined,
			() => {},
			ctx,
		);

		expect(result.isError).toBe(true);
	});
});
