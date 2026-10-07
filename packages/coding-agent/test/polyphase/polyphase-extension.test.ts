import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@draht/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createPolyphaseExtension } from "../../src/core/builtins/polyphase.ts";
import { createSubagentExtension } from "../../src/core/builtins/subagent.ts";
import type { LoadExtensionsResult } from "../../src/core/extensions/types.ts";
import { isPolyphaseDetails } from "../../src/core/polyphase/details.ts";
import { disposePolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { AgentRunner } from "../../src/core/polyphase/types.ts";
import {
	POLYPHASE_DEPTH_ENV,
	POLYPHASE_RESULT_TOOL_NAME,
	POLYPHASE_SCHEMA_FILE_ENV,
	WORKFLOW_TOOL_NAME,
} from "../../src/core/polyphase/types.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { createHarness, createTestUiContext, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { createScriptedRunner, type RecordedCall } from "./helpers/scripted-runner.ts";
import * as wire from "./helpers/wire.ts";

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

function customMessages(harness: Harness, customType: string): SessionEntry[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === customType);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function writeWorkflow(agentDir: string, name: string, script: string): void {
	writeFileSync(join(agentDir, "workflows", `${name}.js`), script);
}

const reviewPrScript = `export const meta = { name: "review-pr", description: "Review a change",
	phases: [{ title: "Review" }] };
return await agent("review " + args);`;

const modelCollisionScript = `export const meta = { name: "model", description: "Collides with a builtin command",
	phases: [{ title: "Run" }] };
return await agent("noop");`;

function extensionCollisionScript(name: string): string {
	return `export const meta = { name: "${name}", description: "Collides with an extension command",
	phases: [{ title: "Run" }] };
return await agent("noop");`;
}

function skillCollisionScript(name: string): string {
	return `export const meta = { name: "${name}", description: "Collides with a skill",
	phases: [{ title: "Run" }] };
return await agent("noop");`;
}

/** A resource loader exposing the given extensions plus one skill named `skillName`, so
 * `planSavedWorkflowCommands`'s `skill:` prefix stripping (commands.ts) has something to collide with. */
function createResourceLoaderWithSkill(extensionsResult: LoadExtensionsResult, skillName: string): ResourceLoader {
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({
			skills: [
				{
					name: skillName,
					description: "A test skill",
					filePath: `/fake/${skillName}/SKILL.md`,
					baseDir: `/fake/${skillName}`,
					sourceInfo: createSyntheticSourceInfo(`/fake/${skillName}/SKILL.md`, { source: "sdk" }),
					disableModelInvocation: false,
				},
			],
			diagnostics: [],
		}),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

describe("polyphase core builtin", () => {
	let agentDir: string;
	const harnesses: Harness[] = [];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "polyphase-extension-"));
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		vi.stubEnv(POLYPHASE_DEPTH_ENV, "");
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		rmSync(agentDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	async function createPolyphaseHarness(
		runner: AgentRunner,
		extra?: Parameters<typeof createHarness>[0],
		ui?: Parameters<typeof createTestUiContext>[0],
		beforeBind?: (harness: Harness) => void,
	): Promise<Harness> {
		const harness = await createHarness({
			...extra,
			extensionFactories: [
				createSubagentExtension({ runner }),
				createPolyphaseExtension({ runner }),
				...(extra?.extensionFactories ?? []),
			],
		});
		beforeBind?.(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(ui), mode: "tui" });
		harnesses.push(harness);
		return harness;
	}

	it("activates the workflow tool on the keyword during the turn, sends guidance once, then deactivates it", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner);

		let activeDuringTurn: string[] = [];
		harness.setResponses([
			() => {
				activeDuringTurn = harness.session.getActiveToolNames();
				return fauxAssistantMessage("acknowledged", { stopReason: "stop" });
			},
			fauxAssistantMessage("acknowledged again", { stopReason: "stop" }),
		]);

		await harness.session.prompt("polyphase review the auth module");

		expect(activeDuringTurn).toContain("workflow");
		expect(harness.session.getAllTools().some((tool) => tool.name === "workflow")).toBe(true);
		expect(harness.session.getActiveToolNames()).not.toContain("workflow");
		expect(customMessages(harness, "polyphase-guidance")).toHaveLength(1);

		await harness.session.prompt("polyphase again please");
		expect(customMessages(harness, "polyphase-guidance")).toHaveLength(1);
	});

	it("activates the workflow tool for a keyword sent while the agent is streaming", async () => {
		const scripted = createScriptedRunner(textOutput);
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};

		const harness = await createPolyphaseHarness(scripted.runner, { tools: [waitTool] });

		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});

		let activeDuringFollowUp: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			() => {
				activeDuringFollowUp = harness.session.getActiveToolNames();
				return fauxAssistantMessage("handled", { stopReason: "stop" });
			},
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.followUp("polyphase handle this while streaming");
		releaseToolExecution?.();
		await promptPromise;

		expect(activeDuringFollowUp).toContain("workflow");
		expect(customMessages(harness, "polyphase-guidance")).toHaveLength(1);
	});

	it("never activates the workflow tool when polyphase.workflowTool is off", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner, {
			settings: { polyphase: { workflowTool: "off" } },
		});

		harness.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
		await harness.session.prompt("polyphase review the auth module");

		expect(harness.session.getAllTools().some((tool) => tool.name === "workflow")).toBe(false);
		expect(customMessages(harness, "polyphase-guidance")).toHaveLength(0);
	});

	it("warns on session start when polyphase settings are invalid, instead of silently falling back", async () => {
		const scripted = createScriptedRunner(textOutput);
		const notify = vi.fn();
		const harness = await createPolyphaseHarness(
			scripted.runner,
			{ settings: { polyphase: { keyword: "pp" } } },
			{ notify },
		);

		expect(
			notify.mock.calls.some(
				([message, level]) => level === "warning" && String(message).includes('polyphase.keyword "pp"'),
			),
		).toBe(true);

		harness.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
		await harness.session.prompt("pp review the auth module");
		expect(customMessages(harness, "polyphase-guidance")).toHaveLength(0);
	});

	it("keeps the workflow tool active across multiple turns when polyphase.workflowTool is 'always'", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner, {
			settings: { polyphase: { workflowTool: "always" } },
		});

		harness.setResponses([
			fauxAssistantMessage("first", { stopReason: "stop" }),
			fauxAssistantMessage("second", { stopReason: "stop" }),
		]);

		await harness.session.prompt("first turn");
		expect(harness.session.getActiveToolNames()).toContain("workflow");

		await harness.session.prompt("second turn");
		expect(harness.session.getActiveToolNames()).toContain("workflow");
	});

	it("a fresh session's getAllTools() lacks the workflow tool", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner);

		expect(harness.session.getAllTools().some((tool) => tool.name === "workflow")).toBe(false);
	});

	it("registers the workflow tool inactive when the branch already contains a workflow toolResult", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner, undefined, undefined, (pendingHarness) => {
			pendingHarness.sessionManager.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
			pendingHarness.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: WORKFLOW_TOOL_NAME,
				content: [],
				details: {},
				isError: false,
				timestamp: Date.now(),
			});
		});

		expect(harness.session.getAllTools().some((tool) => tool.name === "workflow")).toBe(true);
		expect(harness.session.getActiveToolNames()).not.toContain("workflow");
	});

	it("/workflow <name> <args> confirms, runs the saved workflow, and reports back without a paid turn", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async (_title: string, _message: string) => true);
		const harness = await createPolyphaseHarness(scripted.runner, undefined, { confirm });

		harness.setResponses([fauxAssistantMessage("must stay queued", { stopReason: "stop" })]);
		const pendingBefore = harness.getPendingResponseCount();
		await harness.session.prompt("/workflow review-pr #12");

		expect(confirm).toHaveBeenCalledTimes(1);
		const [title] = confirm.mock.calls[0];
		expect(title).toBe('Run workflow "review-pr"?');

		await waitFor(() => customMessages(harness, "polyphase-workflow").length > 0);
		const [entry] = customMessages(harness, "polyphase-workflow");
		expect(entry?.type).toBe("custom_message");
		if (entry?.type === "custom_message") {
			expect(isPolyphaseDetails(entry.details)).toBe(true);
		}
		expect(harness.getPendingResponseCount()).toBe(pendingBefore);
		expect(scripted.calls.length).toBeGreaterThan(0);
		expect(scripted.calls[0]?.task).toContain("#12");
	});

	it("/workflow <name> <args> splits on the first whitespace, not just a literal space", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async (_title: string, _message: string) => true);
		const harness = await createPolyphaseHarness(scripted.runner, undefined, { confirm });

		await harness.session.prompt("/workflow review-pr\n#12 multi-line args");

		await waitFor(() => customMessages(harness, "polyphase-workflow").length > 0);
		expect(confirm).toHaveBeenCalledTimes(1);
		const [title] = confirm.mock.calls[0];
		expect(title).toBe('Run workflow "review-pr"?');
		expect(scripted.calls[0]?.task).toContain("#12 multi-line args");
	});

	it("does not start the run if the session is disposed while the confirm dialog is open", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		const scripted = createScriptedRunner(textOutput);
		const onError = vi.fn();
		const confirm = vi.fn(async (_title: string, _message: string) => {
			disposePolyphaseSession(harness.sessionManager, "test shutdown mid-confirm");
			return true;
		});
		const harness = await createHarness({
			extensionFactories: [
				createSubagentExtension({ runner: scripted.runner }),
				createPolyphaseExtension({ runner: scripted.runner }),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }), mode: "tui", onError });

		await harness.session.prompt("/workflow review-pr #12");
		// The run (if one starts) is fire-and-forget in tui mode: give it a chance to reach the
		// scripted runner before asserting it never did, instead of racing an async host that just
		// has not gotten there yet.
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(onError).not.toHaveBeenCalled();
		expect(scripted.calls).toHaveLength(0);
		expect(customMessages(harness, "polyphase-workflow")).toHaveLength(0);
	});

	it("in print mode, /<name> awaits the run so the completion message exists before prompt() returns", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		vi.stubEnv("DRAHT_PERMISSION_MODE", "yolo");
		const scripted = createScriptedRunner(textOutput);
		const harness = await createHarness({
			extensionFactories: [
				createSubagentExtension({ runner: scripted.runner }),
				createPolyphaseExtension({ runner: scripted.runner }),
			],
		});
		harnesses.push(harness);
		// No uiContext, matching real print mode (print-mode.ts binds with none, so ctx.hasUI is
		// false): a test that still passes a uiContext here cannot catch a regression in the no-UI
		// path (e.g. the approval-needed error, or the awaited run itself).
		await harness.session.bindExtensions({ mode: "print" });

		await harness.session.prompt("/review-pr #9");

		expect(customMessages(harness, "polyphase-workflow")).toHaveLength(1);
		expect(scripted.calls[0]?.task).toContain("#9");
	});

	it("declining the confirm dialog does not run the workflow", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async () => false);
		const notify = vi.fn();
		const harness = await createPolyphaseHarness(scripted.runner, undefined, { confirm, notify });

		await harness.session.prompt("/workflow review-pr #12");

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(scripted.calls).toHaveLength(0);
		expect(customMessages(harness, "polyphase-workflow")).toHaveLength(0);
		expect(notify.mock.calls.some(([message]) => String(message).includes("not started"))).toBe(true);
	});

	it("registers /<name> for a valid saved workflow and reports one aggregated collision warning", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		writeWorkflow(agentDir, "model", modelCollisionScript);
		writeWorkflow(agentDir, "mycmd", extensionCollisionScript("mycmd"));
		writeWorkflow(agentDir, "reviewskill", skillCollisionScript("reviewskill"));

		const scripted = createScriptedRunner(textOutput);
		const notify = vi.fn();
		const extensionsResult = await createTestExtensionsResult([
			createSubagentExtension({ runner: scripted.runner }),
			createPolyphaseExtension({ runner: scripted.runner }),
			(pi) => {
				pi.registerCommand("mycmd", { description: "an extension command", handler: async () => {} });
			},
		]);
		const harness = await createHarness({
			resourceLoader: createResourceLoaderWithSkill(extensionsResult, "reviewskill"),
		});
		await harness.session.bindExtensions({ uiContext: createTestUiContext({ notify }), mode: "tui" });
		harnesses.push(harness);

		const registered = harness.session.extensionRunner
			.getRegisteredCommands()
			.map((command) => command.invocationName);
		expect(registered).toContain("review-pr");
		expect(registered).not.toContain("model");
		expect(registered).not.toContain("reviewskill");

		const aggregated = notify.mock.calls.find(
			([message]) => String(message).includes('"model"') && String(message).includes('"mycmd"'),
		);
		expect(aggregated).toBeDefined();
		expect(aggregated?.[1]).toBe("warning");
		expect(String(aggregated?.[0])).toContain("not registered as /model");
		expect(String(aggregated?.[0])).toContain("not registered as /mycmd");
		expect(String(aggregated?.[0])).toContain("not registered as /reviewskill");
		expect(notify.mock.calls.filter(([, level]) => level === "warning")).toHaveLength(1);
	});

	it("/<name> runs the registered saved workflow directly", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async () => true);
		const harness = await createPolyphaseHarness(scripted.runner, undefined, { confirm });

		await harness.session.prompt("/review-pr #3");

		expect(confirm).toHaveBeenCalledTimes(1);
		await waitFor(() => customMessages(harness, "polyphase-workflow").length > 0);
		expect(scripted.calls[0]?.task).toContain("#3");
	});

	it("'!polyphase ls' does not arm or activate the workflow tool", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner);

		harness.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
		await harness.session.prompt("!polyphase ls");

		expect(harness.session.getAllTools().some((tool) => tool.name === "workflow")).toBe(false);
		expect(customMessages(harness, "polyphase-guidance")).toHaveLength(0);
	});

	it("'/workflows list' notifies live and archived saved-workflow runs as text", async () => {
		writeWorkflow(agentDir, "review-pr", reviewPrScript);
		const scripted = createScriptedRunner(textOutput);
		const confirm = vi.fn(async () => true);
		const notify = vi.fn();
		const harness = await createPolyphaseHarness(
			scripted.runner,
			{ settings: { polyphase: { retainRuns: 1 } } },
			{ confirm, notify },
		);

		await harness.session.prompt("/review-pr first");
		await waitFor(() => customMessages(harness, "polyphase-workflow").length > 0);
		await harness.session.prompt("/review-pr second");
		await waitFor(() => customMessages(harness, "polyphase-workflow").length > 1);

		notify.mockClear();
		await harness.session.prompt("/workflows list");

		const listed = notify.mock.calls.find(([message]) => String(message).includes("done: review-pr"));
		expect(listed).toBeDefined();
		// retainRuns:1 evicts the first run from the live store but keeps it archived: both the live
		// second run and the archived first run must appear, so the live/archived branches are each
		// exercised, not just one of them under the same shared "done: review-pr" format.
		expect(String(listed?.[0]).match(/done: review-pr/g)?.length).toBe(2);
	});

	it("discovers a project workflow only when the project is trusted", async () => {
		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner);
		harness.settingsManager.setProjectTrusted(false);
		expect(harness.settingsManager.isProjectTrusted()).toBe(false);

		mkdirSync(join(harness.tempDir, ".draht", "workflows"), { recursive: true });
		writeFileSync(
			join(harness.tempDir, ".draht", "workflows", "deploy.js"),
			reviewPrScript.replace("review-pr", "deploy"),
		);
		// A second bindExtensions re-runs session_start (idempotent: registerCommand overwrites by
		// name), so the newly written project file enters discovery for this assertion.
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		const registeredUntrusted = harness.session.extensionRunner
			.getRegisteredCommands()
			.map((command) => command.invocationName);
		expect(registeredUntrusted).not.toContain("deploy");

		// Positive control, checked last: a leftover registration from an earlier trusted bind
		// would never be removed (registerCommand has no unregister), so trusting the project
		// only after the negative assertion is the only order that cannot pass by accident.
		harness.settingsManager.setProjectTrusted(true);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		const registeredTrusted = harness.session.extensionRunner
			.getRegisteredCommands()
			.map((command) => command.invocationName);
		expect(registeredTrusted).toContain("deploy");
	});

	it("registers no commands and only polyphase_result in a child process (DRAHT_POLYPHASE_DEPTH >= 1)", async () => {
		vi.stubEnv(POLYPHASE_DEPTH_ENV, "1");
		const schemaFile = join(agentDir, "schema.json");
		writeFileSync(
			schemaFile,
			JSON.stringify({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"] }),
		);
		vi.stubEnv(POLYPHASE_SCHEMA_FILE_ENV, schemaFile);

		const scripted = createScriptedRunner(textOutput);
		const harness = await createPolyphaseHarness(scripted.runner);

		const registered = harness.session.extensionRunner
			.getRegisteredCommands()
			.map((command) => command.invocationName);
		expect(registered).not.toContain("workflow");
		expect(registered).not.toContain("workflows");
		expect(harness.session.getAllTools().some((tool) => tool.name === WORKFLOW_TOOL_NAME)).toBe(false);
		expect(harness.session.getAllTools().some((tool) => tool.name === POLYPHASE_RESULT_TOOL_NAME)).toBe(true);
	});
});
