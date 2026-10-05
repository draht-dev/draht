import { describe, expect, test } from "bun:test";
import {
	buildRecapSourceRegistry,
	buildReleaseSourceRegistry,
	CostMeter,
	computeRecapThemes,
	computeReleaseThemes,
	estimateRecapMaxTokens,
	looksTruncated,
	parseRecapResponse,
	parseReleaseOverviewResponse,
	type RecapChangelogInput,
	type RecapCommitInput,
	type ReleaseOverviewInput,
	type ReleaseStoryInput,
	type SyncRecapInput,
	selectRecapCommits,
	selectWeakFeatures,
	templateReleaseOverview,
	validateReleaseOverview,
	validateSyncRecap,
	type WeakFeatureInput,
	weakFeatureRef,
	writeReleaseOverview,
	writeSyncRecap,
} from "../src/release-writer.ts";
import type { ModelCompleter, ModelCompletionResult } from "../src/script.ts";

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

const STORY_AI: ReleaseStoryInput = {
	sha12: "aaaaaaaaaaaa",
	title: "feat(ai): add streaming",
	origin: "branch",
	attribution: "strong",
	summary: "Streams model output as it is generated.",
	packages: ["ai"],
};

const STORY_AI_2: ReleaseStoryInput = {
	sha12: "bbbbbbbbbbbb",
	title: "feat(ai): retry on 429",
	origin: "commit",
	attribution: "strong",
	summary: "Retries a request once when the provider rate-limits it.",
	packages: ["ai"],
};

const STORY_REELS: ReleaseStoryInput = {
	sha12: "cccccccccccc",
	title: "feat(reels): add release overviews",
	origin: "pr",
	attribution: "strong",
	summary: "Renders a release overview reel.",
	packages: ["reels"],
};

const WEAK_FEATURE = {
	title: "tweak the profile grid spacing",
	anchorText: "tweak the profile grid spacing for small screens",
	changelogSourceId: "cl:tui@2026.10.4-1#3",
};
/** The spoken beat text the pipeline renders for {@link WEAK_FEATURE}: its full anchor text (never the short title), capitalized and period-terminated. */
const WEAK_FEATURE_NARRATION = "Tweak the profile grid spacing for small screens.";

function releaseInput(overrides: Partial<ReleaseOverviewInput> = {}): ReleaseOverviewInput {
	return {
		tag: "v2026.10.4-1",
		stories: [STORY_AI, STORY_AI_2, STORY_REELS],
		weakFeatures: [],
		syncs: [],
		tiny: false,
		...overrides,
	};
}

describe("computeReleaseThemes", () => {
	test("groups stories by their top package deterministically", () => {
		const themes = computeReleaseThemes([STORY_AI, STORY_AI_2, STORY_REELS]);
		expect(themes).toEqual([
			{ id: "theme:ai", name: "ai", storyIds: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] },
			{ id: "theme:reels", name: "reels", storyIds: ["cccccccccccc"] },
		]);
	});

	test("caps at 5 themes, merging overflow into a trailing 'More' theme", () => {
		const stories: ReleaseStoryInput[] = Array.from({ length: 7 }, (_, i) => ({
			sha12: `${i}`.padStart(12, "0"),
			title: `feat(pkg${i}): x`,
			origin: "commit",
			packages: [`pkg${i}`],
		}));
		const themes = computeReleaseThemes(stories);
		expect(themes).toHaveLength(5);
		expect(themes[4]?.id).toBe("theme:more");
		expect(themes[4]?.storyIds).toHaveLength(3);
	});
});

describe("selectWeakFeatures", () => {
	test("drops a near-duplicate whose full anchor text token set is covered >= 80% by one already kept", () => {
		const a: WeakFeatureInput = {
			title: "Show draht logo on OAuth callback pages",
			anchorText: "Show draht logo on OAuth callback pages",
			changelogSourceId: "cl:ai@v1#0",
		};
		const b: WeakFeatureInput = {
			title: "show the `draht` logo on oauth callback pages!",
			anchorText: "show the `draht` logo on oauth callback pages!",
			changelogSourceId: "cl:ai@v1#1",
		};
		const result = selectWeakFeatures([a, b]);
		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]?.changelogSourceId).toBe("cl:ai@v1#0");
		expect(result.remainderCount).toBe(0);
	});

	test("keeps two entries whose anchor text shares only a minority of tokens", () => {
		const a: WeakFeatureInput = {
			title: "tweak the profile grid spacing",
			anchorText: "tweak the profile grid spacing",
			changelogSourceId: "0",
		};
		const b: WeakFeatureInput = {
			title: "add retry on 429 responses",
			anchorText: "add retry on 429 responses",
			changelogSourceId: "1",
		};
		const result = selectWeakFeatures([a, b]);
		expect(result.kept).toHaveLength(2);
		expect(result.remainderCount).toBe(0);
	});

	test("near-duplicate model-list entries collapse into one, keeping the more informative (longer) line", () => {
		// Real paid-render finding: two changelog lines independently list new model support for the same
		// release, one a strict subset of the other's models plus different wrapping prose. Neither reaches
		// the 80% full-token-set bar (too much non-shared prose), but both are the same announcement.
		const shorter: WeakFeatureInput = {
			title: "GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, and GPT-6.1 Sol (now the Codex default) model support",
			anchorText: "GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, and GPT-6.1 Sol (now the Codex default) model support",
			changelogSourceId: "cl:agent@v2026.10.4-1#5",
		};
		const longer: WeakFeatureInput = {
			title: "GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-6.1 Sol, Claude Opus 5.5, Claude Sonnet 5.5,…",
			anchorText:
				"GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-6.1 Sol, Claude Opus 5.5, and Claude Sonnet 5.5 all landed as new model support this release.",
			changelogSourceId: "cl:agent@v2026.10.4-1#1",
		};
		const result = selectWeakFeatures([shorter, longer]);
		expect(result.kept).toHaveLength(1);
		expect(result.kept[0]?.changelogSourceId).toBe("cl:agent@v2026.10.4-1#1");
	});

	test("caps at `cap`, ranking Breaking > Added > Changed > Fixed > Removed then by anchor text length, and reports the rest as a count", () => {
		const candidates: WeakFeatureInput[] = [
			{ title: "a fixed thing", anchorText: "a fixed thing", changelogSourceId: "f0", section: "Fixed" },
			{
				title: "a somewhat longer added thing here",
				anchorText: "a somewhat longer added thing here",
				changelogSourceId: "a0",
				section: "Added",
			},
			{
				title: "a breaking change of some kind",
				anchorText: "a breaking change of some kind",
				changelogSourceId: "b0",
				section: "Breaking Changes",
			},
			{ title: "a changed thing", anchorText: "a changed thing", changelogSourceId: "c0", section: "Changed" },
			{ title: "a removed thing", anchorText: "a removed thing", changelogSourceId: "r0", section: "Removed" },
			{
				title: "an unranked thing with no section at all here",
				anchorText: "an unranked thing with no section at all here",
				changelogSourceId: "u0",
			},
		];
		const result = selectWeakFeatures(candidates, 3);
		expect(result.kept.map((w) => w.changelogSourceId)).toEqual(["b0", "a0", "c0"]);
		expect(result.remainderCount).toBe(3);
	});

	test("defaults the cap to 10", () => {
		const topics = [
			"startup latency for cold boots",
			"pagination cursor off-by-one",
			"caching layer for redundant requests",
			"unused imports across the codebase",
			"error messages on request timeout",
			"null checks in the parser",
			"typo in the help text",
			"color contrast in the settings panel",
			"retry with backoff for flaky calls",
			"memory usage during large uploads",
			"race condition saving config",
			"logging detail for failed auth",
			"keyboard navigation in the file picker",
			"scroll position after a tab switch",
			"clock skew handling in the scheduler",
		];
		const candidates: WeakFeatureInput[] = topics.map((topic, i) => ({
			title: `improve the ${topic}`,
			anchorText: `improve the ${topic}`,
			changelogSourceId: `w${i}`,
		}));
		const result = selectWeakFeatures(candidates);
		expect(result.kept).toHaveLength(10);
		expect(result.remainderCount).toBe(5);
	});
});

describe("templateReleaseOverview: weak feature remainder", () => {
	test("appends a deterministic, uncited 'and N more smaller changes' beat when a remainder is given", () => {
		const input = releaseInput({ weakFeatures: [WEAK_FEATURE], weakFeaturesRemainderCount: 7 });
		const script = templateReleaseOverview(input, computeReleaseThemes(input.stories));
		const also = script.scenes.find((s) => s.kind === "title" && s.title === "Also shipped");
		expect(also).toBeDefined();
		const last = also?.beats?.at(-1);
		expect(last?.text).toBe("And 7 more smaller changes.");
		expect(last?.cites).toEqual([]);
	});

	test("omits the remainder beat when the count is zero", () => {
		const input = releaseInput({ weakFeatures: [WEAK_FEATURE], weakFeaturesRemainderCount: 0 });
		const script = templateReleaseOverview(input, computeReleaseThemes(input.stories));
		const also = script.scenes.find((s) => s.kind === "title" && s.title === "Also shipped");
		expect(also?.beats).toHaveLength(1);
	});
});

function fullReleaseScenes(opts: {
	themeAi?: { cites?: string[]; text?: string };
	themeReels?: { cites?: string[]; text?: string };
	weak?: Array<{ ref: string; quote: string }>;
	syncs?: { text: string; cites?: string[] } | null;
}) {
	return {
		themes: [
			{
				id: "theme:ai",
				name: "AI",
				beats: [
					{
						text: opts.themeAi?.text ?? "The AI package now streams output and retries rate limits.",
						cites: opts.themeAi?.cites ?? ["st:aaaaaaaaaaaa", "st:bbbbbbbbbbbb"],
					},
				],
			},
			{
				id: "theme:reels",
				name: "Reels",
				beats: [
					{
						text: opts.themeReels?.text ?? "Reels can now render a release overview.",
						cites: opts.themeReels?.cites ?? ["st:cccccccccccc"],
					},
				],
			},
		],
		weak: opts.weak ?? [],
		...(opts.syncs === null || opts.syncs === undefined
			? {}
			: { syncs: { text: opts.syncs.text, cites: opts.syncs.cites ?? [] } }),
		outro: { text: "That is this release.", cites: [] },
	};
}

describe("validateReleaseOverview", () => {
	test("cites restricted to st:/cl:/ghr:", () => {
		const input = releaseInput();
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const raw = fullReleaseScenes({ themeAi: { cites: ["h:src/foo.ts#0"] } });
		const result = validateReleaseOverview(raw, { themes, weakFeatures: [], sources, hasSyncs: false }, "release-v1");
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations" && /must start with one of/.test(e.detail))).toBe(true);
	});

	test("rejects a story id cited under a theme it was not assigned to (moved)", () => {
		const input = releaseInput();
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		// "cccccccccccc" belongs to theme:reels, not theme:ai.
		const raw = fullReleaseScenes({ themeAi: { cites: ["st:cccccccccccc"] } });
		const result = validateReleaseOverview(raw, { themes, weakFeatures: [], sources, hasSyncs: false }, "release-v1");
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => /moved/.test(e.detail))).toBe(true);
	});

	test("accepts a valid response and builds theme scenes", () => {
		const input = releaseInput();
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const raw = fullReleaseScenes({});
		const result = validateReleaseOverview(raw, { themes, weakFeatures: [], sources, hasSyncs: false }, "release-v1");
		expect(result.errors).toEqual([]);
		expect(result.script?.scenes.map((s) => s.section)).toEqual(["theme", "theme", "outro"]);
	});

	test("requires a syncs sentence when syncs exist", () => {
		const input = releaseInput({ syncs: [{ title: "sync upstream through v0.99.2", commitCount: 365 }] });
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const withoutSyncs = fullReleaseScenes({ syncs: null });
		const missing = validateReleaseOverview(
			withoutSyncs,
			{ themes, weakFeatures: [], sources, hasSyncs: true },
			"release-v1",
		);
		expect(missing.errors.some((e) => e.path === "syncs")).toBe(true);

		const withSyncs = fullReleaseScenes({
			syncs: { text: "This release also carries an upstream sync.", cites: [] },
		});
		const ok = validateReleaseOverview(
			withSyncs,
			{ themes, weakFeatures: [], sources, hasSyncs: true },
			"release-v1",
		);
		expect(ok.errors).toEqual([]);
		expect(ok.script?.scenes.some((s) => s.section === "overview")).toBe(true);
	});

	test("the model never writes a weak feature's title; it only supplies ref + quote, and the pipeline renders the title", () => {
		const input = releaseInput({ weakFeatures: [WEAK_FEATURE] });
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const ref = weakFeatureRef(0);

		const grounded = fullReleaseScenes({ weak: [{ ref, quote: "tweak the profile grid spacing" }] });
		const accepted = validateReleaseOverview(
			grounded,
			{ themes, weakFeatures: input.weakFeatures, sources, hasSyncs: false },
			"release-v1",
		);
		expect(accepted.errors).toEqual([]);
		const weakScene = accepted.script?.scenes.find((s) => s.section === "overview");
		// The pipeline wrote the beat text itself: it narrates the full anchor text as one sentence, never
		// model prose and never the short, possibly-ellipsis-truncated display title.
		expect(weakScene?.beats?.[0]).toEqual({ text: WEAK_FEATURE_NARRATION, cites: [WEAK_FEATURE.changelogSourceId] });
	});

	test("appends a deterministic, uncited remainder beat after the model's grounded weak mentions", () => {
		const input = releaseInput({ weakFeatures: [WEAK_FEATURE], weakFeaturesRemainderCount: 4 });
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const ref = weakFeatureRef(0);
		const grounded = fullReleaseScenes({ weak: [{ ref, quote: "tweak the profile grid spacing" }] });
		const accepted = validateReleaseOverview(
			grounded,
			{ themes, weakFeatures: input.weakFeatures, weakFeaturesRemainderCount: 4, sources, hasSyncs: false },
			"release-v1",
		);
		expect(accepted.errors).toEqual([]);
		const weakScene = accepted.script?.scenes.find((s) => s.section === "overview");
		expect(weakScene?.beats).toHaveLength(2);
		expect(weakScene?.beats?.[1]).toEqual({ text: "And 4 more smaller changes.", cites: [] });
	});

	test("rejects a weak mention whose quote is not grounded in its own anchor text", () => {
		const input = releaseInput({ weakFeatures: [WEAK_FEATURE] });
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const ref = weakFeatureRef(0);
		const raw = fullReleaseScenes({ weak: [{ ref, quote: "something not in the anchor text" }] });
		const result = validateReleaseOverview(
			raw,
			{ themes, weakFeatures: input.weakFeatures, sources, hasSyncs: false },
			"release-v1",
		);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.path === `weak[${ref}]` && /anchor text/.test(e.detail))).toBe(true);
	});

	test("rejects a response that restates a title instead of using the given ref", () => {
		const input = releaseInput({ weakFeatures: [WEAK_FEATURE] });
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const raw = fullReleaseScenes({
			weak: [
				{ ref: WEAK_FEATURE.title, quote: "tweak the profile grid spacing" } as unknown as {
					ref: string;
					quote: string;
				},
			],
		});
		const result = validateReleaseOverview(
			raw,
			{ themes, weakFeatures: input.weakFeatures, sources, hasSyncs: false },
			"release-v1",
		);
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => /unknown weak feature ref/.test(e.detail))).toBe(true);
		expect(result.errors.some((e) => /missing a mention/.test(e.detail))).toBe(true);
	});

	test("tolerates a quote that drops markdown punctuation present in the anchor text (real-model finding)", () => {
		const markdownFeature: WeakFeatureInput = {
			title: "mom's credentials path",
			anchorText:
				"mom's Anthropic credentials now live at `~/.draht/mom/auth.json` instead of `~/.pi/mom/auth.json`",
			changelogSourceId: "cl:ai@2026.10.4-1#9",
		};
		const input = releaseInput({ weakFeatures: [markdownFeature] });
		const themes = computeReleaseThemes(input.stories);
		const sources = buildReleaseSourceRegistry(input);
		const ref = weakFeatureRef(0);
		// The model quoted the same words but, as real runs showed, sometimes drops the backticks.
		const raw = fullReleaseScenes({
			weak: [{ ref, quote: "mom's Anthropic credentials now live at ~/.draht/mom/auth.json" }],
		});
		const result = validateReleaseOverview(
			raw,
			{ themes, weakFeatures: input.weakFeatures, sources, hasSyncs: false },
			"release-v1",
		);
		expect(result.errors).toEqual([]);
	});

	// Regression for a real paid render (release-v2026.10.4-1): the "Also shipped" scene narrated weak
	// features as their ellipsis-truncated short titles, read back-to-back with no terminal punctuation,
	// and backticks were spoken verbatim.
	describe("regression: weak feature narration is a complete, markdown-free sentence (release-v2026.10.4-1)", () => {
		const momCredentials: WeakFeatureInput = {
			title: "mom's Anthropic credentials now live at `~/.draht/mom/auth.json` instead of…",
			anchorText:
				"mom's Anthropic credentials now live at `~/.draht/mom/auth.json` instead of `~/.pi/mom/auth.json`",
			changelogSourceId: "cl:mom@v2026.10.4-1#8",
		};
		const nativeClipboard: WeakFeatureInput = {
			title: "native clipboard module, replacing the `@mariozechner/clipboard` dependency",
			anchorText: "native clipboard module, replacing the `@mariozechner/clipboard` dependency",
			changelogSourceId: "cl:agent@v2026.10.4-1#7",
		};

		test("the template writer narrates each beat as its own capitalized, period-terminated, backtick-free sentence", () => {
			const input = releaseInput({ weakFeatures: [momCredentials, nativeClipboard] });
			const script = templateReleaseOverview(input, computeReleaseThemes(input.stories));
			const also = script.scenes.find((s) => s.kind === "title" && s.title === "Also shipped");
			expect(also?.beats?.map((b) => b.text)).toEqual([
				"Mom's Anthropic credentials now live at ~/.draht/mom/auth.json instead of ~/.pi/mom/auth.json.",
				"Native clipboard module, replacing the @mariozechner/clipboard dependency.",
			]);
			// No beat carries a display-title truncation ellipsis into narration.
			expect(also?.beats?.every((b) => !b.text.includes("…"))).toBe(true);
			// Every beat is its own complete sentence, so concatenated narration never runs two beats together.
			expect(also?.narration).toBe(
				"Mom's Anthropic credentials now live at ~/.draht/mom/auth.json instead of ~/.pi/mom/auth.json. Native clipboard module, replacing the @mariozechner/clipboard dependency.",
			);
		});

		test("the LLM-validated writer renders the same full-text narration, not the model's words", () => {
			const input = releaseInput({ weakFeatures: [momCredentials] });
			const themes = computeReleaseThemes(input.stories);
			const sources = buildReleaseSourceRegistry(input);
			const ref = weakFeatureRef(0);
			const raw = fullReleaseScenes({
				weak: [{ ref, quote: "mom's Anthropic credentials now live at" }],
			});
			const result = validateReleaseOverview(
				raw,
				{ themes, weakFeatures: input.weakFeatures, sources, hasSyncs: false },
				"release-v1",
			);
			expect(result.errors).toEqual([]);
			const weakScene = result.script?.scenes.find((s) => s.section === "overview");
			expect(weakScene?.beats?.[0]?.text).toBe(
				"Mom's Anthropic credentials now live at ~/.draht/mom/auth.json instead of ~/.pi/mom/auth.json.",
			);
		});

		test("a too-long anchor text is shortened at its first clause boundary, never with an ellipsis", () => {
			const longAnchor: WeakFeatureInput = {
				title: "x",
				anchorText: `This weak feature already fits in one short sentence. ${"Extra trailing detail ".repeat(20)}that would push the whole entry well past the beat cap if it were kept.`,
				changelogSourceId: "cl:x@v1#0",
			};
			expect(longAnchor.anchorText.length).toBeGreaterThan(280);
			const input = releaseInput({ weakFeatures: [longAnchor] });
			const script = templateReleaseOverview(input, computeReleaseThemes(input.stories));
			const also = script.scenes.find((s) => s.kind === "title" && s.title === "Also shipped");
			const text = also?.beats?.[0]?.text ?? "";
			expect(text).toBe("This weak feature already fits in one short sentence.");
			expect(text.includes("…")).toBe(false);
			expect(text.length).toBeLessThanOrEqual(280);
		});

		test("validateBeat rejects narration carrying a truncation ellipsis even from the model itself", () => {
			const input = releaseInput();
			const themes = computeReleaseThemes(input.stories);
			const sources = buildReleaseSourceRegistry(input);
			const raw = fullReleaseScenes({ themeAi: { text: "Streams model output and retries rate limits…" } });
			const result = validateReleaseOverview(
				raw,
				{ themes, weakFeatures: [], sources, hasSyncs: false },
				"release-v1",
			);
			expect(result.script).toBeUndefined();
			expect(result.errors.some((e) => e.rule === "prose" && /ellipsis/.test(e.detail))).toBe(true);
		});
	});
});

describe("parseReleaseOverviewResponse", () => {
	test("strips a markdown code fence and parses the shape", () => {
		const raw = `\`\`\`json\n${JSON.stringify(fullReleaseScenes({}))}\n\`\`\``;
		const parsed = parseReleaseOverviewResponse(raw);
		expect(parsed.themes).toHaveLength(2);
		expect(parsed.outro.text).toBe("That is this release.");
	});
});

describe("writeReleaseOverview", () => {
	test("tiny releases are refused without calling the model", async () => {
		const queue = queueCompleter([]);
		const result = await writeReleaseOverview(releaseInput({ tiny: true }), queue.complete, new CostMeter(100));
		expect(result).toEqual({ ok: false, reason: "tiny" });
		expect(queue.calls).toBe(0);
	});

	test("valid on the first try", async () => {
		const input = releaseInput();
		const queue = queueCompleter([{ text: JSON.stringify(fullReleaseScenes({})) }]);
		const result = await writeReleaseOverview(input, queue.complete, new CostMeter(100));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.writer).toBe("llm");
			expect(result.repaired).toBe(false);
		}
		expect(queue.calls).toBe(1);
	});

	test("invalid then repaired", async () => {
		const input = releaseInput();
		const bad = fullReleaseScenes({ themeAi: { cites: ["st:cccccccccccc"] } });
		const good = fullReleaseScenes({});
		const queue = queueCompleter([{ text: JSON.stringify(bad) }, { text: JSON.stringify(good) }]);
		const result = await writeReleaseOverview(input, queue.complete, new CostMeter(100));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.writer).toBe("llm");
			expect(result.repaired).toBe(true);
		}
		expect(queue.calls).toBe(2);
	});

	test("falls back to the template writer when the model is unparseable twice", async () => {
		const input = releaseInput();
		const queue = queueCompleter([{ text: "not json" }, { text: "still not json" }]);
		const fallbacks: string[] = [];
		const result = await writeReleaseOverview(input, queue.complete, new CostMeter(100), {
			onFallback: (r) => fallbacks.push(r),
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.writer).toBe("template");
			expect(result.script.scenes.some((s) => s.section === "theme")).toBe(true);
		}
		expect(fallbacks).toHaveLength(1);
	});

	test("the template fallback still mentions weak features and syncs", async () => {
		const input = releaseInput({
			weakFeatures: [WEAK_FEATURE],
			syncs: [{ title: "sync upstream", commitCount: 10 }],
		});
		const queue = queueCompleter([{ text: "not json" }, { text: "not json" }]);
		const result = await writeReleaseOverview(input, queue.complete, new CostMeter(100));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.writer).toBe("template");
			const weakScene = result.script.scenes.find((s) => s.kind === "title" && s.title === "Also shipped");
			expect(weakScene?.beats?.some((b) => b.text === WEAK_FEATURE_NARRATION)).toBe(true);
			const syncScene = result.script.scenes.find((s) => s.kind === "title" && s.title === "From upstream");
			expect(syncScene).toBeDefined();
		}
	});

	test("records input+output tokens into the CostMeter after a call", async () => {
		const input = releaseInput();
		const queue = queueCompleter([
			{ text: JSON.stringify(fullReleaseScenes({})), usage: { input: 100, output: 50, costUsd: 0 } },
		]);
		const meter = new CostMeter(100, 1_000);
		await writeReleaseOverview(input, queue.complete, meter);
		expect(meter.spentTokenAmount).toBe(150);
	});

	test("skips the repair call and falls back to the template when the token budget is exhausted after the first call", async () => {
		const input = releaseInput();
		const bad = fullReleaseScenes({ themeAi: { cites: ["st:cccccccccccc"] } });
		const queue = queueCompleter([{ text: JSON.stringify(bad), usage: { input: 100, output: 50, costUsd: 0 } }]);
		const meter = new CostMeter(100, 150);
		const fallbacks: string[] = [];
		const result = await writeReleaseOverview(input, queue.complete, meter, { onFallback: (r) => fallbacks.push(r) });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.writer).toBe("template");
		expect(queue.calls).toBe(1);
		expect(fallbacks).toEqual(["cost cap reached before the repair call"]);
	});

	test("a truncated-looking repair response still gets a 'be shorter' prompt, not the generic error dump", async () => {
		// Second call's prompt is inspected via a custom completer instead of the queue helper.
		const prompts: string[] = [];
		const good = fullReleaseScenes({});
		const complete: ModelCompleter = async (req) => {
			prompts.push(req.prompt);
			if (prompts.length === 1) return { text: '{"themes": [ { "incomplete' }; // unbalanced -> looks truncated
			return { text: JSON.stringify(good) };
		};
		const result = await writeReleaseOverview(releaseInput(), complete, new CostMeter(100));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.writer).toBe("llm");
		expect(prompts[1]).toMatch(/cut off/);
		expect(prompts[1]).not.toMatch(/error list/i);
	});
});

describe("looksTruncated", () => {
	test("flags an unterminated string and unbalanced braces", () => {
		expect(looksTruncated('{"a": "b')).toBe(true);
		expect(looksTruncated('{"a": [1, 2')).toBe(true);
	});

	test("does not flag well-formed (even if semantically wrong) JSON", () => {
		expect(looksTruncated('{"a": "b"}')).toBe(false);
		expect(looksTruncated("not json but balanced")).toBe(false);
	});
});

// --- sync recap writer -----------------------------------------------------------------------

function changelogEntry(
	i: number,
	pkg: string,
	section: RecapChangelogInput["section"] = "Fixed",
): RecapChangelogInput {
	return {
		text: `change number ${i} in ${pkg}, with a \`flag${i}\` detail`,
		sourceId: `cl:${pkg}@0.99.2#${i}`,
		pkg,
		section,
	};
}

const RECAP_INPUT: SyncRecapInput = {
	title: "sync upstream through v0.99.2",
	id: "dddddddddddd",
	commits: [
		{ sha12: "111111111111", subject: "feat(ai): add thinking budget" },
		{ sha12: "222222222222", subject: "fix(cli): correct flag parsing" },
	],
	changelogEntries: [changelogEntry(0, "ai", "Added"), changelogEntry(1, "cli", "Fixed")],
	versionRange: "v0.83.0..v0.99.2",
};

describe("computeRecapThemes", () => {
	test("groups by package only; commits never define a theme", () => {
		const { themes, overflow } = computeRecapThemes(RECAP_INPUT);
		expect(overflow).toBeUndefined();
		expect(themes).toEqual([
			{ id: "theme:ai", name: "ai", sourceIds: ["cl:ai@0.99.2#0"], overflowCount: 0 },
			{ id: "theme:cli", name: "cli", sourceIds: ["cl:cli@0.99.2#1"], overflowCount: 0 },
		]);
	});

	test("condenses a package's entries to the top N by significance, counting the rest as overflow", () => {
		const entries = [
			...Array.from({ length: 12 }, (_, i) => changelogEntry(i, "ai", "Fixed")),
			changelogEntry(100, "ai", "Breaking Changes"),
		];
		const { themes } = computeRecapThemes({ ...RECAP_INPUT, changelogEntries: entries });
		const aiTheme = themes.find((t) => t.id === "theme:ai");
		expect(aiTheme?.sourceIds).toHaveLength(8);
		// The lone "Breaking Changes" entry outranks every "Fixed" entry, so it must survive condensing.
		expect(aiTheme?.sourceIds).toContain("cl:ai@0.99.2#100");
		expect(aiTheme?.overflowCount).toBe(5);
	});

	test("caps at MAX_RECAP_THEMES package groups, summarizing the rest as a deterministic overflow count", () => {
		const entries = Array.from({ length: 7 }, (_, i) => changelogEntry(i, `pkg${i}`, "Fixed"));
		const { themes, overflow } = computeRecapThemes({ ...RECAP_INPUT, changelogEntries: entries });
		expect(themes).toHaveLength(4);
		expect(overflow).toEqual({ themeCount: 3, entryCount: 3 });
	});
});

describe("selectRecapCommits", () => {
	test("ranks feature-shaped subjects first, then longer subjects, and caps the count", () => {
		const commits: RecapCommitInput[] = [
			{ sha12: "aaaaaaaaaaaa", subject: "chore: bump deps" },
			{ sha12: "bbbbbbbbbbbb", subject: "feat(ai): add a very descriptive thinking budget feature" },
			{ sha12: "cccccccccccc", subject: "fix: typo" },
		];
		const selected = selectRecapCommits(commits, 2);
		expect(selected).toHaveLength(2);
		expect(selected[0]?.sha12).toBe("bbbbbbbbbbbb");
	});
});

describe("estimateRecapMaxTokens", () => {
	test("scales with the condensed theme/entry count and stays within bounds", () => {
		const { themes } = computeRecapThemes(RECAP_INPUT);
		const small = estimateRecapMaxTokens(themes, 2);
		const bigThemes = Array.from({ length: 4 }, (_, i) => ({
			id: `theme:pkg${i}`,
			name: `pkg${i}`,
			sourceIds: Array.from({ length: 8 }, (_, j) => `cl:pkg${i}@1#${j}`),
			overflowCount: 0,
		}));
		const big = estimateRecapMaxTokens(bigThemes, 30);
		expect(big).toBeGreaterThan(small);
		expect(big).toBeLessThanOrEqual(6_000);
	});
});

function fullRecapScenes(opts: {
	themeAi?: { cites?: string[]; text?: string };
	themeCli?: { cites?: string[]; text?: string };
	keyMoment?: { text: string; cites: string[] } | null;
}) {
	return {
		themes: [
			{
				id: "theme:ai",
				name: "AI",
				beats: [
					{
						text: opts.themeAi?.text ?? "Models can now stop thinking after a budget is used up.",
						cites: opts.themeAi?.cites ?? ["cl:ai@0.99.2#0"],
					},
				],
			},
			{
				id: "theme:cli",
				name: "CLI",
				beats: [
					{
						text: opts.themeCli?.text ?? "A flag-parsing bug in the CLI is fixed.",
						cites: opts.themeCli?.cites ?? ["cl:cli@0.99.2#1"],
					},
				],
			},
		],
		...(opts.keyMoment === null ? {} : { keyMoment: opts.keyMoment }),
		outro: { text: "That is what came in from upstream.", cites: [] },
	};
}

function recapThemes() {
	return computeRecapThemes(RECAP_INPUT).themes;
}

function recapSources() {
	const themes = recapThemes();
	return buildRecapSourceRegistry(RECAP_INPUT, themes, selectRecapCommits(RECAP_INPUT.commits));
}

describe("validateSyncRecap", () => {
	test("groups by package and scope, and the moved-cite rule applies across themes", () => {
		const themes = recapThemes();
		const sources = recapSources();
		const raw = fullRecapScenes({ themeAi: { cites: ["cl:cli@0.99.2#1"] } });
		const result = validateSyncRecap(raw, { themes, sources }, "recap-ddd");
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => /moved/.test(e.detail))).toBe(true);
	});

	test("a commit (c:) cite is always 'moved' inside a theme, since themes never contain commit ids", () => {
		const themes = recapThemes();
		const sources = buildRecapSourceRegistry(RECAP_INPUT, themes, selectRecapCommits(RECAP_INPUT.commits));
		const raw = fullRecapScenes({ themeAi: { cites: ["c:111111111111"] } });
		const result = validateSyncRecap(raw, { themes, sources }, "recap-ddd");
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => /moved/.test(e.detail))).toBe(true);
	});

	test("rejects an uncited claim", () => {
		const themes = recapThemes();
		const sources = recapSources();
		const raw = fullRecapScenes({ themeAi: { cites: [] } });
		const result = validateSyncRecap(raw, { themes, sources }, "recap-ddd");
		expect(result.script).toBeUndefined();
		expect(result.errors.some((e) => e.rule === "citations" && /at least one cite/.test(e.detail))).toBe(true);
	});

	test("accepts a valid response with at most one key moment", () => {
		const themes = recapThemes();
		const sources = recapSources();
		const raw = fullRecapScenes({
			keyMoment: { text: "One commit added the thinking budget flag.", cites: ["c:111111111111"] },
		});
		const result = validateSyncRecap(raw, { themes, sources }, "recap-ddd");
		expect(result.errors).toEqual([]);
		expect(result.script?.scenes.map((s) => s.section)).toEqual(["theme", "theme", "code", "outro"]);
	});

	test("rejects a key moment that cites more than one commit", () => {
		const themes = recapThemes();
		const sources = recapSources();
		const raw = fullRecapScenes({
			keyMoment: { text: "Two commits did this.", cites: ["c:111111111111", "c:222222222222"] },
		});
		const result = validateSyncRecap(raw, { themes, sources }, "recap-ddd");
		expect(result.errors.some((e) => e.path === "keyMoment")).toBe(true);
	});

	test("rejects a st: cite, which is never allowed in a recap", () => {
		const themes = recapThemes();
		const sources = recapSources();
		const raw = fullRecapScenes({ themeAi: { cites: ["st:aaaaaaaaaaaa"] } });
		const result = validateSyncRecap(raw, { themes, sources }, "recap-ddd");
		expect(result.errors.some((e) => /must start with one of/.test(e.detail))).toBe(true);
	});

	test("appends a deterministic overflow scene when package groups were condensed away", () => {
		const entries = Array.from({ length: 7 }, (_, i) => changelogEntry(i, `pkg${i}`, "Fixed"));
		const { themes, overflow } = computeRecapThemes({ ...RECAP_INPUT, changelogEntries: entries });
		const sources = buildRecapSourceRegistry(
			{ ...RECAP_INPUT, changelogEntries: entries },
			themes,
			selectRecapCommits(RECAP_INPUT.commits),
		);
		const raw = {
			themes: themes.map((t) => ({
				id: t.id,
				name: t.name,
				beats: [{ text: `${t.name} update.`, cites: t.sourceIds }],
			})),
			outro: { text: "That is what came in from upstream.", cites: [] },
		};
		const result = validateSyncRecap(raw, { themes, overflow, sources }, "recap-ddd");
		expect(result.errors).toEqual([]);
		const overflowScene = result.script?.scenes.find((s) => s.kind === "title" && s.title === "More from upstream");
		expect(overflowScene?.beats?.[0]?.text).toMatch(/3 more area.*3 more change/);
	});
});

describe("parseRecapResponse", () => {
	test("strips a markdown code fence and parses the shape", () => {
		const raw = `\`\`\`json\n${JSON.stringify(fullRecapScenes({}))}\n\`\`\``;
		const parsed = parseRecapResponse(raw);
		expect(parsed.themes).toHaveLength(2);
		expect(parsed.outro.text).toBe("That is what came in from upstream.");
	});
});

describe("writeSyncRecap", () => {
	test("valid on the first try", async () => {
		const queue = queueCompleter([{ text: JSON.stringify(fullRecapScenes({})) }]);
		const result = await writeSyncRecap(RECAP_INPUT, queue.complete, new CostMeter(100));
		expect(result.writer).toBe("llm");
		expect(result.repaired).toBe(false);
		expect(queue.calls).toBe(1);
	});

	test("invalid then repaired", async () => {
		const bad = fullRecapScenes({ themeAi: { cites: [] } });
		const good = fullRecapScenes({});
		const queue = queueCompleter([{ text: JSON.stringify(bad) }, { text: JSON.stringify(good) }]);
		const result = await writeSyncRecap(RECAP_INPUT, queue.complete, new CostMeter(100));
		expect(result.writer).toBe("llm");
		expect(result.repaired).toBe(true);
		expect(queue.calls).toBe(2);
	});

	test("the template fallback works and groups by theme, including overflow", async () => {
		const entries = Array.from({ length: 7 }, (_, i) => changelogEntry(i, `pkg${i}`, "Fixed"));
		const input = { ...RECAP_INPUT, changelogEntries: entries };
		const queue = queueCompleter([{ text: "not json" }, { text: "not json" }]);
		const fallbacks: string[] = [];
		const result = await writeSyncRecap(input, queue.complete, new CostMeter(100), {
			onFallback: (r) => fallbacks.push(r),
		});
		expect(result.writer).toBe("template");
		expect(result.script.scenes.filter((s) => s.section === "theme")).toHaveLength(4);
		expect(result.script.scenes.some((s) => s.kind === "title" && s.title === "More from upstream")).toBe(true);
		expect(fallbacks).toHaveLength(1);
	});

	test("records input+output tokens into the CostMeter after a call", async () => {
		const queue = queueCompleter([
			{ text: JSON.stringify(fullRecapScenes({})), usage: { input: 200, output: 80, costUsd: 0 } },
		]);
		const meter = new CostMeter(100, 1_000);
		await writeSyncRecap(RECAP_INPUT, queue.complete, meter);
		expect(meter.spentTokenAmount).toBe(280);
	});

	test("skips the repair call and falls back to the template when the token budget is exhausted after the first call", async () => {
		const bad = fullRecapScenes({ themeAi: { cites: [] } });
		const queue = queueCompleter([{ text: JSON.stringify(bad), usage: { input: 200, output: 80, costUsd: 0 } }]);
		const meter = new CostMeter(100, 280);
		const fallbacks: string[] = [];
		const result = await writeSyncRecap(RECAP_INPUT, queue.complete, meter, { onFallback: (r) => fallbacks.push(r) });
		expect(result.writer).toBe("template");
		expect(queue.calls).toBe(1);
		expect(fallbacks).toEqual(["cost cap reached before the repair call"]);
	});

	test("a truncated first response triggers a 'be shorter' repair with a larger token budget, not parse-garbage handling", async () => {
		const prompts: Array<{ prompt: string; maxTokens: number }> = [];
		const good = fullRecapScenes({});
		const complete: ModelCompleter = async (req) => {
			prompts.push({ prompt: req.prompt, maxTokens: req.maxTokens });
			if (prompts.length === 1)
				return { text: '{"themes": [ {"id": "theme:ai", "name": "AI", "beats": [ {"text": "cut off here' };
			return { text: JSON.stringify(good) };
		};
		const result = await writeSyncRecap(RECAP_INPUT, complete, new CostMeter(100));
		expect(result.writer).toBe("llm");
		expect(prompts[1]?.prompt).toMatch(/cut off/);
		expect(prompts[1]?.maxTokens).toBeGreaterThan(prompts[0]?.maxTokens ?? 0);
	});
});
