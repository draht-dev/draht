import { describe, expect, it } from "vitest";
import {
	billableTokens,
	ChildEventReducer,
	type ChildWireRecord,
	extractStatusLine,
	parseChildLine,
	summarizeToolArgs,
	toRunResult,
} from "../../src/core/polyphase/child-events.ts";
import {
	currentPolyphaseDepth,
	POLYPHASE_DEPTH_ENV,
	POLYPHASE_RESULT_TOOL_NAME,
} from "../../src/core/polyphase/types.ts";
import * as wire from "./helpers/wire.ts";

function createReducer(overrides: Partial<{ limits: Record<string, number>; now: () => number }> = {}) {
	return new ChildEventReducer({
		model: { source: "inherited", confirmed: false },
		limits: overrides.limits,
		now: overrides.now,
	});
}

describe("parseChildLine", () => {
	it("returns undefined for malformed JSON", () => {
		expect(parseChildLine("not json")).toBeUndefined();
	});

	it("returns undefined for a value without a string type", () => {
		expect(parseChildLine("42")).toBeUndefined();
		expect(parseChildLine("{}")).toBeUndefined();
		expect(parseChildLine('{"type":1}')).toBeUndefined();
	});

	it("parses a valid record", () => {
		expect(parseChildLine('{"type":"agent_start"}')).toEqual({ type: "agent_start" });
	});
});

describe("summarizeToolArgs", () => {
	it("prefers known keys", () => {
		expect(summarizeToolArgs("bash", { command: "npm test" })).toBe("npm test");
		expect(summarizeToolArgs("read", { path: "a.ts", other: 1 })).toBe("a.ts");
	});

	it("falls back to compact JSON", () => {
		expect(summarizeToolArgs("x", { a: 1 })).toBe('{"a":1}');
		expect(summarizeToolArgs("x", undefined)).toBe("");
	});

	it("truncates to 120 chars", () => {
		const long = "y".repeat(200);
		const result = summarizeToolArgs("bash", { command: long });
		expect(result.length).toBe(120);
		expect(result.endsWith("…")).toBe(true);
	});

	it("collapses a multi-line command onto one line", () => {
		const result = summarizeToolArgs("bash", { command: "cat <<EOF\nhello\nEOF" });
		expect(result).toBe("cat <<EOF hello EOF");
		expect(result).not.toContain("\n");
	});
});

describe("extractStatusLine", () => {
	it("returns the last STATUS line, trimmed", () => {
		const text = "noise\nSTATUS: first\nmore\nSTATUS:  second  \n";
		expect(extractStatusLine(text)).toBe("STATUS:  second");
	});

	it("returns undefined when absent", () => {
		expect(extractStatusLine("no status here")).toBeUndefined();
	});
});

describe("billableTokens", () => {
	it("sums input+output+cacheWrite, excluding cacheRead", () => {
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 100,
			cacheWrite: 3,
			totalTokens: 118,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(billableTokens(usage)).toBe(18);
	});

	it("returns 0 for undefined", () => {
		expect(billableTokens(undefined)).toBe(0);
	});
});

describe("ChildEventReducer", () => {
	it("confirms the model from message_start and thinkingLevel from message_end", () => {
		const reducer = createReducer();
		reducer.apply(wire.assistantStart("anthropic", "claude-sonnet-5"));
		expect(reducer.state.model.confirmed).toBe(true);
		expect(reducer.state.model.provider).toBe("anthropic");
		expect(reducer.state.model.id).toBe("claude-sonnet-5");

		reducer.apply(wire.assistantEnd({ thinkingLevel: "high" }));
		expect(reducer.state.model.thinkingLevel).toBe("high");
	});

	it("adds a model-switched notice when a later message_start reports a different model", () => {
		const reducer = createReducer();
		reducer.apply(wire.assistantStart("anthropic", "claude-sonnet-5"));
		reducer.apply(wire.assistantEnd());
		reducer.apply(wire.assistantStart("anthropic", "claude-opus-5"));

		expect(reducer.state.model.id).toBe("claude-opus-5");
		const notice = reducer.state.transcript.find(
			(item) => item.kind === "notice" && item.text.includes("model switched"),
		);
		expect(notice).toBeDefined();
	});

	it("accumulates thinking and text with per-item tail caps and droppedChars", () => {
		const reducer = createReducer({ limits: { maxItemChars: 10 } });
		reducer.apply(wire.thinkingStart(0));
		reducer.apply(wire.thinkingDelta(0, "0123456789"));
		reducer.apply(wire.thinkingDelta(0, "ABCDE"));
		const item = reducer.state.transcript.find((i) => i.kind === "thinking");
		expect(item?.kind).toBe("thinking");
		if (item?.kind === "thinking") {
			expect(item.text.length).toBe(10);
			expect(item.text).toBe("56789ABCDE");
			expect(item.droppedChars).toBe(5);
		}

		reducer.apply(wire.thinkingEnd(0, "final content here"));
		const final = reducer.state.transcript.find((i) => i.kind === "thinking");
		expect(final?.kind === "thinking" && final.done).toBe(true);
	});

	it("sets droppedChars from the final content on thinking_end, not the sum of delta caps", () => {
		const reducer = createReducer({ limits: { maxItemChars: 10 } });
		reducer.apply(wire.thinkingStart(0));
		reducer.apply(wire.thinkingDelta(0, "0123456789abcde"));
		reducer.apply(wire.thinkingEnd(0, "0123456789abcde"));
		const item = reducer.state.transcript.find((i) => i.kind === "thinking");
		expect(item?.kind === "thinking" && item.droppedChars).toBe(5);
	});

	it("tail-caps a text item with droppedChars", () => {
		const reducer = createReducer({ limits: { maxItemChars: 10 } });
		reducer.apply(wire.textStart(0));
		reducer.apply(wire.textDelta(0, "0123456789"));
		reducer.apply(wire.textDelta(0, "ABCDE"));
		const item = reducer.state.transcript.find((i) => i.kind === "text");
		expect(item?.kind === "text" && item.text).toBe("56789ABCDE");
		expect(item?.kind === "text" && item.droppedChars).toBe(5);
	});

	it("marks redacted thinking", () => {
		const reducer = createReducer();
		reducer.apply(wire.thinkingStart(0));
		reducer.apply(wire.thinkingEnd(0, "[Reasoning redacted]"));
		const item = reducer.state.transcript.find((i) => i.kind === "thinking");
		expect(item?.kind === "thinking" && item.redacted).toBe(true);
	});

	it("tracks tool lifecycle, toolCounts, and nowLine", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolcallStart("t1", "bash"));
		reducer.apply(wire.toolcallEnd("t1", "bash", { command: "npm test" }));
		reducer.apply(wire.toolStart("t1", "bash", { command: "npm test" }));
		expect(reducer.state.toolCounts.bash).toBe(1);
		expect(reducer.state.currentTool?.name).toBe("bash");
		expect(reducer.state.nowLine).toContain("bash");
		expect(reducer.state.nowLine).toContain("npm test");

		reducer.apply(wire.toolEnd("t1", "bash", "ok output", false));
		const item = reducer.state.transcript.find((i) => i.kind === "tool");
		expect(item?.kind === "tool" && item.status).toBe("ok");
		expect(reducer.state.currentTool).toBeUndefined();
	});

	it("detects a blocked tool call", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolStart("t1", "write_file", { path: "a.ts" }));
		reducer.apply(wire.blockedToolEnd("t1", "write_file", "needs approval"));

		expect(reducer.state.blockedCount).toBe(1);
		expect(reducer.state.blocked).toHaveLength(1);
		expect(reducer.state.blocked[0]?.toolName).toBe("write_file");
		const item = reducer.state.transcript.find((i) => i.kind === "tool");
		expect(item?.kind === "tool" && item.status).toBe("blocked");
		const notice = reducer.state.transcript.find((i) => i.kind === "notice" && i.text.includes("blocked"));
		expect(notice).toBeDefined();
		expect(reducer.state.nowLine).toContain("⚠");
		expect(reducer.state.nowLine).toContain("blocked");
	});

	it("clears the blocked warning once the agent settles", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolStart("t1", "bash", { command: "ls" }));
		reducer.apply(wire.blockedToolEnd("t1", "bash", "needs approval"));
		expect(reducer.state.nowLine).toContain("⚠");

		reducer.apply(wire.textStart(0));
		reducer.apply(wire.textDelta(0, "hello"));
		reducer.apply(wire.settled());
		expect(reducer.state.nowLine).toBe("finished");
	});

	it("shows the tool whose execution actually started, not the last declared call, for a multi-tool message", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolcallStart("a", "bash", 0));
		reducer.apply(wire.toolcallEnd("a", "bash", { command: "ls" }, 0));
		reducer.apply(wire.toolcallStart("b", "read", 1));
		reducer.apply(wire.toolcallEnd("b", "read", { path: "x.ts" }, 1));

		reducer.apply(wire.toolStart("a", "bash", { command: "ls" }));
		expect(reducer.state.currentTool?.name).toBe("bash");
		expect(reducer.state.nowLine).toContain("bash");
		expect(reducer.state.nowLine).not.toContain("read");
	});

	it("captures polyphase_result structured output", () => {
		const reducer = createReducer();
		const args = { ok: true, score: 7 };
		for (const record of wire.resultToolCall("t1", args)) {
			reducer.apply(record);
		}
		expect(reducer.state.structured).toEqual({ value: args });
	});

	it("records retry notices and activity", () => {
		const reducer = createReducer();
		reducer.apply(wire.autoRetryStart(1, 3, 500, "network error"));
		expect(reducer.state.activity).toBe("retrying");
		expect(reducer.state.retry?.attempt).toBe(1);
		expect(reducer.state.nowLine).toContain("retrying");
		expect(reducer.state.transcript.some((item) => item.kind === "notice" && item.text.includes("retrying"))).toBe(
			true,
		);

		reducer.apply(wire.autoRetryEnd(true, 1));
		expect(reducer.state.retry).toBeUndefined();
		expect(reducer.state.activity).toBe("idle");
		expect(
			reducer.state.transcript.some((item) => item.kind === "notice" && item.text.includes("retry succeeded")),
		).toBe(true);
	});

	it("keeps the retrying prefix on nowLine when the retry error is long", () => {
		const reducer = createReducer();
		const longError = `Provider returned 529 overloaded_error: ${"the service is temporarily overloaded. ".repeat(10)}`;
		expect(longError.length).toBeGreaterThan(160);
		reducer.apply(wire.autoRetryStart(1, 3, 500, longError));
		expect(reducer.state.nowLine.startsWith("retrying 1/3")).toBe(true);
		expect(reducer.state.nowLine.length).toBeLessThanOrEqual(160);
	});

	it("adds an ellipsis when clampHead truncates a long retry error instead of cutting it silently", () => {
		const reducer = createReducer();
		const longError = "e".repeat(400);
		reducer.apply(wire.autoRetryStart(1, 3, 500, longError));
		expect(reducer.state.nowLine.length).toBeLessThanOrEqual(160);
		expect(reducer.state.nowLine.endsWith("…")).toBe(true);
	});

	it("records compaction notices and activity", () => {
		const reducer = createReducer();
		reducer.apply(wire.compactionStart("manual"));
		expect(reducer.state.activity).toBe("compacting");
		expect(reducer.state.nowLine).toBe("compacting context");
		expect(
			reducer.state.transcript.some((item) => item.kind === "notice" && item.text.includes("compacting context")),
		).toBe(true);

		reducer.apply(wire.compactionEnd());
		expect(reducer.state.activity).toBe("idle");
		expect(
			reducer.state.transcript.some((item) => item.kind === "notice" && item.text.includes("compaction finished")),
		).toBe(true);
	});

	it("keeps the tool name/summary label on nowLine for a multi-line command", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolStart("t1", "bash", { command: "cd x\nnpm test" }));
		expect(reducer.state.nowLine).toBe("bash cd x npm test");
	});

	it("keeps nowLine content after text_end/thinking_end instead of going blank", () => {
		const reducer = createReducer();
		reducer.apply(wire.textStart(0));
		reducer.apply(wire.textDelta(0, "hello"));
		reducer.apply(wire.textEnd(0, "hello"));
		expect(reducer.state.nowLine).toBe("writing · hello");
	});

	it("keeps showing the last non-empty line of thinking while streaming across a paragraph break", () => {
		const reducer = createReducer();
		reducer.apply(wire.thinkingStart(0));
		reducer.apply(wire.thinkingDelta(0, "first paragraph"));
		reducer.apply(wire.thinkingDelta(0, "\n\n"));
		expect(reducer.state.nowLine).toBe("thinking · first paragraph");
	});

	it("keys pending structured output by toolCallId so parallel polyphase_result calls do not clash", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolStart("t1", POLYPHASE_RESULT_TOOL_NAME, { a: 1 }));
		reducer.apply(wire.toolStart("t2", POLYPHASE_RESULT_TOOL_NAME, { b: 2 }));
		reducer.apply(wire.toolEnd("t1", POLYPHASE_RESULT_TOOL_NAME, JSON.stringify({ a: 1 }), false));
		expect(reducer.state.structured).toEqual({ value: { a: 1 } });
		reducer.apply(wire.toolEnd("t2", POLYPHASE_RESULT_TOOL_NAME, JSON.stringify({ b: 2 }), false));
		expect(reducer.state.structured).toEqual({ value: { b: 2 } });
	});

	it("sums usage across assistant turns via combineUsage", () => {
		const reducer = createReducer();
		reducer.apply(wire.assistantEnd({ usage: wire.usage(5, 5, 0.01) }));
		reducer.apply(wire.assistantEnd({ usage: wire.usage(3, 2, 0.02) }));
		expect(reducer.state.usage).toEqual({
			input: 8,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0.03, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		});
	});

	it("counts a tool named after an Object.prototype member without pollution", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolStart("t1", "constructor", {}));
		expect(reducer.state.toolCounts.constructor).toBe(1);
		reducer.apply(wire.toolStart("t2", "constructor", {}));
		expect(reducer.state.toolCounts.constructor).toBe(2);
	});

	it("counts malformed records without throwing", () => {
		const reducer = createReducer();
		const malformed = { type: "message_update" } as unknown as ChildWireRecord;
		const change = reducer.apply(malformed);
		expect(change).toBe("none");
		expect(reducer.state.malformedLines).toBe(1);
	});

	it("hardens against a thinking_end record whose content is not a string, without poisoning transcriptChars", () => {
		const reducer = createReducer();
		reducer.apply(wire.thinkingStart(0));
		const badThinkingEnd = {
			type: "message_update",
			usage: wire.usage(0, 0, 0),
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: 5 },
		} as unknown as ChildWireRecord;
		const change = reducer.apply(badThinkingEnd);
		expect(change).toBe("none");
		expect(reducer.state.malformedLines).toBe(1);
		expect(Number.isFinite(reducer.state.transcriptChars)).toBe(true);
		const thinkingItem = reducer.state.transcript.find((i) => i.kind === "thinking");
		expect(thinkingItem?.kind === "thinking" && thinkingItem.text).toBe("");

		reducer.apply(wire.textStart(0));
		reducer.apply(wire.textDelta(0, "ok"));
		const item = reducer.state.transcript.find((i) => i.kind === "text");
		expect(item?.kind === "text" && item.text).toBe("ok");
	});

	it("hardens against a thinking_delta record whose delta is not a string", () => {
		const reducer = createReducer();
		reducer.apply(wire.thinkingStart(0));
		const badDelta = {
			type: "message_update",
			usage: wire.usage(0, 0, 0),
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: { not: "a string" } },
		} as unknown as ChildWireRecord;
		const change = reducer.apply(badDelta);
		expect(change).toBe("none");
		expect(reducer.state.malformedLines).toBe(1);
		const item = reducer.state.transcript.find((i) => i.kind === "thinking");
		expect(item?.kind === "thinking" && item.text).toBe("");
	});

	it("ignores an invalid thinking_level_changed level instead of storing it", () => {
		const reducer = createReducer();
		const before = reducer.state.model.thinkingLevel;
		const badLevel = { type: "thinking_level_changed", level: "ultra" } as unknown as ChildWireRecord;
		const change = reducer.apply(badLevel);
		expect(change).toBe("none");
		expect(reducer.state.malformedLines).toBe(0);
		expect(reducer.state.model.thinkingLevel).toBe(before);
	});

	it("does not mutate liveUsage when the event type throws, so there is no state change without a version bump", () => {
		const reducer = createReducer();
		reducer.apply(wire.textStart(0));
		const liveUsageBefore = reducer.state.liveUsage;
		const versionBefore = reducer.state.version;
		const badDelta = {
			type: "message_update",
			usage: wire.usage(9, 9, 0.09),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: 123 },
		} as unknown as ChildWireRecord;
		const change = reducer.apply(badDelta);
		expect(change).toBe("none");
		expect(reducer.state.malformedLines).toBe(1);
		expect(reducer.state.liveUsage).toBe(liveUsageBefore);
		expect(reducer.state.version).toBe(versionBefore);
	});

	it("ignores a non-object usage on message_update instead of storing it as liveUsage", () => {
		const reducer = createReducer();
		const badUsage = {
			type: "message_update",
			usage: "not an object",
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		} as unknown as ChildWireRecord;
		const change = reducer.apply(badUsage);
		expect(change).toBe("coarse");
		expect(reducer.state.liveUsage).toBeUndefined();
	});

	it("tolerates a message_end record whose content is not an array", () => {
		const reducer = createReducer();
		const badEnd = {
			type: "message_end",
			message: {
				role: "assistant",
				content: "not an array",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-5",
				usage: wire.usage(1, 1, 0.001),
				stopReason: "stop",
				timestamp: Date.now(),
			},
		} as unknown as ChildWireRecord;
		const change = reducer.apply(badEnd);
		expect(change).toBe("coarse");
		expect(reducer.state.malformedLines).toBe(0);
		expect(reducer.state.finalText).toBe("");
		expect(reducer.state.stopReason).toBe("stop");
		expect(reducer.state.usage).toEqual(wire.usage(1, 1, 0.001));
	});

	it("bounds transcript growth under 10,000 thinking deltas", () => {
		const reducer = createReducer({ limits: { maxItemChars: 1000, maxChars: 256_000, maxItems: 400 } });
		reducer.apply(wire.thinkingStart(0));
		for (let i = 0; i < 10_000; i++) {
			reducer.apply(wire.thinkingDelta(0, "0123456789"));
		}
		expect(reducer.state.transcriptChars).toBeLessThanOrEqual(256_000);
		const item = reducer.state.transcript.find((x) => x.kind === "thinking");
		expect(item?.kind === "thinking" && item.droppedChars > 0).toBe(true);
	});

	it("evicts whole finished items once their accumulated size exceeds maxChars", () => {
		const reducer = createReducer({ limits: { maxItemChars: 1000, maxChars: 5_000, maxItems: 10_000 } });
		for (let i = 0; i < 50; i++) {
			reducer.apply(wire.thinkingStart(0));
			reducer.apply(wire.thinkingEnd(0, "x".repeat(500)));
		}
		expect(reducer.state.transcriptChars).toBeLessThanOrEqual(5_000);
		expect(reducer.state.droppedItems).toBeGreaterThan(0);
	});

	it("evicts old finished items once maxItems is exceeded", () => {
		const reducer = createReducer({ limits: { maxItems: 5 } });
		for (let i = 0; i < 20; i++) {
			reducer.apply(wire.toolStart(`t${i}`, "bash", {}));
			reducer.apply(wire.toolEnd(`t${i}`, "bash", "ok", false));
		}
		expect(reducer.state.transcript.length).toBeLessThanOrEqual(5);
		expect(reducer.state.droppedItems).toBeGreaterThan(0);
	});

	it("evicts by transcriptChars once maxChars is exceeded", () => {
		const reducer = createReducer({ limits: { maxChars: 500, maxItems: 10_000, maxItemChars: 32_000 } });
		for (let i = 0; i < 50; i++) {
			reducer.apply(wire.toolStart(`t${i}`, "bash", { command: "x".repeat(50) }));
			reducer.apply(wire.toolEnd(`t${i}`, "bash", "ok", false));
		}
		expect(reducer.state.transcriptChars).toBeLessThanOrEqual(500);
		expect(reducer.state.droppedItems).toBeGreaterThan(0);
	});

	it("caps notice text to a single line with an ellipsis instead of leaving it unbounded", () => {
		const reducer = createReducer();
		reducer.apply(wire.assistantEnd({ stopReason: "error", errorMessage: `line one\nline two ${"E".repeat(2000)}` }));
		const notice = reducer.state.transcript.find((item) => item.kind === "notice");
		expect(notice?.kind === "notice" && notice.text.length).toBeLessThanOrEqual(1000);
		expect(notice?.kind === "notice" && notice.text.includes("\n")).toBe(false);
		expect(notice?.kind === "notice" && notice.text.endsWith("…")).toBe(true);
	});

	it("keeps the newest item instead of emptying the live transcript when one huge notice exceeds maxChars", () => {
		const reducer = createReducer({ limits: { maxChars: 500, maxItems: 10_000, maxItemChars: 32_000 } });
		for (let i = 0; i < 50; i++) {
			reducer.apply(wire.toolStart(`t${i}`, "bash", { command: "x".repeat(50) }));
			reducer.apply(wire.toolEnd(`t${i}`, "bash", "ok", false));
		}
		// A single assistantEnd notice is capped at NOTICE_MAX_CHARS (1000), well above this run's
		// 500-char budget, so it alone must drive every older item out without being evicted itself.
		reducer.apply(wire.assistantEnd({ stopReason: "error", errorMessage: "E".repeat(2000) }));
		expect(reducer.state.transcript.length).toBeGreaterThan(0);
		const notice = reducer.state.transcript[reducer.state.transcript.length - 1];
		expect(notice?.kind).toBe("notice");
		expect(reducer.state.transcriptChars).toBeLessThanOrEqual(500);
	});

	it("trimForRetention tail-trims the newest item instead of dropping it when it alone exceeds maxChars", () => {
		const reducer = createReducer({ limits: { maxItemChars: 50_000 } });
		reducer.apply(wire.textStart(0));
		reducer.apply(wire.textDelta(0, "x".repeat(40_000)));
		reducer.apply(wire.textEnd(0, "x".repeat(40_000)));

		reducer.trimForRetention(32_000);

		expect(reducer.state.transcript).toHaveLength(1);
		const item = reducer.state.transcript[0];
		expect(item?.kind === "text" && item.text.length).toBeLessThanOrEqual(32_000);
		expect(reducer.state.transcriptChars).toBeLessThanOrEqual(32_000);
	});

	it("noteHeartbeat throttles to at most once per second", () => {
		let now = 0;
		const reducer = createReducer({ now: () => now });
		expect(reducer.noteHeartbeat()).toBe("fine");
		now = 500;
		expect(reducer.noteHeartbeat()).toBe("none");
		now = 1000;
		expect(reducer.noteHeartbeat()).toBe("fine");
	});

	it("noteStderr keeps a bounded tail", () => {
		const reducer = createReducer({ limits: { maxStderrChars: 10 } });
		reducer.noteStderr("0123456789");
		reducer.noteStderr("ABCDE");
		expect(reducer.state.stderrTail).toBe("56789ABCDE");
	});

	it("markQueued and markSpawning set lifecycle and timestamps", () => {
		let now = 100;
		const reducer = createReducer({ now: () => now });
		reducer.markQueued();
		expect(reducer.state.lifecycle).toBe("queued");
		expect(reducer.state.queuedAt).toBe(100);
		now = 200;
		reducer.markSpawning();
		expect(reducer.state.lifecycle).toBe("spawning");
		expect(reducer.state.startedAt).toBe(200);
	});

	it("resetForRetry keeps queuedAt/startedAt and monotonic counters but clears the rest", () => {
		let now = 0;
		const reducer = createReducer({ now: () => now });
		reducer.markQueued();
		now = 10;
		reducer.markSpawning();
		reducer.apply(wire.sessionHeader());
		reducer.apply(wire.assistantStart("anthropic", "claude-sonnet-5"));
		now = 20;
		reducer.apply(wire.assistantEnd({ stopReason: "error", errorMessage: "boom", usage: wire.usage(5, 5, 0.01) }));
		const versionBefore = reducer.state.version;
		const coarseVersionBefore = reducer.state.coarseVersion;
		const nextSeqBefore = reducer.state.nextSeq;
		now = 30;
		reducer.finish({ code: 1, signal: null, cancelled: false });

		now = 40;
		reducer.resetForRetry({ source: "inherited", confirmed: false }, "retrying without --model");

		expect(reducer.state.queuedAt).toBe(0);
		expect(reducer.state.startedAt).toBe(10);
		expect(reducer.state.endedAt).toBeUndefined();
		expect(reducer.state.lastEventAt).toBe(40);
		expect(reducer.state.usage).toBeUndefined();
		expect(reducer.state.stopReason).toBeUndefined();
		expect(reducer.state.errorMessage).toBeUndefined();
		expect(reducer.state.structured).toBeUndefined();
		expect(reducer.state.sessionId).toBeUndefined();
		expect(reducer.state.lifecycle).toBe("spawning");
		expect(reducer.state.version).toBeGreaterThan(versionBefore);
		expect(reducer.state.coarseVersion).toBeGreaterThan(coarseVersionBefore);
		expect(reducer.state.nextSeq).toBeGreaterThanOrEqual(nextSeqBefore);
	});

	describe("finish", () => {
		it("cancelled", () => {
			const reducer = createReducer();
			const result = reducer.finish({ code: null, signal: null, cancelled: true });
			expect(result).toEqual({ exitCode: 1, failure: "cancelled" });
		});

		it("spawnError", () => {
			const reducer = createReducer();
			const result = reducer.finish({ code: null, signal: null, cancelled: false, spawnError: "ENOENT" });
			expect(result).toEqual({ exitCode: 1, failure: "failed to start: ENOENT" });
		});

		it("success: code 0 and no error/aborted stop reason", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			reducer.apply(wire.settled());
			const result = reducer.finish({ code: 0, signal: null, cancelled: false });
			expect(result).toEqual({ exitCode: 0, failure: undefined });
		});

		it("no output before exit", () => {
			const reducer = createReducer();
			const result = reducer.finish({ code: 1, signal: null, cancelled: false });
			expect(result).toEqual({ exitCode: 1, failure: "child exited (code 1) before producing output" });
		});

		it("exited before settling", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			const result = reducer.finish({ code: 1, signal: "SIGTERM", cancelled: false });
			expect(result).toEqual({ exitCode: 1, failure: "child exited (code 1, signal SIGTERM) before settling" });
		});

		it("closes an open text item left mid-stream when the run is cancelled", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			reducer.apply(wire.textStart(0));
			reducer.apply(wire.textDelta(0, "which keep"));

			reducer.finish({ code: null, signal: null, cancelled: true });

			const item = reducer.state.transcript.at(-1);
			expect(item?.kind).toBe("text");
			expect(item && item.kind === "text" ? item.done : undefined).toBe(true);
		});

		it("closes an open thinking item left mid-stream when the run is cancelled", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			reducer.apply(wire.thinkingStart(0));
			reducer.apply(wire.thinkingDelta(0, "still reasoning"));

			reducer.finish({ code: null, signal: null, cancelled: true });

			const item = reducer.state.transcript.at(-1);
			expect(item?.kind).toBe("thinking");
			expect(item && item.kind === "thinking" ? item.done : undefined).toBe(true);
		});

		it("settled but failed uses the error message", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			reducer.apply(wire.settled());
			reducer.apply(wire.assistantEnd({ stopReason: "error", errorMessage: "boom" }));
			const result = reducer.finish({ code: 1, signal: null, cancelled: false });
			expect(result).toEqual({ exitCode: 1, failure: "boom" });
		});

		it("settled but failed falls back to the stop reason when there is no error message", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			reducer.apply(wire.settled());
			reducer.apply(wire.assistantEnd({ stopReason: "aborted" }));
			const result = reducer.finish({ code: 1, signal: null, cancelled: false });
			expect(result).toEqual({ exitCode: 1, failure: "aborted" });
		});

		it("code 0 with an error/aborted stop reason is still a failure", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			reducer.apply(wire.settled());
			reducer.apply(wire.assistantEnd({ stopReason: "error", errorMessage: "boom" }));
			const result = reducer.finish({ code: 0, signal: null, cancelled: false });
			expect(result).toEqual({ exitCode: 1, failure: "boom" });
		});

		it("settled normally but exited non-zero does not mistake the stop reason for the failure", () => {
			const reducer = createReducer();
			reducer.apply(wire.sessionHeader());
			reducer.apply(wire.assistantEnd({ stopReason: "stop", text: "ok" }));
			reducer.apply(wire.settled());
			const result = reducer.finish({ code: 1, signal: null, cancelled: false });
			expect(result).toEqual({ exitCode: 1, failure: "child exited (code 1)" });
		});
	});

	it("toRunResult maps state and finish into a RunResult", () => {
		const reducer = createReducer();
		reducer.apply(wire.sessionHeader());
		reducer.apply(wire.assistantStart("anthropic", "claude-sonnet-5"));
		reducer.apply(wire.toolStart("t1", "bash", { command: "ls" }));
		reducer.apply(wire.toolEnd("t1", "bash", "ok", false));
		reducer.apply(wire.assistantEnd({ text: "STATUS: DONE", thinkingLevel: "high" }));
		reducer.apply(wire.settled());
		const finish = reducer.finish({ code: 0, signal: null, cancelled: false });

		const result = toRunResult(reducer.state, { agent: "reviewer", task: "review", step: 2 }, finish, {
			cancelled: false,
			durationMs: 1234,
		});

		expect(result.agent).toBe("reviewer");
		expect(result.task).toBe("review");
		expect(result.step).toBe(2);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("STATUS: DONE");
		expect(result.model).toEqual({ provider: "anthropic", id: "claude-sonnet-5" });
		expect(result.thinkingLevel).toBe("high");
		expect(result.toolCalls).toBe(1);
		expect(result.turns).toBe(1);
		expect(result.durationMs).toBe(1234);
		expect(result.cancelled).toBe(false);
	});

	it("toRunResult reports usage, stopReason and blockedToolCalls", () => {
		const reducer = createReducer();
		reducer.apply(wire.toolStart("t1", "write_file", { path: "a.ts" }));
		reducer.apply(wire.blockedToolEnd("t1", "write_file", "needs approval"));
		reducer.apply(wire.assistantEnd({ stopReason: "stop", usage: wire.usage(4, 2, 0.001) }));
		const finish = reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(reducer.state, { agent: "a", task: "t" }, finish, {
			cancelled: false,
			durationMs: 1,
		});
		expect(result.usage).toEqual(reducer.state.usage);
		expect(result.stopReason).toBe("stop");
		expect(result.blockedToolCalls).toBe(1);
	});

	it("toRunResult surfaces a spawn error as stderr", () => {
		const reducer = createReducer();
		const finish = reducer.finish({ code: null, signal: null, cancelled: false, spawnError: "ENOENT" });
		const result = toRunResult(reducer.state, { agent: "a", task: "t" }, finish, {
			cancelled: false,
			durationMs: 1,
		});
		expect(result.stderr).toBe("failed to start: ENOENT");
	});

	it("toRunResult surfaces a cancelled run as stderr", () => {
		const reducer = createReducer();
		const finish = reducer.finish({ code: null, signal: null, cancelled: true });
		const result = toRunResult(reducer.state, { agent: "a", task: "t" }, finish, {
			cancelled: true,
			durationMs: 1,
		});
		expect(result.stderr).toBe("cancelled");
	});

	it("toRunResult surfaces an exit-before-settling failure as stderr", () => {
		const reducer = createReducer();
		reducer.apply(wire.sessionHeader());
		const finish = reducer.finish({ code: 1, signal: "SIGTERM", cancelled: false });
		const result = toRunResult(reducer.state, { agent: "a", task: "t" }, finish, {
			cancelled: false,
			durationMs: 1,
		});
		expect(result.stderr).toBe("child exited (code 1, signal SIGTERM) before settling");
	});

	it("toRunResult uses errorMessage, not the finish failure text, for a failed response", () => {
		const reducer = createReducer();
		reducer.apply(wire.assistantEnd({ stopReason: "error", errorMessage: "boom" }));
		const result = toRunResult(
			reducer.state,
			{ agent: "a", task: "t" },
			{ exitCode: 1, failure: "unrelated finish text" },
			{ cancelled: false, durationMs: 1 },
		);
		expect(result.stderr).toBe("boom");
	});

	it("toRunResult only reports structured when extras.structured is given", () => {
		const reducer = createReducer();
		for (const record of wire.resultToolCall("t1", { ok: true })) {
			reducer.apply(record);
		}
		expect(reducer.state.structured).toEqual({ value: { ok: true } });
		const finish = reducer.finish({ code: 0, signal: null, cancelled: false });
		const result = toRunResult(reducer.state, { agent: "a", task: "t" }, finish, {
			cancelled: false,
			durationMs: 1,
		});
		expect(result.structured).toBeUndefined();
	});
});

describe("currentPolyphaseDepth", () => {
	it("is 0 when the env var is absent", () => {
		expect(currentPolyphaseDepth({})).toBe(0);
	});

	it("parses a positive integer", () => {
		expect(currentPolyphaseDepth({ [POLYPHASE_DEPTH_ENV]: "2" })).toBe(2);
	});

	it("falls back to 0 for a non-numeric value", () => {
		expect(currentPolyphaseDepth({ [POLYPHASE_DEPTH_ENV]: "x" })).toBe(0);
	});

	it("falls back to 0 for a negative value", () => {
		expect(currentPolyphaseDepth({ [POLYPHASE_DEPTH_ENV]: "-1" })).toBe(0);
	});
});
