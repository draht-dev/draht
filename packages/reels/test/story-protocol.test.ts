import { describe, expect, test } from "bun:test";
import { parseWriterResponse, stripCodeFence } from "../src/story-protocol.ts";

describe("stripCodeFence", () => {
	test("strips a ```json fence around the body", () => {
		expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
	});

	test("strips a bare ``` fence with no language tag", () => {
		expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
	});

	test("leaves text with no fence untouched", () => {
		expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
	});

	test("leaves an unterminated fence untouched (no real closing fence)", () => {
		const text = '```json\n{"a":1}';
		expect(stripCodeFence(text)).toBe(text);
	});

	test("leaves text whose opening line is not a plain fence untouched", () => {
		const text = "```json extra stuff\n{}\n```";
		expect(stripCodeFence(text)).toBe(text);
	});

	/**
	 * Security re-audit 2: the original `/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/` backtracked cubically on an
	 * opening fence followed by many lines with no matching close. The rewrite uses `indexOf`/`lastIndexOf` only,
	 * so this must stay well under 50ms even at 50k lines.
	 */
	test("does not blow up on a large unterminated fence (ReDoS regression)", () => {
		const text = `\`\`\`json\n${"\n".repeat(50_000)}`;
		const start = performance.now();
		stripCodeFence(text);
		expect(performance.now() - start).toBeLessThan(50);
	});
});

describe("parseWriterResponse", () => {
	function minimalResponse(): string {
		return JSON.stringify({
			title: "A change",
			subtitle: "By someone",
			summary: { text: "Summary.", cites: [] },
			scenes: [{ section: "outro", beats: [{ text: "The end.", claim: "meta", cites: [] }] }],
		});
	}

	test("parses a minimal, well-shaped response", () => {
		const parsed = parseWriterResponse(minimalResponse());
		expect(parsed.title).toBe("A change");
		expect(parsed.scenes).toHaveLength(1);
	});

	test("strips a code fence before parsing JSON", () => {
		const parsed = parseWriterResponse(`\`\`\`json\n${minimalResponse()}\n\`\`\``);
		expect(parsed.title).toBe("A change");
	});

	test("rejects an unknown claim kind", () => {
		const raw = JSON.stringify({
			title: "A change",
			subtitle: "By someone",
			summary: { text: "Summary.", cites: [] },
			scenes: [{ section: "outro", beats: [{ text: "The end.", claim: "impact", cites: [] }] }],
		});
		expect(() => parseWriterResponse(raw)).toThrow();
	});
});
