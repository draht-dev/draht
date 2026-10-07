import { describe, expect, it } from "vitest";
import {
	extractWorkflowMeta,
	peekWorkflowMeta,
	WORKFLOW_NAME_PATTERN,
} from "../../src/core/polyphase/workflow/meta.ts";
import { runWorkflowScript, type WorkflowHost } from "../../src/core/polyphase/workflow/runtime.ts";

const NOOP_HOST: WorkflowHost = {
	runAgent: async () => ({ kind: "value", value: null }),
	onPhase: () => 0,
	onLog: () => undefined,
	spentTokens: () => 0,
};

function okResult(source: string) {
	const result = extractWorkflowMeta(source);
	if (!result.ok)
		throw new Error(`expected ok, got error: ${result.error.message} at ${result.error.line}:${result.error.column}`);
	return result;
}

function errResult(source: string) {
	const result = extractWorkflowMeta(source);
	if (result.ok) throw new Error("expected a parse/validation error, got ok");
	return result.error;
}

describe("WORKFLOW_NAME_PATTERN", () => {
	it("matches lowercase, hyphenated names starting with a letter", () => {
		expect(WORKFLOW_NAME_PATTERN.test("review")).toBe(true);
		expect(WORKFLOW_NAME_PATTERN.test("code-review-2")).toBe(true);
		expect(WORKFLOW_NAME_PATTERN.test("Review")).toBe(false);
		expect(WORKFLOW_NAME_PATTERN.test("2review")).toBe(false);
		expect(WORKFLOW_NAME_PATTERN.test("a".repeat(49))).toBe(false);
	});
});

describe("extractWorkflowMeta: accepted literal grammar", () => {
	it("accepts comments, trailing commas, single quotes and unquoted keys", () => {
		const source = `// leading comment
/* block */
export const meta = {
	name: 'review',
	description: "Reviews a diff.", // trailing comment
	phases: [
		{ title: 'Read', detail: 'Read the diff', },
	],
};
console.log("body line 9");
`;
		const result = okResult(source);
		expect(result.meta).toEqual({
			name: "review",
			description: "Reviews a diff.",
			phases: [{ title: "Read", detail: "Read the diff" }],
		});
		expect(result.warnings).toEqual([]);
		expect(result.body.split("\n")[9]).toBe('console.log("body line 9");');
	});

	it("accepts a backslash line continuation with CRLF, a lone CR, and U+2028/U+2029", () => {
		const source =
			'export const meta = { name: "a", description: "d\\\r\nx\\\ry\\\n z\\  w\\  v", phases: [{ title: "t" }] };\n';
		const result = okResult(source);
		expect(result.meta.description).toBe("dxy z w v");
	});

	it("accepts template literals without interpolation and nested phases", () => {
		const source = `export const meta = {
	name: "nested",
	description: \`Multi
line description\`,
	phases: [
		{ title: "One", model: "anthropic/claude" },
		{ title: "Two" },
	],
};
`;
		const result = okResult(source);
		expect(result.meta.description).toBe("Multi\nline description");
		expect(result.meta.phases).toEqual([{ title: "One", model: "anthropic/claude" }, { title: "Two" }]);
	});

	it("keeps body line numbers equal to source line numbers", () => {
		const source = `export const meta = {
	name: "a",
	description: "d",
	phases: [{ title: "t" }],
};
line2();
line3();
`;
		const result = okResult(source);
		const lines = result.body.split("\n");
		expect(lines[5]).toBe("line2();");
		expect(lines[6]).toBe("line3();");
		expect(result.body.split("\n").length).toBe(source.split("\n").length);
	});
});

describe("extractWorkflowMeta: rejected grammar", () => {
	it("rejects identifiers with line and column", () => {
		const source = `export const meta = {
	name: review,
};
`;
		const error = errResult(source);
		expect(error.line).toBe(2);
		expect(error.column).toBe(8);
		expect(error.message).toMatch(/identifiers are not allowed/);
	});

	it("rejects calls with line and column", () => {
		const source = `export const meta = {
	name: getName(),
};
`;
		const error = errResult(source);
		expect(error.line).toBe(2);
		expect(error.column).toBe(8);
		expect(error.message).toMatch(/function calls are not allowed/);
	});

	it("rejects spreads with line and column", () => {
		const source = `export const meta = {
	...base,
};
`;
		const error = errResult(source);
		expect(error.line).toBe(2);
		expect(error.column).toBe(2);
		expect(error.message).toMatch(/spread syntax is not allowed/);
	});

	it("rejects computed keys with line and column", () => {
		const source = `export const meta = {
	[key]: "x",
};
`;
		const error = errResult(source);
		expect(error.line).toBe(2);
		expect(error.column).toBe(2);
		expect(error.message).toMatch(/computed keys are not allowed/);
	});

	it("rejects template interpolation with line and column", () => {
		const source = `export const meta = {
	name: \`a\${x}b\`,
};
`;
		const error = errResult(source);
		expect(error.line).toBe(2);
		expect(error.column).toBe(10);
		expect(error.message).toMatch(/interpolation/);
	});

	it("rejects a missing meta declaration with line and column", () => {
		const source = `const notMeta = {};
`;
		const error = errResult(source);
		expect(error.line).toBe(1);
		expect(error.column).toBe(1);
	});

	it("rejects regex literals with line and column", () => {
		const source = `export const meta = {
	name: /abc/,
};
`;
		const error = errResult(source);
		expect(error.line).toBe(2);
		expect(error.column).toBe(8);
		expect(error.message).toMatch(/regex literals are not allowed/);
	});
});

describe("extractWorkflowMeta: nesting depth", () => {
	it("rejects deeply nested arrays as a MetaExtraction error instead of a stack overflow", () => {
		const source = `export const meta = { name: "a", description: "d", phases: [{ title: "t", detail: ${"[".repeat(1000)}`;
		const error = errResult(source);
		expect(error.message).toMatch(/meta nesting is too deep/);
	});
});

describe("extractWorkflowMeta: unicode and hex escapes", () => {
	it("rejects a malformed \\u{...} escape instead of throwing a RangeError", () => {
		const error = errResult(
			`export const meta = { name: "a\\u{zz}", description: "d", phases: [{ title: "t" }] };\n`,
		);
		expect(error.message).toMatch(/invalid unicode escape/);
	});

	it("rejects a \\u{...} code point above 0x10FFFF", () => {
		const error = errResult(
			`export const meta = { name: "a\\u{110000}", description: "d", phases: [{ title: "t" }] };\n`,
		);
		expect(error.message).toMatch(/invalid unicode escape/);
	});

	it("rejects a malformed \\uXXXX escape instead of silently producing U+0000", () => {
		const error = errResult(
			`export const meta = { name: "a\\uZZZZ", description: "d", phases: [{ title: "t" }] };\n`,
		);
		expect(error.message).toMatch(/invalid unicode escape/);
	});

	it("rejects a malformed \\xXX escape instead of silently producing U+0000", () => {
		const error = errResult(`export const meta = { name: "a", description: "d\\xZZ", phases: [{ title: "t" }] };\n`);
		expect(error.message).toMatch(/invalid hex escape/);
	});

	it("rejects a short \\uXXXX escape instead of reading past the closing quote", () => {
		const error = errResult(`export const meta = { name: "a\\u12", description: "d", phases: [{ title: "t" }] };\n`);
		expect(error.message).toMatch(/invalid unicode escape/);
	});
});

describe("extractWorkflowMeta: validation", () => {
	const base = (overrides: string) => `export const meta = {
	name: "ok",
	description: "A workflow.",
	phases: [{ title: "Step" }],
	${overrides}
};
`;

	it("rejects an invalid name", () => {
		const error = errResult(
			`export const meta = { name: "Bad Name", description: "d", phases: [{ title: "t" }] };\n`,
		);
		expect(error.message).toMatch(/meta\.name must match/);
	});

	it("rejects a missing name", () => {
		const error = errResult(`export const meta = { description: "d", phases: [{ title: "t" }] };\n`);
		expect(error.message).toBe("meta.name is required");
	});

	it("rejects a non-string name", () => {
		const error = errResult(`export const meta = { name: 1, description: "d", phases: [{ title: "t" }] };\n`);
		expect(error.message).toMatch(/meta\.name must match/);
	});

	it("rejects a non-object meta", () => {
		const error = errResult(`export const meta = "not an object";\n`);
		expect(error.message).toBe("meta must be an object literal");
	});

	it("rejects a missing description", () => {
		const error = errResult(`export const meta = { name: "ok", phases: [{ title: "t" }] };\n`);
		expect(error.message).toBe("meta.description is required");
	});

	it("rejects a non-string description", () => {
		const error = errResult(`export const meta = { name: "ok", description: 1, phases: [{ title: "t" }] };\n`);
		expect(error.message).toBe("meta.description must be a non-empty string of at most 300 characters");
	});

	it("rejects a missing phases", () => {
		const error = errResult(`export const meta = { name: "ok", description: "d" };\n`);
		expect(error.message).toBe("meta.phases is required");
	});

	it("rejects a non-string whenToUse", () => {
		const error = errResult(base("whenToUse: 1,"));
		expect(error.message).toBe("meta.whenToUse must be a string of at most 300 characters");
	});

	it("rejects a non-string phase title", () => {
		const error = errResult(`export const meta = { name: "ok", description: "d", phases: [{ title: 1 }] };\n`);
		expect(error.message).toBe("meta.phases[0].title must be a non-empty string of at most 60 characters");
	});

	it("rejects a non-string phase detail", () => {
		const error = errResult(
			`export const meta = { name: "ok", description: "d", phases: [{ title: "t", detail: 1 }] };\n`,
		);
		expect(error.message).toBe("meta.phases[0].detail must be a string of at most 200 characters");
	});

	it("rejects a non-string phase model", () => {
		const error = errResult(
			`export const meta = { name: "ok", description: "d", phases: [{ title: "t", model: 1 }] };\n`,
		);
		expect(error.message).toBe("meta.phases[0].model must be a string of at most 120 characters");
	});

	it("rejects phases that is not an array", () => {
		const error = errResult(`export const meta = { name: "ok", description: "d", phases: "nope" };\n`);
		expect(error.message).toBe("meta.phases must be an array of 1 to 20 entries");
	});

	it("rejects a phase entry that is not an object", () => {
		const error = errResult(`export const meta = { name: "ok", description: "d", phases: [42] };\n`);
		expect(error.message).toBe("meta.phases[0] must be an object");
	});

	it("rejects a description over 300 characters", () => {
		const long = "x".repeat(301);
		const error = errResult(
			`export const meta = { name: "ok", description: "${long}", phases: [{ title: "t" }] };\n`,
		);
		expect(error.message).toBe("meta.description must be a non-empty string of at most 300 characters");
	});

	it("rejects an empty description", () => {
		const error = errResult(`export const meta = { name: "ok", description: "", phases: [{ title: "t" }] };\n`);
		expect(error.message).toBe("meta.description must be a non-empty string of at most 300 characters");
	});

	it("rejects a whenToUse over 300 characters", () => {
		const long = "x".repeat(301);
		const error = errResult(base(`whenToUse: "${long}",`));
		expect(error.message).toBe("meta.whenToUse must be a string of at most 300 characters");
	});

	it("rejects an empty phases array", () => {
		const error = errResult(`export const meta = { name: "ok", description: "d", phases: [] };\n`);
		expect(error.message).toBe("meta.phases must be an array of 1 to 20 entries");
	});

	it("rejects more than 20 phases", () => {
		const phases = Array.from({ length: 21 }, (_, i) => `{ title: "p${i}" }`).join(", ");
		const error = errResult(`export const meta = { name: "ok", description: "d", phases: [${phases}] };\n`);
		expect(error.message).toBe("meta.phases must be an array of 1 to 20 entries");
	});

	it("rejects a phase title over 60 characters", () => {
		const long = "t".repeat(61);
		const error = errResult(
			`export const meta = { name: "ok", description: "d", phases: [{ title: "${long}" }] };\n`,
		);
		expect(error.message).toBe("meta.phases[0].title must be a non-empty string of at most 60 characters");
	});

	it("rejects a missing phase title", () => {
		const error = errResult(`export const meta = { name: "ok", description: "d", phases: [{ detail: "d" }] };\n`);
		expect(error.message).toBe("meta.phases[0].title is required");
	});

	it("rejects a phase detail over 200 characters", () => {
		const long = "d".repeat(201);
		const error = errResult(
			`export const meta = { name: "ok", description: "d", phases: [{ title: "t", detail: "${long}" }] };\n`,
		);
		expect(error.message).toBe("meta.phases[0].detail must be a string of at most 200 characters");
	});

	it("rejects a phase model over 120 characters", () => {
		const long = "m".repeat(121);
		const error = errResult(
			`export const meta = { name: "ok", description: "d", phases: [{ title: "t", model: "${long}" }] };\n`,
		);
		expect(error.message).toBe("meta.phases[0].model must be a string of at most 120 characters");
	});

	it("warns on unknown top-level and phase keys, but still parses", () => {
		const result = okResult(
			`export const meta = { name: "ok", description: "d", extra: 1, phases: [{ title: "t", extraPhase: true }] };\n`,
		);
		expect(result.warnings).toEqual([
			expect.stringContaining("meta.extra"),
			expect.stringContaining("meta.phases[0].extraPhase"),
		]);
	});
});

describe("peekWorkflowMeta", () => {
	it("extracts name, description and phase titles from a truncated script", () => {
		const partial = `export const meta = {
	name: "draft",
	description: "In progress",
	phases: [
		{ title: "First" },
		{ title: "Second"`;
		const peek = peekWorkflowMeta(partial);
		expect(peek.name).toBe("draft");
		expect(peek.description).toBe("In progress");
		expect(peek.phases).toEqual(["First", "Second"]);
		expect(peek.lines).toBe(5);
	});

	it("returns no fields for input with none of them yet", () => {
		const peek = peekWorkflowMeta("export const m");
		expect(peek.name).toBeUndefined();
		expect(peek.description).toBeUndefined();
		expect(peek.phases).toBeUndefined();
		expect(peek.lines).toBe(0);
	});

	it("only scans the first 8 KiB for fields but counts lines up to 256 KiB", () => {
		const filler = "x".repeat(9000);
		const partial = `// ${filler}\nname: "late"\n${"y\n".repeat(200)}`;
		const peek = peekWorkflowMeta(partial);
		expect(peek.name).toBeUndefined();
		expect(peek.lines).toBeGreaterThan(190);
	});

	it("caps line counting at 256 KiB even when the input is longer", () => {
		const PEEK_LINE_SCAN_BYTES = 256 * 1024;
		const partial = "\n".repeat(PEEK_LINE_SCAN_BYTES + 10_000);
		const peek = peekWorkflowMeta(partial);
		expect(peek.lines).toBe(PEEK_LINE_SCAN_BYTES);
	});

	it("does not throw on a truncated, unterminated string with many escapes", () => {
		const partial = `export const meta = { name: "a", description: "${"line\\n".repeat(40)}`;
		expect(() => peekWorkflowMeta(partial)).not.toThrow();
	});

	it("handles quoted keys like extractWorkflowMeta does", () => {
		const partial = `export const meta = {
	"name": "draft",
	"description": "In progress",
	phases: [
		{ "title": "First" },
		{ title: "Second"`;
		const peek = peekWorkflowMeta(partial);
		expect(peek.name).toBe("draft");
		expect(peek.description).toBe("In progress");
		expect(peek.phases).toEqual(["First", "Second"]);
	});

	it("does not match a quoted key as a substring of another identifier", () => {
		const partial = 'export const meta = { "myname": "nope", "description": "d", phases: [{ title: "t"';
		const peek = peekWorkflowMeta(partial);
		expect(peek.name).toBeUndefined();
	});
});

describe("extractWorkflowMeta + runWorkflowScript: line numbers survive extraction", () => {
	it("reports an error thrown on source line 12 at line 12", async () => {
		const source = `export const meta = {
	name: "demo",
	description: "d",
	phases: [{ title: "t" }],
};
void 6;
void 7;
void 8;
void 9;
void 10;
void 11;
throw new Error("boom line 12");
`;
		const extraction = okResult(source);
		const outcome = await runWorkflowScript({
			meta: extraction.meta,
			body: extraction.body,
			args: "",
			budgetTokens: null,
			maxAgents: 10,
			maxItemsPerCall: 10,
			timeoutMs: Number.POSITIVE_INFINITY,
			signal: new AbortController().signal,
			host: NOOP_HOST,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.line).toBe(12);
		expect(outcome.error.message).toBe("boom line 12");
	});

	it("reports an error thrown on body line 1 at line 1", async () => {
		const source = `export const meta = { name: "demo", description: "d", phases: [{ title: "t" }] }; throw new Error("boom line 1");
`;
		const extraction = okResult(source);
		const outcome = await runWorkflowScript({
			meta: extraction.meta,
			body: extraction.body,
			args: "",
			budgetTokens: null,
			maxAgents: 10,
			maxItemsPerCall: 10,
			timeoutMs: Number.POSITIVE_INFINITY,
			signal: new AbortController().signal,
			host: NOOP_HOST,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.line).toBe(1);
		expect(outcome.error.message).toBe("boom line 1");
	});
});
