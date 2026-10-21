import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { ensureTool } from "../src/utils/tools-manager.ts";

vi.mock("../src/utils/tools-manager.ts", () => ({
	ensureTool: vi.fn(),
}));

const processes = new Set<ChildProcess>();

function startProcess(source: string) {
	const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
	processes.add(child);
	child.once("close", () => processes.delete(child));
	return child;
}

function matchEvent(text: string, lineNumber = 1) {
	return JSON.stringify({
		type: "match",
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
		const start = vi.fn(() => startProcess(`console.log(${JSON.stringify(matchEvent("needle", 2))})`));
		const readFile = vi.fn(async () => "before\nneedle\nafter\n");
		const tool = createGrepTool("/virtual/project", {
			operations: { isDirectory: () => true, readFile, spawn: start },
		});

		const result = await tool.execute("test", {
			pattern: "needle",
			glob: "*.ts",
			ignoreCase: true,
			literal: true,
			context: 1,
		});

		expect(start).toHaveBeenCalledWith([
			"--json",
			"--line-number",
			"--color=never",
			"--hidden",
			"--ignore-case",
			"--fixed-strings",
			"--glob",
			"*.ts",
			"--",
			"needle",
			"/virtual/project",
		]);
		expect(readFile).toHaveBeenCalledWith("/virtual/project/example.ts");
		expect(result.content).toEqual([
			{ type: "text", text: "example.ts-1- before\nexample.ts:2: needle\nexample.ts-3- after" },
		]);
		expect(ensureTool).not.toHaveBeenCalled();
	});

	it("retains local ripgrep resolution for a filesystem-only custom backend", async () => {
		vi.mocked(ensureTool).mockResolvedValue("/unavailable-draht-test-ripgrep");
		const isDirectory = vi.fn(() => true);
		const tool = createGrepTool("/virtual/project", {
			operations: { isDirectory, readFile: () => "" },
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
				readFile: () => "",
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
			operations: { isDirectory: () => true, readFile: () => "", spawn: start },
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
			operations: { isDirectory: () => true, readFile: () => "", spawn: start },
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
				readFile: () => "",
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
			operations: { isDirectory: () => true, readFile: () => "", spawn: start },
		});

		await expect(tool.execute("test", { pattern: "needle" }, controller.signal)).rejects.toThrow("Operation aborted");
		expect(start.mock.results[0].value.killed).toBe(true);
	});

	it("reports stderr from a failing custom process", async () => {
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: () => true,
				readFile: () => "",
				spawn: () => startProcess('process.stderr.write("invalid search pattern\\n"); process.exitCode = 2'),
			},
		});

		await expect(tool.execute("test", { pattern: "[" })).rejects.toThrow("invalid search pattern");
	});

	it("reports custom process spawn errors", async () => {
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: () => true,
				readFile: () => "",
				spawn: () => spawn("/unavailable-draht-test-ripgrep", [], { stdio: ["ignore", "pipe", "pipe"] }),
			},
		});

		await expect(tool.execute("test", { pattern: "needle" })).rejects.toThrow("Failed to run ripgrep:");
	});

	it("propagates confinement rejection without falling back to local ripgrep", async () => {
		const tool = createGrepTool("/virtual/project", {
			operations: {
				isDirectory: () => true,
				readFile: () => "",
				spawn: () => {
					throw new Error("Confinement unavailable");
				},
			},
		});

		await expect(tool.execute("test", { pattern: "needle" })).rejects.toThrow("Confinement unavailable");
		expect(ensureTool).not.toHaveBeenCalled();
	});
});
