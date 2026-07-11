import type { CSSProperties } from "react";

/**
 * M1 scope only (spec §16): a single room-glass panel (spec §13 — alpha-composited
 * `smoke-900` @ ~78%) with the wordmark in `ink`. No cards, chips, palette or lanes —
 * those land in M4–M7. Every color here is a `var(--token)` reference resolved by
 * `tokens.css`, which `index.html` links directly in <head> — there is no JS-injected
 * stylesheet in this component tree, so there is no moment where this renders unstyled.
 */
const roomGlassStyle: CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	width: "100%",
	height: "100%",
	backgroundColor: "color-mix(in srgb, var(--smoke-900) 78%, transparent)",
	color: "var(--ink)",
	fontSize: "17px",
};

export function App() {
	return <div style={roomGlassStyle}>geist</div>;
}
