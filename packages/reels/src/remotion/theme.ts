/**
 * The draht "Schaltplan" design system, ported from `packages/landing/DESIGN.md`
 * for reel rendering. Every scene imports colors and font stacks from here —
 * no stray hex literals in scene files. See `fonts.ts` for the matching
 * self-hosted `@remotion/fonts` loaders.
 */

export const COLOR = {
	/** Page background. Warm black, not `#000000`. */
	foundryInk: "#0e0d0b",
	/** Card/panel/code/caption surfaces — one step lighter than the page. */
	foundryInk2: "#14110d",
	/** Primary text. */
	workshopPaper: "#efe7d8",
	/** Secondary text. */
	weatheredPaper: "#c9bfae",
	/** Muted/tertiary text and labels. */
	foxedPage: "#8b8472",
	/** The signal accent: current caption word, focused diagram nodes/edges, focused code line marker. Sparingly, never a large fill. */
	solderCopper: "#e8c828",
	/** The dimmer accent. Never a fallback for Solder Copper. */
	oxidizedCopper: "#b89e1e",
	/**
	 * Additions / success. Brightened from the DESIGN.md hex approximation
	 * (#5fa598, ~6.6:1 on Foundry Ink 2) to ~7.9:1 so code-scene diff text at
	 * full strength clears WCAG's 7:1 "enhanced" threshold even against its
	 * own tinted row background (see `code-colors.ts`).
	 */
	patina: "#7fc3b4",
	/**
	 * Deletions. Not in DESIGN.md's palette (which has no "negative" color —
	 * the site has nothing to delete). Chosen as a muted warm rust: the same
	 * oxidation family as Patina (copper verdigris) and Oxidized Copper, but
	 * on iron's reddish side rather than copper's greenish or yellow one, so
	 * it reads as "the other metal", not a foreign red. Kept bright enough
	 * (~8.1:1 on Foundry Ink 2) to clear the same 7:1 threshold as Patina.
	 */
	rust: "#eda488",
	/** Passive section/surface borders. */
	rule: "rgba(239, 231, 216, 0.14)",
	/** Active boundaries: panels, code, caption, focus markers. */
	ruleStrong: "rgba(239, 231, 216, 0.28)",
} as const;

export const FONT = {
	/** Display/headline/title text. Always italic (the Serif-is-italic rule) — there is no upright face loaded. */
	serif: `"Instrument Serif", "Times New Roman", serif`,
	/** Body text and captions. */
	sans: `"Instrument Sans", ui-sans-serif, system-ui, sans-serif`,
	/** Code and uppercase letter-spaced labels. */
	mono: `"Geist Mono", "JetBrains Mono", ui-monospace, monospace`,
} as const;

function hexToRgb(hex: string): [number, number, number] {
	const normalized = hex.replace("#", "");
	const n = Number.parseInt(normalized, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function srgbChannelToLinear(channel: number): number {
	const c = channel / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0..1) of a solid `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(srgbChannelToLinear);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1..21) between two solid `#rrggbb` colors. */
export function contrastRatio(hexA: string, hexB: string): number {
	const a = relativeLuminance(hexA);
	const b = relativeLuminance(hexB);
	const [lighter, darker] = a >= b ? [a, b] : [b, a];
	return (lighter + 0.05) / (darker + 0.05);
}

/** `fgHex` painted at `alpha` (0..1) over solid `bgHex`, flattened to the resulting solid `#rrggbb` color. */
export function blendOver(fgHex: string, bgHex: string, alpha: number): string {
	const fg = hexToRgb(fgHex);
	const bg = hexToRgb(bgHex);
	const mixed = fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i]));
	return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** `hex` as a CSS `rgba(...)` string at `alpha` (0..1), for a translucent fill/border over an unknown background. */
export function hexToRgba(hex: string, alpha: number): string {
	const [r, g, b] = hexToRgb(hex);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
