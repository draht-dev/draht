import type { Model } from "@draht/ai";
import { describe, expect, it } from "vitest";
import { ModelSelectionError, normalizeEffort, resolveChildModel } from "../../src/core/polyphase/model-selection.ts";

const models: Model<"anthropic-messages">[] = [
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	},
	{
		id: "gpt-6.1-sol",
		name: "GPT 6.1 Sol",
		api: "anthropic-messages",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	},
];

const anthropic = models[0];

describe("normalizeEffort", () => {
	it("maps 'none' to 'off'", () => {
		expect(normalizeEffort("none")).toBe("off");
	});

	it("passes through valid thinking levels", () => {
		expect(normalizeEffort("high")).toBe("high");
	});

	it("throws ModelSelectionError for an invalid level", () => {
		expect(() => normalizeEffort("extreme")).toThrow(ModelSelectionError);
	});
});

describe("resolveChildModel", () => {
	it("override: resolves provider/id, source override, and uses the pattern's thinking level", () => {
		const choice = resolveChildModel({ override: "anthropic/claude-sonnet-5:high", available: models });
		expect(choice.modelArg).toBe("anthropic/claude-sonnet-5");
		expect(choice.thinking).toBe("high");
		expect(choice.info).toMatchObject({
			source: "override",
			requested: "anthropic/claude-sonnet-5:high",
			provider: "anthropic",
			id: "claude-sonnet-5",
			confirmed: false,
		});
	});

	it("override: an explicit effort overrides the pattern's thinking level", () => {
		const choice = resolveChildModel({
			override: "anthropic/claude-sonnet-5:high",
			effort: "low",
			available: models,
		});
		expect(choice.thinking).toBe("low");
	});

	it("override: an unknown model throws ModelSelectionError", () => {
		expect(() => resolveChildModel({ override: "nonexistent/model", available: models })).toThrow(
			ModelSelectionError,
		);
	});

	it("phase: same resolution rules, source phase", () => {
		const choice = resolveChildModel({ phaseModel: "openai/gpt-6.1-sol", available: models });
		expect(choice.modelArg).toBe("openai/gpt-6.1-sol");
		expect(choice.info.source).toBe("phase");
		expect(choice.info.provider).toBe("openai");
	});

	it("phase: an unknown model throws ModelSelectionError", () => {
		expect(() => resolveChildModel({ phaseModel: "nonexistent/model", available: models })).toThrow(
			ModelSelectionError,
		);
	});

	it("frontmatter: passed verbatim, resolved only for display", () => {
		const choice = resolveChildModel({ agentModel: "anthropic/claude-sonnet-5:high", available: models });
		expect(choice.modelArg).toBe("anthropic/claude-sonnet-5:high");
		expect(choice.info).toMatchObject({
			source: "frontmatter",
			requested: "anthropic/claude-sonnet-5:high",
			provider: "anthropic",
			id: "claude-sonnet-5",
		});
		// The pattern's own ":high" is not surfaced as `thinking`: only an explicit effort is.
		expect(choice.thinking).toBeUndefined();
	});

	it("frontmatter: an explicit effort sets thinking", () => {
		const choice = resolveChildModel({
			agentModel: "anthropic/claude-sonnet-5",
			effort: "medium",
			available: models,
		});
		expect(choice.thinking).toBe("medium");
	});

	it("frontmatter: an unresolvable pattern is still passed verbatim, without provider/id", () => {
		const choice = resolveChildModel({ agentModel: "some-custom-alias", available: models });
		expect(choice.modelArg).toBe("some-custom-alias");
		expect(choice.info.provider).toBeUndefined();
		expect(choice.info.id).toBeUndefined();
	});

	it("inherited: uses the parent's provider/id and thinking level", () => {
		const choice = resolveChildModel({ parentModel: anthropic, parentThinking: "high", available: models });
		expect(choice.modelArg).toBe("anthropic/claude-sonnet-5");
		expect(choice.thinking).toBe("high");
		expect(choice.info).toMatchObject({
			source: "inherited",
			provider: "anthropic",
			id: "claude-sonnet-5",
		});
	});

	it("inherited: an explicit effort overrides the parent's thinking level", () => {
		const choice = resolveChildModel({
			parentModel: anthropic,
			parentThinking: "high",
			effort: "low",
			available: models,
		});
		expect(choice.thinking).toBe("low");
	});

	it("child-default: no model arg, no provider/id", () => {
		const choice = resolveChildModel({ available: models });
		expect(choice.modelArg).toBeUndefined();
		expect(choice.info).toMatchObject({ source: "child-default", confirmed: false });
		expect(choice.info.provider).toBeUndefined();
	});

	it("child-default: an explicit effort still sets thinking", () => {
		const choice = resolveChildModel({ effort: "none", available: models });
		expect(choice.thinking).toBe("off");
	});

	it("an invalid effort throws regardless of precedence level", () => {
		expect(() => resolveChildModel({ effort: "bogus", available: models })).toThrow(ModelSelectionError);
	});

	it("precedence: override wins over phase, frontmatter, and parent", () => {
		const choice = resolveChildModel({
			override: "anthropic/claude-sonnet-5",
			phaseModel: "openai/gpt-6.1-sol",
			agentModel: "openai/gpt-6.1-sol",
			parentModel: models[1],
			available: models,
		});
		expect(choice.info.source).toBe("override");
	});

	it("precedence: phase wins over frontmatter and parent", () => {
		const choice = resolveChildModel({
			phaseModel: "anthropic/claude-sonnet-5",
			agentModel: "openai/gpt-6.1-sol",
			parentModel: models[1],
			available: models,
		});
		expect(choice.info.source).toBe("phase");
	});

	it("precedence: frontmatter wins over parent", () => {
		const choice = resolveChildModel({
			agentModel: "anthropic/claude-sonnet-5",
			parentModel: models[1],
			available: models,
		});
		expect(choice.info.source).toBe("frontmatter");
	});
});
