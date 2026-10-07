import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "../../src/core/extensions/types.ts";
import { createKeywordHooks, type KeywordHooksDeps } from "../../src/core/polyphase/keyword.ts";
import type { ResolvedPolyphaseSettings } from "../../src/core/polyphase/settings.ts";

function fakeSettings(overrides: Partial<ResolvedPolyphaseSettings> = {}): ResolvedPolyphaseSettings {
	return {
		keyword: "polyphase",
		workflowTool: "keyword",
		maxDepth: 2,
		maxConcurrency: 4,
		maxAgentsPerRun: 20,
		maxItemsPerCall: 8,
		defaultBudgetTokens: null,
		workflowTimeoutMs: 120_000,
		liveUpdateMs: 250,
		resultChars: 4000,
		dock: true,
		retainRuns: 20,
		warnings: [],
		...overrides,
	};
}

function streamingInput(behavior: "steer" | "followUp"): InputEvent {
	return { type: "input", text: "polyphase help", source: "interactive", streamingBehavior: behavior };
}

function fakeCtx(branch: unknown[] = []): ExtensionContext {
	return { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
}

function buildDeps(overrides: Partial<KeywordHooksDeps> = {}): {
	deps: KeywordHooksDeps;
	sendMessage: ReturnType<typeof vi.fn>;
} {
	const sendMessage = vi.fn();
	const deps: KeywordHooksDeps = {
		pi: { sendMessage } as unknown as ExtensionAPI,
		settings: () => fakeSettings(),
		ensureTool: () => true,
		activate: () => {},
		deactivateIfAuto: () => {},
		buildGuide: () => "GUIDE TEXT",
		...overrides,
	};
	return { deps, sendMessage };
}

describe("createKeywordHooks", () => {
	it("queues the authoring guide only once across a burst of keyword steers before it is delivered", () => {
		const { deps, sendMessage } = buildDeps();
		const hooks = createKeywordHooks(deps);
		const ctx = fakeCtx([]);

		// Two keyword-bearing steers in a row, neither yet persisted into the branch (the harness's
		// `getBranch()` here never reflects a `deliverAs: "steer"` send, matching the real
		// agent-session.ts routing of steer/followUp to the agent's own queue).
		hooks.onInput(streamingInput("steer"), ctx);
		hooks.onInput(streamingInput("steer"), ctx);

		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("allows a new guide after the turn settles, if the branch still shows none delivered", () => {
		const { deps, sendMessage } = buildDeps();
		const hooks = createKeywordHooks(deps);
		const ctx = fakeCtx([]);

		hooks.onInput(streamingInput("steer"), ctx);
		expect(sendMessage).toHaveBeenCalledTimes(1);

		hooks.onAgentSettled(ctx);
		hooks.onInput(streamingInput("steer"), ctx);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it("never sends a second guide once the branch already carries one", () => {
		const { deps, sendMessage } = buildDeps();
		const hooks = createKeywordHooks(deps);
		const delivered = [{ type: "custom_message", customType: "polyphase-guidance" }];
		const ctx = fakeCtx(delivered);

		hooks.onInput(streamingInput("steer"), ctx);

		expect(sendMessage).not.toHaveBeenCalled();
	});
});
