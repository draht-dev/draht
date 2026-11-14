import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import type { GrepOperations } from "../src/index.ts";
import type * as ToolsManager from "../src/utils/tools-manager.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

vi.mock("../src/utils/tools-manager.ts", () => ({
	ensureTool: vi.fn(),
}));

const { ensureTool: ensureLocalTool } = await vi.importActual<typeof ToolsManager>("../src/utils/tools-manager.ts");

const processes = new Set<ChildProcess>();

function startProcess(source: string) {
	const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
	processes.add(child);
	child.once("close", () => processes.delete(child));
	return child;
}

function matchEvent(text: string, lineNumber = 1, type: "match" | "context" = "match") {
	return JSON.stringify({
		type,
		data: { path: { text: "/virtual/project/example.ts" }, line_number: lineNumber, lines: { text: `${text}\n` } },
	});
}

afterEach(() => {
	for (const child of processes) child.kill();
	processes.clear();
	vi.resetAllMocks();
});

describe("grep process operations", () => {
	it("uses the custom process and filesystem backend without resolving or downloading local ripgrep", async () => {
		const output = [
			matchEvent("before", 1, "context"),
			matchEvent("needle", 2),
			matchEvent("after", 3, "context"),
		].join("\n");
		const start = vi.fn(() => startProcess(`console.log(${JSON.stringify(output)})`));
		const tool = createGrepTool("/virtual/project", {
			operations: { isDirectory: () => true, spawn: start },
		});

		const result = await tool.execute("test", {
			pattern: "needle",
			glob: "*.ts",
			ignoreCase: true,
			literal: true,
			context: 1,
		});

		expect(start).toHaveBeenCalledWith([
			"--no-config",
			"--json",
			"--line-number",
			"--color=never",
			"--hidden",
			"--ignore-case",
			"--fixed-strings",
			"--glob",
			"*.ts",
			"--context",
			"1",
			"--",
			"needle",
			"/virtual/project",
		]);
		expect(result.content).toEqual([
			{ type: "text", text: "example.ts-1- before\nexample.ts:2: needle\nexample.ts-3- after" },
		]);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("retains local ripgrep resolution for a filesystem-only custom backend", async () => {
		vi.mocked(ensureTool).mockResolvedValue("/unavailable-draht-test-ripgrep");
		const isDirectory = vi.fn(() => true);
		const tool = createGrepTool("/virtual/project", {
			operations: { isDirectory },
		});

		await expect(tool.execute("test", { pattern: "needle" })).rejects.toThrow("Failed to run ripgrep:");
		expect(ensureTool).toHaveBeenCalledWith("rg");
		expect(isDirectory).toHaveBeenCalledWith("/virtual/project");
	});

	it("retains the unavailable-tool error for the default backend", async () => {
		const tool = createGrepTool("/virtual/project");

		await expect(tool.execute("test", { pattern: "needle" })).rejects.toThrow(
			"ripgrep (rg) is not available and could not be downloaded",
		);
		expect(ensureTool).toHaveBeenCalledWith("rg");
	});

	it("accepts ripgrep's no-match exit status from a custom backend", async () => {
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: () => true,
				spawn: () => startProcess("process.exitCode = 1"),
			},
		});

		const result = await tool.execute("test", { pattern: "needle" });

		expect(result.content).toEqual([{ type: "text", text: "No matches found" }]);
	});

	it("stops the custom process at the match limit and ignores later streamed matches", async () => {
		const output = `${matchEvent("first")}\n${matchEvent("second", 2)}\n`;
		const start = vi.fn(() =>
			startProcess(`process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000)`),
		);
		const tool = createGrepTool("/virtual/project", {
			operations: { isDirectory: () => true, spawn: start },
		});

		const result = await tool.execute("test", { pattern: "needle", limit: 1 });

		expect(result.content).toEqual([
			{
				type: "text",
				text: "example.ts:1: first\n\n[1 matches limit reached. Use limit=2 for more, or refine pattern]",
			},
		]);
		expect(result.details).toEqual({ matchLimitReached: 1 });
		expect(start.mock.results[0].value.killed).toBe(true);
	});

	it("kills the custom process when the search is cancelled", async () => {
		const controller = new AbortController();
		const start = vi.fn(() => {
			const child = startProcess("setInterval(() => {}, 1000)");
			child.once("spawn", () => controller.abort());
			return child;
		});
		const tool = createGrepTool("/virtual/project", {
			operations: { isDirectory: () => true, spawn: start },
		});

		await expect(tool.execute("test", { pattern: "needle" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(start.mock.results[0].value.killed).toBe(true);
	});

	it("does not spawn after cancellation while checking the search path", async () => {
		const controller = new AbortController();
		const start = vi.fn(() => startProcess("process.exitCode = 0"));
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: async () => {
					controller.abort();
					return true;
				},
				spawn: start,
			},
		});

		await expect(tool.execute("test", { pattern: "needle" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(start).not.toHaveBeenCalled();
	});

	it("catches cancellation from within the custom spawn operation", async () => {
		const controller = new AbortController();
		const start = vi.fn(() => {
			const child = startProcess("setInterval(() => {}, 1000)");
			controller.abort();
			return child;
		});
		const tool = createGrepTool("/virtual/project", {
			operations: { isDirectory: () => true, spawn: start },
		});

		await expect(tool.execute("test", { pattern: "needle" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(start.mock.results[0].value.killed).toBe(true);
	});

	it("reports stderr from a failing custom process", async () => {
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: () => true,
				spawn: () => startProcess('process.stderr.write("invalid search pattern\\n"); process.exitCode = 2'),
			},
		});

		await expect(tool.execute("test", { pattern: "[" })).rejects.toThrow("invalid search pattern");
	});

	it("reports custom process spawn errors", async () => {
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: () => true,
				spawn: () => spawn("/unavailable-draht-test-ripgrep", [], { stdio: ["ignore", "pipe", "pipe"] }),
			},
		});

		await expect(tool.execute("test", { pattern: "needle" })).rejects.toThrow("Failed to run ripgrep:");
	});

	it("propagates confinement rejection without falling back to local ripgrep", async () => {
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: () => true,
				spawn: () => {
					throw new Error("Confinement unavailable");
				},
			},
		});

		await expect(tool.execute("test", { pattern: "needle" })).rejects.toThrow("Confinement unavailable");
		expect(ensureTool).not.toHaveBeenCalled();
	});
});

const expectedContent = [{ type: "text", text: "file.txt-1- before\nfile.txt:2: needle\nfile.txt-3- after" }];

describe("GrepOperations", () => {
	const cwd = mkdtempSync(join(tmpdir(), "draht-grep-operations-"));
	writeFileSync(join(cwd, "file.txt"), "before\nneedle\nafter\n");
	afterAll(() => rmSync(cwd, { recursive: true, force: true }));
	// These run the real local ripgrep; the process tests above mock tool resolution.
	beforeEach(() => {
		vi.mocked(ensureTool).mockImplementation(ensureLocalTool);
	});

	// #9276: restoring the public hook must not reintroduce whole-file reads for context.
	it.each([
		{ name: "synchronous", readFile: (_absolutePath: string) => "custom context" },
		{ name: "asynchronous", readFile: async (_absolutePath: string) => "custom context" },
	])("accepts a deprecated $name readFile hook without calling it", async ({ readFile }) => {
		const legacyReadFile = vi.fn(readFile);
		const operations: GrepOperations = { isDirectory: () => true, readFile: legacyReadFile };
		const tool = createGrepTool(cwd, { operations });

		const result = await tool.execute("grep", { pattern: "needle", context: 1 });

		expect(result.content).toEqual(expectedContent);
		expect(legacyReadFile).not.toHaveBeenCalled();
	});

	it("allows custom operations without a readFile hook", async () => {
		const operations: GrepOperations = { isDirectory: () => true };
		const tool = createGrepTool(cwd, { operations });

		const result = await tool.execute("grep", { pattern: "needle", context: 1 });

		expect(result.content).toEqual(expectedContent);
	});
});
