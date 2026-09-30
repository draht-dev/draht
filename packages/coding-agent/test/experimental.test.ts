import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.DRAHT_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.DRAHT_EXPERIMENTAL;
		} else {
			process.env.DRAHT_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when DRAHT_EXPERIMENTAL is unset", () => {
		delete process.env.DRAHT_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when DRAHT_EXPERIMENTAL is empty", () => {
		process.env.DRAHT_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when DRAHT_EXPERIMENTAL is set to 1", () => {
		process.env.DRAHT_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when DRAHT_EXPERIMENTAL is set to 0", () => {
		process.env.DRAHT_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when DRAHT_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.DRAHT_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
