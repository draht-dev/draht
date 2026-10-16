/**
 * The child side of the permission bridge: a gate decision of `approve` in a process with no UI
 * goes to the parent instead of becoming a silent block, and only `unavailable` keeps the old block.
 */

import { describe, expect, it } from "vitest";
import { createPermissionGateToolCallHandler } from "../../src/core/builtins/subagent.ts";
import type { ExtensionContext, ToolCallEvent } from "../../src/core/extensions/types.ts";
import { PermissionGate } from "../../src/core/multi-agent/index.ts";
import type { ParentPermissionAsk, ParentPermissionBridge } from "../../src/core/polyphase/permission-bridge.ts";
import { type ChildPermissionVerdict, NO_UI_APPROVAL_SUFFIX } from "../../src/core/polyphase/types.ts";

function bashEvent(command: string): ToolCallEvent {
	return { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command } } as ToolCallEvent;
}

function headlessCtx(signal?: AbortSignal): ExtensionContext {
	return { cwd: "/project", hasUI: false, signal } as unknown as ExtensionContext;
}

function bridgeAnswering(verdict: ChildPermissionVerdict): {
	bridge: ParentPermissionBridge;
	asks: ParentPermissionAsk[];
} {
	const asks: ParentPermissionAsk[] = [];
	return {
		asks,
		bridge: {
			ask: async (ask) => {
				asks.push(ask);
				return verdict;
			},
		},
	};
}

const gate = () => new PermissionGate([], { cwd: "/project", mode: "default" });

describe("createPermissionGateToolCallHandler without a UI", () => {
	it("asks the parent and lets the call run once the parent approves", async () => {
		const { bridge, asks } = bridgeAnswering({ kind: "approved" });
		const handler = createPermissionGateToolCallHandler(gate(), { parentBridge: bridge });
		await expect(handler(bashEvent("npm test"), headlessCtx())).resolves.toBeUndefined();
		expect(asks).toEqual([{ toolName: "bash", toolCallId: "call-1", input: { command: "npm test" }, via: [] }]);
	});

	it("blocks with the parent's reason when the parent denies", async () => {
		const { bridge } = bridgeAnswering({ kind: "denied", reason: "Denied by the user in the parent session" });
		const handler = createPermissionGateToolCallHandler(gate(), { parentBridge: bridge });
		await expect(handler(bashEvent("npm test"), headlessCtx())).resolves.toEqual({
			block: true,
			reason: "Denied by the user in the parent session",
		});
	});

	it("keeps the old block, suffix included, when nobody could be asked", async () => {
		const { bridge } = bridgeAnswering({ kind: "unavailable" });
		const handler = createPermissionGateToolCallHandler(gate(), { parentBridge: bridge });
		const result = await handler(bashEvent("npm test"), headlessCtx());
		expect(result?.block).toBe(true);
		expect(result?.reason?.endsWith(NO_UI_APPROVAL_SUFFIX)).toBe(true);
	});

	it("keeps the old block when there is no bridge at all", async () => {
		const handler = createPermissionGateToolCallHandler(gate());
		const result = await handler(bashEvent("npm test"), headlessCtx());
		expect(result?.reason?.endsWith(NO_UI_APPROVAL_SUFFIX)).toBe(true);
	});

	it("does not call the call a refusal when the turn was aborted while waiting", async () => {
		const { bridge } = bridgeAnswering({ kind: "cancelled" });
		const handler = createPermissionGateToolCallHandler(gate(), { parentBridge: bridge });
		await expect(handler(bashEvent("npm test"), headlessCtx())).resolves.toEqual({
			block: true,
			reason: "the turn was aborted before this call was approved",
		});
	});

	it("never asks the parent about a call its own deny rule blocks", async () => {
		const { bridge, asks } = bridgeAnswering({ kind: "approved" });
		const denyGate = new PermissionGate([{ tool: "bash", pattern: "rm -rf *", action: "deny" }], {
			cwd: "/project",
			mode: "default",
		});
		const handler = createPermissionGateToolCallHandler(denyGate, { parentBridge: bridge });
		const result = await handler(bashEvent("rm -rf /"), headlessCtx());
		expect(result?.block).toBe(true);
		expect(asks).toHaveLength(0);
	});
});
