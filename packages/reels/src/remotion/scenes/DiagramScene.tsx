import mermaid from "mermaid";
import { useEffect, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender } from "remotion";
import type { DiagramScene as DiagramSceneData } from "../../contract.ts";
import { SAFE_ZONE_WIDTH, SCENE_CONTENT_HEIGHT } from "../props.ts";
import { SafeZoneContent } from "./SafeZone.tsx";

let mermaidInitialized = false;

function ensureMermaidInitialized() {
	if (mermaidInitialized) return;
	mermaid.initialize({
		startOnLoad: false,
		theme: "dark",
		securityLevel: "strict",
		themeVariables: { fontSize: "30px" },
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

export function DiagramScene({ scene }: { scene: DiagramSceneData }) {
	const [svg, setSvg] = useState<string | undefined>();
	// Per Remotion's guidance, the delayRender handle is created in a
	// useState initializer (synchronously during the first render), not in
	// an effect — an effect runs after commit, which can race Remotion's
	// frame-readiness check.
	const [handle] = useState(() => delayRender("render mermaid diagram"));

	useEffect(() => {
		ensureMermaidInitialized();
		let unmounted = false;
		const id = `reel-diagram-${Math.random().toString(36).slice(2)}`;
		mermaid
			.render(id, scene.mermaid)
			.then(({ svg: rendered }) => {
				if (unmounted) return;
				setSvg(scaleSvgToFillContainer(rendered));
				continueRender(handle);
			})
			.catch((error: unknown) => {
				if (unmounted) return;
				cancelRender(error);
			});
		// If the scene unmounts (e.g. the composition seeks away) before
		// mermaid resolves, skip the state update and render calls instead
		// of acting on an unmounted component.
		return () => {
			unmounted = true;
		};
	}, [scene.mermaid, handle]);

	return (
		<AbsoluteFill style={{ backgroundColor: "#0b0f19" }}>
			<SafeZoneContent style={{ justifyContent: "center", alignItems: "center" }}>
				{svg ? (
					// biome-ignore lint/security/noDangerouslySetInnerHtml: trusted output of mermaid.render, not user HTML
					<div dangerouslySetInnerHTML={{ __html: svg }} />
				) : null}
			</SafeZoneContent>
		</AbsoluteFill>
	);
}
