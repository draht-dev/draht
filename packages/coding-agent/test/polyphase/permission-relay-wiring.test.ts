/**
 * Every place that spawns a polyphase child hands it an asker, and the asker reaches THIS
 * session's own dialog under the label the agent has here: the subagent tool (single, parallel)
 * and a workflow's agent(). The asker is invoked while the child runs, the way the runner does
 * when a child's IPC ask arrives.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createSubagentExtension, PERMISSION_MODE_ENV } from "../../src/core/builtins/subagent.ts";
import type { PolyphaseRenderDeps } from "../../src/core/polyphase/render/renderers.ts";
import { getPolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { AgentRunner, ChildPermissionVerdict } from "../../src/core/polyphase/types.ts";
import { WORKFLOW_TOOL_NAME } from "../../src/core/polyphase/types.ts";
import { createWorkflowToolDefinition } from "../../src/core/polyphase/workflow/tool.ts";
import { createHarness, createTestUiContext, type Harness } from "../suite/harness.ts";
import { createScriptedRunner, type RecordedCall } from "./helpers/scripted-runner.ts";
import * as wire from "./helpers/wire.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];

beforeEach(() => {
	// A developer's exported mode, or their global permissions.yml, must not decide these asks.
	// `default`, because a session otherwise starts in auto, which allows `npm test` unasked.
	vi.stubEnv(PERMISSION_MODE_ENV, "default");
	const agentDir = mkdtempSync(join(tmpdir(), "relay-wiring-agent-"));
	dirs.push(agentDir);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

/** A scripted runner whose every child asks to run `npm test` while it runs. */
function askingRunner(): { runner: AgentRunner; verdicts: Promise<ChildPermissionVerdict>[] } {
	const verdicts: Promise<ChildPermissionVerdict>[] = [];
	const scripted = createScriptedRunner((call: RecordedCall) => {
		const ask = call.run?.onPermissionAsk;
		if (ask) {
			verdicts.push(
				ask(
					{
						toolName: "bash",
						toolCallId: `call-${verdicts.length}`,
						input: { command: "npm test" },
						via: [],
						cwd: call.cwd,
					},
					new AbortController().signal,
				),
			);
		}
		return {
			records: [
				wire.sessionHeader(),
				wire.agentStart(),
				wire.assistantStart("faux", "faux-1"),
				wire.assistantEnd({ text: `done: ${call.task}`, usage: wire.usage(5, 5, 0) }),
				wire.settled(),
			],
		};
	});
	return { runner: scripted.runner, verdicts };
}

function recordingUi(answer: boolean) {
	const titles: string[] = [];
	const uiContext = createTestUiContext({
		confirm: async (title: string) => {
			titles.push(title);
			return answer;
		},
	});
	return { titles, uiContext };
}

describe("children's permission asks reach this session's dialog", () => {
	it("subagent single mode: the asker asks under the agent's label and returns the answer", async () => {
		const { runner, verdicts } = askingRunner();
		const { titles, uiContext } = recordingUi(true);
		const harness = await createHarness({ extensionFactories: [createSubagentExtension({ runner })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext, mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		await expect(Promise.all(verdicts)).resolves.toEqual([{ kind: "approved" }]);
		expect(titles).toEqual(["Approve bash for subagent reviewer?"]);
	});

	it("subagent parallel mode: each agent asks under its own label, and a refusal is a denial", async () => {
		const { runner, verdicts } = askingRunner();
		const { titles, uiContext } = recordingUi(false);
		const harness = await createHarness({ extensionFactories: [createSubagentExtension({ runner })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext, mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("subagent", {
						tasks: [
							{ agent: "reviewer", task: "look at a.ts" },
							{ agent: "reviewer", task: "look at b.ts" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		const answered = await Promise.all(verdicts);
		expect(answered).toHaveLength(2);
		for (const verdict of answered) expect(verdict.kind).toBe("denied");
		expect([...titles].sort()).toEqual([
			"Approve bash for subagent reviewer#1?",
			"Approve bash for subagent reviewer#2?",
		]);
	});

	it("a session in yolo mode answers without a dialog", async () => {
		const { runner, verdicts } = askingRunner();
		const { titles, uiContext } = recordingUi(false);
		const harness = await createHarness({ extensionFactories: [createSubagentExtension({ runner })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext, mode: "tui" });

		await harness.session.prompt("/permissions yolo");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("subagent", { agent: "reviewer", task: "look at auth.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("review please");

		await expect(Promise.all(verdicts)).resolves.toEqual([{ kind: "approved" }]);
		expect(titles).toEqual([]);
	});

	it("a workflow's agent() asks under its run label", async () => {
		const { runner, verdicts } = askingRunner();
		const { titles, uiContext } = recordingUi(true);
		const renderDeps: PolyphaseRenderDeps = { getStore: () => undefined, viewportRows: () => 24 };
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						const session = getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase);
						renderDeps.getStore = () => session.store;
						// No subagent extension here, so nothing else would provide the mode.
						session.setPermissionModeProvider(() => "default");
						pi.registerTool(createWorkflowToolDefinition({ getSession: () => session, runner, renderDeps }));
						pi.setActiveTools([...pi.getActiveTools(), WORKFLOW_TOOL_NAME]);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext, mode: "tui" });

		const script = `export const meta = { name: "demo", description: "Demo workflow", phases: [{ title: "Only" }] };
			return await agent("task one");`;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("acknowledged", { stopReason: "stop" }),
		]);
		await harness.session.prompt("run the workflow");

		await expect(Promise.all(verdicts)).resolves.toEqual([{ kind: "approved" }]);
		expect(titles).toEqual(["Approve bash for subagent agent#1?"]);
	});
});
