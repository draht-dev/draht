import { measureText } from "@remotion/layout-utils";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { fonts, theme } from "../site";
import { useFontsReady } from "./fonts";
import type { FontSpec } from "./types";

export const WIDTH = 1200;
export const HEIGHT = 630;
export const FPS = 30;
/** Six seconds: slate lifts, card builds, holds with ambient motion, slate returns. */
export const DURATION = 180;

export type FontKey = keyof typeof fonts;

// ─── Timing ─────────────────────────────────────────────────────────────────

export const expoOut = Easing.bezier(0.16, 1, 0.3, 1);
export const inOut = Easing.bezier(0.76, 0, 0.24, 1);

/** 0 → 1 over `duration` frames from `start`, clamped. */
export function progress(frame: number, start: number, duration: number, easing = expoOut): number {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing,
  });
}

/** A settled spring starting at `delay`. */
export function useSpring(delay: number, durationInFrames = 26, damping = 200): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, durationInFrames, config: { damping } });
}

/** Whole sine periods across the clip, so ambient motion loops seamlessly. */
export function loopWave(frame: number, phase = 0, cycles = 1): number {
  return Math.sin(((frame / DURATION) * cycles + phase) * Math.PI * 2);
}

/** 0 → 1 sawtooth with whole cycles across the clip. */
export function loopPhase(frame: number, cycles = 1, offset = 0): number {
  return (((frame / DURATION) * cycles + offset) % 1 + 1) % 1;
}

// ─── Type ───────────────────────────────────────────────────────────────────

export function fontStyle(font: FontKey): CSSProperties {
  const spec: FontSpec = fonts[font];
  return { fontFamily: spec.family, fontWeight: Number(spec.weight), fontStyle: spec.style ?? "normal" };
}

function textWidth(text: string, font: FontKey, size: number, tracking: number): number {
  const spec: FontSpec = fonts[font];
  return measureText({
    text,
    fontFamily: spec.family,
    fontSize: size,
    fontWeight: spec.weight,
    letterSpacing: `${tracking}px`,
    additionalStyles: { fontStyle: spec.style ?? "normal" },
  }).width;
}

/**
 * Greedy word wrap at the largest size (stepping down to `minSize`) that fits
 * `maxLines`. If even `minSize` overflows, the last line is ellipsised.
 */
export function layoutLines(
  text: string,
  opts: { font: FontKey; maxSize: number; minSize: number; maxWidth: number; maxLines: number; tracking?: number },
): { size: number; lines: string[] } {
  const words = text.split(/\s+/).filter(Boolean);
  const tracking = opts.tracking ?? 0;
  for (let size = opts.maxSize; size >= opts.minSize; size -= 2) {
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (current && textWidth(next, opts.font, size, tracking) > opts.maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
    const widest = Math.max(...lines.map((line) => textWidth(line, opts.font, size, tracking)));
    if (lines.length <= opts.maxLines && widest <= opts.maxWidth) return { size, lines };
  }
  // Fall back: fill maxLines at minSize and ellipsise the remainder.
  const size = opts.minSize;
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && textWidth(next, opts.font, size, tracking) > opts.maxWidth) {
      lines.push(current);
      current = word;
      if (lines.length === opts.maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < opts.maxLines && current) lines.push(current);
  const last = lines.length - 1;
  while (lines[last].length > 1 && textWidth(`${lines[last]}…`, opts.font, size, tracking) > opts.maxWidth) {
    lines[last] = lines[last].slice(0, -1).trimEnd();
  }
  if (lines.join(" ").length < text.length) lines[last] = `${lines[last]}…`;
  return { size, lines };
}

export type RevealKind = "rise" | "fade" | "type" | "none";

export interface LinesProps {
  text: string;
  font: FontKey;
  maxSize: number;
  minSize?: number;
  maxWidth: number;
  maxLines: number;
  color?: string;
  tracking?: number;
  lineHeight?: number;
  delay: number;
  /** Frames between successive lines. */
  stagger?: number;
  reveal?: RevealKind;
  /** Typewriter speed in characters per frame, for reveal="type". */
  rate?: number;
  style?: CSSProperties;
  /** Words to colour with `accentColor`, matched case-insensitively. */
  accentWords?: string[];
  accentColor?: string;
  accentFont?: FontKey;
}

/** Auto-wrapped, auto-fitted text block whose lines reveal one by one. */
export function Lines({
  text,
  font,
  maxSize,
  minSize = Math.round(maxSize * 0.55),
  maxWidth,
  maxLines,
  color = theme.fg,
  tracking = 0,
  lineHeight = 1.04,
  delay,
  stagger = 5,
  reveal = "rise",
  rate = 1.6,
  style,
  accentWords = [],
  accentColor,
  accentFont,
}: LinesProps) {
  const frame = useCurrentFrame();
  const { size, lines } = layoutLines(text, { font, maxSize, minSize, maxWidth, maxLines, tracking });
  const accents = new Set(accentWords.map((word) => word.toLowerCase()));
  let typed = Math.max(0, Math.floor((frame - delay) * rate));

  return (
    <div style={{ ...fontStyle(font), fontSize: size, lineHeight, letterSpacing: tracking, color, ...style }}>
      {lines.map((line, index) => {
        const start = delay + index * stagger;
        let content: ReactNode = line.split(" ").map((word, wordIndex, all) => {
          const bare = word.replace(/[^\p{L}\p{N}-]/gu, "").toLowerCase();
          const accented = accents.has(bare);
          return (
            <span key={wordIndex} style={accented ? { color: accentColor, ...(accentFont ? fontStyle(accentFont) : {}) } : undefined}>
              {word}
              {wordIndex < all.length - 1 ? " " : ""}
            </span>
          );
        });
        let inner: CSSProperties = { display: "block", whiteSpace: "pre" };
        let outer: CSSProperties = { display: "block" };

        if (reveal === "rise") {
          const p = progress(frame, start, 26);
          outer = { ...outer, overflow: "hidden", paddingBottom: size * 0.12, marginBottom: -size * 0.12, paddingRight: size * 0.2, marginRight: -size * 0.2 };
          inner = { ...inner, transform: `translateY(${(1 - p) * 110}%)` };
        } else if (reveal === "fade") {
          const p = progress(frame, start, 22);
          inner = { ...inner, opacity: p, transform: `translateY(${(1 - p) * 12}px)` };
        } else if (reveal === "type") {
          const shown = Math.min(line.length, typed);
          typed -= shown;
          content = (
            <>
              {line.slice(0, shown)}
              <span style={{ opacity: 0 }}>{line.slice(shown)}</span>
            </>
          );
        }

        return (
          <span key={index} style={outer}>
            <span style={inner}>{content}</span>
          </span>
        );
      })}
    </div>
  );
}

/** A single-line label (no wrapping) with a typewriter, fade or rise reveal. */
export function Label({
  text,
  font,
  size,
  color = theme.fg,
  tracking = 0,
  delay,
  reveal = "type",
  rate = 1.6,
  style,
}: {
  text: string;
  font: FontKey;
  size: number;
  color?: string;
  tracking?: number;
  delay: number;
  reveal?: RevealKind;
  rate?: number;
  style?: CSSProperties;
}) {
  return (
    <Lines
      text={text}
      font={font}
      maxSize={size}
      minSize={size}
      maxWidth={100000}
      maxLines={1}
      color={color}
      tracking={tracking}
      lineHeight={1.2}
      delay={delay}
      reveal={reveal}
      rate={rate}
      style={{ whiteSpace: "nowrap", ...style }}
    />
  );
}

/** Integer that counts from `from` to `to`. */
export function useCount(from: number, to: number, delay: number, duration: number): number {
  const frame = useCurrentFrame();
  return Math.round(interpolate(progress(frame, delay, duration, Easing.out(Easing.cubic)), [0, 1], [from, to]));
}

/** A hairline that draws from its left end. */
export function Rule({ width, color, opacity = 1, delay, height = 1, style }: { width: number | string; color: string; opacity?: number; delay: number; height?: number; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const p = progress(frame, delay, 34, inOut);
  return <div style={{ width, height, background: color, opacity, transform: `scaleX(${p})`, transformOrigin: "0 50%", ...style }} />;
}

/** Background grid that drifts exactly one cell per loop. */
export function GridBg({ cell = 64, color, style }: { cell?: number; color: string; style?: CSSProperties }) {
  const frame = useCurrentFrame();
  const drift = (frame / DURATION) * cell;
  return (
    <AbsoluteFill
      style={{
        backgroundImage: `linear-gradient(to right, ${color} 1px, transparent 1px), linear-gradient(to bottom, ${color} 1px, transparent 1px)`,
        backgroundSize: `${cell}px ${cell}px`,
        backgroundPosition: `${-drift}px ${-drift}px`,
        ...style,
      }}
    />
  );
}

// ─── Frame ──────────────────────────────────────────────────────────────────

const SLATE = 18;

/**
 * A brand slate that lifts off at the start and slides back up at the end,
 * so the first and last frames match and the clip loops without a seam.
 * Frame 0 doubles as a branded poster for players that ignore og:image.
 */
function Slate({ label }: { label: string }) {
  const frame = useCurrentFrame();
  const exit = progress(frame, 3, SLATE, inOut);
  const enter = progress(frame, DURATION - SLATE, SLATE - 1, inOut);
  const offset = frame < DURATION / 2 ? -exit * HEIGHT : (1 - enter) * HEIGHT;
  const labelOpacity = frame < DURATION / 2 ? 1 - progress(frame, 0, 8) : progress(frame, DURATION - 6, 5);

  return (
    <AbsoluteFill style={{ transform: `translateY(${offset}px)`, background: theme.slateBg }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 14,
          opacity: labelOpacity,
          color: theme.slateFg,
          ...fontStyle(theme.slateFont),
          fontSize: 17,
          letterSpacing: 2.4,
          textTransform: "uppercase",
        }}
      >
        <span style={{ width: 12, height: 12, background: theme.slateFg }} />
        <span>{label}</span>
      </AbsoluteFill>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 5, background: theme.slateFg, opacity: 0.85 }} />
    </AbsoluteFill>
  );
}

export function Card({ background = theme.bg, slate, children }: { background?: string; slate: string; children: ReactNode }) {
  const ready = useFontsReady();
  return (
    <AbsoluteFill style={{ background, overflow: "hidden", color: theme.fg, WebkitFontSmoothing: "antialiased", textRendering: "geometricPrecision" }}>
      {ready ? children : null}
      {ready ? <Slate label={slate} /> : null}
    </AbsoluteFill>
  );
}

/** SVG layer sharing the card's 1200×630 coordinate space. */
export function Svg({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ position: "absolute", inset: 0, ...style }}>
      {children}
    </svg>
  );
}
