/**
 * R34-PERM.3 — the permission gate must ask with CANONICAL DETAIL, and the public
 * RPC protocol must carry it.
 *
 * Every tool permission prompt in the product comes from one line in
 * `createPermissionGateToolCallHandler` (src/core/builtins/subagent.ts). It used to
 * ask with a prose summary sentence — `bash: no rule matched; bash commands require
 * approval by default` — throwing away `event.toolCallId`, `event.input` and
 * `ctx.cwd`, all of which were in scope. A human staring at that sentence cannot tell
 * WHICH command they are approving, and neither can a remote surface.
 *
 * EVIDENCE CLASS 3. This test drives the EMITTED BINARY (`dist/cli.js`) over its
 * PUBLIC RPC PROTOCOL — stdin JSON lines in, stdout JSON lines out. It never imports
 * rpc-mode, never constructs a session in-process, and never calls
 * `PermissionGate.evaluate` (which would be a tautology: it would keep passing even
 * if the gate were unwired from the ask).
 *
 * Harness hygiene, each item load-bearing:
 *  - `DRAHT_PERMISSION_MODE` is DELETED from the child env. This repo's interactive
 *    shell exports `auto`, under which a plain `echo` is auto-allowed and no prompt
 *    is raised at all — the test would pass while proving nothing.
 *  - The agent dir sits directly under `/tmp` with a short name: a Unix socket path
 *    over ~104 bytes fails to bind with EINVAL, and macOS `os.tmpdir()` already
 *    spends ~50 characters.
 *  - The binary is rebuilt first; a stale `dist/` would test yesterday's product.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..");
const EMITTED_CLI = path.join(PKG_ROOT, "dist", "cli.js");

/** Bound on every wait, so a regression fails loudly instead of hanging the suite. */
const WAIT_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 120_000;

/** The grapheme budget the gate bounds every detail string to. */
const DETAIL_MAX_GRAPHEMES = 512;

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(path.join("/tmp", prefix));
	tempDirs.push(dir);
	return dir;
}

function buildEmittedBinary(): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("bun", ["run", "build"], {
			cwd: PKG_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build failed:\n${out}`))));
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

interface RpcSession {
	lines: Record<string, unknown>[];
	stderr: () => string;
	send: (value: unknown) => void;
	waitFor: <T extends Record<string, unknown>>(predicate: (line: Record<string, unknown>) => boolean) => Promise<T>;
	/** Wait for the agent loop to finish the turn — the `prompt` response is ACKNOWLEDGEMENT ONLY. */
	waitForTurnEnd: () => Promise<void>;
	kill: () => void;
}

/**
 * Spawn the emitted binary in RPC mode and expose its newline-delimited JSON stream.
 *
 * The child environment is inherited (the binary needs PATH and HOME) minus exactly
 * the variables that would let ambient shell state decide the outcome.
 */
function startRpc(options: { cwd: string; agentDir: string; script: string }): RpcSession {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.DRAHT_PERMISSION_MODE;
	env.DRAHT_STUB_PROVIDER = "1";
	env.DRAHT_STUB_TOOL_CALLS = options.script;
	env.DRAHT_CODING_AGENT_DIR = options.agentDir;

	const child = spawn(
		process.execPath,
		[EMITTED_CLI, "--provider", "draht-stub", "--model", "stub-1", "--mode", "rpc"],
		{
			cwd: options.cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	const lines: Record<string, unknown>[] = [];
	let stdoutBuffer = "";
	let stderrText = "";
	let exited: string | undefined;

	child.stdout.on("data", (chunk) => {
		stdoutBuffer += String(chunk);
		const parts = stdoutBuffer.split("\n");
		stdoutBuffer = parts.pop() ?? "";
		for (const part of parts) {
			if (part.trim().length === 0) continue;
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(part) as Record<string, unknown>;
			} catch {
				// Startup timings and stray diagnostics are not events; ignore them.
				continue;
			}
			// `message_update` carries the whole partial message on every streamed delta; a
			// 650-character command produces megabytes of it. Nothing here needs them.
			if (parsed.type === "message_update") continue;
			lines.push(parsed);
		}
	});
	child.stderr.on("data", (chunk) => {
		stderrText += String(chunk);
	});
	child.on("close", (code, signal) => {
		exited = `child exited code=${code} signal=${signal}`;
	});

	return {
		lines,
		stderr: () => stderrText,
		send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`),
		waitFor: async <T extends Record<string, unknown>>(predicate: (line: Record<string, unknown>) => boolean) => {
			const deadline = Date.now() + WAIT_TIMEOUT_MS;
			for (;;) {
				const found = lines.find(predicate);
				if (found) return found as T;
				if (exited) {
					throw new Error(`${exited}\nstderr:\n${stderrText}\nlines:\n${JSON.stringify(lines, null, 2)}`);
				}
				if (Date.now() > deadline) {
					throw new Error(
						`timed out waiting for an RPC line\nstderr:\n${stderrText}\nlines:\n${JSON.stringify(lines, null, 2)}`,
					);
				}
				await new Promise((r) => setTimeout(r, 50));
			}
		},
		waitForTurnEnd: async () => {
			// `{"type":"response","command":"prompt","success":true}` is emitted the moment the
			// command is accepted, long before the model turn runs. Waiting on it and then asserting
			// a side effect would be a race that reports the product broken when it is merely slow.
			const deadline = Date.now() + WAIT_TIMEOUT_MS;
			for (;;) {
				if (lines.some((line) => line.type === "agent_end")) return;
				if (exited) throw new Error(`${exited}\nstderr:\n${stderrText}`);
				if (Date.now() > deadline) {
					throw new Error(`timed out waiting for agent_end\nstderr:\n${stderrText}`);
				}
				await new Promise((r) => setTimeout(r, 50));
			}
		},
		kill: () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};
}

/** Every string-valued `id` reachable from a value, alongside a sibling `name`. */
function collectToolCallIds(value: unknown, acc: Set<string>): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) collectToolCallIds(item, acc);
		return acc;
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.id === "string" && typeof record.name === "string") acc.add(record.id);
		if (typeof record.toolCallId === "string") acc.add(record.toolCallId);
		for (const nested of Object.values(record)) collectToolCallIds(nested, acc);
	}
	return acc;
}

describe("the permission ask carries canonical detail over the public RPC protocol (R34-PERM.3)", () => {
	test(
		"confirm request carries toolCallId, canonical cwd, the tail-preserved command and the offered options",
		async () => {
			const workDir = await createTempDir("pdr-");
			const canonicalWorkDir = realpathSync(workDir);
			const marker = path.join(canonicalWorkDir, "ran.txt");

			// A command long enough to force bounding, whose DECISIVE part is its tail. Head
			// truncation would drop `TAIL-MARKER` and the human would approve the wrong thing.
			const filler = "f".repeat(600);
			const command = `echo start && : ${filler} && echo TAIL-MARKER > ${marker}`;
			expect(command.length).toBeGreaterThan(DETAIL_MAX_GRAPHEMES);

			const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
			const rpc = startRpc({ cwd: workDir, agentDir: path.join(workDir, "ad"), script });

			try {
				expect(existsSync(marker)).toBe(false);

				rpc.send({ id: "p1", type: "prompt", message: "run the tool" });

				const ask = await rpc.waitFor((line) => line.type === "extension_ui_request" && line.method === "confirm");

				// The legacy positional strings are unchanged, so every existing renderer keeps working.
				expect(ask.title).toBe("Approve tool call?");
				expect(typeof ask.message).toBe("string");

				const detail = ask.detail as Record<string, unknown> | undefined;
				expect(detail, `no detail on the ask: ${JSON.stringify(ask)}`).toBeDefined();
				const d = detail as Record<string, unknown>;

				expect(d.kind).toBe("tool_permission");
				expect(d.toolName).toBe("bash");

				// (1) The ask names the tool call it gates, and the SAME STREAM reports that id.
				expect(typeof d.toolCallId).toBe("string");
				expect((d.toolCallId as string).length).toBeGreaterThan(0);

				// (2) The cwd is canonical: /tmp on macOS is a symlink to /private/tmp, so an
				//     un-realpathed cwd would read as a different project on the answering surface.
				expect(d.cwd).toBe(canonicalWorkDir);

				// (3) The command survives with its decisive TAIL, not its head.
				expect(typeof d.command).toBe("string");
				const detailCommand = d.command as string;
				expect(detailCommand).toContain("TAIL-MARKER");
				expect(detailCommand).toContain(marker);
				expect([...detailCommand].length).toBeLessThanOrEqual(DETAIL_MAX_GRAPHEMES);
				expect(detailCommand).not.toBe(command); // it really was bounded

				// (4) It is NOT the legacy prose summary sentence.
				expect(detailCommand.startsWith("bash: ")).toBe(false);
				expect(detailCommand).not.toBe(ask.message);
				expect(typeof d.reason).toBe("string");
				expect(d.reason).not.toBe(ask.message);

				// (5) The offered vocabulary is exactly approve/deny, and each option states its
				//     OWN decision. A consumer must never infer meaning from array position.
				expect(d.options).toEqual([
					{ id: "approve", label: "Yes", decision: "approve" },
					{ id: "deny", label: "No", decision: "deny" },
				]);

				// (6) Answering with the named option lets the call through, and the tool RUNS.
				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: true, optionId: "approve" });

				const promptResponse = await rpc.waitFor(
					(line) => line.type === "response" && line.command === "prompt" && line.id === "p1",
				);
				expect(promptResponse.success, JSON.stringify(promptResponse)).toBe(true);
				await rpc.waitForTurnEnd();
				expect(existsSync(marker), `tool did not run; stderr:\n${rpc.stderr()}`).toBe(true);

				// (1, continued) — the id in the ask is the id the transcript reports for the call.
				rpc.send({ id: "m1", type: "get_messages" });
				const messages = await rpc.waitFor(
					(line) => line.type === "response" && line.command === "get_messages" && line.id === "m1",
				);
				const reportedIds = collectToolCallIds(messages.data, new Set<string>());
				expect([...reportedIds], `reported ids: ${[...reportedIds].join(", ")}`).toContain(d.toolCallId as string);
			} finally {
				rpc.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a denial still blocks the call and the tool never runs",
		async () => {
			const workDir = await createTempDir("pdr-");
			const canonicalWorkDir = realpathSync(workDir);
			const marker = path.join(canonicalWorkDir, "denied.txt");
			const command = `echo denied > ${marker}`;
			const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
			const rpc = startRpc({ cwd: workDir, agentDir: path.join(workDir, "ad"), script });

			try {
				rpc.send({ id: "p1", type: "prompt", message: "run the tool" });
				const ask = await rpc.waitFor((line) => line.type === "extension_ui_request" && line.method === "confirm");

				// Short enough not to be bounded: the whole command is shown verbatim.
				expect((ask.detail as Record<string, unknown>).command).toBe(command);

				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: false, optionId: "deny" });

				await rpc.waitForTurnEnd();
				expect(existsSync(marker), `a denied tool call still ran; stderr:\n${rpc.stderr()}`).toBe(false);
			} finally {
				rpc.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
