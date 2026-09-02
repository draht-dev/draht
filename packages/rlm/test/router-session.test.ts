// Tests for `packages/rlm/src/router-session.ts` -- the `@draht/router`-backed
// `RlmSession` factory. Every test injects a **fake** `ModelRouter`-shaped
// object (matching `ModelRouter`'s real public method signatures from
// `packages/router/src/router.ts`: `resolve`, `resolveModel`, `streamSimple`)
// so no real network/API call ever happens. See
// .planning/phases/27-sub-llm-integration/27-01-PLAN.md, Architecture
// section 5, task 3.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from "@draht/ai/compat";
import type { ModelRef, ModelRouter } from "@draht/router";
import { readCostLog } from "@draht/router";
import { afterEach, describe, expect, test } from "vitest";
import type { RlmSession } from "../src/index.js";
import { createRouterBackedSession } from "../src/index.js";
import { HAS_PYTHON3, HAS_USERNS } from "./sandbox-prereqs.js";

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

interface StreamSimpleCall {
	role: string;
	context: Context;
}

interface FakeRouterOptions {
	/** `contextWindow` reported for the "rlm-root" role's resolved model. */
	rootContextWindow: number;
	/** Root-call responses, consumed in order (last one repeats if exhausted). */
	rootResponses: string[];
	/** Sub-call ("llm_query") response, constant for every call in a test. */
	subResponse?: string;
}

/**
 * A fake object shaped like `ModelRouter`'s public API (`resolve`,
 * `resolveModel`, `streamSimple` -- see `packages/router/src/router.ts`).
 * Cast to `ModelRouter` at the call site since `createRouterBackedSession`
 * only ever calls these three methods on it.
 */
class FakeModelRouter {
	readonly calls: StreamSimpleCall[] = [];
	private rootCallIndex = 0;

	constructor(private readonly opts: FakeRouterOptions) {}

	resolve(role: string): ModelRef {
		if (role === "rlm-root") return { provider: "anthropic", model: "claude-opus-4-6" };
		if (role === "rlm-sub") return { provider: "google", model: "gemini-2.5-flash" };
		throw new Error(`FakeModelRouter: unexpected role "${role}"`);
	}

	resolveModel(ref: ModelRef): Model<Api> | null {
		if (ref.model === "claude-opus-4-6") {
			return fakeModel(this.opts.rootContextWindow, "anthropic", "anthropic-messages");
		}
		return fakeModel(1_000_000, "google", "google-generative-ai");
	}

	async *streamSimple(role: string, context: Context): AsyncGenerator<AssistantMessageEvent> {
		this.calls.push({ role, context });

		let text: string;
		let provider: string;
		let model: string;
		let api: Api;
		if (role === "rlm-root") {
			const i = Math.min(this.rootCallIndex, this.opts.rootResponses.length - 1);
			text = this.opts.rootResponses[i];
			this.rootCallIndex++;
			provider = "anthropic";
			model = "claude-opus-4-6";
			api = "anthropic-messages";
		} else if (role === "rlm-sub") {
			text = this.opts.subResponse ?? "sub-response";
			provider = "google";
			model = "gemini-2.5-flash";
			api = "google-generative-ai";
		} else {
			throw new Error(`FakeModelRouter: unexpected role "${role}"`);
		}

		yield { type: "done", reason: "stop", message: fakeAssistantMessage(text, provider, model, api) };
	}
}

function makeRouter(opts: FakeRouterOptions): { router: ModelRouter; fake: FakeModelRouter } {
	const fake = new FakeModelRouter(opts);
	return { router: fake as unknown as ModelRouter, fake };
}

// The router is fake, but every test's session still spawns a real python3
// REPL through the fail-closed OS sandbox -- see sandbox-prereqs.ts.
describe.skipIf(!HAS_PYTHON3 || !HAS_USERNS)("createRouterBackedSession", () => {
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

	function tempCostLogPath(): string {
		tmpDir = mkdtempSync(join(tmpdir(), "rlm-router-session-test-"));
		return join(tmpDir, "cost-log.jsonl");
	}

	test("1. resolves the prompt tier from the fake router's rlm-root context window and renders the matching template", async () => {
		const cases: Array<{ contextWindow: number; heading: string }> = [
			{ contextWindow: 1_000_000, heading: "# RLM Root Loop — Frontier Tier" },
			{ contextWindow: 200_000, heading: "# RLM Root Loop — Coder-Mid Tier" },
			{ contextWindow: 50_000, heading: "# RLM Root Loop — Small-Context Tier" },
		];

		for (const { contextWindow, heading } of cases) {
			const { router, fake } = makeRouter({
				rootContextWindow: contextWindow,
				rootResponses: ["```python\nFINAL('done')\n```"],
			});

			session = createRouterBackedSession({ prompt: "hello world", router, costLogPath: tempCostLogPath() });
			const result = await session.run();
			session.dispose();
			session = undefined;

			expect(result.kind).toBe("final");
			expect(fake.calls).toHaveLength(1);
			expect(fake.calls[0].role).toBe("rlm-root");
			expect(fake.calls[0].context.systemPrompt?.startsWith(heading)).toBe(true);
			// No unsubstituted {{token}} placeholders leaked through into the real prompt.
			expect(fake.calls[0].context.systemPrompt).not.toMatch(/\{\{[a-z_]+\}\}/);
		}
	});

	test("2. running the returned RlmSession to FINAL produces a cost log entry for the root call", async () => {
		const costLogPath = tempCostLogPath();
		const { router } = makeRouter({
			rootContextWindow: 1_000_000,
			rootResponses: ["```python\nFINAL('the answer')\n```"],
		});

		session = createRouterBackedSession({ prompt: "some prompt text", router, costLogPath });
		const result = await session.run();

		expect(result.kind).toBe("final");
		expect(result.value).toBe("the answer");

		const entries = readCostLog(costLogPath);
		const rootEntries = entries.filter((e) => e.role === "rlm-root");
		expect(rootEntries).toHaveLength(1);
		expect(rootEntries[0].provider).toBe("anthropic");
		expect(rootEntries[0].model).toBe("claude-opus-4-6");
		expect(rootEntries[0].trajectoryId).toBeTruthy();
	});

	test("3. a sub-call via llm_query inside the REPL produces a cost entry tagged with the same trajectoryId as the root call", async () => {
		const costLogPath = tempCostLogPath();
		const { router } = makeRouter({
			rootContextWindow: 1_000_000,
			rootResponses: ["```python\nresult = llm_query('summarize this')\nFINAL(result)\n```"],
			subResponse: "a summary",
		});

		session = createRouterBackedSession({ prompt: "some prompt text", router, costLogPath });
		const result = await session.run();

		expect(result.kind).toBe("final");
		expect(result.value).toBe("a summary");

		const entries = readCostLog(costLogPath);
		const rootEntries = entries.filter((e) => e.role === "rlm-root");
		const subEntries = entries.filter((e) => e.role === "rlm-sub");
		expect(rootEntries).toHaveLength(1);
		expect(subEntries).toHaveLength(1);
		expect(subEntries[0].provider).toBe("google");
		expect(subEntries[0].model).toBe("gemini-2.5-flash");

		expect(rootEntries[0].trajectoryId).toBeTruthy();
		expect(subEntries[0].trajectoryId).toBe(rootEntries[0].trajectoryId);
	});

	test("4. two separate createRouterBackedSession calls produce different trajectoryIds", async () => {
		const costLogPath = tempCostLogPath();

		const { router: routerA } = makeRouter({
			rootContextWindow: 1_000_000,
			rootResponses: ["```python\nFINAL('a')\n```"],
		});
		const sessionA = createRouterBackedSession({ prompt: "prompt A", router: routerA, costLogPath });
		await sessionA.run();
		sessionA.dispose();

		const { router: routerB } = makeRouter({
			rootContextWindow: 1_000_000,
			rootResponses: ["```python\nFINAL('b')\n```"],
		});
		session = createRouterBackedSession({ prompt: "prompt B", router: routerB, costLogPath });
		await session.run();

		const entries = readCostLog(costLogPath).filter((e) => e.role === "rlm-root");
		expect(entries).toHaveLength(2);
		expect(entries[0].trajectoryId).toBeTruthy();
		expect(entries[1].trajectoryId).toBeTruthy();
		expect(entries[0].trajectoryId).not.toBe(entries[1].trajectoryId);
	});
});
