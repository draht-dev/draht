---
name: draht
description: GSD workflow engine for coding agents — handgefertigt in Dortmund
colors:
  foundry-ink: "#0e0d0b"
  foundry-ink-2: "#14110d"
  workshop-paper: "#efe7d8"
  weathered-paper: "#c9bfae"
  foxed-page: "#8b8472"
  solder-copper: "#e8c828"
  oxidized-copper: "#b89e1e"
  patina: "oklch(0.68 0.06 175)"
  rule: "rgba(239, 231, 216, 0.14)"
  rule-strong: "rgba(239, 231, 216, 0.28)"
typography:
  display:
    fontFamily: "'Instrument Serif', 'Times New Roman', serif"
    fontSize: "clamp(72px, 16vw, 240px)"
    fontWeight: 300
    lineHeight: 0.88
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "'Instrument Serif', 'Times New Roman', serif"
    fontSize: "clamp(32px, 4vw, 56px)"
    fontWeight: 300
    lineHeight: 1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "'Instrument Serif', 'Times New Roman', serif"
    fontSize: "28px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "'Instrument Sans', ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "0.15em"
rounded:
  none: "0px"
spacing:
  xs: "8px"
  sm: "14px"
  md: "24px"
  lg: "40px"
  xl: "64px"
  section: "clamp(80px, 10vw, 140px)"
components:
  button-primary:
    backgroundColor: "{colors.workshop-paper}"
    textColor: "{colors.foundry-ink}"
    rounded: "{rounded.none}"
    padding: "12px 22px"
  button-primary-hover:
    backgroundColor: "{colors.solder-copper}"
    textColor: "{colors.foundry-ink}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foxed-page}"
    rounded: "{rounded.none}"
    padding: "12px 22px"
  button-ghost-hover:
    backgroundColor: "transparent"
    textColor: "{colors.workshop-paper}"
  install-block:
    backgroundColor: "{colors.foundry-ink-2}"
    textColor: "{colors.workshop-paper}"
    rounded: "{rounded.none}"
    padding: "14px 18px"
  tier-cta:
    backgroundColor: "transparent"
    textColor: "{colors.workshop-paper}"
    rounded: "{rounded.none}"
    padding: "14px 20px"
  tier-cta-featured:
    backgroundColor: "{colors.solder-copper}"
    textColor: "{colors.foundry-ink}"
    rounded: "{rounded.none}"
    padding: "14px 20px"
---

# Design System: draht

## 1. Overview

**Creative North Star: "The Schaltplan"**

This is a PCB wiring diagram translated into a website. Every element earns its place the way a trace earns its routing — by carrying signal. The copper accent is literal: it is solder, the substance that makes connections permanent. The warm dark background is not "dark mode aesthetic" but the inside of a workbench enclosure at night, with instrument light. The Instrument Serif used for display is not editorial flourish but a nod to technical manuals, where italic figures label components and point to tolerances.

The system explicitly rejects: the sleek darkness of Vercel-style SaaS, the minimalist product polish of Linear or Notion used as marketing, DevTool landing pages with floating screenshots and hero metrics, and any pattern identifiable at a glance as "AI-generated developer tool landing." If it looks like the output of a template, it has failed.

**Key Characteristics:**
- Sharp-cornered. Zero border-radius everywhere. Components look machined, not molded.
- Copper is signal, not decoration. It marks interactive elements, active states, accent nodes, and the animated wire layer. Used sparingly on static content.
- Typography mixes at extreme contrast: display at 240px italic serif vs. 11px uppercase monospace label. No intermediate sizes blur the hierarchy.
- Bilingual DE/EN is structural. German phrases ("handgefertigt", "§ 01", "Die Werkbank") are identity markers, not affectation.
- The wire animation layer is the background of the whole page, not decoration inside a component.

## 2. Colors: The Foundry Palette

A warm dark palette derived from the materials of electronics fabrication: scorched metal, solder, workshop paper, and aged copper oxide.

### Primary
- **Solder Copper** (#e8c828): The primary accent. Signal yellow-gold, used on interactive elements, wire animations, copper dot connectors, and the key content accent. Sparingly on static content — its rarity is the point. Converts to OKLCH approximately `oklch(82% 0.165 92)`.
- **Oxidized Copper** (#b89e1e): The dimmer accent. Used for subtle wire traces, stamps, and secondary copper elements. Never a fallback for Solder Copper — it has its own role.

### Secondary
- **Patina** (oklch(0.68 0.06 175)): Muted teal. Used exclusively for success states, green test-pass indicators, and positive terminal output (`t-ok`). Kept in OKLCH in the frontmatter — it uses Display-P3 intent and does not round-trip cleanly to sRGB hex. Approximate hex: #5fa598.

### Neutral
- **Foundry Ink** (#0e0d0b): The page background. Not `#000000` — warm black, tinted toward amber. The faintest brown undertone keeps it from feeling dead.
- **Foundry Ink Variant** (#14110d): Card and terminal backgrounds. One step lighter than the page, creating tonal separation without a border.
- **Workshop Paper** (#efe7d8): Primary text and primary button background. Warm off-white; the color of aged technical documentation.
- **Weathered Paper** (#c9bfae): Secondary text, paragraph body in cards and features. Dimmer than paper, still readable.
- **Foxed Page** (#8b8472): Muted/tertiary text — labels, metadata, ghost button color, footer links at rest.
- **Rule** (rgba(239, 231, 216, 0.14)): Section borders and dividers. Derived from Workshop Paper at low opacity so it reads as a surface boundary without weight.
- **Rule Strong** (rgba(239, 231, 216, 0.28)): Stronger dividers — install block borders, terminal borders, tier borders.

### Named Rules
**The Copper Scarcity Rule.** Solder Copper is for signal, not for color. It appears on: the primary interactive element state (hover), wire traces and animated pulses, copper dot connectors, section numbers, and the hero wordmark period. It does not appear as a background fill on large surfaces, as a text color on body copy, or as a decorative stripe.

**The No-Tint Rule.** No surface uses a color gradient as a background. The single exception is the featured pricing tier, which uses a 5% copper gradient at top to establish priority — not to decorate.

## 3. Typography

**Display Font:** Instrument Serif (with Times New Roman, serif fallback)
**Body Font:** Instrument Sans (with ui-sans-serif, system-ui, sans-serif fallback)
**Label / Mono Font:** Geist Mono (with JetBrains Mono, ui-monospace, monospace fallback)

**Character:** Instrument Serif at display size is italic by default — not for softness but for the precision of a technical drawing label. Geist Mono reads like output: terse, monospaced, always uppercase at label sizes. Instrument Sans bridges the gap: warm enough to read at length, neutral enough not to compete.

### Hierarchy
- **Display** (weight 300, clamp(72px, 16vw, 240px), line-height 0.88, tracking -0.035em, italic): The page hero `draht.` wordmark only. Intentionally oversized — the word fills the viewport. The `.` period is the copper accent.
- **Headline** (weight 300, clamp(32px, 4vw, 56px), line-height 1, tracking -0.02em, italic): Section titles (`§ 01 · Die Werkbank`). The italicized Serif signals "this is a document section", not a UI heading.
- **Title** (weight 400, 28px, line-height 1.2, tracking -0.01em, italic): Card headings (`The right model, every time.`), clause headings, package names. Lighter weight than the headline, still serif italic.
- **Body** (Instrument Sans, weight 400, 15px, line-height 1.55): All paragraph text in cards and feature lists. Color is Weathered Paper (#c9bfae) on dark backgrounds. Max line length 44ch on card content; 42ch on clause blocks.
- **Lede** (Instrument Serif, weight 400, clamp(20px, 2vw, 26px), line-height 1.45): The hero paragraph below the headline. Larger than body, serif, full Workshop Paper color. Max 34ch.
- **Label** (Geist Mono, weight 400, 10-12px, letter-spacing 0.12-0.18em, UPPERCASE): All metadata, section numbers (`§ 01`), package tags (`CORE`), feature numbers (`F/01`), install prompts. The backbone of the information layer.

### Named Rules
**The Serif-is-italic Rule.** Instrument Serif is always italic or weight 300 or both. Upright Instrument Serif at normal weight does not appear. The serif face is a display tool, not a body type.

**The Mono-is-uppercase Rule.** Geist Mono at label sizes (≤12px) is always letter-spaced and uppercase. At code sizes (13px in terminal/install blocks) it is case-sensitive and preserves the code's casing.

## 4. Elevation

Flat. No box shadows. No blur. Depth is conveyed entirely through:

1. **Background tint progression:** Page (`#0e0d0b`) → card/terminal (`#14110d`) → interactive highlight (`rgba(239,231,216,0.02)` on hover)
2. **Border transparency layers:** Rule (14% opacity) for passive dividers, Rule Strong (28% opacity) for active boundaries (install blocks, terminal chrome, tier borders)
3. **The copper connector:** The `.install::before` element — a 12px copper dot with an ink halo and diffuse copper glow — is the only "raised" affordance on the page. It signals "this is a terminal input point."

The animated wire layer creates perceived depth through motion without using shadows or z-axis visual tricks.

### Named Rules
**The No-Shadow Rule.** No `box-shadow` on any element. No `filter: drop-shadow` on HTML elements (only on SVG wire traces as a glow technique). If something needs to feel elevated, change its background tint — never add a shadow.

## 5. Components

All components have `border-radius: 0`. Sharp corners throughout. No exceptions.

### Buttons
- **Shape:** Sharp (0px radius). Components look machined, not rounded.
- **Primary:** Workshop Paper (#efe7d8) background, Foundry Ink (#0e0d0b) text. 12px 22px padding. Border: 1px Workshop Paper.
- **Hover / Focus:** Background and border transition to Solder Copper (#e8c828), text stays Foundry Ink. 0.2s transition.
- **Ghost:** Transparent background, Foxed Page (#8b8472) text, 1px Rule Strong border.
- **Ghost Hover:** Border shifts to Workshop Paper, text shifts to Workshop Paper. Still no background.

### Install Blocks
The primary call-to-action surface on the page. Not a button — a terminal input replica.

- **Background:** Foundry Ink Variant (#14110d)
- **Border:** 1px Rule Strong
- **Connector dot:** 12px copper circle, positioned 6px to the left (outside the block). Halo: `box-shadow: 0 0 0 2px foundry-ink, 0 0 12px copper-glow`. This is the only element on the page that uses glow.
- **Prompt character:** Solder Copper `$`
- **Copy button:** Transparent, 1px Rule Strong border, Foxed Page text. Hover shifts to Solder Copper.

### Terminal
The workbench demo block. Styled to look like a real terminal, not a "terminal UI widget."

- **Chrome:** Foundry Ink Variant background, Rule Strong bottom border, three dark dots (color `#3a332a`), monospace path label in Foxed Page
- **Body:** 20px 22px padding, min-height 320px, white-space pre-wrap lines
- **Color tokens:** prompt (Solder Copper), user input (Workshop Paper), dim output (Foxed Page), ok/success (Patina), key terms (Solder Copper)
- **Cursor:** 8px × 14px Solder Copper block, 1s step-end blink

### Package List
A tabular list — not a card grid. 4-column grid: index, name (with subtitle), description, tag. No card borders, no background per row. Separation through the Rule border at row bottom. Hover shifts row background to `rgba(239,231,216,0.02)` and name color to Solder Copper.

### Pricing Tiers
Three-column grid (single column on mobile). All tiers use Foundry Ink background and Rule Strong outer border. Featured tier only adds: `linear-gradient(180deg, rgba(217,140,70,0.05), transparent 70%)` and a `border: 1px solid solder-copper` badge for "Empfohlen."

### Philosophy Clauses
2-column grid with 2px Rule gaps between cells. Each cell: Foundry Ink background, generous padding (clamp 24-40px). Large italic Instrument Serif numeral (72px) in Solder Copper as the primary visual element. Monospace label (UPPERCASE, foxed-page color) as the subtitle. No card borders — the gap is the border.

### Navbar
- See `Navbar.astro` for current implementation
- Monospace, uppercase, small letter-spacing
- Uses Rule Strong bottom border

### Schaltplan (Wire Layer)
The signature component. A full-page SVG overlay (position: fixed, pointer-events: none, z-index: 1) that draws orthogonal wire traces between key page elements. Traces are copper-colored (0.55 opacity), bus traces slightly heavier (0.75 opacity). Animated pulses travel along the bus (`stroke-dasharray: 18 2000`, WAAPI animation). Nodes are small circles: solid (filled copper) for connection points, pulse (animated opacity) for active routing. Labels in Geist Mono, 9px, uppercase, Foxed Page color.

The wire layer rebuilds on resize and after fonts load. It is aria-hidden and never interactive.

## 6. Do's and Don'ts

### Do:
- **Do** keep `border-radius: 0` on every element. Sharp corners are load-bearing identity.
- **Do** use Solder Copper sparingly — only for signal (interactive states, wire animation, active indicators). Its rarity makes it meaningful.
- **Do** mix typeface registers at extreme scale contrast: 240px italic serif next to 11px uppercase monospace. The gap is the hierarchy.
- **Do** use German section names and bilingual subtitles. "Die Werkbank", "Philosophie", "§ 01" are not decoration — they are identity.
- **Do** use Rule/Rule Strong (opacity-derived borders from Workshop Paper) for all surface boundaries. This keeps borders warm and integrated, never cold or harsh.
- **Do** represent the product honestly. The terminal demo must show real commands, real output format, real behavior. A demo that lies destroys the brand's "receipts before promises" principle.

### Don't:
- **Don't** use Vercel-dark aesthetics: sleek gradient dark backgrounds, glowing floating cards, or color-filled feature icon cards.
- **Don't** use Linear-clean aesthetic: minimalist product-app polish (rounded corners, soft spacing, card grids with icon + heading + text) as marketing.
- **Don't** use typical DevTool landing patterns: floating screenshots, animated feature grids, "10x your productivity" hero copy, hero metrics ("412k tokens saved").
- **Don't** use gradient text (`background-clip: text` + gradient). Single solid color only, always.
- **Don't** use glassmorphism or blur-based surfaces. Forbidden.
- **Don't** add `border-left` or `border-right` as a colored accent stripe. Rewrite with full borders, background tints, or nothing.
- **Don't** add `box-shadow` to HTML elements. The No-Shadow Rule is absolute.
- **Don't** use Solder Copper as a large background fill. It is a point element — a dot, a label, a transition state.
- **Don't** use Instrument Serif upright at normal weight. Serif is italic, weight 300, display-only.
- **Don't** round corners. `border-radius` greater than 0 is prohibited. This includes inputs, buttons, badges, cards, code blocks, and modals.
