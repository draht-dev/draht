// Unit-level test for `packages/rlm-agent/src/extension.ts`'s default
// export: invokes the extension factory directly against a mock
// `ExtensionAPI` (fast, isolated -- no real coding-agent session, no
// filesystem/network/sandbox I/O) and asserts it registers the `/rlm`
// command and `rlm_query` tool with the expected shape.
//
// This is deliberately NOT the proof that the extension is actually
// reachable through the real, settings-driven package-resolution path --
// that's `test/real-session-loading.test.ts`, the mandatory test per
// .planning/phases/29-agent-cli-integration/29-01-PLAN.md's "IMPORTANT"
// section (the Phase 23 dead-code lesson: an extension factory that only
// ever runs against a mock is exactly the kind of "tested in isolation but
// never actually loaded" gap that phase's fix closed).

import type { ExtensionAPI, RegisteredCommand, ToolDefinition } from "@draht/coding-agent";
import { describe, expect, it, vi } from "vitest";
import rlmAgentExtension, { formatRlmResult } from "../src/extension.js";

/** Minimal mock covering only what `extension.ts`'s default export calls. */
function createMockPi() {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		}),
		registerCommand: vi.fn((name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, options);
		}),
	};

	return { pi: pi as unknown as ExtensionAPI, tools, commands };
}

describe("rlm-agent extension factory (mock ExtensionAPI)", () => {
	it("registers the rlm_query tool", () => {
		const { pi, tools } = createMockPi();
		rlmAgentExtension(pi);

		expect(tools.has("rlm_query")).toBe(true);
		const tool = tools.get("rlm_query")!;
		expect(tool.label).toBe("RLM Query");
		expect(typeof tool.execute).toBe("function");
	});

	it("registers the /rlm command", () => {
		const { pi, commands } = createMockPi();
		rlmAgentExtension(pi);

		expect(commands.has("rlm")).toBe(true);
		const command = commands.get("rlm")!;
		expect(command.description).toContain("Usage: /rlm <input> <query>");
		expect(typeof command.handler).toBe("function");
	});

	it("/rlm with no arguments shows a usage warning instead of throwing", async () => {
		const { pi, commands } = createMockPi();
		rlmAgentExtension(pi);
		const command = commands.get("rlm")!;

		const notify = vi.fn();
		const ctx = { cwd: "/tmp", ui: { notify } } as unknown as Parameters<typeof command.handler>[1];

		await expect(command.handler("", ctx)).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /rlm <input> <query>"), "warning");
	});

	it("/rlm with an input but no query shows a usage warning", async () => {
		const { pi, commands } = createMockPi();
		rlmAgentExtension(pi);
		const command = commands.get("rlm")!;

		const notify = vi.fn();
		const ctx = { cwd: "/tmp", ui: { notify } } as unknown as Parameters<typeof command.handler>[1];

		await expect(command.handler("some-file.md", ctx)).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "warning");
	});
});

describe("formatRlmResult", () => {
	it("returns the string value as-is for a final result", () => {
		expect(formatRlmResult({ kind: "final", value: "42", steps: 3, history: [] })).toBe("42");
	});

	it("JSON-stringifies a non-string final_var value", () => {
		expect(formatRlmResult({ kind: "final_var", value: { a: 1 }, steps: 2, history: [] })).toBe('{"a":1}');
	});

	it("describes a non-final outcome including step count and diagnostic value", () => {
		const text = formatRlmResult({ kind: "max_iterations", steps: 24, history: [] });
		expect(text).toContain("max_iterations");
		expect(text).toContain("24 steps");
	});

	it("uses singular 'step' for a single-step outcome", () => {
		const text = formatRlmResult({ kind: "timeout", value: "boom", steps: 1, history: [] });
		expect(text).toContain("1 step)");
		expect(text).toContain("boom");
	});
});
