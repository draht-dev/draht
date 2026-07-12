import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@draht/ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

/**
 * Regression: `core/builtins/subagent.ts` (the `subagent` tool, and the
 * permission-gate `tool_call` hook it registers) was fully implemented and
 * tested in isolation but never actually loaded by the real CLI — nothing
 * in main.ts/agent-session.ts/sdk.ts referenced it, so it was dead code from
 * a running session's point of view. Fixed by always including
 * `CORE_BUILTIN_EXTENSIONS` in `createAgentSessionServices`, the single
 * choke point every entrypoint (CLI, SDK) goes through.
 */
describe("regression: core builtins are always loaded", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-core-builtins-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers the subagent tool with no settings, packages, or extensionFactories configured", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({ cwd: tempDir, agentDir, settingsManager });

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("subagent");
		session.dispose();
	});

	it("still registers the subagent tool via the single-call createAgentSession path", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
		});
		await session.bindExtensions({});

		expect(session.getAllTools().map((tool) => tool.name)).toContain("subagent");
		session.dispose();
	});

	it("caller-supplied extensionFactories load alongside the core builtins, not instead of them", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "custom_probe",
							label: "Custom Probe",
							description: "test-only tool",
							promptSnippet: "probe",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
					},
				],
			},
		});

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});

		const toolNames = session.getAllTools().map((tool) => tool.name);
		expect(toolNames).toContain("subagent");
		expect(toolNames).toContain("custom_probe");
		session.dispose();
	});
});
