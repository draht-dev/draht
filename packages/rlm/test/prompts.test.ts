// Tests for `packages/rlm/src/prompts.ts` -- prompt tier auto-selection from
// a resolved model's context window, and `{{token}}` substitution against
// the three tuned templates in `packages/rlm/prompts/`. See
// .planning/phases/27-sub-llm-integration/27-01-PLAN.md, Architecture
// sections 3-4.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { PromptTier, PromptVars } from "../src/prompts.js";
import { renderPrompt, selectTier } from "../src/prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "..", "prompts");

const TIERS: PromptTier[] = ["frontier", "coder-mid", "small-context"];

const TIER_FILENAMES: Record<PromptTier, string> = {
	frontier: "frontier.md",
	"coder-mid": "coder-mid.md",
	"small-context": "small-context.md",
};

function rawTemplate(tier: PromptTier): string {
	return readFileSync(join(PROMPTS_DIR, TIER_FILENAMES[tier]), "utf8");
}

const SAMPLE_VARS: PromptVars = {
	contextType: "text",
	contextTotalLength: 123_456,
	chunkLengths: [10_000, 10_000, 3_456],
	maxSubCallBudget: 40,
	subCallCharBudget: 12_000,
};

describe("selectTier", () => {
	test("1. comfortably-inside values pick the expected tier", () => {
		expect(selectTier(1_000_000)).toBe("frontier");
		expect(selectTier(200_000)).toBe("coder-mid");
		expect(selectTier(32_000)).toBe("small-context");
	});

	test("2. boundary values: >= 500_000 is frontier, just under is coder-mid", () => {
		expect(selectTier(500_000)).toBe("frontier");
		expect(selectTier(499_999)).toBe("coder-mid");
	});

	test("3. boundary values: >= 128_000 is coder-mid, just under is small-context", () => {
		expect(selectTier(128_000)).toBe("coder-mid");
		expect(selectTier(127_999)).toBe("small-context");
	});

	test("4. zero and negative-ish tiny windows still resolve to small-context", () => {
		expect(selectTier(0)).toBe("small-context");
		expect(selectTier(1)).toBe("small-context");
	});
});

describe("renderPrompt", () => {
	for (const tier of TIERS) {
		test(`substitutes all 5 tokens for tier "${tier}" and leaves no placeholder behind`, () => {
			const rendered = renderPrompt(tier, SAMPLE_VARS);

			expect(rendered).toContain(SAMPLE_VARS.contextType);
			expect(rendered).toContain(String(SAMPLE_VARS.contextTotalLength));
			expect(rendered).toContain(JSON.stringify(SAMPLE_VARS.chunkLengths));
			expect(rendered).toContain(String(SAMPLE_VARS.maxSubCallBudget));
			expect(rendered).toContain(String(SAMPLE_VARS.subCallCharBudget));

			expect(rendered).not.toMatch(/\{\{[a-z_]+\}\}/);
		});
	}
});

describe("the three raw templates", () => {
	test("are not byte-identical copies of each other", () => {
		const [frontier, coderMid, smallContext] = TIERS.map(rawTemplate);
		expect(frontier).not.toBe(coderMid);
		expect(frontier).not.toBe(smallContext);
		expect(coderMid).not.toBe(smallContext);
	});

	test("differ in more than just substituted values -- distinct lengths and structure", () => {
		const lengths = TIERS.map((tier) => rawTemplate(tier).length);
		// All three should have meaningfully different raw lengths (the plan
		// calls for differing verbosity/scaffolding, not just cosmetic
		// rewording), not just differ by a token here or there.
		expect(new Set(lengths).size).toBe(3);
	});

	test("each contains the batching advisory: discourage one-item-per-call, recommend ~10-15k char batches", () => {
		for (const tier of TIERS) {
			const raw = rawTemplate(tier);
			// Discourages per-item calls.
			expect(raw.toLowerCase()).toMatch(/one call per|per item|per line|per record/);
			// Recommends the ~10-15k char batch size.
			expect(raw).toMatch(/10,000|10k|10,?000–?/i);
			expect(raw).toMatch(/15,000|15k/i);
		}
	});

	test("each template still contains all 5 placeholder tokens verbatim", () => {
		for (const tier of TIERS) {
			const raw = rawTemplate(tier);
			expect(raw).toContain("{{context_type}}");
			expect(raw).toContain("{{context_total_length}}");
			expect(raw).toContain("{{chunk_lengths}}");
			expect(raw).toContain("{{max_sub_call_budget}}");
			expect(raw).toContain("{{sub_call_char_budget}}");
		}
	});
});
