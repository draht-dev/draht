import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import subagentBuiltin from "../../../src/core/builtins/subagent.ts";
import type { ExtensionUIDialogOptions } from "../../../src/core/extensions/types.ts";
import type { PermissionMode } from "../../../src/core/multi-agent/permission-gate.ts";
import type { RelayAnswer, RelayAsk } from "../../../src/core/permission-relay/types.ts";
import { createCodemodeExtension } from "../../../src/extensions/codemode/index.ts";
import { createHarness, createTestUiContext, getToolResult } from "../harness.ts";

const cases = [
	{ name: "bash", patterns: ["b*", "*ash"] },
	{ name: "mcp__docs__search", patterns: ["mcp__*", "mcp__docs__s*"] },
	{ name: "mcp__docs_extra__search", patterns: ["mcp__docs*", "*search"] },
	{ name: "read_mcp_resource", patterns: ["read_*", "*_mcp_*"] },
	{ name: "list_mcp_resources", patterns: ["list_*", "*_mcp_*"] },
];

async function setup(name: string, patterns: string[], mode: PermissionMode, deny: boolean) {
	const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
	const confirm = vi.fn(async (_title: string, _message: string, _options?: ExtensionUIDialogOptions) => false);
	const harness = await createHarness({
		allowedToolNames: [...patterns, "codemode"],
		extensionFactories: [
			{ name: "multi-agent", factory: subagentBuiltin },
			createCodemodeExtension(),
			(api) =>
				api.registerTool({
					name,
					label: name,
					description: "Permission regression target",
					parameters: Type.Object({ command: Type.String() }),
					execute,
				}),
		],
	});
	mkdirSync(join(harness.tempDir, ".draht"), { recursive: true });
	writeFileSync(
		join(harness.tempDir, ".draht", "permissions.yml"),
		`rules:\n${deny ? `  - tool: ${name}\n    action: deny\n` : ""}  - tool: codemode\n    action: allow\n`,
	);
	await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }) });
	await harness.session.prompt(`/permissions ${mode}`);
	expect(harness.session.getActiveToolNames()).toContain(name);
	return { harness, execute, confirm };
}

async function call(harness: Awaited<ReturnType<typeof setup>>["harness"], name: string, nested = false) {
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(
					nested ? "codemode" : name,
					nested
						? { code: `text(await tools.${name}({command: "echo permission-probe"}));` }
						: { command: "echo permission-probe" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("Exercise the selected tool");
}

describe("regression #5109: tool selection patterns do not grant permission", () => {
	for (const { name, patterns } of cases) {
		for (const mode of ["ask", "auto", "yolo"] as const) {
			it(`${mode}: deny wins over overlapping ${patterns.join(",")} for ${name}`, async () => {
				const { harness, execute, confirm } = await setup(name, patterns, mode, true);
				try {
					await call(harness, name);
					expect(getToolResult(harness, name).isError).toBe(true);
					expect(execute).not.toHaveBeenCalled();
					expect(confirm).not.toHaveBeenCalled();
				} finally {
					harness.cleanup();
				}
			});
		}
		it(`ask: ${name} still asks when a global wildcard matches`, async () => {
			const { harness, execute, confirm } = await setup(name, ["*", ...patterns], "ask", false);
			try {
				await call(harness, name);
				expect(confirm).toHaveBeenCalledOnce();
				expect(confirm.mock.calls[0][2]?.detail).toMatchObject({ toolName: name });
				expect(execute).not.toHaveBeenCalled();
				expect(getToolResult(harness, name).isError).toBe(true);
			} finally {
				harness.cleanup();
			}
		});
	}

	for (const deny of [true, false]) {
		it(`codemode nested MCP call ${deny ? "is denied" : "still asks"} despite a matching pattern`, async () => {
			const name = "mcp__docs__search";
			const { harness, execute, confirm } = await setup(name, ["mcp__*"], "ask", deny);
			try {
				await call(harness, name, true);
				expect(execute).not.toHaveBeenCalled();
				expect(confirm).toHaveBeenCalledTimes(deny ? 0 : 1);
				if (!deny) expect(confirm.mock.calls[0][2]?.detail).toMatchObject({ toolName: name });
			} finally {
				harness.cleanup();
			}
		});
	}

	it("executes a matching tool only after approval", async () => {
		const { harness, execute, confirm } = await setup("mcp__docs__search", ["mcp__*"], "ask", false);
		try {
			confirm.mockResolvedValue(true);
			await call(harness, "mcp__docs__search");
			expect(confirm).toHaveBeenCalledOnce();
			expect(execute).toHaveBeenCalledOnce();
			expect(getToolResult(harness, "mcp__docs__search").isError).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps a wildcard-selected MCP tool pending until the relay answers, and honors denial", async () => {
		const name = "mcp__docs__search";
		const { harness, execute, confirm } = await setup(name, ["*", "mcp__docs*"], "ask", false);
		const pendingAnswer = Promise.withResolvers<RelayAnswer>();
		const raised = Promise.withResolvers<RelayAsk>();
		const withdraw = vi.fn();
		confirm.mockImplementation(
			(_title, _message, options) =>
				new Promise<boolean>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
				}),
		);
		harness.session.setPermissionRelay({
			readWriteClientCount: () => 1,
			raise: (ask) => {
				raised.resolve(ask);
				return pendingAnswer.promise;
			},
			withdraw,
		});
		try {
			const running = call(harness, name);
			const ask = await raised.promise;
			expect(ask.detail).toMatchObject({ toolName: name });
			expect(execute).not.toHaveBeenCalled();
			const denial = ask.options.find((option) => option.decision === "deny");
			if (!denial) throw new Error("Permission gate offered no denial");
			pendingAnswer.resolve({
				requestId: ask.requestId,
				optionId: denial.id,
				decidedBy: { surface: "attach", clientId: "test" },
			});
			await running;
			expect(execute).not.toHaveBeenCalled();
			expect(getToolResult(harness, name).isError).toBe(true);
			expect(withdraw).toHaveBeenCalledWith(
				ask.requestId,
				{ surface: "attach", clientId: "test" },
				{ kind: "denied", chosenOptionId: denial.id },
			);
		} finally {
			harness.cleanup();
		}
	});
});
