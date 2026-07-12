import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLoopContext } from "../../src/lanes/loop-context.js";

let worktree: string;

beforeEach(() => {
	worktree = mkdtempSync(join(tmpdir(), "loop-context-test-"));
});

afterEach(() => {
	rmSync(worktree, { recursive: true, force: true });
});

describe("readLoopContext", () => {
	test("returns undefined when .planning/loop/ doesn't exist at all", () => {
		expect(readLoopContext(worktree)).toBeUndefined();
	});

	test("returns undefined when .planning/loop/ exists but has no LOOP.md", () => {
		mkdirSync(join(worktree, ".planning", "loop"), { recursive: true });

		expect(readLoopContext(worktree)).toBeUndefined();
	});

	test("returns the exact content and absolute path when LOOP.md is present", () => {
		mkdirSync(join(worktree, ".planning", "loop"), { recursive: true });
		const loopPath = join(worktree, ".planning", "loop", "LOOP.md");
		writeFileSync(loopPath, "# Loop\n\ncurrent phase: 39\n");

		expect(readLoopContext(worktree)).toEqual({
			path: loopPath,
			content: "# Loop\n\ncurrent phase: 39\n",
		});
	});
});
