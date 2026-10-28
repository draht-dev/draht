import { describe, expect, test } from "bun:test";
import type { FileChange } from "../src/contract.ts";
import { buildChangeDiagram, escapeMermaidLabel } from "../src/diagram.ts";

function file(path: string, status: FileChange["status"] = "modified"): FileChange {
	return { path, status, additions: 1, deletions: 0, hunks: [] };
}

describe("buildChangeDiagram", () => {
	test("is deterministic for the same input", () => {
		const files = [file("src/a.ts"), file("src/b.ts"), file("test/c.ts")];
		const a = buildChangeDiagram(files);
		const b = buildChangeDiagram(files);
		expect(a.mermaid).toBe(b.mermaid);
	});

	test("produces the same output regardless of input order", () => {
		const files = [file("src/a.ts"), file("test/c.ts"), file("src/b.ts")];
		const reordered = [file("test/c.ts"), file("src/b.ts"), file("src/a.ts")];
		expect(buildChangeDiagram(files).mermaid).toBe(buildChangeDiagram(reordered).mermaid);
	});

	test("only emits directories and files that appear in the input", () => {
		const files = [file("src/a.ts"), file("docs/readme.md")];
		const { mermaid } = buildChangeDiagram(files);
		expect(mermaid).toContain("src");
		expect(mermaid).toContain("a.ts");
		expect(mermaid).toContain("docs");
		expect(mermaid).toContain("readme.md");
		expect(mermaid).not.toContain("lib");
	});

	test("caps directory and file node counts", () => {
		const manyDirs = Array.from({ length: 20 }, (_, i) => file(`dir${i}/file.ts`));
		const { mermaid, dirCount } = buildChangeDiagram(manyDirs);
		expect(dirCount).toBe(20);
		expect(mermaid).toContain("more directories");
	});

	test("applies a status classDef to each file node", () => {
		const files = [file("src/a.ts", "added"), file("src/b.ts", "deleted")];
		const { mermaid } = buildChangeDiagram(files);
		expect(mermaid).toContain("class file_0 added;");
		expect(mermaid).toContain("class file_1 deleted;");
	});

	test("node ids never collide, even for paths that sanitize to the same string", () => {
		// src/a-b.ts and src/a_b.ts both sanitize to "a_b" under a replace-non-alphanumerics scheme.
		const files = [file("src/a-b.ts", "added"), file("src/a_b.ts", "deleted")];
		const { mermaid } = buildChangeDiagram(files);
		const fileNodeIds = [...mermaid.matchAll(/^(file_\d+)\[/gm)].map((m) => m[1]);
		expect(new Set(fileNodeIds).size).toBe(fileNodeIds.length);
		expect(fileNodeIds).toHaveLength(2);
	});
});

describe("escapeMermaidLabel", () => {
	test("escapes double quotes and newlines", () => {
		expect(escapeMermaidLabel('say "hi"\nnext line')).toBe("say #quot;hi#quot; next line");
	});

	test("leaves backslashes alone (Mermaid does not treat \\ as an escape character)", () => {
		expect(escapeMermaidLabel("a\\b")).toBe("a\\b");
	});

	test("file paths with quotes do not break the diagram", () => {
		const files = [file('src/weird "name".ts')];
		const { mermaid } = buildChangeDiagram(files);
		expect(mermaid).toContain("#quot;name#quot;");
		expect(mermaid).not.toMatch(/\["weird "name"\.ts"\]/);
	});
});
