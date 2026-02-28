import assert from "node:assert";
import { describe, it } from "node:test";

// Test the parseFindings logic (extracted for testability)

interface Finding {
	path: string;
	line: number;
	severity: "info" | "warning" | "critical";
	message: string;
	suggestion?: string;
}

function parseFindings(text: string): Finding[] {
	try {
		const jsonMatch = text.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return [];

		const parsed = JSON.parse(jsonMatch[0]);
		if (!Array.isArray(parsed)) return [];

		return parsed.filter(
			(f: unknown): f is Finding =>
				typeof f === "object" &&
				f !== null &&
				typeof (f as Finding).path === "string" &&
				typeof (f as Finding).line === "number" &&
				typeof (f as Finding).message === "string" &&
				["info", "warning", "critical"].includes((f as Finding).severity),
		);
	} catch {
		return [];
	}
}

describe("parseFindings", () => {
	it("parses valid JSON array", () => {
		const input = JSON.stringify([
			{ path: "src/index.ts", line: 10, severity: "critical", message: "SQL injection" },
		]);
		const result = parseFindings(input);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].path, "src/index.ts");
		assert.strictEqual(result[0].severity, "critical");
	});

	it("returns empty for no findings", () => {
		assert.deepStrictEqual(parseFindings("[]"), []);
	});

	it("returns empty for invalid JSON", () => {
		assert.deepStrictEqual(parseFindings("not json at all"), []);
	});

	it("returns empty for non-array JSON", () => {
		assert.deepStrictEqual(parseFindings('{"key": "value"}'), []);
	});

	it("extracts JSON from surrounding text", () => {
		const input = `Here are my findings:\n\n[{"path":"a.ts","line":1,"severity":"info","message":"test"}]\n\nDone.`;
		const result = parseFindings(input);
		assert.strictEqual(result.length, 1);
	});

	it("filters out malformed findings", () => {
		const input = JSON.stringify([
			{ path: "a.ts", line: 1, severity: "info", message: "good" },
			{ path: "b.ts", severity: "info", message: "missing line" }, // no line
			{ path: "c.ts", line: 2, severity: "invalid", message: "bad severity" },
			{ line: 3, severity: "warning", message: "missing path" },
			null,
			"string",
		]);
		const result = parseFindings(input);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].path, "a.ts");
	});

	it("preserves optional suggestion field", () => {
		const input = JSON.stringify([
			{ path: "a.ts", line: 1, severity: "warning", message: "issue", suggestion: "fix it" },
		]);
		const result = parseFindings(input);
		assert.strictEqual(result[0].suggestion, "fix it");
	});
});
