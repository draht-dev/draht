import geistMono from "../../public/fonts/geist-mono-latin.woff2";
import instrumentSans from "../../public/fonts/instrument-sans-latin.woff2";
import instrumentSerif from "../../public/fonts/instrument-serif-latin.woff2";
import instrumentSerifItalic from "../../public/fonts/instrument-serif-italic-latin.woff2";
import type { FontSpec, SiteConfig } from "./kit/types";

export const site: SiteConfig = {
  origin: "https://draht.dev",
  sitemaps: ["/sitemap-index.xml"],
  exclude: [/^\/404$/],
  cleanTitle: (title) => title.replace(/\s+[—–|-]\s+draht(\.dev| blog)?$/i, "").replace(/^draht\s+[—–-]\s+/i, ""),
  section: (path) => {
    const first = path.split("/")[1];
    if (!first) return "draht";
    return first === "uni" ? "uni" : first;
  },
  publicDir: "../public",
  manifest: "../src/data/og-video.json",
};

// Atelier tokens from src/layouts/Atelier.astro.
export const theme = {
  bg: "#0e0d0b",
  fg: "#efe7d8",
  dim: "#c9bfae",
  soft: "#8b8472",
  rule: "rgba(239, 231, 216, 0.14)",
  ruleStrong: "rgba(239, 231, 216, 0.28)",
  copper: "#e8c828",
  copperDim: "#b89e1e",
  slateBg: "#e8c828",
  slateFg: "#0e0d0b",
  slateFont: "mono" as const,
};

export const fonts = {
  display: { family: "OG Instrument Serif", url: instrumentSerif, weight: "400" },
  displayItalic: { family: "OG Instrument Serif Italic", url: instrumentSerifItalic, weight: "400", style: "italic" },
  sans: { family: "OG Instrument Sans", url: instrumentSans, weight: "400" },
  mono: { family: "OG Geist Mono", url: geistMono, weight: "400" },
} satisfies Record<string, FontSpec>;
