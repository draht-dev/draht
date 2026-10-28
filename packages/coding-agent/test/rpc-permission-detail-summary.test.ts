/**
 * `PermissionAskDetail.summary` is documented as forwarded to an RPC client the same way it
 * reaches the TUI (`rpc-mode.ts`'s `createExtensionUIContext` threads `detail` through by
 * reference), while `RpcPermissionDetail` — the type an RPC client checks against — did not
 * declare the field. Regression for that drift: this drives the real RPC wire protocol (stdin
 * JSON lines in, stdout JSON lines out) and asserts `summary` actually arrives on an
 * `extension_ui_request`'s `detail`.
 */

import type { AgentTool } from "@draht/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/core/extensions/index.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarnessWithExtensions, type Harness } from "./test-harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const WAIT_TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 20000;

type ParsedOutputLine = Record<string, unknown>;

function parsedOutput(): ParsedOutputLine[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function findConfirmRequest(): ParsedOutputLine | undefined {
	return parsedOutput().find((line) => line.type === "extension_ui_request" && line.method === "confirm");
}

function send(line: object): void {
	if (!rpcIo.lineHandler) throw new Error("RPC line handler not attached");
	rpcIo.lineHandler(JSON.stringify(line));
}

describe("RPC permission detail summary", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it(
		"forwards detail.summary to the extension_ui_request wire, matching the TUI",
		async () => {
			const echoTool: AgentTool = {
				name: "echo",
				label: "Echo",
				description: "Echo back the given text",
				parameters: Type.Object({ text: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
			};

			const askingExtension = (pi: ExtensionAPI) => {
				pi.on(
					"tool_call",
					async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
						const approved = await ctx.ui.confirm("Approve tool call?", `${event.toolName}: needs approval`, {
							detail: {
								kind: "tool_permission",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								cwd: ctx.cwd,
								reason: "needs approval",
								options: [
									{ id: "allow", label: "Allow", decision: "approve" },
									{ id: "deny", label: "Deny", decision: "deny" },
								],
								summary: ["Plan: do the thing", "Step 1: do it"],
							},
						});
						if (!approved) return { block: true, reason: "User denied approval" };
						return undefined;
					},
				);
			};

			harness = await createHarnessWithExtensions({
				responses: [{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, "done"],
				tools: [echoTool],
				baseToolsOverride: { echo: echoTool },
				extensionFactories: [{ name: "asking", factory: askingExtension }],
			});

			const runtimeHost = {
				session: harness.session,
				newSession: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
				dispose: vi.fn(async () => {}),
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime;

			rpcIo.outputLines = [];
			rpcIo.lineHandler = undefined;
			void runRpcMode(runtimeHost);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });

			send({ id: "p1", type: "prompt", message: "use the tool" });
			await vi.waitFor(() => expect(findConfirmRequest()).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });

			const request = findConfirmRequest();
			expect(request?.detail).toMatchObject({ summary: ["Plan: do the thing", "Step 1: do it"] });

			send({ type: "extension_ui_response", id: request?.id, confirmed: true });
			await vi.waitFor(
				() => {
					const settled = parsedOutput().filter((line) => line.type === "agent_settled");
					expect(settled.length).toBeGreaterThan(0);
				},
				{ timeout: WAIT_TIMEOUT_MS },
			);
		},
		TEST_TIMEOUT_MS,
	);
});
