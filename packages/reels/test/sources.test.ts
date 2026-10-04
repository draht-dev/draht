import { describe, expect, test } from "bun:test";
import {
	commitSourceId,
	createSourceRegistry,
	getSource,
	isSourceAvailable,
	normalizeForQuote,
	quoteOccursIn,
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
