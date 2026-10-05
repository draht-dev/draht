import { describe, expect, test } from "bun:test";
import type { AnchorContext } from "../src/anchored-diagram.ts";
import type { HeadFileContent } from "../src/code-ref.ts";
import type { AssembledStoryContext } from "../src/context.ts";
import type { FileChange, Story } from "../src/contract.ts";
import type { ModelCompleter, ModelCompletionResult } from "../src/script.ts";
import { createSourceRegistry } from "../src/sources.ts";
import { REASON_NOT_RECORDED_TEXT } from "../src/story-validate.ts";
import {
	applyDeterministicFixes,
	buildUserPrompt,
	CostMeter,
	computeDeepDiveScoreInputs,
	type DeepDiveScoreInputs,
	deepDiveScore,
	SYSTEM_PROMPT,
	shouldRenderDeepDive,
	writeOneScript,
	writeStories,
	writeStoryScript,
} from "../src/story-writer.ts";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const files: FileChange[] = [
	{
		path: "src/foo.ts",
		status: "modified",
		additions: 1,
		deletions: 1,
		hunks: [
			{
				header: "@@ -10,3 +10,4 @@",
				lines: [" line ten", "+line eleven (added)", " line twelve", "-line thirteen (removed)"],
			},
		],
	},
];

const headFiles = new Map<string, HeadFileContent>([
	["src/foo.ts", { path: "src/foo.ts", lines: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`) }],
]);

const anchors: AnchorContext = {
	changedPaths: new Set(["src/foo.ts"]),
	contextPaths: new Set(),
	textByPath: new Map([["src/foo.ts", "export function resolveCodeRef() {}"]]),
	packageNames: new Set(["@draht/reels"]),
	topLevelDirs: new Set(["src"]),
};

const sources = createSourceRegistry([
	{
		id: "c:abcdef123456",
		kind: "commit",
		label: "fix: slow query",
		text: "fix: slow query\n\nBecause performance degraded under load, we added an index.",
	},
]);

function story(overrides: Partial<Story> = {}): Story {
	return {
		id: HEAD_SHA,
		commits: [HEAD_SHA.slice(0, 12)],
		title: "fix: slow query",
		body: "",
		authors: ["Ada Lovelace"],
		date: "2024-01-01T00:00:00Z",
		files,
		origin: "commit",
		base: "parent12345678901234567890123456789012345",
		branchCommits: [],
		related: [],
		...overrides,
	};
}

function ctx(overrides: Partial<AssembledStoryContext> = {}): AssembledStoryContext {
	return {
		sources,
		promptContext: '<<src id=c:abcdef123456 kind=commit label="x" nonce=n>>\nfix: slow query\n<</src nonce=n>>',
		manifest: { totalChars: 0, budgetChars: 0, entries: [] },
		nonce: "n",
		headFiles,
		anchors,
		...overrides,
	};
}

function queueCompleter(responses: ModelCompletionResult[]): { complete: ModelCompleter; calls: number } {
	const queue = [...responses];
	const state = { calls: 0 };
	const complete: ModelCompleter = async () => {
		state.calls++;
		const next = queue.shift();
		if (!next) throw new Error("faux completer queue exhausted");
		return next;
	};
	return {
		complete,
		get calls() {
			return state.calls;
		},
	} as { complete: ModelCompleter; calls: number };
}

function metaBeat(text: string) {
	return { text, claim: "meta" as const, cites: [] };
}

function validDiagram() {
	return {
		nodes: [
			{ id: "a", anchor: { kind: "component", value: "@draht/reels" }, caption: "the package" },
			{ id: "b", anchor: { kind: "component", value: "src" }, caption: "the source" },
			{ id: "c", anchor: { kind: "symbol", value: "resolveCodeRef" }, caption: "resolves it" },
		],
		edges: [],
	};
}

function validCodeRef() {
	return { path: "src/foo.ts", ref: "diff" as const, hunk: 0, lines: [1, 2] as [number, number] };
}

/** The minimal short arc (problem -> idea -> mechanism -> code -> impact -> outro) with single `meta` beats. */
function fullArcScenes(overrides: Record<string, unknown> = {}) {
	return [
		overrides.problem ?? { section: "problem", beats: [metaBeat("Problem.")] },
		overrides.idea ?? { section: "idea", beats: [metaBeat("Idea.")] },
		overrides.mechanism ?? { section: "mechanism", diagram: validDiagram(), beats: [metaBeat("Mechanism.")] },
		overrides.code ?? { section: "code", code: validCodeRef(), beats: [metaBeat("Code.")] },
		overrides.impact ?? { section: "impact", beats: [metaBeat("Impact.")] },
		overrides.outro ?? { section: "outro", beats: [metaBeat("That's the change.")] },
	];
}

const VALID_RESPONSE = JSON.stringify({
	title: "A fix",
	subtitle: "By Ada",
	summary: { text: "A fix.", cites: [] },
	scenes: fullArcScenes(),
});

function uncitedWhyResponse(): string {
	return JSON.stringify({
		title: "A fix",
		subtitle: "By Ada",
		summary: { text: "A fix.", cites: [] },
		scenes: fullArcScenes({
			problem: { section: "problem", beats: [{ text: "It was slow because of load.", claim: "why", cites: [] }] },
		}),
	});
}

const REPAIRED_RESPONSE = JSON.stringify({
	title: "A fix",
	subtitle: "By Ada",
	summary: { text: "A fix.", cites: [] },
	scenes: fullArcScenes({
		problem: {
			section: "problem",
			beats: [
				{
					text: "It was slow because performance degraded under load.",
					claim: "why",
					cites: ["c:abcdef123456"],
					quote: "performance degraded under load",
				},
			],
		},
	}),
});

describe("writeOneScript", () => {
	test("valid on the first try: one call, writer llm, not repaired", async () => {
		const queue = queueCompleter([{ text: VALID_RESPONSE }]);
		const costMeter = new CostMeter(100);
		const result = await writeOneScript(story(), ctx(), queue.complete, costMeter, {
			isDeepDive: false,
			maxTokens: 1000,
			maxCodeLines: 18,
		});
		expect(result.writer).toBe("llm");
		expect(result.repaired).toBe(false);
		expect(queue.calls).toBe(1);
	});

	test("invalid first, then repaired by the second call", async () => {
		const queue = queueCompleter([{ text: uncitedWhyResponse() }, { text: REPAIRED_RESPONSE }]);
		const costMeter = new CostMeter(100);
		const result = await writeOneScript(story(), ctx(), queue.complete, costMeter, {
			isDeepDive: false,
			maxTokens: 1000,
			maxCodeLines: 18,
		});
		expect(result.writer).toBe("llm");
		expect(result.repaired).toBe(true);
		expect(queue.calls).toBe(2);
	});

	test("invalid twice: deterministic fixes turn the uncited why beat into a meta beat", async () => {
		const queue = queueCompleter([{ text: uncitedWhyResponse() }, { text: uncitedWhyResponse() }]);
		const costMeter = new CostMeter(100);
		const fallbacks: string[] = [];
		const result = await writeOneScript(story(), ctx(), queue.complete, costMeter, {
			isDeepDive: false,
			maxTokens: 1000,
			maxCodeLines: 18,
			onFallback: (reason) => fallbacks.push(reason),
		});
		expect(result.writer).toBe("llm");
		expect(result.repaired).toBe(true);
		expect(fallbacks).toEqual([]);
		const problemScene = result.script.scenes.find((s) => s.section === "problem");
		expect(problemScene?.beats?.[0]).toMatchObject({ text: REASON_NOT_RECORDED_TEXT.en });
	});

	test("unparseable twice: falls back to the template writer", async () => {
		const queue = queueCompleter([{ text: "not json" }, { text: "still not json" }]);
		const costMeter = new CostMeter(100);
		const fallbacks: string[] = [];
		const result = await writeOneScript(story(), ctx(), queue.complete, costMeter, {
			isDeepDive: false,
			maxTokens: 1000,
			maxCodeLines: 18,
			onFallback: (reason) => fallbacks.push(reason),
		});
		expect(result.writer).toBe("template");
		expect(fallbacks).toHaveLength(1);
		expect(fallbacks[0]).toMatch(/unparseable twice/);
	});
});

describe("CostMeter / writeStories cost cap", () => {
	test("stops starting new stories once the cap is hit, keeping finished ones", async () => {
		const queue = queueCompleter([
			{ text: VALID_RESPONSE, usage: { input: 100, output: 100, costUsd: 0.6 } },
			{ text: VALID_RESPONSE, usage: { input: 100, output: 100, costUsd: 0.6 } },
			{ text: VALID_RESPONSE, usage: { input: 100, output: 100, costUsd: 0.6 } },
		]);
		const costMeter = new CostMeter(1); // first call (0.6) leaves budget, second (1.2 total) exhausts it
		const jobs = [
			{ story: story({ id: HEAD_SHA }), ctx: ctx() },
			{ story: story({ id: `${HEAD_SHA.slice(0, -1)}1` }), ctx: ctx() },
			{ story: story({ id: `${HEAD_SHA.slice(0, -1)}2` }), ctx: ctx() },
		];
		let capReachedWith: number | undefined;
		const results = await writeStories(jobs, queue.complete, costMeter, {
			deepDive: "never",
			onCapReached: (remaining) => {
				capReachedWith = remaining.length;
			},
		});
		expect(results).toHaveLength(2);
		expect(capReachedWith).toBe(1);
		expect(costMeter.hasBudget()).toBe(false);
	});
});

describe("deep-dive score", () => {
	const base: DeepDiveScoreInputs = {
		commitCount: 1,
		commitBodyChars: 0,
		hasPrDiscussion: false,
		hasFixOrRelatedCommit: false,
		hasAlternativesDoc: false,
		changedNonTestLines: 0,
	};

	test("each signal contributes exactly one point", () => {
		expect(deepDiveScore(base)).toBe(0);
		expect(deepDiveScore({ ...base, commitCount: 3 })).toBe(1);
		expect(deepDiveScore({ ...base, commitBodyChars: 1_500 })).toBe(1);
		expect(deepDiveScore({ ...base, hasPrDiscussion: true })).toBe(1);
		expect(deepDiveScore({ ...base, hasFixOrRelatedCommit: true })).toBe(1);
		expect(deepDiveScore({ ...base, hasAlternativesDoc: true })).toBe(1);
		expect(deepDiveScore({ ...base, changedNonTestLines: 300 })).toBe(1);
	});

	test("auto renders at a score of 3 or more, never below", () => {
		expect(shouldRenderDeepDive("auto", 2)).toBe(false);
		expect(shouldRenderDeepDive("auto", 3)).toBe(true);
	});

	test("never never renders, always always renders", () => {
		expect(shouldRenderDeepDive("never", 10)).toBe(false);
		expect(shouldRenderDeepDive("always", 0)).toBe(true);
	});

	test("computeDeepDiveScoreInputs reads real signals off the story and sources", () => {
		const s = story({
			branchCommits: [
				{ sha: "a".repeat(40), subject: "fix: edge case", body: "x".repeat(2_000), author: "a", date: "d" },
				{ sha: "b".repeat(40), subject: "feat: more", body: "", author: "a", date: "d" },
			],
			files: [
				{ path: "src/big.ts", status: "modified", additions: 200, deletions: 150, hunks: [] },
				{ path: "src/big.test.ts", status: "modified", additions: 500, deletions: 0, hunks: [] },
			],
		});
		const inputs = computeDeepDiveScoreInputs(s, sources);
		expect(inputs.commitCount).toBe(3);
		expect(inputs.hasFixOrRelatedCommit).toBe(true);
		expect(inputs.changedNonTestLines).toBe(350); // test file excluded
		expect(inputs.commitBodyChars).toBeGreaterThanOrEqual(2_000);
	});
});

describe("writeStoryScript: deep dive", () => {
	test("always renders a deep dive and omits an alternatives section with no alternatives source", async () => {
		const deepResponse = JSON.stringify({
			title: "A fix",
			subtitle: "By Ada",
			summary: { text: "A fix.", cites: [] },
			scenes: [
				...fullArcScenes().slice(0, -1),
				{
					section: "alternatives",
					beats: [{ text: "We could have done it differently.", claim: "meta", cites: [] }],
				},
				{ section: "outro", beats: [{ text: "That's the change.", claim: "meta", cites: [] }] },
			],
		});
		const queue = queueCompleter([{ text: VALID_RESPONSE }, { text: deepResponse }]);
		const costMeter = new CostMeter(100);
		const result = await writeStoryScript(story(), ctx(), queue.complete, costMeter, { deepDive: "always" });

		expect(result.deepDiveOutcome).toBe("rendered");
		expect(result.deepDive?.script.scenes.some((s) => s.section === "alternatives")).toBe(false);
	});

	test("auto skips the deep dive when the score is below 3", async () => {
		const queue = queueCompleter([{ text: VALID_RESPONSE }]);
		const costMeter = new CostMeter(100);
		const result = await writeStoryScript(story(), ctx(), queue.complete, costMeter, { deepDive: "auto" });

		expect(result.deepDiveOutcome).toBe("not-warranted");
		expect(result.deepDive).toBeUndefined();
		expect(queue.calls).toBe(1);
	});
});

describe("the beat claim rename (impact -> effect)", () => {
	test('the user prompt\'s schema uses claim "effect", not "impact"', () => {
		const prompt = buildUserPrompt("source text", false);
		expect(prompt).toContain('"why"|"what"|"how"|"effect"|"meta"');
	});

	test('the system prompt enumerates "effect" as a claim, and "impact" only as a section name', () => {
		expect(SYSTEM_PROMPT).toContain('"why" | "what" | "how" | "effect" | "meta"');
		expect(SYSTEM_PROMPT).toContain("why, what, how, effect, meta");
	});

	test("an effect beat validates like a why beat once cited", async () => {
		const response = JSON.stringify({
			title: "A fix",
			subtitle: "By Ada",
			summary: { text: "A fix.", cites: [] },
			scenes: fullArcScenes({
				impact: {
					section: "impact",
					beats: [
						{
							text: "Queries are now fast because of the new index.",
							claim: "effect",
							cites: ["c:abcdef123456"],
							quote: "we added an index",
						},
					],
				},
			}),
		});
		const queue = queueCompleter([{ text: response }]);
		const costMeter = new CostMeter(100);
		const result = await writeOneScript(story(), ctx(), queue.complete, costMeter, {
			isDeepDive: false,
			maxTokens: 1000,
			maxCodeLines: 18,
		});
		expect(result.writer).toBe("llm");
		expect(result.repaired).toBe(false);
	});

	test("applyDeterministicFixes replaces an ungrounded why/effect beat with a meta beat, never an invented claim", () => {
		const raw = {
			title: "t",
			subtitle: "s",
			summary: { text: "s", cites: [] },
			scenes: [
				{
					section: "impact" as const,
					beats: [{ text: "It got faster.", claim: "effect" as const, cites: [] }],
				},
			],
		};
		const fixed = applyDeterministicFixes(raw, [{ path: "scenes[0].beats[0]", rule: "citations", detail: "x" }]);
		expect(fixed.scenes[0].beats[0]).toMatchObject({
			claim: "meta",
			text: REASON_NOT_RECORDED_TEXT.en,
		});
	});
});
