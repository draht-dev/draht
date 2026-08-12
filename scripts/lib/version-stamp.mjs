#!/usr/bin/env node
/**
 * Shared version-stamping helpers for the release pipeline.
 *
 * computeNextVersion is the single version-computation rule, imported by
 * scripts/release.mjs. stampPluginManifests is imported by
 * scripts/sync-versions.js (the manual `npm run version:*` path); the
 * automated release path stamps the same manifests via
 * scripts/release-helpers.mjs setVersion. A previous fix landed only in
 * sync-versions.js's inline stamping — which the release path never calls —
 * so the manifests froze at a stale version. Two gates now make any writer
 * drift loud: check-draht-customizations.mjs asserts manifest/package
 * version equality, and release-helpers.mjs assertReleaseVersions re-reads
 * every stamped surface after writing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plugin manifests are what Claude Code / Codex use to decide whether an
 * update exists — if they freeze while package.json moves on, installed
 * plugins silently never refresh. Keep them in lockstep with the package
 * version being released.
 */
export function stampPluginManifests(version, rootDir) {
	const packagesDir = join(rootDir, "packages");
	const pluginManifests = [
		join(packagesDir, "draht-claude", ".claude-plugin", "plugin.json"),
		join(packagesDir, "draht-codex", ".codex-plugin", "plugin.json"),
	];
	for (const manifestPath of pluginManifests) {
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch (e) {
			console.error(`Failed to read ${manifestPath}:`, e.message);
			process.exitCode = 1;
			continue;
		}
		if (manifest.version !== version) {
			console.log(`\n${manifestPath}:`);
			console.log(`  version: ${manifest.version} → ${version}`);
			manifest.version = version;
			writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
		}
	}
	console.log("✅ Plugin manifests in lockstep");
}

/**
 * Compute the next always-suffixed CalVer version for a release.
 *
 * Version format: YYYY.M.D-N (e.g. 2026.2.28-1, 2026.2.28-2, ...). The first
 * release of a calendar day is always "-1" — there is no bare "YYYY.M.D"
 * form — because a bare version sorts *above* any "-N" suffix of the same
 * day under semver (a version with no prerelease identifier has higher
 * precedence than the same version with one attached), which breaks release
 * ordering the moment a second release happens on a day that started with a
 * bare version.
 *
 * `existingVersions` is a flat array of version strings with no leading "v"
 * (e.g. git tags with the tag prefix stripped, or package.json version
 * history). Only entries for today's `date` (bare "YYYY.M.D" or
 * "YYYY.M.D-N") are considered; everything else — other days, malformed
 * strings — is ignored. This function is pure: it never reads git, the
 * filesystem, or the clock itself.
 *
 * Legacy transition note: if a BARE "YYYY.M.D" version exists for today
 * (produced by the pre-CalVer-suffix release.mjs, before this always-
 * suffixed design), it counts as suffix 1, so the next release that day is
 * "-2". On that one transition day, "-2" sorts *below* the pre-existing bare
 * "YYYY.M.D" under semver — a one-day comparator degradation that converges
 * again the next day, once nothing bare remains for "today". The npm
 * dist-tag `latest` is unaffected by this: npm always repoints `latest` at
 * whatever was just published, regardless of semver ordering.
 */
export function computeNextVersion(existingVersions, date) {
	const base = `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}`;
	const escapedBase = base.replace(/\./g, "\\.");
	const bareRegex = new RegExp(`^${escapedBase}$`);
	const suffixRegex = new RegExp(`^${escapedBase}-(\\d+)$`);

	let maxSuffix = 0;
	let foundToday = false;
	for (const version of existingVersions) {
		if (bareRegex.test(version)) {
			foundToday = true;
			maxSuffix = Math.max(maxSuffix, 1);
			continue;
		}
		const match = version.match(suffixRegex);
		if (match) {
			foundToday = true;
			maxSuffix = Math.max(maxSuffix, Number.parseInt(match[1], 10));
		}
	}

	return foundToday ? `${base}-${maxSuffix + 1}` : `${base}-1`;
}
