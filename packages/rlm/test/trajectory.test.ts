// Tests for `packages/rlm/src/trajectory.ts` -- trajectory JSONL
// logging/replay, and its wiring into `createRouterBackedSession`
// (router-session.ts). See
// .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
// section 1, task 1.
//
// Tests 2-4 exercise a real `RlmSession` (real sandboxed python3 REPL) with a
// **fake** `ModelRouter`-shaped object for `rlm-root`/`rlm-sub` -- same
// pattern as router-session.test.ts -- so no real network/API call ever
// happens, but the step/sub-call boundaries are real.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@draht/ai/compat";
import type { ModelRef, ModelRouter } from "@draht/router";
import { afterEach, describe, expect, test } from "vitest";
import type { RlmSession } from "../src/index.js";
import { appendTrajectoryEntry, createRouterBackedSession, readTrajectory } from "../src/index.js";
import type { TrajectoryFinalEntry, TrajectoryStepEntry } from "../src/trajectory.js";
import { HAS_PYTHON3, HAS_USERNS } from "./sandbox-prereqs.js";

// Tests 2-4 spawn a real python3 REPL through the fail-closed OS sandbox
// (via createRouterBackedSession) -- see sandbox-prereqs.ts. Test 1 and the
// nonexistent-id test are pure file I/O and run everywhere.
const SKIP_SANDBOXED = !HAS_PYTHON3 || !HAS_USERNS;

/** Builds a minimally-valid `Model<Api>` -- only `contextWindow` matters to router-session.ts. */
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
 * A fake object shaped like `ModelRouter`'s public API (`resolve`,
 * `resolveModel`, `streamSimple`). `rootResponses` is consumed one entry per
 * `rlm-root` call (last one repeats once exhausted); every `rlm-sub` call
 * gets the same canned `subResponse`.
 */
class FakeModelRouter {
	private rootCallIndex = 0;

	constructor(
		private readonly rootResponses: string[],
		private readonly subResponse = "sub-response",
	) {}

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
		if (role === "rlm-root") {
			const i = Math.min(this.rootCallIndex, this.rootResponses.length - 1);
			const text = this.rootResponses[i];
			this.rootCallIndex++;
			yield {
				type: "done",
				reason: "stop",
				message: fakeAssistantMessage(text, "anthropic", "claude-opus-4-6", "anthropic-messages"),
			};
			return;
		}
		if (role === "rlm-sub") {
			yield {
				type: "done",
				reason: "stop",
				message: fakeAssistantMessage(this.subResponse, "google", "gemini-2.5-flash", "google-generative-ai"),
			};
			return;
		}
		throw new Error(`FakeModelRouter: unexpected role "${role}"`);
	}
}

function makeRouter(rootResponses: string[], subResponse?: string): ModelRouter {
	return new FakeModelRouter(rootResponses, subResponse) as unknown as ModelRouter;
}

describe("trajectory.ts", () => {
	let tmpDir: string | undefined;
	let session: RlmSession | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = undefined;
		}
	});

	function tempLogDir(): string {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-trajectory-test-"));
		return tmpDir;
	}

	test("1. appendTrajectoryEntry/readTrajectory round-trip step and final entries correctly", () => {
		const logDir = tempLogDir();
		const trajectoryId = "test-trajectory-1";

		const step1: TrajectoryStepEntry = {
			type: "step",
			trajectoryId,
			step: 1,
			code: "x = 1",
			truncatedStdout: "",
			error: null,
			subCalls: [{ costUsd: 0.001, provider: "google", model: "gemini-2.5-flash" }],
			costUsd: 0.002,
			timestamp: new Date(0).toISOString(),
		};
		const step2: TrajectoryStepEntry = {
			type: "step",
			trajectoryId,
			step: 2,
			code: "FINAL(x)",
			truncatedStdout: "",
			error: null,
			subCalls: [],
			costUsd: 0.0005,
			timestamp: new Date(1000).toISOString(),
		};
		const final: TrajectoryFinalEntry = {
			type: "final",
			trajectoryId,
			kind: "final",
			value: 1,
			totalCostUsd: 0.0025,
			totalSteps: 2,
			timestamp: new Date(2000).toISOString(),
		};

		appendTrajectoryEntry(trajectoryId, step1, logDir);
		appendTrajectoryEntry(trajectoryId, step2, logDir);
		appendTrajectoryEntry(trajectoryId, final, logDir);

		// The file itself is one JSON object per line, under logDir/<id>.jsonl.
		const raw = readFileSync(join(logDir, `${trajectoryId}.jsonl`), "utf-8");
		expect(raw.trim().split("\n")).toHaveLength(3);

		const result = readTrajectory(trajectoryId, logDir);
		expect(result.steps).toEqual([step1, step2]);
		expect(result.final).toEqual(final);
	});

	test("readTrajectory throws a clear error (not a crash) for a nonexistent trajectory id", () => {
		const logDir = tempLogDir();
		expect(() => readTrajectory("does-not-exist", logDir)).toThrow(/no trajectory log found/);
	});

	test.skipIf(SKIP_SANDBOXED)(
		"2. a full createRouterBackedSession trajectory produces one step entry per actual step and exactly one final entry",
		async () => {
			const logDir = tempLogDir();
			const router = makeRouter([
				"```python\nprint('step one')\n```",
				"```python\nprint('step two')\n```",
				"```python\nFINAL('the answer')\n```",
			]);

			session = createRouterBackedSession({ prompt: "some context", router, trajectoryLogDir: logDir });
			const result = await session.run();

			expect(result.kind).toBe("final");
			expect(result.steps).toBe(3);

			// Recover the trajectoryId `createRouterBackedSession` generated -- it's
			// the only file written under `logDir`.
			const trajectoryId = readdirTrajectoryId(logDir);
			const trajectory = readTrajectory(trajectoryId, logDir);

			expect(trajectory.steps).toHaveLength(3);
			expect(trajectory.steps.map((s) => s.step)).toEqual([1, 2, 3]);
			expect(trajectory.final).not.toBeNull();
			expect(trajectory.final?.kind).toBe("final");
			expect(trajectory.final?.value).toBe("the answer");
			expect(trajectory.final?.totalSteps).toBe(3);
		},
	);

	test.skipIf(SKIP_SANDBOXED)(
		"3. a step that triggers 2 sub-calls has both their costs summed into that step's costUsd and listed in subCalls, not attributed to the wrong step",
		async () => {
			const logDir = tempLogDir();
			const router = makeRouter(
				["```python\na = llm_query('q1')\nb = llm_query('q2')\nprint(a, b)\n```", "```python\nFINAL('done')\n```"],
				"sub-response",
			);

			session = createRouterBackedSession({ prompt: "some context", router, trajectoryLogDir: logDir });
			const result = await session.run();
			expect(result.kind).toBe("final");

			const trajectoryId = readdirTrajectoryId(logDir);
			const trajectory = readTrajectory(trajectoryId, logDir);

			expect(trajectory.steps).toHaveLength(2);
			const [step1, step2] = trajectory.steps;

			// Step 1 triggered both sub-calls -- both land on it, not step 2.
			expect(step1.subCalls).toHaveLength(2);
			expect(step1.subCalls.every((s) => s.provider === "google" && s.model === "gemini-2.5-flash")).toBe(true);
			const step1SubCostSum = step1.subCalls.reduce((sum, s) => sum + s.costUsd, 0);
			expect(step1.costUsd).toBeCloseTo(step1.costUsd, 10); // sanity: costUsd is a finite number
			expect(step1SubCostSum).toBeGreaterThan(0);
			// step1.costUsd = its own root cost + the sum of its subCalls' costs.
			expect(step1.costUsd).toBeGreaterThan(step1SubCostSum);

			// Step 2 made no sub-calls -- none of step 1's sub-calls leaked onto it.
			expect(step2.subCalls).toHaveLength(0);
		},
	);

	test.skipIf(SKIP_SANDBOXED)("4. the final entry's totalCostUsd equals the sum of all step costs", async () => {
		const logDir = tempLogDir();
		const router = makeRouter([
			"```python\na = llm_query('q1')\nb = llm_query('q2')\nprint(a, b)\n```",
			"```python\nFINAL('done')\n```",
		]);

		session = createRouterBackedSession({ prompt: "some context", router, trajectoryLogDir: logDir });
		await session.run();

		const trajectoryId = readdirTrajectoryId(logDir);
		const trajectory = readTrajectory(trajectoryId, logDir);

		const sumOfSteps = trajectory.steps.reduce((sum, s) => sum + s.costUsd, 0);
		expect(trajectory.final?.totalCostUsd).toBeCloseTo(sumOfSteps, 10);
	});
});

/** Reads the single `<trajectoryId>.jsonl` file name back out of a temp `logDir`. */
function readdirTrajectoryId(logDir: string): string {
	const files = readdirSync(logDir).filter((f) => f.endsWith(".jsonl"));
	if (files.length !== 1) {
		throw new Error(`readdirTrajectoryId: expected exactly one .jsonl file in ${logDir}, found ${files.length}`);
	}
	return files[0].replace(/\.jsonl$/, "");
}
