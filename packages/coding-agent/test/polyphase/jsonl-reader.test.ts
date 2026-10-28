import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachChildLineReader, DEFAULT_SKIP_PREFIXES } from "../../src/core/polyphase/jsonl-reader.ts";

function collect() {
	const lines: string[] = [];
	return { lines, onLine: (line: string) => lines.push(line) };
}

describe("attachChildLineReader", () => {
	it("reassembles multi-byte UTF-8 split at every byte offset", async () => {
		const text = `{"type":"text","value":"emoji 😀 CJK 漢字 end"}`;
		const bytes = Buffer.from(`${text}\n`, "utf8");
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		attachChildLineReader(stream, onLine);

		for (const byte of bytes) {
			stream.write(Buffer.from([byte]));
		}
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(lines).toEqual([text]);
	});

	it("strips a single trailing CR", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		attachChildLineReader(stream, onLine);
		stream.write('{"type":"a"}\r\n');
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(lines).toEqual(['{"type":"a"}']);
	});

	it("keeps U+2028/U+2029 inside a line untouched", async () => {
		const line = '{"type":"a","text":"line sep end"}';
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		attachChildLineReader(stream, onLine);
		stream.write(`${line}\n`);
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(lines).toEqual([line]);
	});

	it("emits a final line without a trailing LF on end", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		attachChildLineReader(stream, onLine);
		stream.write('{"type":"a"}\n{"type":"b"}');
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
	});

	it("keeps maxBufferedChars well below 65536 for a 20 MB agent_end line in 64 KiB chunks", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		const skipped: string[] = [];
		const reader = attachChildLineReader(stream, onLine, { onSkipped: (prefix) => skipped.push(prefix) });

		const total = 20 * 1024 * 1024;
		const chunkSize = 64 * 1024;
		const prefix = '{"type":"agent_end","messages":[';
		const filler = "x".repeat(total - prefix.length - 2);
		const full = `${prefix}${filler}]}`;

		for (let offset = 0; offset < full.length; offset += chunkSize) {
			stream.write(full.slice(offset, offset + chunkSize));
			await new Promise((resolve) => setImmediate(resolve));
			expect(reader.maxBufferedChars).toBeLessThan(65536);
		}
		stream.write("\n");
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(lines).toEqual([]);
		expect(skipped).toEqual(['{"type":"agent_end"']);
		expect(reader.skippedLines).toBe(1);
		expect(reader.maxBufferedChars).toBeLessThan(65536);
	});

	it("matches a custom skip prefix longer than the default 64-char threshold while still streaming", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		const skipped: string[] = [];
		const longPrefix =
			'{"type":"custom_noisy_event","reason":"a-prefix-that-is-definitely-longer-than-sixty-four-characters"';
		expect(longPrefix.length).toBeGreaterThan(64);
		const reader = attachChildLineReader(stream, onLine, {
			skipPrefixes: [longPrefix],
			onSkipped: (prefix) => skipped.push(prefix),
		});

		const total = 512 * 1024;
		const chunkSize = 64 * 1024;
		const filler = "x".repeat(total - longPrefix.length - 2);
		const full = `${longPrefix}${filler}"}`;

		for (let offset = 0; offset < full.length; offset += chunkSize) {
			stream.write(full.slice(offset, offset + chunkSize));
			await new Promise((resolve) => setImmediate(resolve));
			expect(reader.maxBufferedChars).toBeLessThan(longPrefix.length + 64);
		}
		stream.write("\n");
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(lines).toEqual([]);
		expect(skipped).toEqual([longPrefix]);
		expect(reader.skippedLines).toBe(1);
	});

	it("skips tool_execution_update lines", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		const skipped: string[] = [];
		attachChildLineReader(stream, onLine, { onSkipped: (prefix) => skipped.push(prefix) });
		stream.write('{"type":"tool_execution_update","toolCallId":"t1","delta":"x"}\n{"type":"real"}\n');
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(lines).toEqual(['{"type":"real"}']);
		expect(skipped).toEqual(['{"type":"tool_execution_update"']);
	});

	it("calls onOversize for a long non-prefix line and still delivers the next line", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		let oversizeCount = 0;
		attachChildLineReader(stream, onLine, {
			maxLineChars: 100,
			onOversize: () => oversizeCount++,
		});
		const longLine = `{"type":"custom","data":"${"y".repeat(200)}"}`;
		stream.write(`${longLine}\n{"type":"next"}\n`);
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(oversizeCount).toBe(1);
		expect(lines).toEqual(['{"type":"next"}']);
	});

	it("delivers 10,000 small lines in one chunk, in order", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		attachChildLineReader(stream, onLine);
		const count = 10_000;
		const chunk = `${Array.from({ length: count }, (_, i) => `{"type":"n","i":${i}}`).join("\n")}\n`;
		stream.write(chunk);
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(lines).toHaveLength(count);
		expect(lines.every((line, i) => line === `{"type":"n","i":${i}}`)).toBe(true);
	});

	it("detach() stops delivering lines", async () => {
		const stream = new PassThrough();
		const { lines, onLine } = collect();
		const reader = attachChildLineReader(stream, onLine);
		stream.write('{"type":"a"}\n');
		await new Promise((resolve) => setImmediate(resolve));
		reader.detach();
		stream.write('{"type":"b"}\n');
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(lines).toEqual(['{"type":"a"}']);
	});

	it("never throws when onLine itself throws, and keeps delivering later lines", async () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		let calls = 0;
		attachChildLineReader(stream, (line) => {
			calls++;
			if (calls === 1) throw new Error("boom");
			lines.push(line);
		});
		expect(() => {
			stream.write('{"type":"a"}\n{"type":"b"}\n');
		}).not.toThrow();
		stream.end();
		await new Promise((resolve) => stream.on("end", resolve));
		expect(lines).toEqual(['{"type":"b"}']);
	});

	it("exports the default skip prefixes", () => {
		expect(DEFAULT_SKIP_PREFIXES).toContain('{"type":"agent_end"');
		expect(DEFAULT_SKIP_PREFIXES).toContain('{"type":"tool_execution_update"');
	});
});
