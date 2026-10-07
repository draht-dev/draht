import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonObject, JsonValue } from "@draht/ai";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../../src/core/extensions/types.ts";
import { isPolyphaseDetails } from "../../src/core/polyphase/details.ts";
import type { PolyphaseRenderDeps } from "../../src/core/polyphase/render/renderers.ts";
import { getPolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { AgentRunner } from "../../src/core/polyphase/types.ts";
import { WORKFLOW_TOOL_NAME } from "../../src/core/polyphase/types.ts";
import { STRUCTURED_OUTPUT_INSTRUCTION } from "../../src/core/polyphase/workflow/structured-output.ts";
import { createWorkflowToolDefinition } from "../../src/core/polyphase/workflow/tool.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "../suite/harness.ts";
import { createScriptedRunner, type RecordedCall, type ScriptResult } from "./helpers/scripted-runner.ts";
import * as wire from "./helpers/wire.ts";

function textOutput(call: RecordedCall, usageTokens = wire.usage(10, 5, 0.001)): ScriptResult {
	const text = `output for: ${call.task}`;
	return {
		records: [
			wire.sessionHeader(),
			wire.agentStart(),
			wire.assistantStart("faux", "faux-model"),
			wire.textStart(0),
			wire.textDelta(0, text),
			wire.textEnd(0, text),
			wire.assistantEnd({ text, usage: usageTokens }),
			wire.settled(),
		],
	};
}

function schemaOutput(value: JsonObject): ScriptResult {
	return {
		records: [
			wire.sessionHeader(),
			wire.agentStart(),
			wire.assistantStart("faux", "faux-model"),
			...wire.resultToolCall("result-1", value),
			wire.assistantEnd({ text: "done", usage: wire.usage(10, 5, 0.001) }),
			wire.settled(),
		],
	};
}

/** `agent-host.ts` wraps a non-object `schema` as `{value: <schema>}` before handing it to the
 * child; the scripted child's `polyphase_result` call therefore carries the wrapped shape. */
function schemaWrappedOutput(value: JsonValue): ScriptResult {
	return schemaOutput({ value });
}

function partialDetailsFor(harness: Harness, toolCallId: string) {
	return harness
		.eventsOfType("tool_execution_update")
		.filter((event) => event.toolCallId === toolCallId)
		.map((event) => (event.partialResult as AgentToolResult<unknown>).details)
		.filter(isPolyphaseDetails);
}

async function createWorkflowHarness(runner: AgentRunner): Promise<Harness> {
	const renderDeps: PolyphaseRenderDeps = { getStore: () => undefined, viewportRows: () => 24 };
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async (_event, ctx) => {
					const session = getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase);
					renderDeps.getStore = () => session.store;
					pi.registerTool(createWorkflowToolDefinition({ getSession: () => session, runner, renderDeps }));
					pi.setActiveTools([...pi.getActiveTools(), WORKFLOW_TOOL_NAME]);
				});
			},
		],
	});
	await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
	return harness;
}

function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

describe("workflow tool", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.unstubAllEnvs();
	});

	it("runs a 3-phase script with parallel and pipeline; details and content reflect it", async () => {
		// Paced so the live store has time to flush at least one partial update while agents are
		// still running, rather than only the pre-start partial emitted when the emitter is created.
		const scripted = createScriptedRunner((call) => ({ ...textOutput(call), stepDelayMs: 5 }));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "demo", description: "Demo workflow",
			phases: [{ title: "Scan" }, { title: "Review" }, { title: "Synthesize" }] };
			phase("Scan");
			log("narrator line");
			const scan = await agent("scan task");
			phase("Review");
			const reviews = await parallel([() => agent("review a"), () => agent("review b")]);
			phase("Synthesize");
			const piped = await pipeline([1, 2], (prev, item) => agent("pipeline " + item));
			return { scan, reviews, piped };`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("acknowledged", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the demo workflow");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).not.toBe(true);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");

		expect(details.phases?.map((p) => p.title)).toEqual(["Scan", "Review", "Synthesize"]);
		const sortedAgents = [...details.agents].sort((a, b) => a.i - b.i);
		expect(sortedAgents.map((a) => a.label)).toEqual(["agent#1", "agent#2", "agent#3", "agent#4", "agent#5"]);
		// scan is phase 0; the two parallel reviews are phase 1; the two pipeline steps are phase 2.
		expect(sortedAgents.map((a) => a.phase)).toEqual([0, 1, 1, 2, 2]);
		expect(details.log?.some((line) => line.includes("narrator line"))).toBe(true);
		expect(details.totals.tokens).toBeGreaterThan(0);

		const perAgentUsage = wire.usage(10, 5, 0.001);
		expect(result.usage?.input).toBe(perAgentUsage.input * 5);
		expect(result.usage?.output).toBe(perAgentUsage.output * 5);

		const partials = partialDetailsFor(harness, result.toolCallId);
		expect(partials.length).toBeGreaterThan(0);
		for (const partial of partials) {
			expect(partial.phases?.map((p) => p.title)).toEqual(["Scan", "Review", "Synthesize"]);
		}
		const partialWithAgents = partials.find((partial) => partial.agents.length > 0);
		expect(partialWithAgents).toBeDefined();
		if (partialWithAgents) {
			expect(partialWithAgents.status).toBe("running");
			const sortedPartialAgents = [...partialWithAgents.agents].sort((a, b) => a.i - b.i);
			expect(sortedPartialAgents.map((a) => a.label)).toEqual(
				sortedAgents.slice(0, sortedPartialAgents.length).map((a) => a.label),
			);
			expect(sortedPartialAgents[0]?.phase).toBe(0);
			expect(partialWithAgents.log?.some((line) => line.includes("narrator line"))).toBe(true);
		}

		const text = toolResultText(result);
		expect(text).toContain("Result:");
		expect(text).toContain("scan task");
	});

	it("validates a schema agent's structured output against run.schema", async () => {
		const scripted = createScriptedRunner(() => schemaOutput({ areas: ["auth", "billing"] }));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "scan-demo", description: "Scan demo", phases: [{ title: "Scan" }] };
			const result = await agent("scan task", { schema: { type: "object",
				properties: { areas: { type: "array", items: { type: "string" } } }, required: ["areas"] } });
			return result;`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-schema" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the scan demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).not.toBe(true);
		expect(scripted.calls).toHaveLength(1);
		expect(scripted.calls[0].run?.schema).toEqual({
			type: "object",
			properties: { areas: { type: "array", items: { type: "string" } } },
			required: ["areas"],
		});
		expect(scripted.calls[0].run?.extraTools).toEqual(["polyphase_result"]);
		expect(scripted.calls[0].run?.extraSystemPrompt).toBe(STRUCTURED_OUTPUT_INSTRUCTION);

		const text = toolResultText(result);
		expect(text).toContain("auth");
		expect(text).toContain("billing");
	});

	it("wraps and unwraps a non-object schema through the host", async () => {
		const scripted = createScriptedRunner(() => schemaWrappedOutput(["auth", "billing"]));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "list-demo", description: "List demo", phases: [{ title: "Only" }] };
			const result = await agent("list task", { schema: { type: "array", items: { type: "string" } } });
			return result;`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-list" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the list demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).not.toBe(true);
		expect(scripted.calls[0].run?.schema).toEqual({
			type: "object",
			properties: { value: { type: "array", items: { type: "string" } } },
			required: ["value"],
		});

		const text = toolResultText(result);
		expect(text).toContain('"auth"');
		expect(text).toContain('"billing"');
	});

	it("exhausts the budget: later agent() calls return null and details.budget is exhausted", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call, wire.usage(2000, 0, 0)));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "budget-demo", description: "Budget demo", phases: [{ title: "Only" }] };
			const first = await agent("first task");
			const second = await agent("second task");
			return { first, second };`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script, budgetTokens: 1000 }, { id: "wf-budget" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the budget demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		expect(details.budget?.exhausted).toBe(true);
		expect(details.log?.some((line) => line.includes("agent(...) returns null"))).toBe(true);
		expect(scripted.calls).toHaveLength(1);

		const text = toolResultText(result);
		expect(text.toLowerCase()).toContain("budget");
		expect(text).toMatch(/"second":\s*null/);
	});

	it("cancelling one agent mid-run makes agent() return null without failing the run", async () => {
		const scripted = createScriptedRunner(() => ({ records: [], hangUntilAbort: true }));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "cancel-demo", description: "Cancel demo", phases: [{ title: "Only" }] };
			return await agent("hang task");`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-cancel" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		const promptPromise = harness.session.prompt("run the cancel demo");

		const session = getPolyphaseSession(harness.sessionManager, undefined);
		await vi.waitFor(
			() => {
				const run = session.store.getRun("wf-cancel");
				if (!run || run.agents.length === 0) throw new Error("agent not started yet");
			},
			{ timeout: 10_000 },
		);
		session.store.cancelAgent("wf-cancel", 0);

		await promptPromise;

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).not.toBe(true);
		const text = toolResultText(result);
		expect(text).toContain("Result:\nnull");

		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		expect(details.log?.some((line) => line.includes("skipped (cancelled by you)"))).toBe(true);
	});

	it("awaits an abandoned agent before returning final details", async () => {
		const scripted = createScriptedRunner(() => ({ records: [], hangUntilAbort: true }));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "abandon-demo", description: "x", phases: [{ title: "Only" }] };
			agent("never awaited");
			return 1;`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-abandon" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the abandon demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");

		const liveStatuses = new Set(["pending", "queued", "starting", "running"]);
		expect(details.agents.some((a) => liveStatuses.has(a.status))).toBe(false);
	});

	it("rejects an invalid meta block with the line and column", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: notAString, description: "x", phases: [{ title: "Only" }] };
			return 1;`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-invalid" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the invalid demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).toBe(true);
		const text = toolResultText(result);
		expect(text).toContain("line 1, column 29");
	});

	it("logs a warning for an unknown meta key instead of silently dropping it", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "typo-demo", description: "x", phases: [{ title: "Only", modle: "x" }] };
			await agent("go");`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-typo" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the typo demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		expect(details.log?.some((line) => line.includes('unknown key "meta.phases[0].modle"'))).toBe(true);
	});

	it("logs the first real detail line, not a blank one, when stderr starts with a newline", async () => {
		const scripted = createScriptedRunner(() => ({
			records: [wire.sessionHeader(), wire.agentStart(), wire.assistantStart("faux", "faux-model")],
			exitCode: 1,
			stderr: "\nreal failure detail",
		}));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "blank-stderr-demo", description: "x", phases: [{ title: "Only" }] };
			await agent("go", { label: "runner" });`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-blank-stderr" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the blank-stderr demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		expect(details.log?.some((line) => line.includes("runner failed: real failure detail"))).toBe(true);
		expect(details.log?.some((line) => line.includes("runner failed: \n"))).toBe(false);
	});

	it("normalizes a blank explicit agent() label to the default agentType#n label", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "blank-label-demo", description: "x", phases: [{ title: "Only" }] };
			await agent("go", { label: "   " });`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-blank-label" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the blank-label demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		expect(details.agents[0]?.label).toBe("agent#1");
	});

	it("trims a non-blank explicit agent() label, matching subagent.ts's labelKey", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "untrimmed-label-demo", description: "x", phases: [{ title: "Only" }] };
			await agent("go", { label: " reviewer " });`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-untrimmed-label" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the untrimmed-label demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		expect(details.agents[0]?.label).toBe("reviewer");
	});

	it("truncates a long result preview by code point, never splitting a surrogate pair", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		// `JSON.stringify` of this value is 401 UTF-16 code units long (over the 400-char preview
		// cap), with the emoji's two surrogate halves landing exactly at the old naive slice(0, 399)
		// boundary (index 398/399): a `text.slice` truncation splits them, an `Array.from` one does not.
		const script = `export const meta = { name: "surrogate-demo", description: "x", phases: [{ title: "Only" }] };
			return ${JSON.stringify("a".repeat(397))} + "\\u{1F600}";`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-surrogate" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the surrogate demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		const preview = details.resultPreview ?? "";
		expect(preview.length).toBeGreaterThan(0);
		const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		expect(loneSurrogate.test(preview)).toBe(false);
	});

	it("keeps a result whole, with no trailing ellipsis, when it is over 400 UTF-16 units but at most 400 code points", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		// `JSON.stringify` of 397 emoji (plus the two quote characters) is 399 code points but 796
		// UTF-16 code units: deciding truncation from `text.length` (code units) against the 400-char
		// cap instead of the code-point count wrongly truncated this (and appended "…") even though
		// it is under the cap by code point.
		const script = `export const meta = { name: "wide-codepoint-demo", description: "x", phases: [{ title: "Only" }] };
			return "\\u{1F600}".repeat(397);`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-wide-codepoint" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the wide-codepoint demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		const details = result.details;
		expect(isPolyphaseDetails(details)).toBe(true);
		if (!isPolyphaseDetails(details)) throw new Error("expected valid polyphase details");
		const preview = details.resultPreview ?? "";
		const expected = JSON.stringify("\u{1f600}".repeat(397));
		expect(preview).toBe(expected);
		expect(preview.endsWith("…")).toBe(false);
	});

	it("reports a redeclaration hint when a script shadows a prelude binding", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "redeclare-demo", description: "x", phases: [{ title: "Only" }] };
			const agent = 2;
			return agent;`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-redeclare" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the redeclare demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).toBe(true);
		const text = toolResultText(result);
		expect(text).toContain("do not redeclare");
	});

	it("runs a saved workflow by name from the user agent dir", async () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "draht-polyphase-saved-"));
		tempDirs.push(agentDir);
		fs.mkdirSync(path.join(agentDir, "workflows"), { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "workflows", "greet.js"),
			`export const meta = { name: "greet", description: "Greets", phases: [{ title: "Only" }] };\n` +
				`return await agent("greet task");\n`,
		);
		vi.stubEnv("DRAHT_CODING_AGENT_DIR", agentDir);

		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { name: "greet" }, { id: "wf-saved" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the saved greet workflow");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).not.toBe(true);
		const text = toolResultText(result);
		expect(text).toContain("greet task");
	});

	it("an unknown model in agent() opts fails the script and names the model", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "bad-model", description: "x", phases: [{ title: "Only" }] };
			return await agent("task", { model: "no-such-provider/no-such-model" });`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-bad-model" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the bad model demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).toBe(true);
		const text = toolResultText(result);
		expect(text).toContain("no-such-provider/no-such-model");
		expect(scripted.calls).toHaveLength(0);
	});

	it("an unknown agentType fails the script and lists the available agents", async () => {
		const scripted = createScriptedRunner((call) => textOutput(call));
		const harness = await createWorkflowHarness(scripted.runner);
		harnesses.push(harness);

		const script = `export const meta = { name: "bad-agent", description: "x", phases: [{ title: "Only" }] };
			return await agent("task", { agentType: "no-such-agent-type" });`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-bad-agent" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("ok", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the bad agent demo");

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).toBe(true);
		const text = toolResultText(result);
		expect(text).toContain("no-such-agent-type");
		expect(text).toContain("available:");
		expect(scripted.calls).toHaveLength(0);
	});
});
