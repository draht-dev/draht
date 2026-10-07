/**
 * End-to-end polyphase flows (DESIGN.md §21, task P17): the keyword, the gate, the workflow
 * script runtime, saved command runs, the cross-call limiter and child mode, all driven through
 * the real builtins (`createSubagentExtension`, `duetBuiltin`, `createPolyphaseExtension`) and the
 * faux provider. No source file in `src/core/polyphase/**` is touched by this task.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { KeybindingsManager, setKeybindings, type TUI } from "@draht/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import duetBuiltin from "../../src/core/builtins/duet.ts";
import { createPolyphaseExtension } from "../../src/core/builtins/polyphase.ts";
import { createSubagentExtension } from "../../src/core/builtins/subagent.ts";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import { isPolyphaseDetails } from "../../src/core/polyphase/details.ts";
import { createWorkflowRenderers, type PolyphaseRenderDeps } from "../../src/core/polyphase/render/renderers.ts";
import {
	POLYPHASE_DEPTH_ENV,
	POLYPHASE_RESULT_TOOL_NAME,
	POLYPHASE_SCHEMA_FILE_ENV,
	WORKFLOW_TOOL_NAME,
} from "../../src/core/polyphase/types.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createScriptedRunner, type RecordedCall } from "../polyphase/helpers/scripted-runner.ts";
import * as wire from "../polyphase/helpers/wire.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

function textOutput(call: RecordedCall) {
	const text = `output for: ${call.task}`;
	return {
		records: [
			wire.sessionHeader(),
			wire.agentStart(),
			wire.assistantStart("faux", "faux-model"),
			wire.textStart(0),
			wire.textDelta(0, text),
			wire.textEnd(0, text),
			wire.assistantEnd({ text, usage: wire.usage(10, 5, 0.001) }),
			wire.settled(),
		],
	};
}

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function writeWorkflow(agentDir: string, name: string, script: string): void {
	writeFileSync(join(agentDir, "workflows", `${name}.js`), script);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function customMessages(harness: Harness, customType: string) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
}

const TWO_PHASE_SCRIPT = `export const meta = { name: "demo-end-to-end", description: "Two phase demo",
	phases: [{ title: "Scan" }, { title: "Review" }] };
phase("Scan");
const scan = await agent("scan the codebase", { label: "scanner" });
phase("Review");
const review = await agent("review the scan", { label: "reviewer" });
return { scan, review };`;

describe("polyphase end-to-end flows", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager(KEYBINDINGS));
	});

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "polyphase-e2e-"));
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv(POLYPHASE_DEPTH_ENV, "");
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("runs a keyword-triggered 2-phase workflow through the gate, with inherited models and a resumable render", async () => {
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async (_title: string, _message: string) => true);
		const harness = await createHarness({
			extensionFactories: [
				createSubagentExtension({ runner: scripted.runner }),
				duetBuiltin,
				createPolyphaseExtension({ runner: scripted.runner }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script: TWO_PHASE_SCRIPT }, { id: "wf-e2e" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("acknowledged", { stopReason: "stop" }),
		]);

		await harness.session.prompt("polyphase run the two phase demo");

		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, message] = confirm.mock.calls[0];
		expect(title).toBe('Run workflow "demo-end-to-end"?');
		expect(message).toContain("1 Scan");
		expect(message).toContain("2 Review");

		expect(scripted.calls).toHaveLength(2);
		for (const call of scripted.calls) {
			expect(call.run?.modelInfo?.source).toBe("inherited");
			expect(call.run?.model).toBe(`${harness.getModel().provider}/${harness.getModel().id}`);
		}

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).not.toBe(true);
		expect(isPolyphaseDetails(result.details)).toBe(true);
		if (!isPolyphaseDetails(result.details)) throw new Error("expected PolyphaseDetails");
		const details = result.details;
		expect(Buffer.byteLength(JSON.stringify(details), "utf8")).toBeLessThanOrEqual(16_384);

		const perAgentUsage = wire.usage(10, 5, 0.001);
		expect(result.usage?.input).toBe(perAgentUsage.input * 2);
		expect(result.usage?.output).toBe(perAgentUsage.output * 2);

		expect(customMessages(harness, "polyphase-guidance")).toHaveLength(1);
		expect(harness.session.getActiveToolNames()).not.toContain(WORKFLOW_TOOL_NAME);

		// Resume path: re-render the persisted toolResult with no live store, as a fresh session would.
		const renderDeps: PolyphaseRenderDeps = { getStore: () => undefined, viewportRows: () => 24 };
		const { renderCall, renderResult } = createWorkflowRenderers(renderDeps);
		const component = new ToolExecutionComponent(
			WORKFLOW_TOOL_NAME,
			result.toolCallId,
			{ script: TWO_PHASE_SCRIPT },
			{},
			{ renderCall, renderResult, renderShell: "default" as const },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: result.content, details, isError: result.isError ?? false }, false);

		component.setExpanded(true);
		const expandedText = stripAnsi(component.render(80).join("\n"));
		expect(expandedText).toContain("Scan");
		expect(expandedText).toContain("Review");
		expect(expandedText).toContain("scanner");
		expect(expandedText).toContain("reviewer");

		// Collapsed, a finished run's non-active phases show only their header and tally (§11.3);
		// agent labels there are an expanded-only detail, already asserted above.
		component.setExpanded(false);
		const collapsedText = stripAnsi(component.render(80).join("\n"));
		expect(collapsedText).toContain("Scan");
		expect(collapsedText).toContain("Review");
	});

	it("a declined confirm blocks the keyword-triggered workflow call without ever invoking the runner", async () => {
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async () => false);
		const harness = await createHarness({
			extensionFactories: [
				createSubagentExtension({ runner: scripted.runner }),
				duetBuiltin,
				createPolyphaseExtension({ runner: scripted.runner }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script: TWO_PHASE_SCRIPT }, { id: "wf-denied" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("understood", { stopReason: "stop" }),
		]);

		await harness.session.prompt("polyphase run the two phase demo");

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(scripted.calls).toHaveLength(0);

		const result = getToolResult(harness, WORKFLOW_TOOL_NAME);
		expect(result.isError).toBe(true);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("User denied approval");
	});

	it("a saved /<name> command run produces a polyphase-workflow message without consuming a faux turn", async () => {
		writeWorkflow(
			agentDir,
			"greet",
			`export const meta = { name: "greet", description: "Greets", phases: [{ title: "Only" }] };
return await agent("greet " + args);`,
		);
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async () => true);
		const harness = await createHarness({
			extensionFactories: [
				createSubagentExtension({ runner: scripted.runner }),
				duetBuiltin,
				createPolyphaseExtension({ runner: scripted.runner }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }), mode: "tui" });

		harness.setResponses([fauxAssistantMessage("must stay queued", { stopReason: "stop" })]);
		const pendingBefore = harness.getPendingResponseCount();

		await harness.session.prompt("/greet friend");

		expect(confirm).toHaveBeenCalledTimes(1);
		await waitFor(() => customMessages(harness, "polyphase-workflow").length > 0);
		expect(harness.getPendingResponseCount()).toBe(pendingBefore);
		expect(scripted.calls).toHaveLength(1);
		expect(scripted.calls[0]?.task).toContain("friend");

		const [entry] = customMessages(harness, "polyphase-workflow");
		expect(entry?.type).toBe("custom_message");
		if (entry?.type === "custom_message") expect(isPolyphaseDetails(entry.details)).toBe(true);
	});

	it("bounds the cross-call limiter to 1 across two subagent calls in one assistant message", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createHarness({
			settings: { polyphase: { maxConcurrency: 1 } },
			extensionFactories: [
				createSubagentExtension({ runner: scripted.runner }),
				duetBuiltin,
				createPolyphaseExtension({ runner: scripted.runner }),
			],
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
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);

		await harness.session.prompt("review please");

		expect(scripted.maxConcurrent()).toBe(1);
		expect(scripted.calls).toHaveLength(2);
	});

	it("registers only polyphase_result in child mode, and the gate allows it with no UI attached", async () => {
		const schemaFile = join(agentDir, "schema.json");
		writeFileSync(
			schemaFile,
			JSON.stringify({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }),
		);
		vi.stubEnv(POLYPHASE_DEPTH_ENV, "1");
		vi.stubEnv(POLYPHASE_SCHEMA_FILE_ENV, schemaFile);

		const scripted = createScriptedRunner(textOutput);
		const harness = await createHarness({
			extensionFactories: [
				createSubagentExtension({ runner: scripted.runner }),
				duetBuiltin,
				createPolyphaseExtension({ runner: scripted.runner }),
			],
		});
		harnesses.push(harness);
		// No uiContext at all: the runner's `hasUI()` stays false, exercising the no-UI gate path.
		await harness.session.bindExtensions({ mode: "print" });

		expect(harness.session.getAllTools().some((tool) => tool.name === POLYPHASE_RESULT_TOOL_NAME)).toBe(true);
		expect(harness.session.getAllTools().some((tool) => tool.name === WORKFLOW_TOOL_NAME)).toBe(false);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(POLYPHASE_RESULT_TOOL_NAME, { summary: "done" }, { id: "r1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("should not be reached", { stopReason: "stop" }),
		]);

		await harness.session.prompt("finish up");

		const result = getToolResult(harness, POLYPHASE_RESULT_TOOL_NAME);
		expect(result.isError).not.toBe(true);
	});
});
