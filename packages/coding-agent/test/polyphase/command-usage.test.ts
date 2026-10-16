/**
 * A command run (`/<name>`) records one session usage entry per finished
 * agent with usage (kind `"polyphase"`), attributed to the agent's confirmed provider/model, or
 * to provider `"unknown"` with the requested model string when the child never confirmed one.
 * Tool-origin runs (the `workflow` tool) report usage through their tool result and must not
 * also write usage entries (no double counting).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { createPolyphaseExtension } from "../../src/core/builtins/polyphase.ts";
import { createSubagentExtension, PERMISSION_MODE_ENV } from "../../src/core/builtins/subagent.ts";
import type { PolyphaseRenderDeps } from "../../src/core/polyphase/render/renderers.ts";
import { getPolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { AgentRunner } from "../../src/core/polyphase/types.ts";
import { WORKFLOW_TOOL_NAME } from "../../src/core/polyphase/types.ts";
import { createWorkflowToolDefinition } from "../../src/core/polyphase/workflow/tool.ts";
import type { UsageEntry } from "../../src/core/session-manager.ts";
import { getUsageCostBreakdown } from "../../src/core/usage-totals.ts";
import { createHarness, createTestUiContext, type Harness } from "../suite/harness.ts";
import { createScriptedRunner, type RecordedCall } from "./helpers/scripted-runner.ts";
import * as wire from "./helpers/wire.ts";

/** One agent confirms its model (`assistantStart`); the other never does, to exercise the
 * "unknown provider + requested model" fallback. */
function scriptFor(call: RecordedCall) {
	if (call.task === "confirmed-task") {
		return {
			records: [
				wire.sessionHeader(),
				wire.agentStart(),
				wire.assistantStart("acme", "acme-model-1"),
				wire.assistantEnd({
					provider: "acme",
					model: "acme-model-1",
					text: "done",
					usage: wire.usage(10, 5, 0.01),
				}),
				wire.settled(),
			],
		};
	}
	return {
		records: [
			wire.sessionHeader(),
			wire.agentStart(),
			wire.assistantEnd({ text: "done", usage: wire.usage(3, 2, 0.002) }),
			wire.settled(),
		],
	};
}

function polyphaseUsageEntries(harness: Harness): UsageEntry[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry): entry is UsageEntry => entry.type === "usage" && entry.kind === "polyphase");
}

describe("command-run usage attribution", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	// A stale DRAHT_PERMISSION_MODE=yolo in the shell running these tests would make `/yolo`
	// below toggle OFF instead of ON, breaking the approval bypass for a reason unrelated to the
	// behaviour under test.
	beforeEach(() => {
		vi.stubEnv(PERMISSION_MODE_ENV, "");
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
		vi.unstubAllEnvs();
	});

	function writeSavedWorkflow(name: string, body: string): void {
		const agentDir = join(tmpdir(), `command-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(agentDir, "workflows"), { recursive: true });
		writeFileSync(join(agentDir, "workflows", `${name}.js`), body);
		tempDirs.push(agentDir);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	}

	async function createCommandHarness(runner: AgentRunner): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [createSubagentExtension({ runner }), createPolyphaseExtension({ runner })],
		});
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "print" });
		return harness;
	}

	it("records one usage entry per finished agent, attributed to its model", async () => {
		writeSavedWorkflow(
			"demo-cmd",
			`export const meta = { name: "demo-cmd", description: "Demo command workflow", phases: [{ title: "Only phase" }] };
			const confirmed = await agent("confirmed-task");
			const unconfirmed = await agent("unconfirmed-task");
			return { confirmed, unconfirmed };`,
		);

		const scripted = createScriptedRunner(scriptFor);
		const harness = await createCommandHarness(scripted.runner);
		harnesses.push(harness);

		// yolo bypasses the approval prompt so the run starts without a UI confirm step.
		// (/permissions yolo rather than the /yolo toggle: the latter flips off a stale env mode.)
		await harness.session.prompt("/permissions yolo");
		await harness.session.prompt("/demo-cmd");

		const entries = polyphaseUsageEntries(harness);
		expect(entries.map((entry) => ({ provider: entry.provider, model: entry.model, note: entry.note }))).toEqual([
			{ provider: "acme", model: "acme-model-1", note: "/demo-cmd agent#1" },
			{ provider: "unknown", model: "faux/faux-1", note: "/demo-cmd agent#2" },
		]);
		expect(entries[0]?.usage.cost.total).toBeCloseTo(0.01);
		expect(entries[1]?.usage.cost.total).toBeCloseTo(0.002);

		const breakdown = getUsageCostBreakdown(harness.sessionManager.getBranch());
		expect(breakdown.find((entry) => entry.key === "acme/acme-model-1")?.cost).toBeCloseTo(0.01);
		expect(breakdown.find((entry) => entry.key === "unknown/faux/faux-1")?.cost).toBeCloseTo(0.002);

		const appended = harness.eventsOfType("entry_appended").filter((event) => event.entry.type === "usage");
		expect(appended).toHaveLength(2);
	});

	it("skips an agent that reported no usage", async () => {
		writeSavedWorkflow(
			"no-usage-cmd",
			`export const meta = { name: "no-usage-cmd", description: "Demo", phases: [{ title: "Only phase" }] };
			return await agent("silent-task");`,
		);

		const scripted = createScriptedRunner(() => ({
			records: [wire.sessionHeader(), wire.agentStart(), wire.settled()],
		}));
		const harness = await createCommandHarness(scripted.runner);
		harnesses.push(harness);

		await harness.session.prompt("/permissions yolo");
		await harness.session.prompt("/no-usage-cmd");

		expect(polyphaseUsageEntries(harness)).toHaveLength(0);
	});

	it("does not double-count a tool-origin workflow run", async () => {
		const scripted = createScriptedRunner(scriptFor);
		const renderDeps: PolyphaseRenderDeps = { getStore: () => undefined, viewportRows: () => 24 };
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						const session = getPolyphaseSession(ctx.sessionManager, pi.getSettings().polyphase);
						renderDeps.getStore = () => session.store;
						pi.registerTool(
							createWorkflowToolDefinition({ getSession: () => session, runner: scripted.runner, renderDeps }),
						);
						pi.setActiveTools([...pi.getActiveTools(), WORKFLOW_TOOL_NAME]);
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		const script = `export const meta = { name: "demo-tool", description: "Demo", phases: [{ title: "Only phase" }] };
			return await agent("confirmed-task");`;

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(WORKFLOW_TOOL_NAME, { script }, { id: "wf-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("acknowledged", { stopReason: "stop" }),
		]);

		await harness.session.prompt("run the demo workflow");

		expect(polyphaseUsageEntries(harness)).toHaveLength(0);
	});
});
