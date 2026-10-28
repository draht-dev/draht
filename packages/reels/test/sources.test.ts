import { describe, expect, test } from "bun:test";
import {
	cleanProse,
	commitSourceId,
	createSourceRegistry,
	getSource,
	isSourceAvailable,
	normalizeForQuote,
	proseViolatesDenyPatterns,
	quoteHasValidLength,
	quoteIsWellFormed,
	quoteOccursIn,
	quoteOverlapsBeat,
	toPublicSources,
} from "../src/sources.ts";

describe("source id builders", () => {
	test("commitSourceId rejects a sha that is not 12 lowercase hex chars", () => {
		expect(() => commitSourceId("ABCDEF123456")).toThrow();
		expect(() => commitSourceId("short")).toThrow();
		expect(commitSourceId("abcdef123456")).toBe("c:abcdef123456");
	});
});

describe("createSourceRegistry / getSource / isSourceAvailable", () => {
	const registry = createSourceRegistry([
		{ id: "c:abcdef123456", kind: "commit", label: "feat: add thing", text: "feat: add thing\n\nBecause X." },
		{ id: "doc:README.md#intro", kind: "doc", label: "README intro", text: "[large doc omitted]", included: false },
	]);

	test("a registered, included source is available and fetchable", () => {
		expect(isSourceAvailable(registry, "c:abcdef123456")).toBe(true);
		expect(getSource(registry, "c:abcdef123456")?.label).toBe("feat: add thing");
	});

	test("a cite to a truncated source is not available even though the record exists", () => {
		expect(getSource(registry, "doc:README.md#intro")).toBeDefined();
		expect(isSourceAvailable(registry, "doc:README.md#intro")).toBe(false);
	});

	test("a cite to an unknown source is not available", () => {
		expect(isSourceAvailable(registry, "c:000000000000")).toBe(false);
		expect(getSource(registry, "c:000000000000")).toBeUndefined();
	});

	test("toPublicSources drops truncated sources and strips text", () => {
		const published = toPublicSources(registry);
		expect(published).toEqual([{ id: "c:abcdef123456", kind: "commit", label: "feat: add thing" }]);
	});
});

describe("normalizeForQuote / quoteOccursIn", () => {
	test("normalization collapses whitespace and lowercases", () => {
		expect(normalizeForQuote("  Hello   World\n")).toBe("hello world");
	});

	test("a quote matches after whitespace/case normalization", () => {
		expect(quoteOccursIn("hello   WORLD", "Some text.\nHello world. More text.")).toBe(true);
	});

	test("a quote that is not present in the source is rejected", () => {
		expect(quoteOccursIn("this was never said", "Some unrelated source text.")).toBe(false);
	});

	test("an empty quote never matches", () => {
		expect(quoteOccursIn("   ", "anything")).toBe(false);
	});
});

describe("quoteHasValidLength / quoteOverlapsBeat / quoteIsWellFormed", () => {
	test("a quote under 4 words is rejected, even if it occurs in the source", () => {
		expect(quoteHasValidLength("the")).toBe(false);
		expect(quoteIsWellFormed("the", "the fix was needed because the index was missing")).toBe(false);
	});

	test("a quote over 25 words is rejected", () => {
		const tooLong = Array.from({ length: 26 }, (_, i) => `word${i}`).join(" ");
		expect(quoteHasValidLength(tooLong)).toBe(false);
	});

	test("a 4-25 word prose quote is valid length", () => {
		expect(quoteHasValidLength("performance degraded under load")).toBe(true);
	});

	test("a code-like quote under 4 words is valid if it is at least 20 characters", () => {
		expect(quoteHasValidLength("resolveCodeRef(ref1)")).toBe(true);
		expect(quoteHasValidLength("a.b()")).toBe(false);
	});

	test("a quote sharing a content word with the beat text overlaps", () => {
		expect(quoteOverlapsBeat("performance degraded under load", "It was slow because performance dropped.")).toBe(
			true,
		);
	});

	test("a quote sharing no content word with the beat text does not overlap", () => {
		expect(quoteOverlapsBeat("the weather was nice that day", "It was slow because of load.")).toBe(false);
	});

	test("a beat's code identifier occurring verbatim in the quote counts as overlap", () => {
		expect(
			quoteOverlapsBeat("the function resolveCodeRef is called here", "It calls resolveCodeRef internally."),
		).toBe(true);
	});

	test("quoteIsWellFormed requires both length and overlap", () => {
		expect(quoteIsWellFormed("performance degraded under load", "It was slow under load.")).toBe(true);
		expect(quoteIsWellFormed("the weather was nice today", "It was slow under load.")).toBe(false);
	});
});

describe("cleanProse / proseViolatesDenyPatterns", () => {
	test("cleanProse redacts secrets and strips URLs", () => {
		const cleaned = cleanProse('api_key = "supersecretvalue123" see https://example.com/x for details');
		expect(cleaned).toContain("[redacted]");
		expect(cleaned).not.toContain("https://");
	});

	test("proseViolatesDenyPatterns matches any configured pattern", () => {
		expect(proseViolatesDenyPatterns("Acme Corp internal project", [/acme corp/i])).toBe(true);
		expect(proseViolatesDenyPatterns("nothing sensitive here", [/acme corp/i])).toBe(false);
		expect(proseViolatesDenyPatterns("anything", undefined)).toBe(false);
	});
});
