import type { Scene } from "../../../src/contract.js";
import { DiagramView } from "./DiagramView.js";

function diffLineClass(line: string): string {
	if (line.startsWith("+")) return "diff-line diff-add";
	if (line.startsWith("-")) return "diff-line diff-del";
	return "diff-line";
}

export function SceneView({ scene }: { scene: Scene }) {
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

		case "code":
			return (
				<div className="scene scene-code">
					<p className="scene-code-path">{scene.path}</p>
					<pre className="scene-code-body">
						<code>
							{scene.lines.map((line, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
								<span key={index} className={diffLineClass(line)}>
									{line}
									{"\n"}
								</span>
							))}
						</code>
					</pre>
				</div>
			);

		case "diagram":
			return (
				<div className="scene scene-diagram-wrap">
					<DiagramView source={scene.mermaid} />
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
