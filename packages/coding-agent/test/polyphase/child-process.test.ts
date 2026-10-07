import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "@draht/ai";
import { describe, expect, it, vi } from "vitest";
import { ChildEventReducer, type ChildWireRecord } from "../../src/core/polyphase/child-events.ts";
import {
	buildChildInvocation,
	type ChildCommand,
	type ChildSpawnSpec,
	createProcessAgentRunner,
	runChildAgent,
	validateStructuredOutput,
} from "../../src/core/polyphase/child-process.ts";
import * as jsonlReader from "../../src/core/polyphase/jsonl-reader.ts";
import {
	DEFAULT_CHILD_STATE_LIMITS,
	POLYPHASE_DEPTH_ENV,
	POLYPHASE_SCHEMA_FILE_ENV,
} from "../../src/core/polyphase/types.ts";
import * as shell from "../../src/utils/shell.ts";
import * as wire from "./helpers/wire.ts";

const fixturePath = fileURLToPath(new URL("../fixtures/polyphase/fake-child.mjs", import.meta.url));
const fixtureCommand: ChildCommand = { bin: process.execPath, argsPrefix: [fixturePath] };

/** Polls for the `<echoFile>.ready` marker fake-child.mjs writes once its SIGTERM handling is
 * installed, so a test can send SIGTERM deterministically instead of racing process startup. */
async function waitForReady(echoFile: string, timeoutMs = 5000): Promise<void> {
	const readyFile = `${echoFile}.ready`;
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(readyFile)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${readyFile}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function baseAgent(overrides: Partial<Parameters<typeof runChildAgent>[0]["agent"]> = {}) {
	return {
		name: "reviewer",
		description: "reviews code",
		systemPrompt: "",
		source: "user" as const,
		...overrides,
	};
}

function writeScenario(dir: string, lines: string): string {
	const file = join(dir, "scenario.jsonl");
	writeFileSync(file, lines, "utf-8");
	return file;
}

function happyPathRecords(): ChildWireRecord[] {
	return [
		wire.sessionHeader(),
		wire.agentStart(),
		wire.assistantStart("anthropic", "claude-sonnet-5"),
		wire.textStart(0),
		wire.textDelta(0, "Hello "),
		wire.textDelta(0, "world"),
		wire.textEnd(0, "Hello world"),
		wire.toolcallStart("t1", "bash"),
		wire.toolcallEnd("t1", "bash", { command: "ls" }),
		wire.toolStart("t1", "bash", { command: "ls" }),
		wire.toolEnd("t1", "bash", "file1\nfile2", false),
		wire.assistantEnd({
			provider: "anthropic",
			model: "claude-sonnet-5",
			usage: wire.usage(10, 5, 0.01),
			thinkingLevel: "low",
			stopReason: "stop",
			text: "Hello world",
		}),
		wire.settled(),
	];
}

describe("runChildAgent", () => {
	it("happy path: output, usage, confirmed model, thinkingLevel, turns, toolCalls", async () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			const result = await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "review it",
				command: fixtureCommand,
				baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "normal" },
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("Hello world");
			expect(result.usage).toMatchObject({ input: 10, output: 5 });
			expect(result.model).toEqual({ provider: "anthropic", id: "claude-sonnet-5" });
			expect(result.thinkingLevel).toBe("low");
			expect(result.turns).toBe(1);
			expect(result.toolCalls).toBe(1);
			expect(result.cancelled).toBeFalsy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps multibyte text intact when split across 1-byte chunks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const text = "emoji 😀 CJK 漢字 end";
			const records = [
				wire.sessionHeader(),
				wire.agentStart(),
				wire.assistantStart("anthropic", "claude-sonnet-5"),
				wire.assistantEnd({ text, stopReason: "stop" }),
				wire.settled(),
			];
			const scenario = writeScenario(dir, wire.toLines(records));
			const result = await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				baseEnv: {
					...process.env,
					FAKE_CHILD_SCENARIO: scenario,
					FAKE_CHILD_MODE: "normal",
					FAKE_CHILD_CHUNK: "1",
				},
			});

			expect(result.output).toBe(text);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("completes quickly with bounded buffering for a 30 MB agent_end line", async () => {
		const readerSpy = vi.spyOn(jsonlReader, "attachChildLineReader");
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const prefix = '{"type":"agent_end","messages":[';
			const totalBytes = 30 * 1024 * 1024;
			const filler = "x".repeat(totalBytes - prefix.length - 2);
			const bigLine = `${prefix}${filler}]}\n`;
			const lines = `${wire.toLines(happyPathRecords())}${bigLine}`;
			const scenario = writeScenario(dir, lines);

			const start = Date.now();
			const result = await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "normal" },
			});
			expect(Date.now() - start).toBeLessThan(10_000);
			expect(result.output).toBe("Hello world");

			const reader = readerSpy.mock.results[0]?.value;
			expect(reader).toBeDefined();
			// Bounded by the discard-prefix check threshold, not by the 30 MB line: a buffering or
			// rescanning reader would have to retain (a large fraction of) the whole line.
			expect(reader?.maxBufferedChars).toBeLessThan(4096);
			expect(reader?.skippedLines).toBeGreaterThanOrEqual(1);
		} finally {
			readerSpy.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("exit-early gives exitCode 1 with a 'before settling' failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			const result = await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "exit-early" },
			});

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toMatch(/before settling/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a stderr tail of at most 16 KiB during a stderr flood", async () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			const result = await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "stderr-flood" },
			});

			expect(result.stderr.length).toBeLessThanOrEqual(16_384);
			expect(result.stderr.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a cooperative hang, aborted once its SIGTERM handler is ready, resolves cancelled", async () => {
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const controller = new AbortController();
			const resultPromise = runChildAgent({
				cwd: process.cwd(),
				agent: baseAgent(),
				task: "task",
				signal: controller.signal,
				command: fixtureCommand,
				baseEnv: { ...process.env, FAKE_CHILD_MODE: "hang", FAKE_CHILD_ECHO: echoFile },
			});
			await waitForReady(echoFile);
			controller.abort();
			const result = await resultPromise;

			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBe(1);
		} finally {
			rmSync(echoDir, { recursive: true, force: true });
		}
	});

	it("kills a process that ignores SIGTERM after killGraceMs", async () => {
		const killSpy = vi.spyOn(shell, "killProcessTree");
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const controller = new AbortController();
			const killGraceMs = 200;
			let pid: number | undefined;
			const resultPromise = runChildAgent({
				cwd: process.cwd(),
				agent: baseAgent(),
				task: "task",
				signal: controller.signal,
				command: fixtureCommand,
				killGraceMs,
				baseEnv: { ...process.env, FAKE_CHILD_MODE: "ignore-sigterm", FAKE_CHILD_ECHO: echoFile },
				run: {
					onStart: (info) => {
						pid = info.pid;
					},
				},
			});
			await waitForReady(echoFile);
			const abortedAt = Date.now();
			controller.abort();
			const result = await resultPromise;

			expect(result.cancelled).toBe(true);
			// Node timers (and the libuv clock backing them) can fire up to ~1ms before their nominal
			// delay relative to Date.now(), so a strict >= killGraceMs comparison is a rare, real flake.
			expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(killGraceMs - 5);
			expect(killSpy).toHaveBeenCalledWith(pid);
		} finally {
			killSpy.mockRestore();
			rmSync(echoDir, { recursive: true, force: true });
		}
	}, 10_000);

	it("a nonexistent bin resolves as a failed result, never rejecting", async () => {
		const result = await runChildAgent({
			cwd: process.cwd(),
			agent: baseAgent(),
			task: "task",
			command: { bin: join(tmpdir(), "draht-polyphase-does-not-exist"), argsPrefix: [] },
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(/failed to start/);
	});

	it("removes its temp directory, including the appended system prompt file", async () => {
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			try {
				await runChildAgent({
					cwd: dir,
					agent: baseAgent({ systemPrompt: "be careful" }),
					task: "task",
					command: fixtureCommand,
					baseEnv: {
						...process.env,
						FAKE_CHILD_SCENARIO: scenario,
						FAKE_CHILD_MODE: "normal",
						FAKE_CHILD_ECHO: echoFile,
					},
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}

			const echoed = JSON.parse(readFileSync(echoFile, "utf-8").trim()) as { argv: string[] };
			const flagIndex = echoed.argv.indexOf("--append-system-prompt");
			expect(flagIndex).toBeGreaterThanOrEqual(0);
			const promptFile = echoed.argv[flagIndex + 1];
			expect(existsSync(promptFile)).toBe(false);
		} finally {
			rmSync(echoDir, { recursive: true, force: true });
		}
	});

	it("writes one appended system prompt file combining agent.systemPrompt and run.extraSystemPrompt", async () => {
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			try {
				await runChildAgent({
					cwd: dir,
					agent: baseAgent({ systemPrompt: "be careful" }),
					task: "task",
					command: fixtureCommand,
					run: { extraSystemPrompt: "and be fast" },
					baseEnv: {
						...process.env,
						FAKE_CHILD_SCENARIO: scenario,
						FAKE_CHILD_MODE: "normal",
						FAKE_CHILD_ECHO: echoFile,
					},
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}

			const echoed = JSON.parse(readFileSync(echoFile, "utf-8").trim()) as { systemPrompt?: string };
			expect(echoed.systemPrompt).toBe("be careful\n\nand be fast");
		} finally {
			rmSync(echoDir, { recursive: true, force: true });
		}
	});

	it("omits --append-system-prompt when agent.systemPrompt and run.extraSystemPrompt are both blank", async () => {
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			try {
				await runChildAgent({
					cwd: dir,
					agent: baseAgent(),
					task: "task",
					command: fixtureCommand,
					baseEnv: {
						...process.env,
						FAKE_CHILD_SCENARIO: scenario,
						FAKE_CHILD_MODE: "normal",
						FAKE_CHILD_ECHO: echoFile,
					},
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}

			const echoed = JSON.parse(readFileSync(echoFile, "utf-8").trim()) as { argv: string[] };
			expect(echoed.argv).not.toContain("--append-system-prompt");
		} finally {
			rmSync(echoDir, { recursive: true, force: true });
		}
	});

	it("re-spawns without --model on a model error, falling back to the child default", async () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			const reducer = new ChildEventReducer({
				model: { source: "inherited", requested: "anthropic/claude-sonnet-5", confirmed: false },
			});

			const result = await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				run: { model: "anthropic/claude-sonnet-5", fallbackToChildDefaultModel: true, reducer },
				baseEnv: {
					...process.env,
					FAKE_CHILD_SCENARIO: scenario,
					FAKE_CHILD_MODE: "model-error",
					FAKE_CHILD_ECHO: echoFile,
				},
			});

			expect(result.exitCode).toBe(0);
			expect(reducer.state.model.source).toBe("child-default");
			expect(result.model).toEqual({ provider: "anthropic", id: "claude-sonnet-5" });

			const echoed = readFileSync(echoFile, "utf-8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { argv: string[] });
			expect(echoed).toHaveLength(2);
			expect(echoed[0]?.argv).toContain("--model");
			expect(echoed[1]?.argv).not.toContain("--model");
			expect(echoed[1]?.argv).not.toContain("--thinking");
			expect(
				reducer.state.transcript.some(
					(item) => item.kind === "notice" && /inherited model .* unavailable/.test(item.text),
				),
			).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(echoDir, { recursive: true, force: true });
		}
	});

	it("tracks and untracks the detached child pid", async () => {
		const trackSpy = vi.spyOn(shell, "trackDetachedChildPid");
		const untrackSpy = vi.spyOn(shell, "untrackDetachedChildPid");
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "normal" },
			});

			expect(trackSpy).toHaveBeenCalledTimes(1);
			expect(untrackSpy).toHaveBeenCalledTimes(1);
			expect(trackSpy.mock.calls[0]?.[0]).toBe(untrackSpy.mock.calls[0]?.[0]);
		} finally {
			trackSpy.mockRestore();
			untrackSpy.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a throwing run.onStart does not orphan the child: it still settles and untracks the pid", async () => {
		const untrackSpy = vi.spyOn(shell, "untrackDetachedChildPid");
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			const result = await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				run: {
					onStart: () => {
						throw new Error("boom");
					},
				},
				baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "normal" },
			});

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("Hello world");
			expect(untrackSpy).toHaveBeenCalledTimes(1);
		} finally {
			untrackSpy.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("validates structured output: a valid object survives, an invalid one leaves structured undefined with a notice naming the failing field", async () => {
		const schema = {
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		};

		async function run(args: JsonObject, onChange?: (change: "fine" | "coarse") => void) {
			const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
			try {
				const records = [
					wire.sessionHeader(),
					wire.agentStart(),
					wire.assistantStart("anthropic", "claude-sonnet-5"),
					...wire.resultToolCall("r1", args),
					wire.assistantEnd({ stopReason: "stop" }),
					wire.settled(),
				];
				const scenario = writeScenario(dir, wire.toLines(records));
				const reducer = new ChildEventReducer({
					model: { source: "child-default", confirmed: false },
				});
				const result = await runChildAgent({
					cwd: dir,
					agent: baseAgent(),
					task: "task",
					command: fixtureCommand,
					run: { schema, reducer, onChange },
					baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "normal" },
				});
				return { result, reducer };
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		const valid = await run({ foo: "bar" });
		expect(valid.result.structured).toEqual({ value: { foo: "bar" } });

		const onChange = vi.fn<(change: "fine" | "coarse") => void>();
		const invalid = await run({ bar: "baz" }, onChange);
		expect(invalid.result.structured).toBeUndefined();
		const notice = invalid.reducer.state.transcript.find((item) => item.kind === "notice");
		expect(notice?.text).toMatch(/structured output invalid: .*foo/);
		expect(notice?.text).not.toMatch(/Validation failed for tool/);

		// The notice must be forwarded through run.onChange, like every other reducer change.
		expect(onChange).toHaveBeenCalledWith("coarse");
	});

	it("sends 'Task: <task>' on stdin", async () => {
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			try {
				await runChildAgent({
					cwd: dir,
					agent: baseAgent(),
					task: "review this diff",
					command: fixtureCommand,
					baseEnv: {
						...process.env,
						FAKE_CHILD_SCENARIO: scenario,
						FAKE_CHILD_MODE: "normal",
						FAKE_CHILD_ECHO: echoFile,
					},
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}

			const echoed = JSON.parse(readFileSync(echoFile, "utf-8").trim()) as { stdin: string };
			expect(echoed.stdin).toBe("Task: review this diff");
		} finally {
			rmSync(echoDir, { recursive: true, force: true });
		}
	});

	it("writes prompt.md and schema.json with mode 0600, and sets the depth and schema env vars", async () => {
		const echoDir = mkdtempSync(join(tmpdir(), "draht-polyphase-echo-"));
		try {
			const echoFile = join(echoDir, "echo.jsonl");
			const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			try {
				await runChildAgent({
					cwd: dir,
					agent: baseAgent({ systemPrompt: "be careful" }),
					task: "task",
					command: fixtureCommand,
					run: { schema: { type: "object", properties: {} } },
					baseEnv: {
						...process.env,
						FAKE_CHILD_SCENARIO: scenario,
						FAKE_CHILD_MODE: "normal",
						FAKE_CHILD_ECHO: echoFile,
						[POLYPHASE_DEPTH_ENV]: "2",
					},
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}

			const echoed = JSON.parse(readFileSync(echoFile, "utf-8").trim()) as {
				env: Record<string, string | undefined>;
				systemPromptMode?: number;
				schemaMode?: number;
			};
			expect(echoed.systemPromptMode).toBe(0o600);
			expect(echoed.schemaMode).toBe(0o600);
			expect(echoed.env[POLYPHASE_DEPTH_ENV]).toBe("3");
			expect(echoed.env[POLYPHASE_SCHEMA_FILE_ENV]).toBeTruthy();
		} finally {
			rmSync(echoDir, { recursive: true, force: true });
		}
	});

	it("reports legacy onProgress strings for a tool start and the first text delta", async () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			const progress: string[] = [];
			await runChildAgent({
				cwd: dir,
				agent: baseAgent(),
				task: "task",
				command: fixtureCommand,
				onProgress: (text) => progress.push(text),
				baseEnv: { ...process.env, FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "normal" },
			});

			expect(progress).toContainEqual(expect.stringContaining("bash ls"));
			expect(progress).toContainEqual(expect.stringContaining("Hello "));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("validateStructuredOutput bookkeeping", () => {
	it("bumps version by exactly one, sets transcriptChars to the notice's own length, and reports a coarse change", () => {
		const schema = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
		const reducer = new ChildEventReducer({ model: { source: "child-default", confirmed: false } });
		reducer.state.structured = { value: { bar: "baz" } };
		const beforeVersion = reducer.state.version;
		const onChange = vi.fn<(change: "fine" | "coarse") => void>();

		validateStructuredOutput(reducer, schema, onChange);

		expect(reducer.state.structured).toBeUndefined();
		expect(reducer.state.version).toBe(beforeVersion + 1);
		const notice = reducer.state.transcript.find((item) => item.kind === "notice");
		expect(notice?.text).toMatch(/structured output invalid: .*foo/);
		// recordReducerNotice must only account for the notice it just pushed, not trim the live
		// transcript down to the run's post-finish retention budget as a side effect.
		expect(reducer.state.transcriptChars).toBe(notice?.text.length ?? -1);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith("coarse");
	});

	it("leaves the transcript untouched when the structured value is already valid", () => {
		const schema = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
		const reducer = new ChildEventReducer({ model: { source: "child-default", confirmed: false } });
		reducer.state.structured = { value: { foo: "bar" } };
		const beforeVersion = reducer.state.version;

		validateStructuredOutput(reducer, schema);

		expect(reducer.state.structured).toEqual({ value: { foo: "bar" } });
		expect(reducer.state.version).toBe(beforeVersion);
		expect(reducer.state.transcript).toHaveLength(0);
	});

	it("does not trim the live transcript to the finished-run retention budget as a side effect", () => {
		const schema = { type: "object", properties: { foo: { type: "string" } }, required: ["foo"] };
		const reducer = new ChildEventReducer({ model: { source: "child-default", confirmed: false } });
		// 5 finished text items of 20,000 chars each: over finishedMaxChars (32,000, the post-run
		// retention budget) but under maxItemChars (32,000 per item) and maxChars (256,000 live),
		// so nothing is evicted by the reducer's own running-state bookkeeping.
		const chunk = "x".repeat(20_000);
		for (let i = 0; i < 5; i++) {
			reducer.apply(wire.textStart(i));
			reducer.apply(wire.textDelta(i, chunk));
			reducer.apply(wire.textEnd(i, chunk));
		}
		const beforeChars = reducer.state.transcriptChars;
		expect(beforeChars).toBeGreaterThan(DEFAULT_CHILD_STATE_LIMITS.finishedMaxChars);

		reducer.state.structured = { value: { bar: "baz" } };
		validateStructuredOutput(reducer, schema);

		// A mid-run notice must not cut the transcript down to the post-finish retention budget;
		// that is store.ts's job at run finish, not this notice's.
		expect(reducer.state.transcriptChars).toBeGreaterThanOrEqual(beforeChars);
	});
});

describe("validateStructuredOutput: regex schema keywords are stripped before re-validation", () => {
	it("does not enforce a `pattern` keyword, so a value that would fail it is still accepted", () => {
		const schema = { type: "object", properties: { a: { type: "string", pattern: "^[0-9]+$" } }, required: ["a"] };
		const reducer = new ChildEventReducer({ model: { source: "child-default", confirmed: false } });
		reducer.state.structured = { value: { a: "not-digits" } };

		validateStructuredOutput(reducer, schema);

		// A `pattern` violation would normally invalidate the value (and record a notice); the fix
		// drops `pattern` from the parent's copy of the schema before re-validating, so this value
		// (already fully validated, `pattern` included, by the child) passes here too.
		expect(reducer.state.structured).toEqual({ value: { a: "not-digits" } });
		expect(reducer.state.transcript).toHaveLength(0);
	});

	it("drops `patternProperties` from a nested schema without erroring on the keyword itself", () => {
		// Asserts the recursive strip reaches nested schemas, not just the top level: a
		// `patternProperties` left in place is itself harmless here (this is not a backtracking
		// pattern), but this pins that `stripRegexSchemaKeywords` walks into `properties.config`.
		const schema = {
			type: "object",
			properties: { config: { type: "object", patternProperties: { "^[a-z]+$": { type: "string" } } } },
			required: ["config"],
		};
		const reducer = new ChildEventReducer({ model: { source: "child-default", confirmed: false } });
		reducer.state.structured = { value: { config: { ABC: "x" } } };

		validateStructuredOutput(reducer, schema);

		expect(reducer.state.structured).toEqual({ value: { config: { ABC: "x" } } });
	});

	it("completes quickly against a catastrophic-backtracking pattern, instead of freezing on ReDoS", () => {
		// `^(a+)+$` against a near-matching-but-failing string is the classic ReDoS case: unpatched,
		// `validateToolArguments` backtracks exponentially on the main thread (confirmed in DESIGN.md's
		// security note: ~666ms at 26 'a's, roughly doubling per character). 32 'a's would take this
		// unpatched well past this test's budget; the fix makes it near-instant because `pattern` is
		// never compiled at all.
		const schema = { type: "object", properties: { a: { type: "string", pattern: "^(a+)+$" } }, required: ["a"] };
		const reducer = new ChildEventReducer({ model: { source: "child-default", confirmed: false } });
		reducer.state.structured = { value: { a: `${"a".repeat(32)}!` } };

		const start = Date.now();
		validateStructuredOutput(reducer, schema);
		const elapsedMs = Date.now() - start;

		expect(elapsedMs).toBeLessThan(1000);
		expect(reducer.state.structured).toEqual({ value: { a: `${"a".repeat(32)}!` } });
	});
});

describe("buildChildInvocation", () => {
	function spec(overrides: Partial<ChildSpawnSpec> = {}): ChildSpawnSpec {
		return {
			cwd: "/tmp",
			agent: baseAgent(),
			task: "task",
			baseEnv: {},
			...overrides,
		};
	}

	it("includes --model from run.model, falling back to agent.model", () => {
		expect(buildChildInvocation(spec({ run: { model: "p/a" } }), {}).args).toEqual(
			expect.arrayContaining(["--model", "p/a"]),
		);
		expect(buildChildInvocation(spec({ agent: baseAgent({ model: "p/b" }) }), {}).args).toEqual(
			expect.arrayContaining(["--model", "p/b"]),
		);
	});

	it("omits --model and --thinking when options.omitModel is set", () => {
		const { args } = buildChildInvocation(spec({ run: { model: "p/a", thinking: "high" } }), {}, { omitModel: true });
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--thinking");
	});

	it("includes --thinking from run.thinking", () => {
		const { args } = buildChildInvocation(spec({ run: { thinking: "high" } }), {});
		expect(args).toEqual(expect.arrayContaining(["--thinking", "high"]));
	});

	it("includes --tools only when agent.tools has entries, appending run.extraTools", () => {
		const withoutAllowlist = buildChildInvocation(spec({ run: { extraTools: ["x"] } }), {});
		expect(withoutAllowlist.args).not.toContain("--tools");

		const withAllowlist = buildChildInvocation(
			spec({ agent: baseAgent({ tools: ["a", "b"] }), run: { extraTools: ["c"] } }),
			{},
		);
		expect(withAllowlist.args).toEqual(expect.arrayContaining(["--tools", "a,b,c"]));
	});

	it("includes --no-extensions when agent.disableExtensions is set", () => {
		const { args } = buildChildInvocation(spec({ agent: baseAgent({ disableExtensions: true }) }), {});
		expect(args).toContain("--no-extensions");
	});

	it("always excludes workflow and duet_delegate, deduplicated with run.excludeTools", () => {
		const { args } = buildChildInvocation(spec({ run: { excludeTools: ["workflow", "subagent"] } }), {});
		const index = args.indexOf("--exclude-tools");
		expect(args[index + 1]).toBe("workflow,duet_delegate,subagent");
	});

	it("includes --append-system-prompt only when a system prompt file is given", () => {
		expect(buildChildInvocation(spec(), {}).args).not.toContain("--append-system-prompt");
		const { args } = buildChildInvocation(spec(), { systemPromptFile: "/tmp/prompt.md" });
		expect(args).toEqual(expect.arrayContaining(["--append-system-prompt", "/tmp/prompt.md"]));
	});

	it("produces the exact argument order and exclusions of §7.1 for a fully-specified spec", () => {
		const { args } = buildChildInvocation(
			spec({
				agent: baseAgent({ model: "p/agent-model", tools: ["a", "b"], disableExtensions: true }),
				run: { model: "p/override-model", thinking: "high", extraTools: ["c"], excludeTools: ["extra"] },
			}),
			{ systemPromptFile: "/tmp/prompt.md", schemaFile: "/tmp/schema.json" },
		);

		expect(args).toEqual([
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			"p/override-model",
			"--thinking",
			"high",
			"--tools",
			"a,b,c",
			"--no-extensions",
			"--exclude-tools",
			"workflow,duet_delegate,extra",
			"--append-system-prompt",
			"/tmp/prompt.md",
		]);
	});

	it("sets DRAHT_POLYPHASE_DEPTH to the parent depth plus one", () => {
		const { env } = buildChildInvocation(spec({ baseEnv: {} }), {});
		expect(env[POLYPHASE_DEPTH_ENV]).toBe("1");

		const { env: nested } = buildChildInvocation(spec({ baseEnv: { [POLYPHASE_DEPTH_ENV]: "2" } }), {});
		expect(nested[POLYPHASE_DEPTH_ENV]).toBe("3");
	});

	it("sets the schema env var only when a schema file is given, otherwise deletes it", () => {
		const { env } = buildChildInvocation(spec(), { schemaFile: "/tmp/schema.json" });
		expect(env[POLYPHASE_SCHEMA_FILE_ENV]).toBe("/tmp/schema.json");

		const { env: cleared } = buildChildInvocation(
			spec({ baseEnv: { [POLYPHASE_SCHEMA_FILE_ENV]: "/parent/schema.json" } }),
			{},
		);
		expect(cleared[POLYPHASE_SCHEMA_FILE_ENV]).toBeUndefined();
	});

	it("merges run.env over baseEnv", () => {
		const { env } = buildChildInvocation(spec({ baseEnv: { A: "1" }, run: { env: { A: "2", B: "3" } } }), {});
		expect(env.A).toBe("2");
		expect(env.B).toBe("3");
	});
});

describe("createProcessAgentRunner", () => {
	it("returns an AgentRunner that spawns through runChildAgent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-polyphase-test-"));
		try {
			const scenario = writeScenario(dir, wire.toLines(happyPathRecords()));
			const runner = createProcessAgentRunner(fixtureCommand);
			const result = await runner(dir, baseAgent(), "task", undefined, undefined, undefined, {
				env: { FAKE_CHILD_SCENARIO: scenario, FAKE_CHILD_MODE: "normal" },
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("Hello world");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
