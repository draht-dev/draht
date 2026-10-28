import type { Beat, PublicSource } from "../../../src/contract.js";
import { isSourceCited } from "../lib/sources.js";

/** Lists a reel's cited sources, highlighting the ones the currently active beat cites. */
export function SourcesSheet({
	sources,
	activeBeat,
	onClose,
}: {
	sources: PublicSource[];
	activeBeat: Beat | undefined;
	onClose: () => void;
}) {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a tap-to-dismiss backdrop, not the interactive content itself.
		<div className="sources-sheet-backdrop" onClick={onClose}>
			<div className="sources-sheet" onClick={(event) => event.stopPropagation()}>
				<div className="sources-sheet-header">
					<h2>Sources</h2>
					<button type="button" className="sources-sheet-close" onClick={onClose} aria-label="Close sources">
						×
					</button>
				</div>
				<ul className="sources-sheet-list">
					{sources.map((source) => {
						const cited = isSourceCited(activeBeat?.cites, source.id);
						return (
							<li key={source.id} className={cited ? "sources-sheet-item sources-sheet-item-cited" : "sources-sheet-item"}>
								{source.url ? (
									<a href={source.url} target="_blank" rel="noreferrer">
										{source.label}
									</a>
								) : (
									<span>{source.label}</span>
								)}
								<span className="sources-sheet-kind">{source.kind}</span>
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}
