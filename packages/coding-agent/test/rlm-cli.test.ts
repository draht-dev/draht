// Tests for `packages/coding-agent/src/rlm-cli.ts` -- the `draht rlm
// --input ... --query ...` CLI subcommand. See
// .planning/phases/29-agent-cli-integration/29-01-PLAN.md, Architecture
// section 3, task 3.
//
// The end-to-end test injects a **fake** `ModelRouter`-shaped object
// (matching `ModelRouter`'s real public method signatures from
// `packages/router/src/router.ts`: `resolve`, `resolveModel`,
// `streamSimple` -- same pattern as
// `packages/rlm/test/router-session.test.ts`'s `FakeModelRouter`) so no
// real network/API call ever happens. The RLM session's Python REPL side
// (finding the needle, calling FINAL) still runs for real through
// `@draht/rlm`'s sandboxed driver -- only the LLM call is faked.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@draht/ai/compat";
import { appendTrajectoryEntry } from "@draht/rlm";
import type { ModelRef, ModelRouter } from "@draht/router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handleRlmCommand, parseRlmArgs } from "../src/rlm-cli.ts";

/** Builds a minimally-valid `Model<Api>` -- only `contextWindow` matters to `createRouterBackedSession`. */
function fakeModel(contextWindow: number, provider: string, api: Api): Model<Api> {
	return {
		id: `${provider}-fake-model`,
		name: `${provider} fake model`,
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
	};
}

function fakeAssistantMessage(text: string, provider: string, model: string, api: Api): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api,
		provider,
		model,
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * A fake object shaped like `ModelRouter`'s public API. Its scripted
 * "rlm-root" response is a single Python step that finds the fixture's
 * planted needle and calls `FINAL(...)` -- no `llm_query` sub-call is ever
 * made, so "rlm-sub" is never exercised here. Cast to `ModelRouter` at the
 * call site.
 */
class FakeModelRouter {
	calls: Array<{ role: string }> = [];

	resolve(role: string): ModelRef {
		if (role === "rlm-root") return { provider: "anthropic", model: "claude-opus-4-6" };
		if (role === "rlm-sub") return { provider: "google", model: "gemini-2.5-flash" };
		throw new Error(`FakeModelRouter: unexpected role "${role}"`);
	}

	resolveModel(ref: ModelRef): Model<Api> | null {
		if (ref.model === "claude-opus-4-6") {
			return fakeModel(1_000_000, "anthropic", "anthropic-messages");
		}
		return fakeModel(1_000_000, "google", "google-generative-ai");
	}

	async *streamSimple(role: string, _context: Context): AsyncGenerator<AssistantMessageEvent> {
		this.calls.push({ role });
		if (role !== "rlm-root") {
			throw new Error(`FakeModelRouter: unexpected streamSimple role "${role}" (test never calls llm_query)`);
		}
		const code = [
			'idx = context.find("<<NEEDLE:")',
			'end = context.find(">>", idx) + 2',
			"FINAL(context[idx:end])",
		].join("\n");
		yield {
			type: "done",
			reason: "stop",
			message: fakeAssistantMessage(
				`\`\`\`python\n${code}\n\`\`\``,
				"anthropic",
				"claude-opus-4-6",
				"anthropic-messages",
			),
		};
	}
}

/** Generates a real 500KB+ text fixture: repeated realistic paragraphs with a needle planted in the middle. */
function generateLargeFixture(): { text: string; needle: string } {
	const paragraph =
		"The recursive language model root loop writes Python that peeks, chunks, and searches its context " +
		"variable, calling llm_query for recursive sub-calls whenever a fragment needs deeper reasoning than " +
		"a plain string search can provide, and terminates by invoking FINAL or FINAL_VAR once the answer is " +
		"in hand. ";
	const needle = "<<NEEDLE:the-planted-answer-is-8675309>>";

	const chunks: string[] = [];
	let total = 0;
	const targetBeforeNeedle = 260_000;
	while (total < targetBeforeNeedle) {
		chunks.push(paragraph);
		total += paragraph.length;
	}
	chunks.push(`\n${needle}\n`);
	while (total < 500_000) {
		chunks.push(paragraph);
		total += paragraph.length;
	}

	return { text: chunks.join(""), needle };
}

describe("parseRlmArgs", () => {
	test("1. parses --input, --query, and --max-cost correctly", () => {
		const parsed = parseRlmArgs(["--input", "./big.txt", "--query", "what happened?", "--max-cost", "1.5"]);
		expect(parsed).toMatchObject({
			input: "./big.txt",
			query: "what happened?",
			maxCost: 1.5,
			help: false,
		});
		expect(parsed.invalidOption).toBeUndefined();
		expect(parsed.invalidArgument).toBeUndefined();
		expect(parsed.missingOptionValue).toBeUndefined();
		expect(parsed.invalidMaxCost).toBeUndefined();
	});

	test("--max-cost is optional and undefined when omitted", () => {
		const parsed = parseRlmArgs(["--input", "./big.txt", "--query", "what happened?"]);
		expect(parsed.input).toBe("./big.txt");
		expect(parsed.query).toBe("what happened?");
		expect(parsed.maxCost).toBeUndefined();
	});

	test("flags an invalid (non-numeric or non-positive) --max-cost value", () => {
		const parsed = parseRlmArgs(["--input", "./big.txt", "--query", "q", "--max-cost", "not-a-number"]);
		expect(parsed.invalidMaxCost).toBe("not-a-number");
		expect(parsed.maxCost).toBeUndefined();
	});

	test("flags an unknown option", () => {
		const parsed = parseRlmArgs(["--input", "./big.txt", "--query", "q", "--bogus"]);
		expect(parsed.invalidOption).toBe("--bogus");
	});

	test("parses replay mode with a trajectory id and --verbose", () => {
		const parsed = parseRlmArgs(["replay", "some-trajectory-id", "--verbose"]);
		expect(parsed).toMatchObject({
			mode: "replay",
			trajectoryId: "some-trajectory-id",
			verbose: true,
			help: false,
		});
		expect(parsed.invalidOption).toBeUndefined();
		expect(parsed.invalidArgument).toBeUndefined();
	});

	test("replay mode with no trajectory id leaves trajectoryId undefined", () => {
		const parsed = parseRlmArgs(["replay"]);
		expect(parsed.mode).toBe("replay");
		expect(parsed.trajectoryId).toBeUndefined();
	});

	test("replay mode flags an unknown option", () => {
		const parsed = parseRlmArgs(["replay", "some-id", "--bogus"]);
		expect(parsed.invalidOption).toBe("--bogus");
	});
});

describe("handleRlmCommand", () => {
	let tmpDir: string | undefined;
	let originalCwd: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		originalCwd = process.cwd();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = undefined;
		vi.restoreAllMocks();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	test("returns false (no side effects) for a non-rlm command", async () => {
		const handled = await handleRlmCommand(["chat", "hello"]);
		expect(handled).toBe(false);
		expect(process.exitCode).toBeUndefined();
		expect(logSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("3a. missing --query produces a clear usage error, not a crash", async () => {
		const handled = await handleRlmCommand(["rlm", "--input", "./whatever.txt"]);
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalled();
		const printed = errorSpy.mock.calls.flat().join("\n");
		expect(printed).toMatch(/--query/);
	});

	test("3b. missing --input produces a clear usage error, not a crash", async () => {
		const handled = await handleRlmCommand(["rlm", "--query", "what happened?"]);
		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalled();
		const printed = errorSpy.mock.calls.flat().join("\n");
		expect(printed).toMatch(/--input/);
	});

	test("2. end-to-end on a 500KB+ fixture with a fake router finds the needle and exits 0", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-cli-test-"));
		// Sandbox any `.draht/cost-log.jsonl` writes (createRouterBackedSession's
		// default costLogPath is resolved against process.cwd()) into the temp
		// dir instead of the real repo working directory.
		process.chdir(tmpDir);

		const { text, needle } = generateLargeFixture();
		expect(text.length).toBeGreaterThanOrEqual(500_000);
		const filePath = join(tmpDir, "large-fixture.txt");
		writeFileSync(filePath, text, "utf-8");

		const fakeRouter = new FakeModelRouter() as unknown as ModelRouter;

		const handled = await handleRlmCommand(
			["rlm", "--input", filePath, "--query", "Find the planted needle sentence."],
			{ router: fakeRouter },
		);

		expect(handled).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(0);
		const printed = logSpy.mock.calls.flat().join("\n");
		expect(printed).toContain(needle);
	});
});

// `draht rlm replay <trajectory-id>` (Phase 30) -- see
// .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
// section 4, task 4. Reads a pre-written trajectory JSONL fixture (written
// directly via `@draht/rlm`'s `appendTrajectoryEntry`, not by running a real
// session) and reconstructs the final answer with zero LLM calls.
describe("handleRlmCommand replay mode", () => {
	let tmpDir: string | undefined;
	let originalCwd: string;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		originalCwd = process.cwd();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = undefined;
		vi.restoreAllMocks();
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	/** Writes a minimal 1-step trajectory fixture under the current cwd's default `.draht/rlm/` dir. */
	function writeFixtureTrajectory(trajectoryId: string, finalValue: string): void {
		const timestamp = new Date(0).toISOString();
		appendTrajectoryEntry(trajectoryId, {
			type: "step",
			trajectoryId,
			step: 1,
			code: `FINAL(${JSON.stringify(finalValue)})`,
			truncatedStdout: "",
			error: null,
			subCalls: [],
			costUsd: 0.001,
			timestamp,
		});
		appendTrajectoryEntry(trajectoryId, {
			type: "final",
			trajectoryId,
			kind: "final",
			value: finalValue,
			totalCostUsd: 0.001,
			totalSteps: 1,
			timestamp,
		});
	}

	test("4a. replays a pre-written trajectory fixture and prints its final answer", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-cli-replay-test-"));
		process.chdir(tmpDir);

		const trajectoryId = "fixture-trajectory-1";
		writeFixtureTrajectory(trajectoryId, "the recovered answer");

		const handled = await handleRlmCommand(["rlm", "replay", trajectoryId]);

		expect(handled).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(0);
		const printed = logSpy.mock.calls.flat().join("\n");
		expect(printed).toContain("the recovered answer");
	});

	test("4b. replay makes zero network/router/model calls -- works with no router wiring supplied at all", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-cli-replay-test-"));
		process.chdir(tmpDir);

		const trajectoryId = "fixture-trajectory-2";
		writeFixtureTrajectory(trajectoryId, "no-llm-needed");

		// No `runtimeOptions` (and thus no `router`) is passed at all -- the
		// replay code path never reaches the `runtimeOptions.router ?? new
		// ModelRouter()` line in query mode, so there's no router to inject in
		// the first place. Succeeding here without any router wiring is the
		// strongest possible proof this path can't be making an LLM call.
		const handled = await handleRlmCommand(["rlm", "replay", trajectoryId]);

		expect(handled).toBe(true);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(0);
		const printed = logSpy.mock.calls.flat().join("\n");
		expect(printed).toContain("no-llm-needed");
	});

	test("4c. a nonexistent trajectory id produces a clear error, not a crash", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-cli-replay-test-"));
		process.chdir(tmpDir);

		const handled = await handleRlmCommand(["rlm", "replay", "does-not-exist"]);

		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalled();
		const printed = errorSpy.mock.calls.flat().join("\n");
		expect(printed).toMatch(/does-not-exist/);
	});

	test("missing <trajectory-id> produces a clear usage error, not a crash", async () => {
		const handled = await handleRlmCommand(["rlm", "replay"]);

		expect(handled).toBe(true);
		expect(process.exitCode).toBe(1);
		expect(errorSpy).toHaveBeenCalled();
		const printed = errorSpy.mock.calls.flat().join("\n");
		expect(printed).toMatch(/trajectory-id/);
	});

	test("--verbose also prints the step-by-step trace ahead of the final answer", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-cli-replay-test-"));
		process.chdir(tmpDir);

		const trajectoryId = "fixture-trajectory-verbose";
		writeFixtureTrajectory(trajectoryId, "verbose-answer");

		const handled = await handleRlmCommand(["rlm", "replay", trajectoryId, "--verbose"]);

		expect(handled).toBe(true);
		expect(process.exitCode).toBe(0);
		const printed = logSpy.mock.calls.flat().join("\n");
		expect(printed).toContain("FINAL(");
		expect(printed).toContain("verbose-answer");
	});
});
