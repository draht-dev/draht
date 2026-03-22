import type { PathMetadata } from "./package-manager.js";

export interface SourceInfo {
	path?: string;
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	baseDir?: string;
}

export function createSourceInfo(path: string | undefined, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}
