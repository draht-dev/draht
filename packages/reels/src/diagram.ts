/**
 * Deterministic Mermaid diagrams built only from changed file paths. No
 * edges or nodes are invented: every node is a directory or file that
 * actually appears in {@link FileChange.path}.
 */

import type { FileChange, FileStatus } from "./contract.ts";

const MAX_DIR_NODES = 8;
const MAX_FILE_NODES_PER_DIR = 6;

function topLevelDir(path: string): string {
	const slash = path.indexOf("/");
	return slash === -1 ? "." : path.slice(0, slash);
}

/**
 * Mermaid node ids must be stable, unique identifiers; labels (via
 * {@link escapeMermaidLabel}) carry the real text. Sanitizing the path into
 * an id (replacing non-alphanumerics with `_`) is not unique — e.g.
 * `src/a-b.ts` and `src/a_b.ts` would collide — so ids are index-based
 * instead, scoped per prefix.
 */
function nodeId(prefix: string, index: number): string {
	return `${prefix}_${index}`;
}

/**
 * Escapes a label for Mermaid's `["..."]` quoted-string node syntax.
 * Mermaid does not treat `\` as an escape character inside a label, so a
 * literal backslash in a path must be left alone, not doubled.
 */
export function escapeMermaidLabel(label: string): string {
	return label.replace(/"/g, "#quot;").replace(/\n/g, " ");
}

function statusClass(status: FileStatus): string {
	switch (status) {
		case "added":
			return "added";
		case "deleted":
			return "deleted";
		case "renamed":
			return "renamed";
		default:
			return "modified";
	}
}

export interface DiagramResult {
	mermaid: string;
	dirCount: number;
}

/**
 * Builds a `graph TD` of top-level directories fanning out to the changed
 * files beneath them, capped so large change sets stay readable. Directories
 * are sorted by name for determinism; files within a directory are sorted
 * by path and capped at {@link MAX_FILE_NODES_PER_DIR}.
 */
export function buildChangeDiagram(files: FileChange[]): DiagramResult {
	const byDir = new Map<string, FileChange[]>();
	for (const file of files) {
		const dir = topLevelDir(file.path);
		const bucket = byDir.get(dir) ?? [];
		bucket.push(file);
		byDir.set(dir, bucket);
	}

	const dirs = Array.from(byDir.keys()).sort((a, b) => a.localeCompare(b));
	const shownDirs = dirs.slice(0, MAX_DIR_NODES);
	const extraDirCount = dirs.length - shownDirs.length;

	const lines: string[] = ["graph TD"];
	lines.push("classDef added fill:#16a34a,color:#fff,stroke:#065f46;");
	lines.push("classDef modified fill:#2563eb,color:#fff,stroke:#1e3a8a;");
	lines.push("classDef deleted fill:#dc2626,color:#fff,stroke:#7f1d1d;");
	lines.push("classDef renamed fill:#9333ea,color:#fff,stroke:#581c87;");

	let fileIndex = 0;
	let moreIndex = 0;
	shownDirs.forEach((dir, dirIndex) => {
		const dirNode = nodeId("dir", dirIndex);
		lines.push(`${dirNode}["${escapeMermaidLabel(dir)}"]`);
		const dirFiles = (byDir.get(dir) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
		const shownFiles = dirFiles.slice(0, MAX_FILE_NODES_PER_DIR);
		const extraFileCount = dirFiles.length - shownFiles.length;

		for (const file of shownFiles) {
			const fileNode = nodeId("file", fileIndex++);
			const name = file.path.slice(dir === "." ? 0 : dir.length + 1);
			lines.push(`${fileNode}["${escapeMermaidLabel(name)}"]`);
			lines.push(`${dirNode} --> ${fileNode}`);
			lines.push(`class ${fileNode} ${statusClass(file.status)};`);
		}
		if (extraFileCount > 0) {
			const moreNode = nodeId("more", moreIndex++);
			lines.push(`${moreNode}["+${extraFileCount} more"]`);
			lines.push(`${dirNode} --> ${moreNode}`);
		}
	});
	if (extraDirCount > 0) {
		lines.push(`more_dirs["+${extraDirCount} more directories"]`);
	}

	return { mermaid: lines.join("\n"), dirCount: dirs.length };
}
