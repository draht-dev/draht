import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * This package's own version, read from the shipped `package.json`.
 *
 * `import.meta.dirname` is `src/` when running from source (tests, tsx) and
 * `dist/` when running from the published tarball; `package.json` is the
 * parent of both, and `files` ships it, so one relative path serves both.
 */
export function packageVersion(): string {
	const raw = readFileSync(packageManifestPath(), "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	if (typeof parsed.version !== "string") {
		throw new Error(`package manifest at ${packageManifestPath()} has no string "version" field`);
	}
	return parsed.version;
}

/** Absolute path of this package's own manifest — also read by `doctor` for version-drift checks. */
export function packageManifestPath(): string {
	return join(packageRoot(), "package.json");
}

/** Absolute path of this package's root directory (the parent of `src/`/`dist/`). */
export function packageRoot(): string {
	return dirname(import.meta.dirname);
}
