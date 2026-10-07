import { describe, expect, it, vi } from "vitest";
import { createPermissionGateToolCallHandler, createSubagentExtension } from "../../src/core/builtins/subagent.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIDialogOptions,
	ToolCallEvent,
} from "../../src/core/extensions/types.ts";
import { PermissionGate } from "../../src/core/multi-agent/index.ts";

const VALID_WORKFLOW_SCRIPT = [
	"export const meta = {",
	'  name: "review-pr",',
	'  description: "Review a change in parallel",',
	'  phases: [{ title: "Scan" }, { title: "Review" }],',
	"};",
	"",
	'agent("reviewer", "look at the diff");',
	"",
].join("\n");

function fakeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: "/fake/cwd",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: {} as ExtensionContext["sessionManager"],
		signal: undefined,
		mode: "tui",
		ui: { confirm: vi.fn(async () => true) } as unknown as ExtensionContext["ui"],
		...overrides,
	} as unknown as ExtensionContext;
}

function workflowEvent(input: Record<string, unknown> = { script: VALID_WORKFLOW_SCRIPT }): ToolCallEvent {
	return { type: "tool_call", toolCallId: "1", toolName: "workflow", input } as unknown as ToolCallEvent;
}

function bashEvent(): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "2",
		toolName: "bash",
		input: { command: "ls" },
	} as unknown as ToolCallEvent;
}

describe("createPermissionGateToolCallHandler", () => {
	it("passes the describe title/message/operation to confirm and calls beforePrompt first", async () => {
		const order: string[] = [];
		const confirm = vi.fn(async (_title: string, _message: string, _opts?: ExtensionUIDialogOptions) => {
			order.push("confirm");
			return true;
		});
		const ctx = fakeCtx({ ui: { confirm } as unknown as ExtensionContext["ui"] });
		const gate = new PermissionGate([], { cwd: ctx.cwd, mode: "default" });

		const handler = createPermissionGateToolCallHandler(gate, {
			describe: () => ({
				title: "Run workflow?",
				message: "Does things\nPhases: 1 Scan · 2 Check",
				operation: "workflow x: A -> B",
			}),
			beforePrompt: () => {
				order.push("beforePrompt");
			},
		});

		const result = await handler(workflowEvent(), ctx);
		expect(result).toBeUndefined();
		expect(order).toEqual(["beforePrompt", "confirm"]);
		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, message, options] = confirm.mock.calls[0];
		expect(title).toBe("Run workflow?");
		expect(message).toContain("Does things");
		expect(message).toContain("no rule matched");
		expect(options?.detail?.operation).toBe("workflow x: A -> B");
		// `description.message` must also reach the typed detail, not just the positional `message`
		// string the TUI's confirm path drops whenever a `detail` is present.
		expect(options?.detail?.summary).toEqual(["Does things", "Phases: 1 Scan · 2 Check"]);
	});

	it("blocks with the no-UI suffix when there is no answering surface", async () => {
		const ctx = fakeCtx({ hasUI: false });
		const gate = new PermissionGate([], { cwd: ctx.cwd, mode: "default" });
		const handler = createPermissionGateToolCallHandler(gate);

		const result = await handler(workflowEvent(), ctx);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/\(no UI available to request approval\)$/);
	});

	it("allows yolo-mode approvals without prompting", async () => {
		const confirm = vi.fn(async () => true);
		const ctx = fakeCtx({ ui: { confirm } as unknown as ExtensionContext["ui"] });
		const gate = new PermissionGate([], { cwd: ctx.cwd, mode: "yolo" });
		const handler = createPermissionGateToolCallHandler(gate, { describe: () => undefined });

		const result = await handler(workflowEvent(), ctx);
		expect(result).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("subagent factory tool_call wiring", () => {
	function captureToolCallHandler(getSettings: ReturnType<typeof vi.fn>) {
		let handler: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;
		const fakePi = {
			registerTool: () => {},
			registerCommand: () => {},
			getSettings,
			on: (event: string, fn: unknown) => {
				if (event === "tool_call") handler = fn as typeof handler;
			},
		} as unknown as ExtensionAPI;
		createSubagentExtension()(fakePi);
		if (!handler) throw new Error("subagent registered no tool_call handler");
		return handler;
	}

	it("describes a workflow call with inline meta", async () => {
		const getSettings = vi.fn(() => ({}));
		const handler = captureToolCallHandler(getSettings);
		const confirm = vi.fn(async (_title: string, _message: string, _opts?: ExtensionUIDialogOptions) => true);
		const ctx = fakeCtx({ ui: { confirm } as unknown as ExtensionContext["ui"] });

		await handler(workflowEvent(), ctx);

		expect(getSettings).toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledTimes(1);
		const [title] = confirm.mock.calls[0];
		expect(title).toBe('Run workflow "review-pr"?');
	});

	it("never calls pi.getSettings for a bash call", async () => {
		const getSettings = vi.fn(() => ({}));
		const handler = captureToolCallHandler(getSettings);
		const confirm = vi.fn(async () => true);
		const ctx = fakeCtx({ ui: { confirm } as unknown as ExtensionContext["ui"] });

		await handler(bashEvent(), ctx);

		expect(getSettings).not.toHaveBeenCalled();
	});
});
