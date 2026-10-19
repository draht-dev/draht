import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../../src/config.ts";
import gitSafetyBuiltin from "../../src/core/builtins/git-safety.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

describe("native Git safeguards", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("keeps protected commands blocked when the packaged policy cannot load", async () => {
		let executed = false;
		const harness = await createHarness({
			extensionFactories: [
				gitSafetyBuiltin,
				(pi) => {
					pi.registerTool({
						name: "bash",
						label: "bash",
						description: "Records a command without executing it",
						parameters: Type.Object({ command: Type.String() }),
						execute: async () => {
							executed = true;
							return { content: [{ type: "text", text: "recorded" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		vi.spyOn(config, "getPackageDir").mockReturnValue(harness.tempDir);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "git status --short" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("blocked"),
		]);
		await harness.session.prompt("push");
		expect(executed).toBe(false);
		expect(getToolResult(harness, "bash").isError).toBe(true);
	});

	it.each(["bash", "powershell"])("blocks forbidden Git calls before the %s tool executes", async (toolName) => {
		const executed: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				gitSafetyBuiltin,
				(pi) => {
					pi.registerTool({
						name: toolName,
						label: toolName,
						description: "Records a command without executing it",
						parameters: Type.Object({ command: Type.String() }),
						execute: async (_id, { command }) => {
							executed.push(command);
							return { content: [{ type: "text", text: "recorded" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(toolName, { command: "git push --force origin main" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("blocked"),
		]);
		await harness.session.prompt("push");
		expect(executed).toEqual([]);
		expect(getToolResult(harness, toolName).isError).toBe(true);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(toolName, { command: "git status --short" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("checked"),
		]);
		await harness.session.prompt("inspect");
		expect(executed).toEqual(["git status --short"]);
		expect(getToolResult(harness, toolName).isError).not.toBe(true);
	});
});
