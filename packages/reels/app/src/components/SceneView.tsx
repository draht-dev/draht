import type { Scene } from "../../../src/contract.js";
import { codeLineStates } from "../lib/codeFocus.js";
import { DiagramView } from "./DiagramView.js";

function diffLineClass(line: string): string {
	if (line.startsWith("+")) return "diff-line diff-add";
	if (line.startsWith("-")) return "diff-line diff-del";
	return "diff-line";
}

/**
 * `beatIndex` is the active beat within the scene's own `beats` (audio
 * mode's `activeBeatIndex`), -1 or absent before any beat has started. Code
 * scenes dim everything outside the active beat's focused lines; diagram
 * scenes forward it to `DiagramView`, which mirrors the video engine's node
 * focus (`diagram-focus.ts`).
 */
export function SceneView({ scene, beatIndex }: { scene: Scene; beatIndex?: number }) {
	switch (scene.kind) {
		case "title":
			return (
				<div className="scene scene-title">
					<h2>{scene.title}</h2>
					<p className="scene-subtitle">{scene.subtitle}</p>
				</div>
			);

		case "stats":
			return (
				<div className="scene scene-stats">
					<ul>
						{scene.files.map((file) => (
							<li key={file.path} className={`file-status file-status-${file.status}`}>
								<span className="file-path">{file.path}</span>
								<span className="file-counts">
									+{file.additions} -{file.deletions}
								</span>
							</li>
						))}
					</ul>
				</div>
			);

		case "code": {
			const focus = beatIndex !== undefined && beatIndex >= 0 ? scene.beats?.[beatIndex]?.focus : undefined;
			const states = codeLineStates(scene.lines.length, focus);
			return (
				<div className="scene scene-code">
					<p className="scene-code-path">{scene.path}</p>
					{scene.origin === "head" && <p className="scene-code-context-badge">context at {scene.ref}</p>}
					<pre className="scene-code-body">
						<code>
							{scene.lines.map((line, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
								<span key={index} className={`${diffLineClass(line)} scene-code-line-${states[index]}`}>
									{line}
									{"\n"}
								</span>
							))}
						</code>
					</pre>
				</div>
			);
		}

		case "diagram":
			return (
				<div className="scene scene-diagram-wrap">
					<DiagramView source={scene.mermaid} beats={scene.beats} beatIndex={beatIndex} />
				</div>
			);

		case "outro":
			return (
				<div className="scene scene-outro">
					<p>{scene.narration}</p>
				</div>
			);
	}
}
