/**
 * R34-PERM.7 enabler — the keyless stub provider must be able to emit a REAL
 * tool call from a SPAWNED binary.
 *
 * Every Class-3 acceptance in Phase 34 needs a permission ask, and a permission
 * ask needs a tool call. Until now the stub could only answer with text
 * (`fauxAssistantMessage(stubReplyFor(...))`), so no offline test could make
 * `dist/cli.js` issue one. `DRAHT_STUB_TOOL_CALLS` scripts the provider's turns
 * from outside the process — the only channel a child process has.
 *
 * These tests drive the EMITTED BINARY, never an in-process import: an
 * in-process test would pass while the product a child process sees stayed
 * broken. `DRAHT_PERMISSION_MODE` is deleted from every child environment
 * because this repo's interactive shell exports `auto`; a test that inherited it
 * would prove nothing about permissions.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..");
const EMITTED_CLI = path.join(PKG_ROOT, "dist", "cli.js");

/** How long a single spawned run may take before it is killed and reported. */
const RUN_TIMEOUT_MS = 50_000;

const tempDirs: string[] = [];

/**
 * Temp dirs live directly under `/tmp` with a short prefix: an attachable
 * session binds a Unix socket under the agent dir, and a socket path over ~104
 * bytes fails with EINVAL. macOS `os.tmpdir()` is already ~50 characters.
 */
async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join("/tmp", prefix));
	tempDirs.push(dir);
	return dir;
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/**
 * The child environment: inherited (the binary needs PATH and HOME), minus the
 * two variables that would let ambient shell state decide the outcome.
 */
function childEnv(agentDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.DRAHT_PERMISSION_MODE;
	delete env.DRAHT_STUB_TOOL_CALLS;
	env.DRAHT_STUB_PROVIDER = "1";
	env.DRAHT_CODING_AGENT_DIR = agentDir;
	return { ...env, ...extra };
}

async function runCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<RunResult> {
	const child = spawn(process.execPath, [EMITTED_CLI, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	try {
		return await new Promise<RunResult>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const watchdog = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, RUN_TIMEOUT_MS);
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", (error) => {
				clearTimeout(watchdog);
				reject(error);
			});
			child.on("close", (code) => {
				clearTimeout(watchdog);
				resolve({ code, stdout, stderr, timedOut });
			});
		});
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

/** Every JSON event line the run printed; unparsable lines are ignored. */
function parseEvents(stdout: string): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [];
	for (const line of stdout.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			events.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// Not every line of a real run is an event; a stray line is not a failure.
		}
	}
	return events;
}

interface ObservedToolCall {
	id?: unknown;
	name?: unknown;
	arguments?: Record<string, unknown>;
}

/** Tool calls the assistant actually emitted, read off `toolcall_end`. */
function observedToolCalls(events: Record<string, unknown>[]): ObservedToolCall[] {
	const calls: ObservedToolCall[] = [];
	for (const event of events) {
		if (event.type !== "message_update") continue;
		const assistantEvent = event.assistantMessageEvent as { type?: string; toolCall?: ObservedToolCall } | undefined;
		if (assistantEvent?.type !== "toolcall_end" || !assistantEvent.toolCall) continue;
		calls.push(assistantEvent.toolCall);
	}
	return calls;
}

function buildEmittedBinary(): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("bun", ["run", "build"], {
			cwd: PKG_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`build failed:\n${stdout}\n${stderr}`));
			else resolve({ code, stdout, stderr, timedOut: false });
		});
	});
}

beforeAll(async () => {
	await buildEmittedBinary();
}, 300_000);

afterAll(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("scripted tool calls from the keyless stub provider (R34-PERM.7 enabler)", () => {
	test("the emitted binary issues the scripted tool call", async () => {
		const workDir = await createTempDir("dst-a-");
		const command = `echo scripted > ${path.join(workDir, "marker.txt")}`;
		const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);

		const result = await runCli(
			["--provider", "draht-stub", "--model", "stub-1", "--mode", "json", "-p", "--no-session", "run the tool"],
			{
				cwd: workDir,
				env: childEnv(path.join(workDir, "ad"), { DRAHT_STUB_TOOL_CALLS: script }),
			},
		);

		const detail = `code=${result.code} timedOut=${result.timedOut}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
		expect(result.timedOut, detail).toBe(false);
		expect(result.code, detail).toBe(0);

		const calls = observedToolCalls(parseEvents(result.stdout));
		const names = calls.map((call) => call.name);
		expect(names, detail).toContain("bash");
		const bashCall = calls.find((call) => call.name === "bash");
		expect(bashCall?.id).toBe("call-1");
		expect(bashCall?.arguments?.command).toBe(command);
	}, 120_000);

	test("the scripted tool call really executes when permissions allow it", async () => {
		const workDir = await createTempDir("dst-b-");
		const marker = path.join(workDir, "marker.txt");
		const command = `echo scripted > ${marker}`;
		const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);

		expect(existsSync(marker)).toBe(false);

		const result = await runCli(
			["--provider", "draht-stub", "--model", "stub-1", "--mode", "json", "-p", "--no-session", "run the tool"],
			{
				cwd: workDir,
				env: childEnv(path.join(workDir, "ad"), {
					DRAHT_STUB_TOOL_CALLS: script,
					DRAHT_PERMISSION_MODE: "yolo",
				}),
			},
		);

		const detail = `code=${result.code} timedOut=${result.timedOut}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
		expect(result.timedOut, detail).toBe(false);
		expect(result.code, detail).toBe(0);
		expect(existsSync(marker), detail).toBe(true);
	}, 120_000);

	test("without the environment variable the stub still answers with plain text", async () => {
		const workDir = await createTempDir("dst-c-");

		const result = await runCli(
			["--provider", "draht-stub", "--model", "stub-1", "--mode", "json", "-p", "--no-session", "plain please"],
			{ cwd: workDir, env: childEnv(path.join(workDir, "ad")) },
		);

		const detail = `code=${result.code} timedOut=${result.timedOut}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
		expect(result.timedOut, detail).toBe(false);
		expect(result.code, detail).toBe(0);
		expect(result.stdout, detail).toContain("stub: plain please");
		expect(observedToolCalls(parseEvents(result.stdout)), detail).toEqual([]);
	}, 120_000);

	test("a malformed script degrades to text instead of killing the binary", async () => {
		const workDir = await createTempDir("dst-d-");

		const result = await runCli(
			["--provider", "draht-stub", "--model", "stub-1", "--mode", "json", "-p", "--no-session", "malformed please"],
			{
				cwd: workDir,
				env: childEnv(path.join(workDir, "ad"), { DRAHT_STUB_TOOL_CALLS: "{not json" }),
			},
		);

		const detail = `code=${result.code} timedOut=${result.timedOut}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
		expect(result.timedOut, detail).toBe(false);
		expect(result.code, detail).toBe(0);
		expect(result.stdout, detail).toContain("stub: malformed please");
		expect(result.stderr).toContain("DRAHT_STUB_TOOL_CALLS");
	}, 120_000);
});
