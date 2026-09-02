/**
 * G2 regression: aborting while a permission ask is outstanding must not wedge
 * the agent.
 *
 * RPC mode parks the agent loop in `beforeToolCall` while an extension awaits
 * `ctx.ui.confirm(...)` (this is exactly what the permission gate does — see
 * `createPermissionGateToolCallHandler` in src/core/builtins/subagent.ts). The
 * dialog promise lives in `pendingExtensionRequests` inside `runRpcMode`, and
 * an `abort` command used to leave it there untouched: the loop never resumed,
 * `session.abort()` never saw idle, and the session was dead for good.
 *
 * These tests drive the real RPC wire protocol (stdin JSON lines in, stdout
 * JSON lines out) — no direct calls into rpc-mode internals.
 *
 * Every wait here is bounded so a regression fails fast instead of hanging the
 * suite.
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

/** Bound on every wait: a wedge must surface as a failure, never as a hang. */
const WAIT_TIMEOUT_MS = 5000;
const TEST_TIMEOUT_MS = 20000;

type ParsedOutputLine = Record<string, unknown>;

function parsedOutput(): ParsedOutputLine[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function confirmRequestIds(): string[] {
	return parsedOutput()
		.filter((line) => line.type === "extension_ui_request" && line.method === "confirm")
		.map((line) => line.id as string);
}

function findConfirmRequest(): ParsedOutputLine | undefined {
	return parsedOutput().find((line) => line.type === "extension_ui_request" && line.method === "confirm");
}

function findResponse(id: string, command: string): ParsedOutputLine | undefined {
	return parsedOutput().find((line) => line.id === id && line.type === "response" && line.command === command);
}

function send(line: object): void {
	if (!rpcIo.lineHandler) throw new Error("RPC line handler not attached");
	rpcIo.lineHandler(JSON.stringify(line));
}

function toolResultTexts(harness: Harness): string[] {
	const texts: string[] = [];
	for (const message of harness.session.messages) {
		if (message.role !== "toolResult") continue;
		for (const part of message.content ?? []) {
			if (part.type === "text") texts.push(part.text);
		}
	}
	return texts;
}

function assistantTexts(harness: Harness): string[] {
	const texts: string[] = [];
	for (const message of harness.session.messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content ?? []) {
			if (part.type === "text") texts.push(part.text);
		}
	}
	return texts;
}

describe("RPC abort with a pending permission ask", () => {
	let harness: Harness | undefined;
	let toolExecutions = 0;
	let confirmResults: Array<boolean> = [];

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		toolExecutions = 0;
		confirmResults = [];
	});

	async function startRpc(): Promise<void> {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back the given text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecutions++;
				return { content: [{ type: "text", text: "echoed" }], details: {} };
			},
		};

		// A faithful stand-in for the permission gate: block unless the user confirms.
		const askingExtension = (pi: ExtensionAPI) => {
			pi.on(
				"tool_call",
				async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
					const approved = await ctx.ui.confirm("Approve tool call?", `${event.toolName}: needs approval`);
					confirmResults.push(approved);
					if (!approved) return { block: true, reason: "User denied approval" };
					return undefined;
				},
			);
		};

		harness = await createHarnessWithExtensions({
			responses: [{ toolCalls: [{ name: "echo", args: { text: "hi" } }] }, "recovered"],
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
	}

	it(
		"resolves the pending dialog, skips the tool, and leaves the session usable",
		async () => {
			await startRpc();
			const session = harness!.session;

			// 1. Prompt -> model asks for the tool -> extension parks on ui.confirm.
			send({ id: "p1", type: "prompt", message: "use the tool" });
			await vi.waitFor(() => expect(findConfirmRequest()).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });
			expect(toolExecutions).toBe(0);
			expect(confirmResults).toEqual([]);

			// 2. Abort while the ask is still outstanding.
			send({ id: "a1", type: "abort" });

			// (a) The abort command itself completes — it cannot complete unless the
			//     dialog resolved and the agent loop unwound to idle.
			await vi.waitFor(
				() => {
					expect(findResponse("a1", "abort")).toMatchObject({ success: true });
				},
				{ timeout: WAIT_TIMEOUT_MS },
			);

			// (a') The dialog promise actually settled.
			expect(confirmResults).toEqual([false]);

			// (b) The tool did not execute. Fail closed.
			expect(toolExecutions).toBe(0);

			// (c) The loop unwound.
			await vi.waitFor(() => expect(session.isStreaming).toBe(false), { timeout: WAIT_TIMEOUT_MS });

			// A follow-up turn works end to end: the session is not wedged, and the
			// dialog channel still carries a real answer rather than the dead id.
			const abortedAskId = confirmRequestIds()[0];
			rpcIo.outputLines = [];
			send({ id: "p2", type: "prompt", message: "try again" });
			await vi.waitFor(
				() => {
					expect(findResponse("p2", "prompt")).toMatchObject({ success: true });
				},
				{ timeout: WAIT_TIMEOUT_MS },
			);
			await vi.waitFor(() => expect(confirmRequestIds()).toHaveLength(1), { timeout: WAIT_TIMEOUT_MS });
			const freshAskId = confirmRequestIds()[0];
			expect(freshAskId).not.toBe(abortedAskId);

			send({ type: "extension_ui_response", id: freshAskId, confirmed: true });
			await vi.waitFor(
				() => {
					const settled = parsedOutput().filter((line) => line.type === "agent_settled");
					expect(settled.length).toBeGreaterThan(0);
				},
				{ timeout: WAIT_TIMEOUT_MS },
			);

			expect(confirmResults).toEqual([false, true]);
			expect(toolExecutions).toBe(1);
			expect(assistantTexts(harness!).join("\n")).toContain("recovered");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"records the skipped call as aborted, not as a user denial",
		async () => {
			await startRpc();

			send({ id: "p1", type: "prompt", message: "use the tool" });
			await vi.waitFor(() => expect(findConfirmRequest()).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });

			send({ id: "a1", type: "abort" });
			await vi.waitFor(
				() => {
					expect(findResponse("a1", "abort")).toMatchObject({ success: true });
				},
				{ timeout: WAIT_TIMEOUT_MS },
			);

			await vi.waitFor(
				() => {
					expect(toolResultTexts(harness!).length).toBeGreaterThan(0);
				},
				{ timeout: WAIT_TIMEOUT_MS },
			);
			const texts = toolResultTexts(harness!).join("\n");
			expect(texts).toContain("Operation aborted");
			expect(texts).not.toContain("User denied approval");
		},
		TEST_TIMEOUT_MS,
	);
});
