import assert from "node:assert";
import { describe, it } from "node:test";

// Test the chunking logic (pure function, no API calls needed)

const MAX_CHUNK_CHARS = 2000;

function chunkContent(content: string): { content: string }[] {
	const chunks: { content: string }[] = [];
	const sections = content.split(/^(?=#{1,3}\s)/m);

	for (const section of sections) {
		const trimmed = section.trim();
		if (!trimmed) continue;

		if (trimmed.length <= MAX_CHUNK_CHARS) {
			chunks.push({ content: trimmed });
		} else {
			const paragraphs = trimmed.split(/\n\n+/);
			let current = "";
			for (const para of paragraphs) {
				if (current.length + para.length + 2 > MAX_CHUNK_CHARS) {
					if (current.trim()) {
						chunks.push({ content: current.trim() });
					}
					current = para;
				} else {
					current = current ? `${current}\n\n${para}` : para;
				}
			}
			if (current.trim()) {
				chunks.push({ content: current.trim() });
			}
		}
	}
	return chunks;
}

function inferChunkType(filePath: string): string {
	const basename = filePath.toLowerCase().split("/").pop() ?? "";
	if (basename.includes("agents") || basename.includes("convention")) return "convention";
	if (basename.includes("decision") || basename.includes("adr")) return "decision";
	if (basename.includes("pattern")) return "pattern";
	return "general";
}

describe("chunkContent", () => {
	it("returns empty array for empty content", () => {
		assert.deepStrictEqual(chunkContent(""), []);
		assert.deepStrictEqual(chunkContent("   "), []);
	});

	it("keeps short content as a single chunk", () => {
		const result = chunkContent("Hello world");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].content, "Hello world");
	});

	it("splits by markdown headings", () => {
		const content = "# Heading 1\nParagraph 1\n\n# Heading 2\nParagraph 2";
		const result = chunkContent(content);
		assert.strictEqual(result.length, 2);
		assert.ok(result[0].content.includes("Heading 1"));
		assert.ok(result[1].content.includes("Heading 2"));
	});

	it("splits by h2 and h3 headings", () => {
		const content = "## H2\nText\n\n### H3\nMore text";
		const result = chunkContent(content);
		assert.strictEqual(result.length, 2);
	});

	it("splits long sections into paragraph chunks", () => {
		const longParagraph = "A".repeat(800);
		const content = `# Section\n\n${longParagraph}\n\n${longParagraph}\n\n${longParagraph}`;
		const result = chunkContent(content);
		assert.ok(result.length >= 2, `Expected >= 2 chunks, got ${result.length}`);
		for (const chunk of result) {
			assert.ok(chunk.content.length <= MAX_CHUNK_CHARS + 100, `Chunk too large: ${chunk.content.length}`);
		}
	});

	it("handles content without headings", () => {
		const content = "Just some plain text\n\nWith multiple paragraphs\n\nAnd more";
		const result = chunkContent(content);
		assert.strictEqual(result.length, 1);
	});
});

describe("inferChunkType", () => {
	it("detects convention files", () => {
		assert.strictEqual(inferChunkType("AGENTS.md"), "convention");
		assert.strictEqual(inferChunkType("/path/to/conventions.md"), "convention");
	});

	it("detects decision files", () => {
		assert.strictEqual(inferChunkType("decisions.md"), "decision");
		assert.strictEqual(inferChunkType("adr-001.md"), "decision");
	});

	it("detects pattern files", () => {
		assert.strictEqual(inferChunkType("patterns.md"), "pattern");
	});

	it("defaults to general", () => {
		assert.strictEqual(inferChunkType("README.md"), "general");
		assert.strictEqual(inferChunkType("random-notes.txt"), "general");
	});
});
