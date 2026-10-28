import { useEffect, useMemo, useRef, useState } from "react";
import type { Beat } from "../../../src/contract.js";
import { buildBeatFocusCss } from "../../../src/remotion/scenes/diagram-focus.ts";
import { loadMermaid } from "../lib/mermaid.lazy.js";

let diagramSeq = 0;

/** `beatIndex` is the active beat within `beats` (audio mode's `activeBeatIndex`); -1 or absent means no beat has started, so no node is focused yet. */
export function DiagramView({ source, beats, beatIndex }: { source: string; beats?: Beat[]; beatIndex?: number }) {
	const [svg, setSvg] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const idRef = useRef(`reels-mermaid-${++diagramSeq}`);

	useEffect(() => {
		let cancelled = false;
		setSvg(undefined);
		setError(undefined);

		loadMermaid()
			.then((mermaid) => mermaid.render(idRef.current, source))
			.then((result) => {
				if (!cancelled) setSvg(result.svg);
			})
			.catch((renderError: unknown) => {
				if (!cancelled) setError(renderError instanceof Error ? renderError.message : String(renderError));
			});

		return () => {
			cancelled = true;
		};
	}, [source]);

	// Recomputed on every render rather than imperative DOM mutation, same reasoning as
	// `DiagramScene.tsx`'s Remotion counterpart: the focus style is folded into the same
	// markup React commits, so it is never applied to not-yet-painted or stale DOM.
	const html = useMemo(() => {
		if (!svg) return undefined;
		const css = buildBeatFocusCss(svg, beats, beatIndex ?? -1);
		return css ? `<style>${css}</style>${svg}` : svg;
	}, [svg, beats, beatIndex]);

	if (error) return <p className="scene-diagram-error">Diagram failed to render: {error}</p>;
	if (!html) return <div className="scene-diagram scene-diagram-loading" aria-busy="true" />;
	// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid.render output plus our own generated <style>, not user HTML.
	return <div className="scene-diagram" dangerouslySetInnerHTML={{ __html: html }} />;
}
