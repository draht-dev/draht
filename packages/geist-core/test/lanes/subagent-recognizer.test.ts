import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	type GenericToolCallEvent,
	type Lane,
	recognizeSubagentLane,
	SUBAGENT_RECOGNIZERS,
	toLane,
	toPlanLane,
} from "../../src/index.js";

/** Reads a JSON fixture next to this test's `golden/` directory. */
function readGolden<T>(name: string): T {
	const path = fileURLToPath(new URL(`./golden/${name}`, import.meta.url));
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * A scripted mock tool-call sequence and the lane output it must produce
 * (spec §16 M7 ✅: "scripted mock tool-call sequences → lane goldens"). The
 * input is checked-in `GenericToolCallEvent[]`; the golden is the exact
 * `recognizeSubagentLane` output, hand-verified against the recognizer logic.
 */
function runGoldenSequence(fixture: string): { actual: Lane[]; expected: Lane[] } {
	const events = readGolden<GenericToolCallEvent[]>(`${fixture}.input.json`);
	const expected = readGolden<Lane[]>(`${fixture}.lanes.json`);
	return { actual: events.map(recognizeSubagentLane), expected };
}

describe("recognizeSubagentLane golden sequences", () => {
	test("generic (unrecognized) read/execute calls stay generic lanes", () => {
		const { actual, expected } = runGoldenSequence("generic-sequence");
		expect(actual).toEqual(expected);
		// Every lane in the generic sequence is exactly the default `toLane`
		// output — the recognizer upgraded nothing.
		expect(actual.every((lane) => lane.kind === "generic")).toBe(true);
	});

	test("draht subagent calls upgrade to typed subagent lanes", () => {
		const { actual, expected } = runGoldenSequence("draht-subagent-sequence");
		expect(actual).toEqual(expected);
		expect(actual.every((lane) => lane.kind === "subagent")).toBe(true);
	});

	test("Claude Task calls upgrade to typed subagent lanes", () => {
		const { actual, expected } = runGoldenSequence("claude-task-sequence");
		expect(actual).toEqual(expected);
		expect(actual.every((lane) => lane.kind === "subagent")).toBe(true);
	});
});

describe("recognizeSubagentLane contract", () => {
	test("runs toLane first: an unrecognized event returns exactly the generic lane", () => {
		const event: GenericToolCallEvent = {
			toolCallId: "x-1",
			title: "Read README.md",
			kind: "read",
			status: "in_progress",
			isUpdate: false,
		};
		expect(recognizeSubagentLane(event)).toEqual(toLane(event));
	});

	test("the recognizer is a data-driven table, not a hardcoded pair", () => {
		// Both named conventions live as rows, each with an id used as
		// `recognizedBy` (spec §7: "a recognizer, not an import").
		expect(SUBAGENT_RECOGNIZERS.map((r) => r.id)).toEqual(["draht", "claude-task"]);
	});

	test("matchers are precise: near-miss titles are NOT upgraded", () => {
		// "subagent" must be the bare word or `subagent <mode>` — not a prefix.
		const notDraht: GenericToolCallEvent = { toolCallId: "n-1", title: "subagentmanager", isUpdate: false };
		expect(recognizeSubagentLane(notDraht).kind).toBe("generic");
		// "Task" must be a leading word — "Taskbar" is a different tool.
		const notClaude: GenericToolCallEvent = { toolCallId: "n-2", title: "Taskbar tweak", isUpdate: false };
		expect(recognizeSubagentLane(notClaude).kind).toBe("generic");
	});

	test("a titleless tool call is never upgraded and carries no undefined fields", () => {
		const event: GenericToolCallEvent = { toolCallId: "t-1", isUpdate: false };
		expect(recognizeSubagentLane(event)).toEqual({ kind: "generic", toolCallId: "t-1", isUpdate: false });
	});
});

describe("toPlanLane", () => {
	test("renders a plan update as a plan lane, preserving entries", () => {
		expect(
			toPlanLane({
				entries: [
					{ content: "Investigate the failing test", status: "in_progress", priority: "high" },
					{ content: "Apply the fix", status: "pending" },
				],
			}),
		).toEqual({
			kind: "plan",
			entries: [
				{ content: "Investigate the failing test", status: "in_progress", priority: "high" },
				{ content: "Apply the fix", status: "pending" },
			],
		});
	});
});
