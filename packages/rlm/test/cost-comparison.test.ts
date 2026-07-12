// Tests for `packages/rlm/src/cost-comparison.ts` -- the cost-comparison
// harness (RLM trajectory cost vs. a truncate-and-single-call baseline for
// the same task). See
// .planning/phases/30-eval-observability-docs/30-01-PLAN.md, Architecture
// section 3, task 3.
//
// Runs a real `RlmSession` (real sandboxed python3 REPL) against a synthetic
// oversize task with a **fake** `ModelRouter`-shaped object for
// `rlm-root`/`rlm-sub` -- same pattern as router-session.test.ts/
// trajectory.test.ts -- so no real network/API call, and no real spend,
// ever happens.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@draht/ai/compat";
import type { ModelRef, ModelRouter } from "@draht/router";
import { estimateCost, readCostLog } from "@draht/router";
import { afterEach, describe, expect, test } from "vitest";
import { compareCost, writeCostComparisonReport } from "../src/cost-comparison.js";
import type { RlmSession } from "../src/index.js";
import { createRouterBackedSession } from "../src/index.js";

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
 * gets the same canned `subResponse`. `rootContextWindow` is reported for the
 * "rlm-root" role's resolved model, so tests can control what `compareCost`'s
 * baseline truncates against.
 */
class FakeModelRouter {
	private rootCallIndex = 0;

	constructor(
		private readonly rootContextWindow: number,
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
			return fakeModel(this.rootContextWindow, "anthropic", "anthropic-messages");
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

function makeRouter(rootContextWindow: number, rootResponses: string[], subResponse?: string): ModelRouter {
	return new FakeModelRouter(rootContextWindow, rootResponses, subResponse) as unknown as ModelRouter;
}

describe("compareCost", () => {
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

	function tempDir(): string {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-cost-comparison-test-"));
		return tmpDir;
	}

	test("1. returns a well-formed CostComparisonResult whose rlmCostUsd/rlmSteps match a real trajectory's cost-log entries", async () => {
		const dir = tempDir();
		const costLogPath = join(dir, "cost-log.jsonl");

		// Synthetic oversize task: a context far larger than any real model's
		// window, forcing the "why would you even RLM this" scenario the
		// harness is meant to quantify.
		const contextLengthChars = 500_000;
		const syntheticContext = "needle-haystack-filler "
			.repeat(Math.ceil(contextLengthChars / 24))
			.slice(0, contextLengthChars);

		const rootContextWindow = 128_000;
		const router = makeRouter(rootContextWindow, [
			"```python\nprint(len(context))\n```",
			"```python\na = llm_query('summarize a chunk')\nb = llm_query('summarize another chunk')\nprint(a, b)\n```",
			"```python\nFINAL('the synthesized answer')\n```",
		]);

		session = createRouterBackedSession({ prompt: syntheticContext, router, costLogPath });
		const result = await session.run();
		expect(result.kind).toBe("final");
		expect(result.steps).toBe(3);

		const entries = readCostLog(costLogPath);
		expect(entries.length).toBeGreaterThan(0);
		const trajectoryId = entries[0].trajectoryId;
		expect(trajectoryId).toBeTruthy();
		if (!trajectoryId) throw new Error("expected a trajectoryId on the logged cost entries");

		const comparison = compareCost(
			trajectoryId,
			contextLengthChars,
			{ provider: "anthropic", modelName: "claude-opus-4-6", contextWindow: rootContextWindow },
			costLogPath,
		);

		// Structural well-formedness.
		expect(comparison.task).toBe(trajectoryId);
		expect(comparison.contextLengthChars).toBe(contextLengthChars);
		expect(typeof comparison.rlmCostUsd).toBe("number");
		expect(typeof comparison.baselineCostUsd).toBe("number");
		expect(Number.isFinite(comparison.rlmCostUsd)).toBe(true);
		expect(Number.isFinite(comparison.baselineCostUsd)).toBe(true);

		// rlmCostUsd is exactly the sum of this trajectory's logged cost
		// entries (root + sub calls) -- recomputed independently here.
		const trajectoryEntries = entries.filter((e) => e.trajectoryId === trajectoryId);
		const expectedRlmCostUsd = trajectoryEntries.reduce((sum, e) => sum + e.estimatedCostUsd, 0);
		expect(comparison.rlmCostUsd).toBeCloseTo(expectedRlmCostUsd, 10);
		expect(comparison.rlmCostUsd).toBeGreaterThan(0);

		// rlmSteps counts only "rlm-root"-role entries -- one per actual step,
		// not inflated by the two "rlm-sub" calls step 2 triggered.
		const expectedRlmSteps = trajectoryEntries.filter((e) => e.role === "rlm-root").length;
		expect(comparison.rlmSteps).toBe(expectedRlmSteps);
		expect(comparison.rlmSteps).toBe(3);

		// baselineCostUsd follows the documented formula: truncate
		// contextLengthChars to whatever fits rootContextWindow via the 4
		// chars/token heuristic, then price one call at 500 assumed output
		// tokens via @draht/router's estimateCost.
		const expectedInputTokens = Math.min(rootContextWindow, Math.ceil(contextLengthChars / 4));
		const expectedBaselineCostUsd = estimateCost("anthropic", "claude-opus-4-6", expectedInputTokens, 500, 0);
		expect(comparison.baselineCostUsd).toBeCloseTo(expectedBaselineCostUsd, 10);
		expect(comparison.baselineCostUsd).toBeGreaterThan(0);
	});

	test("2. baseline truncates to the model's context window when contextLengthChars exceeds it, and does not when it fits", async () => {
		const dir = tempDir();
		const costLogPath = join(dir, "cost-log.jsonl");

		const rootContextWindow = 100_000; // tokens -> 400_000 chars at 4 chars/token
		const router = makeRouter(rootContextWindow, ["```python\nFINAL('done')\n```"]);
		session = createRouterBackedSession({ prompt: "small context", router, costLogPath });
		const result = await session.run();
		expect(result.kind).toBe("final");

		const entries = readCostLog(costLogPath);
		const trajectoryId = entries[0].trajectoryId;
		if (!trajectoryId) throw new Error("expected a trajectoryId on the logged cost entries");

		// Oversize: 4_000_000 chars is 10x the 400_000-char equivalent of the
		// window -- the baseline must cap input tokens at the window itself,
		// not at ceil(4_000_000 / 4) = 1_000_000.
		const oversized = compareCost(
			trajectoryId,
			4_000_000,
			{ provider: "anthropic", modelName: "claude-opus-4-6", contextWindow: rootContextWindow },
			costLogPath,
		);
		const cappedBaselineCostUsd = estimateCost("anthropic", "claude-opus-4-6", rootContextWindow, 500, 0);
		expect(oversized.baselineCostUsd).toBeCloseTo(cappedBaselineCostUsd, 10);

		// Undersize: fits comfortably within the window -- no truncation, input
		// tokens track the actual context length.
		const undersized = compareCost(
			trajectoryId,
			4_000,
			{ provider: "anthropic", modelName: "claude-opus-4-6", contextWindow: rootContextWindow },
			costLogPath,
		);
		const uncappedBaselineCostUsd = estimateCost("anthropic", "claude-opus-4-6", Math.ceil(4_000 / 4), 500, 0);
		expect(undersized.baselineCostUsd).toBeCloseTo(uncappedBaselineCostUsd, 10);
		expect(undersized.baselineCostUsd).toBeLessThan(oversized.baselineCostUsd);
	});

	test("3. writeCostComparisonReport writes the exact CostComparisonResult as JSON to the given path", async () => {
		const dir = tempDir();
		const costLogPath = join(dir, "cost-log.jsonl");
		const reportPath = join(dir, "nested", "cost-comparison-report.json");

		const router = makeRouter(1_000_000, ["```python\nFINAL('done')\n```"]);
		session = createRouterBackedSession({ prompt: "some context", router, costLogPath });
		await session.run();

		const entries = readCostLog(costLogPath);
		const trajectoryId = entries[0].trajectoryId;
		if (!trajectoryId) throw new Error("expected a trajectoryId on the logged cost entries");

		const comparison = compareCost(
			trajectoryId,
			12,
			{ provider: "anthropic", modelName: "claude-opus-4-6", contextWindow: 1_000_000 },
			costLogPath,
		);

		// Nested directory that doesn't exist yet -- must be created.
		writeCostComparisonReport(comparison, reportPath);

		const written = JSON.parse(readFileSync(reportPath, "utf-8"));
		expect(written).toEqual(comparison);
	});
});
