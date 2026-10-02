import { useEffect, useRef, useState } from "react";
import { loadMermaid } from "../lib/mermaid.lazy.js";

let diagramSeq = 0;

export function DiagramView({ source }: { source: string }) {
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

	if (error) return <p className="scene-diagram-error">Diagram failed to render: {error}</p>;
	if (!svg) return <div className="scene-diagram scene-diagram-loading" aria-busy="true" />;
	// biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid.render output, generated client-side from scene data only.
	return <div className="scene-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
