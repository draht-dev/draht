// Tests for `packages/rlm/src/loaders.ts` -- input loaders that turn a raw
// `--input`/`/rlm <input>` argument into loaded text content ready to
// become an `RlmSession`'s `prompt`. See
// .planning/phases/29-agent-cli-integration/29-01-PLAN.md, Architecture
// section 1.
//
// The URL loader mocks `fetch` and the knowledge loader mocks
// `@draht/knowledge`'s exports -- no real network/embedding-API call ever
// happens. The file/glob loaders exercise real filesystem I/O against temp
// directories, including a real 500KB+ generated fixture (task 1's
// acceptance criterion), so those two paths are proven against the actual
// `node:fs/promises` machinery, not a mock.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchResult } from "@draht/knowledge";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadInput, parseInputArg } from "../src/loaders.js";

const searchKnowledgeMock = vi.fn(async (_query: string, mode: string): Promise<SearchResult[]> => {
	if (mode === "decide") {
		return [
			{
				content: "Decided to route oversize inputs through @draht/rlm instead of reading them directly.",
				metadata: { source: "decisions.md", client: "acme", timestamp: 0, type: "decision" },
				score: 0.91,
			},
		];
	}
	return [
		{
			content: "# AGENTS.md\n\nAlways run the test suite before committing.",
			metadata: { source: "AGENTS.md", client: "acme", timestamp: 0, type: "convention" },
			score: 0.95,
		},
	];
});
const closeMock = vi.fn();
const knowledgeManagerCtor = vi.fn().mockImplementation((clientSlug: string) => ({
	clientSlug,
	searchKnowledge: searchKnowledgeMock,
	close: closeMock,
}));

vi.mock("@draht/knowledge", () => ({
	KnowledgeManager: knowledgeManagerCtor,
}));

/** Generates a real 500KB+ text fixture: repeated realistic paragraphs with a needle planted in the middle. */
function generateLargeFixture(): { text: string; needle: string } {
	const paragraph =
		"The recursive language model root loop writes Python that peeks, chunks, and searches its context " +
		"variable, calling llm_query for recursive sub-calls whenever a fragment needs deeper reasoning than " +
		"a plain string search can provide, and terminates by invoking FINAL or FINAL_VAR once the answer is " +
		"in hand. ";
	const needle = "<<NEEDLE:the-planted-answer-is-8675309>>";

	const chunks: string[] = [];
	let total = 0;
	const targetBeforeNeedle = 260_000;
	while (total < targetBeforeNeedle) {
		chunks.push(paragraph);
		total += paragraph.length;
	}
	chunks.push(`\n${needle}\n`);
	while (total < 500_000) {
		chunks.push(paragraph);
		total += paragraph.length;
	}

	const text = chunks.join("");
	return { text, needle };
}

describe("loaders", () => {
	let tmpDir: string | undefined;

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	function makeTmpDir(): string {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-loaders-test-"));
		return tmpDir;
	}

	test("1. file loader reads a real temp file's content correctly", async () => {
		const dir = makeTmpDir();
		const filePath = join(dir, "notes.txt");
		writeFileSync(filePath, "hello from a real file on disk", "utf-8");

		const source = parseInputArg(filePath, dir);
		expect(source).toEqual({ type: "file", path: filePath });

		const result = await loadInput(source);
		expect(result.content).toBe("hello from a real file on disk");
		expect(result.contextType).toBe("text");
	});

	test("2. glob loader concatenates multiple matched files with clear per-file separators", async () => {
		const dir = makeTmpDir();
		const fileA = join(dir, "a.txt");
		const fileB = join(dir, "b.txt");
		writeFileSync(fileA, "content of A", "utf-8");
		writeFileSync(fileB, "content of B", "utf-8");
		// Should not be picked up by the "*.txt" pattern below.
		writeFileSync(join(dir, "c.md"), "content of C", "utf-8");

		const source = parseInputArg("*.txt", dir);
		expect(source).toEqual({ type: "glob", pattern: "*.txt", cwd: dir });

		const result = await loadInput(source);
		expect(result.content).toContain(`--- source: ${fileA} ---\ncontent of A`);
		expect(result.content).toContain(`--- source: ${fileB} ---\ncontent of B`);
		expect(result.content).not.toContain("content of C");
		// A appears before B (sorted, deterministic ordering).
		expect(result.content.indexOf("content of A")).toBeLessThan(result.content.indexOf("content of B"));
		expect(result.contextType).toBe("text");
	});

	test("3. URL loader (mocked fetch) returns the fetched body", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			expect(url).toBe("https://example.invalid/doc.txt");
			return {
				ok: true,
				status: 200,
				headers: { get: (name: string) => (name === "content-type" ? "text/plain; charset=utf-8" : null) },
				text: async () => "fetched body content",
			} as unknown as Response;
		});
		vi.stubGlobal("fetch", fetchMock);

		const source = parseInputArg("https://example.invalid/doc.txt", "/unused/cwd");
		expect(source).toEqual({ type: "url", url: "https://example.invalid/doc.txt" });

		const result = await loadInput(source);
		expect(result.content).toBe("fetched body content");
		expect(result.contextType).toBe("text");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test("4. knowledge loader (mocked @draht/knowledge) returns a combined AGENTS.md + decisions string", async () => {
		const source = parseInputArg("knowledge:acme", "/unused/cwd");
		expect(source).toEqual({ type: "knowledge", clientSlug: "acme" });

		const result = await loadInput(source);

		expect(knowledgeManagerCtor).toHaveBeenCalledWith("acme");
		expect(result.content).toContain("AGENTS.md");
		expect(result.content).toContain("Always run the test suite before committing.");
		expect(result.content).toContain("Decided to route oversize inputs through @draht/rlm");
		expect(result.contextType).toBe("text");
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	test("5. parseInputArg correctly classifies a file path, a glob pattern, an http(s) URL, and a knowledge reference", () => {
		const cwd = "/some/project";

		expect(parseInputArg("docs/report.txt", cwd)).toEqual({ type: "file", path: "/some/project/docs/report.txt" });
		expect(parseInputArg("/abs/path/file.txt", cwd)).toEqual({ type: "file", path: "/abs/path/file.txt" });

		expect(parseInputArg("docs/**/*.md", cwd)).toEqual({ type: "glob", pattern: "docs/**/*.md", cwd });
		expect(parseInputArg("src/*.ts", cwd)).toEqual({ type: "glob", pattern: "src/*.ts", cwd });

		expect(parseInputArg("http://example.com/a.txt", cwd)).toEqual({ type: "url", url: "http://example.com/a.txt" });
		expect(parseInputArg("https://example.com/a.txt", cwd)).toEqual({
			type: "url",
			url: "https://example.com/a.txt",
		});

		expect(parseInputArg("knowledge:acme-corp", cwd)).toEqual({ type: "knowledge", clientSlug: "acme-corp" });
	});

	test("6. a real 500KB+ generated fixture loads intact through the file loader", async () => {
		const dir = makeTmpDir();
		const { text, needle } = generateLargeFixture();
		expect(text.length).toBeGreaterThanOrEqual(500_000);

		const filePath = join(dir, "large-fixture.txt");
		writeFileSync(filePath, text, "utf-8");

		const source = parseInputArg(filePath, dir);
		const result = await loadInput(source);

		expect(result.content.length).toBe(text.length);
		expect(result.content).toBe(text);
		expect(result.content).toContain(needle);
	});
});
