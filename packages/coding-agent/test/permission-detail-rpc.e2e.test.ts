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
	waitFor: <T extends Record<string, unknown>>(
		predicate: (line: Record<string, unknown>) => boolean,
		timeoutMs?: number,
	) => Promise<T>;
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
		waitFor: async <T extends Record<string, unknown>>(
			predicate: (line: Record<string, unknown>) => boolean,
			timeoutMs?: number,
		) => {
			const deadline = Date.now() + (timeoutMs ?? WAIT_TIMEOUT_MS);
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

/**
 * R34-PERM.5 on the RPC surface — an answer that NAMES an option is decided by THAT
 * option's own `decision`, and an answer naming an option nobody offered is refused
 * without consuming the still-answerable request.
 *
 * The hole these tests close: `optionId` was documented as "must be one of the ids the
 * matching request offered", but nothing validated it. rpc-mode decided purely on
 * `confirmed`, so `{confirmed: true, optionId: "deny"}` — a client whose operator
 * pressed the DENY button — was recorded as an APPROVAL and the tool ran.
 *
 * Evidence class 3 as above: the emitted binary, driven over the public protocol.
 */
describe("an RPC answer is decided by the option it names, not by `confirmed` (R34-PERM.5)", () => {
	/** Poll until `probe` reports the outcome we are trying to DISPROVE, or the window closes. */
	async function settle(probe: () => string | undefined, windowMs: number): Promise<void> {
		const deadline = Date.now() + windowMs;
		while (Date.now() < deadline) {
			const violation = probe();
			if (violation) throw new Error(violation);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	test(
		'`{confirmed: true, optionId: "deny"}` denies — the named option wins over the boolean',
		async () => {
			const workDir = await createTempDir("pdr-");
			const marker = path.join(realpathSync(workDir), "approved.txt");
			const command = `echo ran > ${marker}`;
			const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
			const rpc = startRpc({ cwd: workDir, agentDir: path.join(workDir, "ad"), script });

			try {
				rpc.send({ id: "p1", type: "prompt", message: "run the tool" });
				const ask = await rpc.waitFor((line) => line.type === "extension_ui_request" && line.method === "confirm");

				// The request offered `deny`, and the answer names it. `confirmed: true` is the
				// contradiction a confused client sends; the offered set must win.
				expect(ask.detail as Record<string, unknown>).toMatchObject({
					options: [
						{ id: "approve", label: "Yes", decision: "approve" },
						{ id: "deny", label: "No", decision: "deny" },
					],
				});

				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: true, optionId: "deny" });

				await rpc.waitForTurnEnd();
				expect(existsSync(marker), `an answer naming "deny" ran the tool anyway; stderr:\n${rpc.stderr()}`).toBe(
					false,
				);
			} finally {
				rpc.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"an optionId nobody offered is refused WITHOUT consuming the ask — a later valid answer still wins",
		async () => {
			const workDir = await createTempDir("pdr-");
			const marker = path.join(realpathSync(workDir), "later.txt");
			const command = `echo ran > ${marker}`;
			const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
			const rpc = startRpc({ cwd: workDir, agentDir: path.join(workDir, "ad"), script });

			try {
				rpc.send({ id: "p1", type: "prompt", message: "run the tool" });
				const ask = await rpc.waitFor((line) => line.type === "extension_ui_request" && line.method === "confirm");

				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: true, optionId: "not-an-option" });

				// The unofferred id decides NOTHING: the turn must not end and the tool must not run
				// while the dialog is still, legitimately, waiting for an answer.
				await settle(() => {
					if (existsSync(marker)) return `an unoffered optionId approved the call; stderr:\n${rpc.stderr()}`;
					if (rpc.lines.some((line) => line.type === "agent_end")) {
						return `the turn ended on an unoffered optionId; stderr:\n${rpc.stderr()}`;
					}
					return undefined;
				}, 3_000);

				// The client is told its answer was refused rather than left guessing.
				const refusal = rpc.lines.find(
					(line) => line.type === "response" && line.command === "extension_ui_response" && line.success === false,
				);
				expect(
					refusal,
					`no refusal reported for an unoffered optionId: ${JSON.stringify(rpc.lines)}`,
				).toBeDefined();

				// And the request is still answerable: the valid answer that follows decides it.
				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: true, optionId: "approve" });

				await rpc.waitForTurnEnd();
				expect(
					existsSync(marker),
					`the refusal consumed the ask; a later valid approval did nothing; stderr:\n${rpc.stderr()}`,
				).toBe(true);
			} finally {
				rpc.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a present-but-non-string optionId is refused, not silently treated as absent",
		async () => {
			const workDir = await createTempDir("pdr-");
			const marker = path.join(realpathSync(workDir), "typed.txt");
			const command = `echo ran > ${marker}`;
			const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
			const rpc = startRpc({ cwd: workDir, agentDir: path.join(workDir, "ad"), script });

			try {
				rpc.send({ id: "p1", type: "prompt", message: "run the tool" });
				const ask = await rpc.waitFor((line) => line.type === "extension_ui_request" && line.method === "confirm");

				// `123` is PRESENT and is not one of the offered ids, so the documented rule
				// ("when present it must be one of the ids the matching request offered") refuses
				// it. A `typeof === "string"` guard would reclassify it as ABSENT and fall back to
				// `confirmed: true` — the tool would run on an answer the protocol forbids, which
				// is exactly the shape a buggy or hostile middlebox produces.
				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: true, optionId: 123 });

				await settle(() => {
					if (existsSync(marker)) return `a non-string optionId approved the call; stderr:\n${rpc.stderr()}`;
					if (rpc.lines.some((line) => line.type === "agent_end")) {
						return `the turn ended on a non-string optionId; stderr:\n${rpc.stderr()}`;
					}
					return undefined;
				}, 3_000);

				const refusal = rpc.lines.find(
					(line) => line.type === "response" && line.command === "extension_ui_response" && line.success === false,
				);
				expect(
					refusal,
					`no refusal reported for a non-string optionId: ${JSON.stringify(rpc.lines)}`,
				).toBeDefined();

				// Same as any other invalid id: the ask was not consumed, so a valid answer decides.
				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: true, optionId: "approve" });

				await rpc.waitForTurnEnd();
				expect(
					existsSync(marker),
					`the refusal consumed the ask; a later valid approval did nothing; stderr:\n${rpc.stderr()}`,
				).toBe(true);
			} finally {
				rpc.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"an answer with no optionId still decides on `confirmed` — existing clients keep working",
		async () => {
			const workDir = await createTempDir("pdr-");
			const marker = path.join(realpathSync(workDir), "legacy.txt");
			const command = `echo ran > ${marker}`;
			const script = JSON.stringify([{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command } }] }]);
			const rpc = startRpc({ cwd: workDir, agentDir: path.join(workDir, "ad"), script });

			try {
				rpc.send({ id: "p1", type: "prompt", message: "run the tool" });
				const ask = await rpc.waitFor((line) => line.type === "extension_ui_request" && line.method === "confirm");

				rpc.send({ type: "extension_ui_response", id: ask.id, confirmed: true });

				await rpc.waitForTurnEnd();
				expect(
					existsSync(marker),
					`a legacy yes/no client's approval stopped working; stderr:\n${rpc.stderr()}`,
				).toBe(true);
			} finally {
				rpc.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * R34-PERM.5 validates an answer against THE SET A REQUEST OFFERED — so where a request
 * offered no set, the rule has no subject and `optionId` must be IGNORED, not refused.
 *
 * The hole this closes: refusing an `optionId` on a dialog that recorded no offered set
 * wedges the agent loop permanently. Five in-repo dialogs carry no `detail` AND pass no
 * `timeout` and no `signal` — `/rewind`'s "Restore files?" confirm, `/agent`'s picker, two
 * llama dialogs and `promptForMissingSessionCwd` — so `createDialogPromise` has nothing
 * that can ever settle them. A client that reflexively attaches `optionId` to any answer
 * (which the protocol permits: the field is optional, and these requests carry no
 * `detail.options` to check it against) would park the loop forever with only an error
 * line to show for it.
 *
 * Evidence class 3 as above: the emitted binary, driven over the public protocol.
 */
describe("a dialog that offered no options ignores `optionId` instead of hanging on it", () => {
	test(
		"a detail-less dialog answered with an optionId still settles",
		async () => {
			const workDir = await createTempDir("pdr-");
			// No tool calls: `/agent` is an extension command, it runs no model turn.
			const rpc = startRpc({ cwd: workDir, agentDir: path.join(workDir, "ad"), script: "[]" });

			try {
				rpc.send({ id: "c1", type: "prompt", message: "/agent" });

				const ask = await rpc.waitFor(
					(line) =>
						line.type === "extension_ui_request" &&
						line.method === "select" &&
						line.title === "Select agent for your prompts",
				);

				// The three properties that make this dialog unsettleable by anything but an
				// answer. If any of them ever appears here, this test has stopped covering the
				// wedge and the dialog it stands in for must be replaced, not the assertions.
				expect(ask.detail, `the /agent picker grew a detail: ${JSON.stringify(ask)}`).toBeUndefined();
				expect(ask.timeout, `the /agent picker grew a timeout: ${JSON.stringify(ask)}`).toBeUndefined();

				const options = ask.options as string[];
				expect(options.length).toBeGreaterThan(0);

				rpc.send({
					type: "extension_ui_response",
					id: ask.id,
					value: options[0],
					optionId: "reflexively-attached",
				});

				// rpc-mode emits the `prompt` response only after the extension command's handler
				// has RETURNED, so this line cannot appear while the dialog is still pending. It is
				// the settle signal here; `agent_end` never comes, because no model turn ran.
				const ack = await rpc.waitFor(
					(line) => line.type === "response" && line.command === "prompt" && line.id === "c1",
					20_000,
				);
				expect(ack.success, JSON.stringify(ack)).toBe(true);

				const refusal = rpc.lines.find(
					(line) => line.type === "response" && line.command === "extension_ui_response" && line.success === false,
				);
				expect(
					refusal,
					`an optionId was refused on a dialog that offered no options: ${JSON.stringify(refusal)}`,
				).toBeUndefined();
			} finally {
				rpc.kill();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
