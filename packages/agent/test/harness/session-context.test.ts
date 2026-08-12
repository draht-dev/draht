import type { AssistantMessage } from "@draht/ai";
import { describe, expect, it } from "vitest";
import { buildSessionContext } from "../../src/harness/session/context.ts";
import type { CompactionEntry, MessageEntry } from "../../src/harness/session/types.ts";
import type { AgentMessage } from "../../src/types.ts";

const NOW = 1_700_000_000_000;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: NOW };
}

function assistantMessage(stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage {
	return {
		role: "assistant",
		content:
			stopReason === "toolUse"
				? [{ type: "toolCall", id: "call", name: "read", arguments: {} }]
				: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason,
		...(stopReason === "deferred"
			? { deferred: { provider: "anthropic", modelId: "claude-sonnet-4-5", api: "anthropic-messages", id: "job" } }
			: {}),
		timestamp: NOW,
	};
}

function messageEntry(id: string, parentId: string | null, seq: number, message: AgentMessage): MessageEntry {
	return { id, parentId, seq, timestamp: NOW, type: "message", message };
}

describe("session context projection", () => {
	it("filters non-context assistant response entries while preserving valid messages", () => {
		const user = userMessage("question");
		const stopped = assistantMessage("stop", "answer");
		const length = assistantMessage("length", "truncated answer");
		const toolUse = assistantMessage("toolUse", "");
		const failed = assistantMessage("error", "failed");
		const aborted = assistantMessage("aborted", "aborted");
		const deferred = assistantMessage("deferred", "");
		const entries = [
			messageEntry("user", null, 1, user),
			messageEntry("failed", "user", 2, failed),
			messageEntry("stopped", "failed", 3, stopped),
			messageEntry("aborted", "stopped", 4, aborted),
			messageEntry("tool-use", "aborted", 5, toolUse),
			messageEntry("deferred", "tool-use", 6, deferred),
			messageEntry("length", "deferred", 7, length),
		];

		expect(buildSessionContext(entries)).toEqual([user, stopped, toolUse, length]);
	});

	it("filters retained-tail responses without hiding the compaction summary", () => {
		const user = userMessage("kept user");
		const stopped = assistantMessage("stop", "kept answer");
		const toolUse = assistantMessage("toolUse", "");
		const length = assistantMessage("length", "kept truncated answer");
		const failed = assistantMessage("error", "failed");
		const aborted = assistantMessage("aborted", "aborted");
		const deferred = assistantMessage("deferred", "");
		const compaction: CompactionEntry = {
			id: "compaction",
			parentId: null,
			seq: 1,
			timestamp: NOW,
			type: "compaction",
			summary: "summary",
			retainedTail: [failed, user, aborted, stopped, deferred, toolUse, length],
			tokensBefore: 100,
			fromHook: false,
		};

		expect(buildSessionContext([compaction])).toEqual([
			{ role: "compactionSummary", summary: "summary", tokensBefore: 100, timestamp: NOW },
			user,
			stopped,
			toolUse,
			length,
		]);
	});
});
