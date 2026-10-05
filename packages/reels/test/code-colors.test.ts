import { describe, expect, test } from "bun:test";
import {
	DIFF_TINT_ALPHA,
	FOCUSED_OPACITY,
	lineBackground,
	lineRole,
	lineTextColor,
	UNFOCUSED_OPACITY,
} from "../src/remotion/scenes/code-colors.ts";
import { blendOver, COLOR, contrastRatio } from "../src/remotion/theme.ts";

function rgbaToHex(rgba: string): string {
	const match = /rgba\((\d+), (\d+), (\d+)/.exec(rgba);
	if (!match) throw new Error(`not an rgba() string: ${rgba}`);
	const [, r, g, b] = match;
	return `#${[r, g, b].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Flattens a role's text/background to the solid colors actually composited
 * on screen: a line's own CSS `opacity` blends both its text and its
 * (already-tinted) background over the code panel's Foundry Ink 2.
 */
function renderedContrast(role: Parameters<typeof lineTextColor>[0], opacity: number): number {
	const tint = lineBackground(role);
	const flatBackground = tint ? blendOver(rgbaToHex(tint), COLOR.foundryInk2, DIFF_TINT_ALPHA) : COLOR.foundryInk2;
	const compositedBackground = blendOver(flatBackground, COLOR.foundryInk2, opacity);
	const compositedText = blendOver(lineTextColor(role), COLOR.foundryInk2, opacity);
	return contrastRatio(compositedText, compositedBackground);
}

describe("code line contrast", () => {
	test("lineRole classifies by leading marker", () => {
		expect(lineRole("+added")).toBe("addition");
		expect(lineRole("-removed")).toBe("deletion");
		expect(lineRole(" context")).toBe("context");
	});

	for (const role of ["context", "addition", "deletion"] as const) {
		test(`${role}: focused line text reaches WCAG 7:1 against its own row background`, () => {
			expect(renderedContrast(role, FOCUSED_OPACITY)).toBeGreaterThanOrEqual(7);
		});

		test(`${role}: unfocused (dimmed) line text still reaches WCAG 3:1 against its own row background`, () => {
			expect(renderedContrast(role, UNFOCUSED_OPACITY)).toBeGreaterThanOrEqual(3);
		});
	}

	test("the diff background tint is subtle, not a loud fill", () => {
		expect(DIFF_TINT_ALPHA).toBeLessThanOrEqual(0.12);
	});

	test("unfocused opacity sits in the 0.5-0.6 range the design calls for, not near-zero", () => {
		expect(UNFOCUSED_OPACITY).toBeGreaterThanOrEqual(0.5);
		expect(UNFOCUSED_OPACITY).toBeLessThanOrEqual(0.6);
	});
});
