import { existsSync, readFileSync } from "fs";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	/** Intraday release suffix for date-based versions (e.g., -1, -2) */
	suffix: number;
	content: string;
}

/**
 * Parse a version string into components.
 * Handles both semver (x.y.z) and date-based versions (YYYY.M.D or YYYY.M.D-N).
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number; suffix: number } {
	// Match YYYY.M.D-N or YYYY.M.D or x.y.z
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/);
	if (!match) {
		return { major: 0, minor: 0, patch: 0, suffix: 0 };
	}
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		suffix: match[4] ? Number.parseInt(match[4], 10) : 0,
	};
}

/**
 * Parse changelog entries from CHANGELOG.md
 * Scans for ## lines and collects content until next ## or EOF
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number; suffix: number } | null = null;

		for (const line of lines) {
			// Check if this is a version header (## [x.y.z] or ## [YYYY.M.D-N] ...)
			if (line.startsWith("## ")) {
				// Save previous entry if exists
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// Try to parse version from this line (supports YYYY.M.D-N format)
				const versionMatch = line.match(/##\s+\[?(\d+\.\d+\.\d+(?:-\d+)?)\]?/);
				if (versionMatch) {
					currentVersion = parseVersion(versionMatch[1]);
					currentLines = [line];
				} else {
					// Reset if we can't parse version
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// Collect lines for current version
				currentLines.push(line);
			}
		}

		// Save last entry
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	if (v1.patch !== v2.patch) return v1.patch - v2.patch;
	return v1.suffix - v2.suffix;
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	const last: ChangelogEntry = {
		...parseVersion(lastVersion),
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config.js";
