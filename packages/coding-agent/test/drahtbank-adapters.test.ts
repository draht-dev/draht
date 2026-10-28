import { describe, expect, it } from "vitest";
import type { AdapterConfig } from "../eval/drahtbank/adapters.mjs";
import { buildInvocation, parseOutput } from "../eval/drahtbank/adapters.mjs";

const paths = {
	workspace: "/tmp/benchmark spaces/$(literal)",
	promptFile: "/tmp/prompt file.md",
	taskFile: "/tmp/task file.md",
	prompt: "Prompt text",
	task: "Task text",
};
const native: AdapterConfig = {
	format: "draht-jsonl",
	command: ["node", "/tools/draht.js"],
	provider: "test-provider",
	model: "test-model",
	settings: { thinking: "high" },
};
const usage = {
	input: 100,
	output: 20,
	cacheRead: 30,
	cacheWrite: 5,
	totalTokens: 155,
	cost: { input: 0.1, output: 0.02, cacheRead: 0.03, cacheWrite: 0.01, total: 0.16 },
};
function message(text = "Finished", stopReason = "stop", extra: Record<string, unknown> = {}) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason, usage, ...extra };
}
function jsonl(...events: unknown[]) {
	return events.map((event) => JSON.stringify(event)).join("\n");
}
function completed(...messages: unknown[]) {
	return jsonl({ type: "agent_start" }, ...messages.map((entry) => ({ type: "message_end", message: entry })), {
		type: "agent_end",
		messages,
	});
}

describe("drahtbank runner invocations", () => {
	it("builds an isolated native run with literal argv paths and settings", () => {
		const result = buildInvocation(native, paths);
		expect(result.stdin).toBe("");
		expect(result.command.slice(0, 2)).toEqual(native.command);
		for (const flag of [
			"--no-session",
			"--no-context-files",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-approve",
			"--offline",
		])
			expect(result.command).toContain(flag);
		expect(result.command.slice(-6)).toEqual([
			"--thinking",
			"high",
			"--append-system-prompt",
			paths.promptFile,
			"--",
			`@${paths.taskFile}`,
		]);
		expect(
			result.command.slice(result.command.indexOf("--provider"), result.command.indexOf("--provider") + 4),
		).toEqual(["--provider", native.provider, "--model", native.model]);
	});

	it.each([
		"--mode=json",
		"--system-prompt",
		"--model",
		"--thinking",
		"-p",
		"--",
		"--session",
		"-e",
		"--skill",
		"--tools",
		"--api-key",
		"@other.md",
	])("rejects native overrides: %s", (flag) => {
		expect(() => buildInvocation({ ...native, command: [...native.command, flag] }, paths)).toThrow(
			"controlled by drahtbank",
		);
	});

	it("rejects unsupported native settings and invalid thinking levels", () => {
		expect(() => buildInvocation({ ...native, settings: { temperature: 0 } }, paths)).toThrow(
			"Unsupported native runner setting",
		);
		expect(() => buildInvocation({ ...native, settings: { thinking: "ultra" } }, paths)).toThrow(
			"Invalid native thinking setting",
		);
	});

	it("passes generic settings and substitutes standalone file placeholders without a shell", () => {
		const result = buildInvocation(
			{
				...native,
				format: "json",
				settings: { temperature: 0 },
				command: ["adapter", "{workspace}", "{prompt}", "{task}"],
			},
			paths,
		);
		expect(result.command).toEqual(["adapter", paths.workspace, paths.promptFile, paths.taskFile]);
		expect(JSON.parse(result.stdin)).toEqual({
			...paths,
			provider: native.provider,
			model: native.model,
			settings: { temperature: 0 },
		});
		expect(() =>
			buildInvocation({ ...native, format: "json", command: ["adapter", "--prompt={prompt}"] }, paths),
		).toThrow("complete argument");
	});

	it.each([{ command: [] }, { command: [""] }, { command: ["node", "bad\0argument"] }])(
		"rejects malformed argv %j",
		({ command }) => {
			expect(() => buildInvocation({ ...native, command }, paths)).toThrow();
		},
	);
});

describe("drahtbank native telemetry", () => {
	it("counts authoritative assistant usage once and counts started tool calls", () => {
		const first = message("Inspecting", "toolUse");
		const last = message("Finished");
		const result = parseOutput(
			"draht-jsonl",
			jsonl(
				{ type: "session", id: "session" },
				{ type: "agent_start" },
				{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", delta: "Inspecting" } },
				{ type: "message_end", message: first },
				{ type: "turn_end", message: first, toolResults: [] },
				{ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: {} },
				{ type: "tool_execution_end", toolCallId: "tool-1", toolName: "read", result: {}, isError: false },
				{ type: "message_end", message: { role: "toolResult", usage, content: [] } },
				{ type: "message_end", message: last },
				{ type: "agent_end", messages: [first, last] },
			),
		);
		expect(result).toEqual({
			finalText: "Finished",
			usage: { inputTokens: 200, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 10, costUsd: 0.32 },
			toolCalls: 1,
			telemetrySource: "draht-events",
			error: null,
		});
	});

	it("keeps incomplete usage unknown rather than reporting a partial total", () => {
		const result = parseOutput(
			"draht-jsonl",
			completed(message("Inspecting", "toolUse", { usage: { input: 10 } }), message()),
		);
		expect(result.usage).toEqual({
			inputTokens: 110,
			outputTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			costUsd: null,
		});
		expect(result.toolCalls).toBe(0);
	});

	it.each(["error", "aborted"])("recognizes assistant %s despite a successful process exit", (reason) => {
		const result = parseOutput(
			"draht-jsonl",
			completed(message("", reason, { errorMessage: "provider unavailable" })),
		);
		expect(result.error).toBe("provider unavailable");
		expect(result.usage.inputTokens).toBe(100);
	});

	it("allows a recovered error while retaining usage from the failed attempt", () => {
		const result = parseOutput(
			"draht-jsonl",
			completed(message("", "error", { errorMessage: "retryable" }), message("Recovered")),
		);
		expect(result.error).toBeNull();
		expect(result.usage.outputTokens).toBe(40);
	});

	it.each(["length", "toolUse", "pending", "deferred"])("rejects an incomplete terminal reason: %s", (reason) => {
		expect(parseOutput("draht-jsonl", completed(message("Partial", reason))).error).toContain("no completed final");
	});

	it("does not accept an earlier final message after a new run starts or the stream truncates", () => {
		expect(
			parseOutput("draht-jsonl", `${completed(message())}\n${JSON.stringify({ type: "agent_start" })}`).error,
		).toContain("no completed final");
		expect(
			parseOutput(
				"draht-jsonl",
				`${completed(message())}\n${jsonl({ type: "agent_start" }, { type: "agent_end", messages: [] })}`,
			).error,
		).toContain("no completed final");
		expect(parseOutput("draht-jsonl", jsonl({ type: "message_end", message: message() })).error).toContain(
			"no completed final",
		);
		expect(parseOutput("draht-jsonl", completed(message("  "))).error).toContain("no completed final");
	});

	it("does not label partially captured provider usage as a complete total", () => {
		const result = parseOutput(
			"draht-jsonl",
			`${completed(message())}\n${jsonl({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } }, { type: "agent_end", messages: [] })}`,
		);
		expect(result.error).not.toBeNull();
		expect(result.usage.inputTokens).toBeNull();
	});

	it("preserves a streamed terminal error without a completed assistant message", () => {
		const result = parseOutput(
			"draht-jsonl",
			jsonl({
				type: "message_update",
				assistantMessageEvent: { type: "error", error: message("", "error", { errorMessage: "stream broke" }) },
			}),
		);
		expect(result.error).toBe("stream broke");
		expect(result.usage.inputTokens).toBeNull();
	});

	it.each(["", "not json", "null", "[]", '{"type":"message_end"}', '{"type":"tool_execution_start"}'])(
		"fails closed for incomplete or malformed native output: %s",
		(stdout) => {
			expect(parseOutput("draht-jsonl", stdout).error).not.toBeNull();
		},
	);

	it("rejects invalid telemetry rather than coercing it", () => {
		expect(parseOutput("draht-jsonl", completed(message("done", "stop", { usage: { input: -1 } }))).error).toContain(
			"usage.input",
		);
		expect(
			parseOutput("draht-jsonl", completed(message("done", "stop", { usage: { input: "12" } }))).error,
		).toContain("usage.input");
	});
});

describe("drahtbank generic telemetry", () => {
	it("records missing metrics as unknown", () => {
		const result = parseOutput("json", JSON.stringify({ finalText: "Done" }));
		expect(result).toEqual({
			finalText: "Done",
			usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null },
			toolCalls: null,
			telemetrySource: "adapter-reported",
			error: null,
		});
	});

	it("accepts explicitly reported zero values and errors", () => {
		expect(
			parseOutput("json", JSON.stringify({ finalText: "Done", usage: { inputTokens: 0, costUsd: 0 }, toolCalls: 0 }))
				.usage.inputTokens,
		).toBe(0);
		expect(parseOutput("json", JSON.stringify({ finalText: "", error: "Unavailable model" })).error).toBe(
			"Unavailable model",
		);
	});

	it.each([
		{},
		{ finalText: "" },
		{ finalText: 1 },
		{ finalText: "Done", usage: [] },
		{ finalText: "Done", usage: { inputTokens: -1 } },
		{ finalText: "Done", usage: { outputTokens: 1.5 } },
		{ finalText: "Done", usage: { outputTokens: "10" } },
		{ finalText: "Done", usage: { totalTokens: 10 } },
		{ finalText: "Done", toolCalls: -1 },
		{ finalText: "Done", toolCalls: 1.5 },
		{ finalText: "Done", error: true },
		{ finalText: "Done", unrecognized: 1 },
	])("rejects malformed adapter envelope %j", (output) => {
		expect(parseOutput("json", JSON.stringify(output)).error).not.toBeNull();
	});
});
