import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Card, Label, Lines, Rule, Svg, fontStyle, loopPhase, progress } from "./kit/motion";
import type { PageEntry } from "./kit/types";
import { theme } from "./site";

// draht's own motif: wires on a dotted plan, with copper pulses running
// along them (the landing page's "wireplan").

type Point = readonly [number, number];

/** Position at fraction `t` along a polyline. */
function along(points: readonly Point[], t: number): Point {
  const segments = points.slice(1).map((point, index) => {
    const from = points[index];
    return { from, to: point, length: Math.hypot(point[0] - from[0], point[1] - from[1]) };
  });
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = Math.min(1, Math.max(0, t)) * total;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const k = segment.length ? remaining / segment.length : 0;
      return [segment.from[0] + (segment.to[0] - segment.from[0]) * k, segment.from[1] + (segment.to[1] - segment.from[1]) * k];
    }
    remaining -= segment.length;
  }
  return points[points.length - 1];
}

function polyline(points: readonly Point[]): string {
  return points.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join(" ");
}

function length(points: readonly Point[]): number {
  return points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0);
}

/** A wire that draws itself in, starting at `delay`. */
function Wire({ points, delay, strong = false }: { points: readonly Point[]; delay: number; strong?: boolean }) {
  const frame = useCurrentFrame();
  const total = length(points);
  const p = progress(frame, delay, 30);
  return <path d={polyline(points)} fill="none" stroke={strong ? theme.ruleStrong : theme.rule} strokeWidth={1.5} strokeDasharray={total} strokeDashoffset={total * (1 - p)} />;
}

function Pulse({ at }: { at: Point }) {
  return (
    <g>
      <circle cx={at[0]} cy={at[1]} r={16} fill="url(#pulseGlow)" />
      <circle cx={at[0]} cy={at[1]} r={3.5} fill={theme.copper} />
    </g>
  );
}

function Defs() {
  return (
    <defs>
      <radialGradient id="pulseGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor={theme.copper} stopOpacity={0.9} />
        <stop offset="40%" stopColor={theme.copper} stopOpacity={0.35} />
        <stop offset="100%" stopColor={theme.copper} stopOpacity={0} />
      </radialGradient>
      <pattern id="dots" width={28} height={28} patternUnits="userSpaceOnUse">
        <circle cx={1} cy={1} r={0.8} fill="rgba(239,231,216,0.07)" />
      </pattern>
    </defs>
  );
}

function DotPlan() {
  const frame = useCurrentFrame();
  // Drift one 28px cell per loop so the last frame meets the first.
  const drift = (frame / 180) * 28;
  return (
    <Svg>
      <Defs />
      <rect x={-28} y={-28} width={1256} height={686} fill="url(#dots)" transform={`translate(${drift} 0)`} />
    </Svg>
  );
}

function TopBar({ label, delay = 8 }: { label: string; delay?: number }) {
  const frame = useCurrentFrame();
  const mark = progress(frame, delay, 14);
  return (
    <div style={{ position: "absolute", left: 64, right: 64, top: 50 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, height: 20 }}>
        <div style={{ width: 9, height: 9, background: theme.copper, transform: `scale(${mark})` }} />
        <Label text={label} font="mono" size={14} color={theme.copper} tracking={2.4} delay={delay + 3} />
        <div style={{ flex: 1 }} />
        <Label text="DRAHT.DEV" font="mono" size={13} color={theme.soft} tracking={2.2} delay={delay + 12} reveal="fade" />
      </div>
      <Rule width="100%" color={theme.rule} delay={delay} style={{ marginTop: 18 }} />
    </div>
  );
}

// ─── Home ───────────────────────────────────────────────────────────────────

const TASK: Point = [690, 334];
const ROUTER: Point = [812, 334];
const MODELS = [
  { label: "FAST", at: [1012, 196] as Point },
  { label: "BALANCED", at: [1012, 334] as Point },
  { label: "DEEP", at: [1012, 472] as Point },
];
const ROUTES: Point[][] = MODELS.map(({ at }) => [TASK, ROUTER, [900, ROUTER[1]], [900, at[1]], [at[0] - 16, at[1]]]);
/** Which model each successive task is routed to, in order. */
const PICKS = [1, 0, 2, 1];
const PULSE_START = 62;
const PULSE_EVERY = 24;
const PULSE_TRAVEL = 20;

export function HomeCard() {
  const frame = useCurrentFrame();
  const nodes = progress(frame, 34, 18);
  return (
    <Card slate="draht / coding agents">
      <DotPlan />
      <TopBar label="DYNAMIC ROUTING FOR CODING AGENTS" />
      <div style={{ position: "absolute", left: 58, top: 128, overflow: "hidden", paddingBottom: 30, paddingRight: 40 }}>
        {/* The wordmark as the site sets it: italic "draht" with a copper full stop. */}
        <div style={{ ...fontStyle("displayItalic"), fontSize: 228, lineHeight: 0.95, letterSpacing: -6, transform: `translateY(${(1 - progress(frame, 10, 28)) * 110}%)` }}>
          draht<span style={{ color: theme.copper }}>.</span>
        </div>
      </div>
      <div style={{ position: "absolute", left: 64, top: 352, width: 520 }}>
        <Lines
          text="Use the right model. Test before code. Read the domain."
          font="sans"
          maxSize={30}
          maxWidth={500}
          maxLines={3}
          lineHeight={1.3}
          color={theme.dim}
          delay={30}
          stagger={6}
          reveal="fade"
          accentWords={["domain"]}
          accentColor={theme.copper}
        />
      </div>
      <Svg>
        <Defs />
        {ROUTES.map((route, index) => (
          <Wire key={index} points={route} delay={22 + index * 4} />
        ))}
        {MODELS.map(({ label, at }, index) => {
          // A node glows while a task routed to it arrives.
          const glow = PICKS.reduce((sum, pick, n) => {
            if (pick !== index) return sum;
            const arrive = PULSE_START + n * PULSE_EVERY + PULSE_TRAVEL;
            return Math.max(sum, progress(frame, arrive - 2, 4) * (1 - progress(frame, arrive + 4, 18)));
          }, 0);
          return (
            <g key={label} opacity={nodes}>
              <rect x={at[0] - 16} y={at[1] - 22} width={130} height={44} fill={theme.bg} stroke={glow > 0.05 ? theme.copper : theme.ruleStrong} strokeWidth={1.5} />
              <rect x={at[0] - 16} y={at[1] - 22} width={130} height={44} fill={theme.copper} opacity={glow * 0.18} />
              <text x={at[0] + 49} y={at[1] + 5} textAnchor="middle" fill={glow > 0.05 ? theme.copper : theme.dim} style={{ ...fontStyle("mono"), fontSize: 13, letterSpacing: 2 }}>
                {label}
              </text>
            </g>
          );
        })}
        <g opacity={nodes}>
          <circle cx={TASK[0]} cy={TASK[1]} r={7} fill={theme.bg} stroke={theme.copper} strokeWidth={1.5} />
          <text x={TASK[0]} y={TASK[1] - 20} textAnchor="middle" fill={theme.soft} style={{ ...fontStyle("mono"), fontSize: 12, letterSpacing: 2 }}>
            TASK
          </text>
          <rect x={ROUTER[0] - 9} y={ROUTER[1] - 9} width={18} height={18} fill={theme.copper} transform={`rotate(45 ${ROUTER[0]} ${ROUTER[1]})`} />
          <text x={ROUTER[0]} y={ROUTER[1] + 34} textAnchor="middle" fill={theme.soft} style={{ ...fontStyle("mono"), fontSize: 12, letterSpacing: 2 }}>
            ROUTE
          </text>
        </g>
        {PICKS.map((pick, n) => {
          const start = PULSE_START + n * PULSE_EVERY;
          const t = progress(frame, start, PULSE_TRAVEL, (x) => x);
          if (frame < start || t >= 1) return null;
          return <Pulse key={n} at={along(ROUTES[pick], t)} />;
        })}
      </Svg>
      <div style={{ position: "absolute", left: 64, right: 64, bottom: 46 }}>
        <Rule width="100%" color={theme.rule} delay={40} style={{ marginBottom: 18 }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Label text="TEST FIRST · DOMAIN AWARE · EVERY CALL LOGGED" font="mono" size={13} color={theme.soft} tracking={2} delay={50} />
          <Label text="HANDGEFERTIGT IN DORTMUND" font="mono" size={13} color={theme.soft} tracking={2} delay={58} reveal="fade" />
        </div>
      </div>
    </Card>
  );
}

// ─── Every other page ───────────────────────────────────────────────────────

const WIRE: Point[] = [[64, 520], [1136, 520]];

export function PageCard({ page }: { page: PageEntry }) {
  const frame = useCurrentFrame();
  const section = page.section.toUpperCase();
  // Two pulses per loop along the bottom wire once the card has built.
  const pulses = frame > 54 ? [loopPhase(frame, 2), loopPhase(frame, 2, 0.5)] : [];
  const url = `draht.dev${page.path}`;

  return (
    <Card slate={`draht / ${page.section}`}>
      <DotPlan />
      <TopBar label={`DRAHT / ${section}`} />
      <AbsoluteFill style={{ padding: "132px 64px 0", justifyContent: "flex-start" }}>
        <Lines text={page.title} font="displayItalic" maxSize={96} minSize={54} maxWidth={1060} maxLines={3} lineHeight={1.02} tracking={-1.5} delay={14} />
        <div style={{ height: 26 }} />
        <Lines text={page.description} font="sans" maxSize={25} minSize={20} maxWidth={940} maxLines={2} lineHeight={1.35} color={theme.dim} delay={34} reveal="fade" />
      </AbsoluteFill>
      <Svg>
        <Defs />
        <Wire points={WIRE} delay={30} strong />
        <circle cx={WIRE[0][0]} cy={WIRE[0][1]} r={5} fill={theme.bg} stroke={theme.copper} strokeWidth={1.5} opacity={progress(frame, 30, 10)} />
        <rect x={WIRE[1][0] - 5} y={WIRE[1][1] - 5} width={10} height={10} fill={theme.copper} opacity={progress(frame, 54, 10)} />
        {pulses.map((t, index) => (
          <Pulse key={index} at={along(WIRE, t)} />
        ))}
      </Svg>
      <div style={{ position: "absolute", left: 64, right: 64, bottom: 50, display: "flex", justifyContent: "space-between" }}>
        <Label text={url.toUpperCase()} font="mono" size={13} color={theme.soft} tracking={1.8} delay={46} />
        <Label text="CODING AGENTS THAT SHIP FOR LESS" font="mono" size={13} color={theme.soft} tracking={1.8} delay={56} reveal="fade" />
      </div>
    </Card>
  );
}
