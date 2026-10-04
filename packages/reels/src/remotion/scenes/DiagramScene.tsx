import mermaid from "mermaid";
import { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, useCurrentFrame } from "remotion";
import type { DiagramScene as DiagramSceneData } from "../../contract.ts";
import { activeBeatIndex } from "../beats.ts";
import { SAFE_ZONE_WIDTH, SCENE_CONTENT_HEIGHT } from "../props.ts";
import { buildBeatFocusCss } from "./diagram-focus.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

let mermaidInitialized = false;

/**
 * Wide `wrappingWidth` plus generous spacing so labels sit on one or two
 * lines instead of wrapping into a narrow column (the frame is 1080px wide;
 * the diagram fills the ~884px safe zone, so a 380px label column still
 * leaves room for a TD flow's nodes to stay side by side where possible).
 */
function ensureMermaidInitialized() {
	if (mermaidInitialized) return;
	mermaid.initialize({
		startOnLoad: false,
		theme: "dark",
		securityLevel: "strict",
		htmlLabels: false,
		themeVariables: { fontSize: "34px" },
		flowchart: {
			wrappingWidth: 380,
			nodeSpacing: 60,
			rankSpacing: 90,
			padding: 20,
		},
	});
	mermaidInitialized = true;
}

/**
 * Mermaid renders with a `viewBox` plus a fixed pixel `width`/`max-width`
 * matching the diagram's natural size, so it never grows past that size no
 * matter how big its container is. Parse the `viewBox` and replace the
 * width/height/style with explicit pixel values scaled up to fill the
 * available frame (preserving aspect ratio), instead of relying on
 * percentage sizing of a replaced SVG element, which mermaid's own
 * `max-width` style otherwise overrides.
 */
function scaleSvgToFillContainer(svg: string): string {
	const viewBoxMatch = svg.match(/viewBox="([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+)"/);
	if (!viewBoxMatch) return svg;
	const vbWidth = Number(viewBoxMatch[3]);
	const vbHeight = Number(viewBoxMatch[4]);
	if (!vbWidth || !vbHeight) return svg;

	const scale = Math.min(SAFE_ZONE_WIDTH / vbWidth, SCENE_CONTENT_HEIGHT / vbHeight);
	const width = Math.round(vbWidth * scale);
	const height = Math.round(vbHeight * scale);

	return svg.replace(/<svg([^>]*)>/, (_match, attrs: string) => {
		const stripped = attrs.replace(/\s(width|height|style)="[^"]*"/g, "");
		return `<svg${stripped} width="${width}" height="${height}">`;
	});
}

export function DiagramScene({ scene, beatStartFrames }: { scene: DiagramSceneData; beatStartFrames?: number[] }) {
	const [svg, setSvg] = useState<string | undefined>();
	// Per Remotion's guidance, the delayRender handle is created in a
	// useState initializer (synchronously during the first render), not in
	// an effect — an effect runs after commit, which can race Remotion's
	// frame-readiness check.
	const [handle] = useState(() => delayRender("render mermaid diagram"));
	const frame = useCurrentFrame();
	const beatIndex = activeBeatIndex(beatStartFrames, frame);

	useEffect(() => {
		ensureMermaidInitialized();
		let unmounted = false;
		const id = `reel-diagram-${Math.random().toString(36).slice(2)}`;
		mermaid
			.render(id, scene.mermaid)
			.then(({ svg: rendered }) => {
				if (unmounted) {
					// The scene unmounted (e.g. the composition seeked away) before mermaid
					// resolved: still release the render handle, or Remotion waits forever.
					continueRender(handle);
					return;
				}
				setSvg(scaleSvgToFillContainer(rendered));
				continueRender(handle);
			})
			.catch((error: unknown) => {
				cancelRender(error);
			});
		return () => {
			unmounted = true;
		};
	}, [scene.mermaid, handle]);

	// Beat-driven focus is recomputed into a `<style>` block on every render (not an
	// effect): Remotion's frame capture only reliably waits for work gated behind
	// delayRender/continueRender, so mutating the mounted SVG's DOM imperatively after
	// paint can race the screenshot. Folding the style into the same markup React commits
	// keeps it on the normal, frame-synchronous render path.
	const html = useMemo(() => {
		if (!svg) return undefined;
		const css = buildBeatFocusCss(svg, scene.beats, beatIndex);
		return css ? `<style>${css}</style>${svg}` : svg;
	}, [svg, scene.beats, beatIndex]);

	return (
		<AbsoluteFill style={{ backgroundColor: "#0b0f19" }}>
			<SafeZoneContent style={{ justifyContent: "center", alignItems: "center" }}>
				{html ? (
					// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted output of mermaid.render plus our own generated <style>, not user HTML
					<div dangerouslySetInnerHTML={{ __html: html }} />
				) : null}
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
