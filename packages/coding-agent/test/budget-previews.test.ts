import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewTool } from "../src/core/budgets/tools.ts";

describe("budget edit previews", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "budget-previews-"));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("previews writes and sequential multi-edits without changing the file", () => {
		writeFileSync(join(cwd, "a.ts"), "one one\n");
		expect(previewTool(cwd, "Write", { file_path: "a.ts", content: "new\n" })).toEqual([
			{ path: join(cwd, "a.ts"), content: "new\n" },
		]);
		expect(
			previewTool(cwd, "MultiEdit", {
				file_path: "a.ts",
				edits: [
					{ old_string: "one", new_string: "two", replace_all: true },
					{ old_string: "two two", new_string: "three" },
				],
			}),
		).toEqual([{ path: join(cwd, "a.ts"), content: "three\n" }]);
		expect(readFileSync(join(cwd, "a.ts"), "utf8")).toBe("one one\n");
	});

	it("rejects ambiguous replacements rather than guessing the mutation", () => {
		writeFileSync(join(cwd, "a.ts"), "one one\n");
		expect(() => previewTool(cwd, "Edit", { file_path: "a.ts", old_string: "one", new_string: "two" })).toThrow(
			/ambiguous/,
		);
	});

	it("previews a Codex patch that adds, updates, moves and deletes files", () => {
		writeFileSync(join(cwd, "old.ts"), "export const old = 1;\n");
		writeFileSync(join(cwd, "gone.ts"), "remove me\n");
		const patch =
			"*** Begin Patch\n*** Add File: new.ts\n+new file\n*** Update File: old.ts\n*** Move to: renamed.ts\n@@\n-export const old = 1;\n+export const renamed = 2;\n*** Delete File: gone.ts\n*** End Patch";
		expect(previewTool(cwd, "functions.apply_patch", { input: patch })).toEqual([
			{ path: join(cwd, "new.ts"), content: "new file\n" },
			{ path: join(cwd, "old.ts"), content: null },
			{ path: join(cwd, "renamed.ts"), content: "export const renamed = 2;\n" },
			{ path: join(cwd, "gone.ts"), content: null },
		]);
		expect(readFileSync(join(cwd, "old.ts"), "utf8")).toBe("export const old = 1;\n");
	});

	it("locates patch hunks using a skip-ahead context and end-of-file marker", () => {
		writeFileSync(join(cwd, "a.ts"), "prefix\nanchor\none\ntail\n");
		const patch =
			"*** Begin Patch\n*** Update File: a.ts\n@@ anchor\n-one\n+two\n tail\n*** End of File\n*** End Patch\n";
		expect(previewTool(cwd, "apply_patch", patch)).toEqual([
			{ path: join(cwd, "a.ts"), content: "prefix\nanchor\ntwo\ntail\n" },
		]);
	});

	it("does not interpret shell commands as known file edits", () => {
		expect(previewTool(cwd, "Bash", { command: "echo text > a.ts" })).toBeUndefined();
	});

	it("preserves CRLF when a Codex patch changes one line", () => {
		writeFileSync(join(cwd, "a.ts"), "keep\r\nold\r\ntail\r\n");
		const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n tail\n*** End Patch";
		expect(previewTool(cwd, "apply_patch", patch)).toEqual([
			{ path: join(cwd, "a.ts"), content: "keep\r\nnew\r\ntail\r\n" },
		]);
	});

	it("preserves original fuzzy-matched context and mixed line endings", () => {
		writeFileSync(join(cwd, "a.ts"), "first\r\n        keep\nold\r\nlast");
		const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n keep\n-old\n+new\n*** End Patch";
		expect(previewTool(cwd, "apply_patch", patch)).toEqual([
			{ path: join(cwd, "a.ts"), content: "first\r\n        keep\nnew\r\nlast\r\n" },
		]);
	});

	it("produces an empty file when a patch removes every line", () => {
		writeFileSync(join(cwd, "a.ts"), "old\n");
		const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n*** End Patch";
		expect(previewTool(cwd, "apply_patch", patch)).toEqual([{ path: join(cwd, "a.ts"), content: "" }]);
	});

	it("locates later hunks in the original file after an append-only hunk", () => {
		writeFileSync(join(cwd, "a.ts"), "first\nsecond\n");
		const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n+append\n@@\n-first\n+updated\n*** End Patch";
		expect(previewTool(cwd, "apply_patch", patch)).toEqual([
			{ path: join(cwd, "a.ts"), content: "updated\nsecond\nappend\n" },
		]);
	});

	it("fails closed on malformed known tool payloads", () => {
		expect(() => previewTool(cwd, "Write", {})).toThrow();
		expect(() => previewTool(cwd, "apply_patch", "not a patch")).toThrow();
	});
});
