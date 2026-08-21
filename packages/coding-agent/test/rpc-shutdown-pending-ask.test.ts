/**
 * G3 regression: a dying relay bridge must not silently kill a pending
 * permission ask.
 *
 * RPC mode treats stdin EOF as "my parent went away, terminate" — see the
 * `process.stdin.on("end", ...)` wiring at the bottom of `runRpcMode`. That is
 * the correct and documented lifecycle for an RPC child (`rpc-client.ts` also
 * SIGTERMs, and both funnel into the same `shutdown()`), so these tests do NOT
 * ask the agent to stay alive. They ask only that the shutdown be *clean*:
 *
 *   - every outstanding `extension_ui_request` resolves fail-closed (denied /
 *     cancelled, never approved) BEFORE the process exits,
 *   - no tool executes off a promise that was about to be garbage,
 *   - the session records the skipped call rather than leaving it dangling,
 *   - and a normal stdin close with nothing pending still terminates exactly
 *     as it always did.
 *
 * These tests drive the RPC wire protocol (JSON lines in via the reader
 * `runRpcMode` attaches, JSON lines out via `writeRawStdout`) and the real
 * stdin `end` listener that `runRpcMode` itself registers — no direct calls
 * into rpc-mode internals.
 *
 * Why a sibling file rather than `rpc-abort-pending-ask.test.ts` (G2's): this
 * file has to stub `process.exit`, or `shutdown()` would take the vitest worker
 * down with it, and it has to sweep the stdin `end` listeners it installs. Both
 * are module-wide changes that would silently alter the environment G2's abort
 * tests run in.
 *
 * Every wait here is bounded so a wedge fails fast instead of hanging the suite.
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
type NodeListener = (...args: unknown[]) => void;

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

describe("RPC shutdown on stdin close with a pending permission ask", () => {
	let harness: Harness | undefined;
	let toolExecutions = 0;
	let confirmResults: boolean[] = [];
	/** Ordered log of lifecycle milestones, so we can assert what happened before the exit. */
	let lifecycle: string[] = [];
	// Only ever restored, never inspected — a structural type keeps this from
	// fighting vitest's MockInstance generics over `process.exit`'s `never`.
	let exitSpy: { mockRestore: () => void } | undefined;
	let installedEndListeners: NodeListener[] = [];
	let disposeMock: ReturnType<typeof vi.fn> | undefined;

	afterEach(() => {
		for (const listener of installedEndListeners) {
			process.stdin.off("end", listener);
		}
		installedEndListeners = [];
		exitSpy?.mockRestore();
		exitSpy = undefined;
		harness?.cleanup();
		harness = undefined;
		disposeMock = undefined;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		toolExecutions = 0;
		confirmResults = [];
		lifecycle = [];
	});

	/**
	 * Boot rpc-mode over the mocked wire and hand back the stdin `end` listener
	 * that `runRpcMode` registered — invoking it is exactly what Node does when
	 * the parent end of the pipe (the relay bridge) goes away.
	 */
	async function startRpc(): Promise<{ onStdinEnd: NodeListener }> {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo back the given text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				toolExecutions++;
				lifecycle.push("tool:executed");
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
					lifecycle.push(`confirm:resolved:${approved}`);
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

		disposeMock = vi.fn(async () => {
			lifecycle.push("runtime:disposed");
		});

		const runtimeHost = {
			session: harness.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: disposeMock,
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		// `shutdown()` ends in process.exit; without this the worker dies.
		exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			lifecycle.push(`process:exit:${code ?? 0}`);
			return undefined as never;
		}) as typeof process.exit);

		const endListenersBefore = new Set(process.stdin.listeners("end") as NodeListener[]);

		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });

		const onStdinEnd = (process.stdin.listeners("end") as NodeListener[]).find(
			(listener) => !endListenersBefore.has(listener),
		);
		if (!onStdinEnd) throw new Error("runRpcMode did not register a stdin 'end' listener");
		installedEndListeners.push(onStdinEnd);
		return { onStdinEnd };
	}

	it(
		"fails the pending ask closed, runs no tool, and only then exits",
		async () => {
			const { onStdinEnd } = await startRpc();

			// 1. Prompt -> model asks for the tool -> extension parks on ui.confirm.
			send({ id: "p1", type: "prompt", message: "use the tool" });
			await vi.waitFor(() => expect(findConfirmRequest()).toBeDefined(), { timeout: WAIT_TIMEOUT_MS });
			expect(toolExecutions).toBe(0);
			expect(confirmResults).toEqual([]);

			// 2. The relay bridge dies: our end of the pipe sees EOF.
			onStdinEnd();

			// (a) The process still terminates — the lifecycle is preserved.
			await vi.waitFor(() => expect(lifecycle).toContain("process:exit:0"), { timeout: WAIT_TIMEOUT_MS });

			// (b) The dialog actually settled, and settled *denied*. Fail closed.
			expect(confirmResults).toEqual([false]);

			// (c) No tool ran off the promise that was about to be garbage.
			expect(toolExecutions).toBe(0);
			expect(lifecycle).not.toContain("tool:executed");

			// (d) Ordering is the whole point: the ask resolved, and the runtime was
			//     disposed (which is what persists the session), before the exit.
			const exitAt = lifecycle.indexOf("process:exit:0");
			expect(lifecycle.indexOf("confirm:resolved:false")).toBeGreaterThan(-1);
			expect(lifecycle.indexOf("confirm:resolved:false")).toBeLessThan(exitAt);
			expect(lifecycle.indexOf("runtime:disposed")).toBeGreaterThan(-1);
			expect(lifecycle.indexOf("runtime:disposed")).toBeLessThan(exitAt);

			// (e) The session recorded the outcome rather than leaving it dangling.
			await vi.waitFor(() => expect(toolResultTexts(harness!).length).toBeGreaterThan(0), {
				timeout: WAIT_TIMEOUT_MS,
			});
			const texts = toolResultTexts(harness!).join("\n");
			expect(texts).toContain("Operation aborted");
			expect(texts).not.toContain("echoed");

			// (f) Nothing is left waiting on the wire.
			expect(harness!.session.isStreaming).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"still terminates on a plain stdin close with nothing pending",
		async () => {
			const { onStdinEnd } = await startRpc();

			// No prompt, no dialog: the ordinary "parent closed my stdin" teardown.
			onStdinEnd();

			await vi.waitFor(() => expect(lifecycle).toContain("process:exit:0"), { timeout: WAIT_TIMEOUT_MS });
			expect(disposeMock).toHaveBeenCalledTimes(1);
			expect(lifecycle.indexOf("runtime:disposed")).toBeLessThan(lifecycle.indexOf("process:exit:0"));
			expect(confirmResults).toEqual([]);
			expect(toolExecutions).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});
