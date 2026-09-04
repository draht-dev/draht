import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { exitCodeForSignal, spawnProcess, waitForChildProcess } from "../src/utils/child-process.ts";

// Mirrors upstream c2d3dc55b (pi#8992) for draht's own bash tool: a child killed by a
// signal has no exit code, and `null` used to be treated as success.
describe.skipIf(process.platform === "win32")("bash tool signal-killed exit codes", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "draht-bash-signal-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("exitCodeForSignal follows the 128 + signal number convention", () => {
		expect(exitCodeForSignal("SIGKILL")).toBe(137);
		expect(exitCodeForSignal("SIGTERM")).toBe(143);
	});

	it("waitForChildProcess resolves 128 + signal number for a signal-killed child", async () => {
		const child = spawnProcess("/bin/sh", ["-c", "kill -9 $$"], { stdio: ["ignore", "pipe", "pipe"] });
		expect(await waitForChildProcess(child)).toBe(137);
	});

	it("local bash operations report a non-zero exit code for a signal-killed command", async () => {
		const result = await createLocalBashOperations().exec("kill -9 $$", cwd, { onData: () => {} });
		expect(result.exitCode).toBe(137);
	});

	it("bash tool fails a signal-killed command instead of treating it as success", async () => {
		const tool = createBashTool(cwd);
		await expect(tool.execute("call-1", { command: "echo before; kill -9 $$" })).rejects.toThrow(
			/before[\s\S]*Command exited with code 137/,
		);
	});

	it("bash tool fails when custom operations report no exit code at all", async () => {
		const tool = createBashTool(cwd, { operations: { exec: async () => ({ exitCode: null }) } });
		await expect(tool.execute("call-1", { command: "true" })).rejects.toThrow(
			"Command terminated without an exit code",
		);
	});
});
