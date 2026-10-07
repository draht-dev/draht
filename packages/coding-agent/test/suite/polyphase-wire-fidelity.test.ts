import { PassThrough } from "node:stream";
import type { AgentTool } from "@draht/agent-core";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type TextContent,
	type ThinkingContent,
} from "@draht/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ChildEventReducer, parseChildLine } from "../../src/core/polyphase/child-events.ts";
import { attachChildLineReader } from "../../src/core/polyphase/jsonl-reader.ts";
import { combineUsage } from "../../src/core/usage-totals.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("polyphase wire fidelity", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reduces a harness-recorded session to the same model, thinking text, finalText and usage", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echoes text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return {
					content: [{ type: "text", text }],
					details: {},
				};
			},
		};

		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("Let me think about this request."),
					fauxText("I will call echo."),
					fauxToolCall("echo", { text: "hi" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxText("All done.")], { stopReason: "stop" }),
		]);

		await harness.session.prompt("please echo hi");

		expect(harness.events.length).toBeGreaterThan(0);

		const lines = harness.events.map((event) => JSON.stringify(toJsonEvent(event)));

		const reducer = new ChildEventReducer({ model: { source: "inherited", confirmed: false } });
		const stream = new PassThrough();
		const reader = attachChildLineReader(stream, (line) => {
			const record = parseChildLine(line);
			if (record) reducer.apply(record);
		});
		stream.write(`${lines.join("\n")}\n`);
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(reader.skippedLines).toBeGreaterThan(0);
		expect(reducer.state.malformedLines).toBe(0);

		const assistantMessages = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant");
		expect(assistantMessages).toHaveLength(2);

		const finalMessage = assistantMessages[assistantMessages.length - 1]!;

		expect(reducer.state.model.confirmed).toBe(true);
		expect(reducer.state.model.provider).toBe(finalMessage.provider);
		expect(reducer.state.model.id).toBe(finalMessage.model);

		const expectedThinking = assistantMessages[0]!.content.find(
			(part): part is ThinkingContent => part.type === "thinking",
		);
		expect(expectedThinking).toBeDefined();
		const thinkingItem = reducer.state.transcript.find((item) => item.kind === "thinking");
		expect(thinkingItem?.kind === "thinking" && thinkingItem.text).toBe(expectedThinking?.thinking);

		const expectedFinalText = finalMessage.content.find((part): part is TextContent => part.type === "text");
		expect(reducer.state.finalText).toBe(expectedFinalText?.text);

		let expectedUsage = assistantMessages[0]!.usage;
		for (const message of assistantMessages.slice(1)) {
			expectedUsage = combineUsage(expectedUsage, message.usage);
		}
		expect(reducer.state.usage).toEqual(expectedUsage);
	});
});
