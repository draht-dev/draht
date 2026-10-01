#!/usr/bin/env node
/**
 * Promote the last release of a finished day to its bare CalVer version.
 *
 * Releases are always cut as YYYY.M.D-N (see lib/version-stamp.mjs): a bare
 * YYYY.M.D sorts ABOVE every YYYY.M.D-N under semver, so it can only exist once
 * the day is over and no further -N can follow. This script closes each past
 * day by re-tagging its highest -N release as the bare version, waiting for the
 * tag-triggered binary build, and publishing the same packages under the bare
 * version so `latest` ends up on it.
 *
 * Usage: node scripts/promote-daily-release.mjs [--dry-run] [--min-age-hours N] [--only vYYYY.M.D-N]
 *
 * Needs GH_TOKEN (a PAT, so the tag push triggers Build Binaries) and npm auth
 * (NODE_AUTH_TOKEN) when not a dry run.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkspaces, topologicallySortPublicPackages } from "./publish-workspaces.mjs";
import { assertReleaseVersions, setVersion, waitForVerifiedRelease } from "./release-helpers.mjs";

const TAG_PATTERN = /^v(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?$/;
export const PROMOTED_DIST_TAG = "promoted";

/** `v2026.9.5-2` -> { day: "2026.9.5", suffix: 2, version: "2026.9.5-2" }; null for anything else. */
export function parseDrahtTag(tag) {
	const match = TAG_PATTERN.exec(tag);
	if (!match) return null;
	const [, year, month, day, suffix] = match;
	return {
		tag,
		day: `${Number(year)}.${Number(month)}.${Number(day)}`,
		dayKey: Number(year) * 10_000 + Number(month) * 100 + Number(day),
		suffix: suffix === undefined ? null : Number(suffix),
		version: tag.slice(1),
	};
}

/** semver order for draht versions: by day, then bare above every -N, then by N. */
export function compareDrahtVersions(a, b) {
	const pa = parseDrahtTag(`v${a}`);
	const pb = parseDrahtTag(`v${b}`);
	if (!pa || !pb) throw new Error(`not a draht version: ${!pa ? a : b}`);
	if (pa.dayKey !== pb.dayKey) return pa.dayKey - pb.dayKey;
	if (pa.suffix === null || pb.suffix === null) return (pa.suffix === null ? 1 : 0) - (pb.suffix === null ? 1 : 0);
	return pa.suffix - pb.suffix;
}

function utcDayKey(date) {
	return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

/**
 * Which past days still need their bare version, oldest first.
 *
 * A day qualifies when it is strictly before today (UTC), has at least one -N
 * tag, has no bare tag yet, and its newest -N tag is older than `minAgeMs`
 * (so a release cut late in a releaser's local day is never promoted from
 * under them by a UTC boundary).
 */
export function findPromotionCandidates(tags, { now = new Date(), minAgeMs = 6 * 60 * 60 * 1000 } = {}) {
	const days = new Map();
	for (const entry of tags) {
		const parsed = parseDrahtTag(entry.tag);
		if (!parsed) continue;
		const day = days.get(parsed.day) ?? { day: parsed.day, dayKey: parsed.dayKey, bare: null, suffixed: [] };
		if (parsed.suffix === null) day.bare = parsed;
		else day.suffixed.push({ ...parsed, createdAt: entry.createdAt });
		days.set(parsed.day, day);
	}
	const today = utcDayKey(now);
	const candidates = [];
	for (const day of days.values()) {
		if (day.bare || day.suffixed.length === 0 || day.dayKey >= today) continue;
		const newest = day.suffixed.sort((a, b) => b.suffix - a.suffix)[0];
		if (newest.createdAt && now.getTime() - newest.createdAt.getTime() < minAgeMs) continue;
		candidates.push({ day: day.day, from: newest.tag, fromVersion: newest.version, version: day.day, tag: `v${day.day}` });
	}
	return candidates.sort((a, b) => compareDrahtVersions(a.version, b.version));
}

/** The dist-tag plan for one package after the bare version is published. */
export function distTagPlan(publishedVersions, promoted) {
	const known = publishedVersions.filter((v) => parseDrahtTag(`v${v}`));
	const newest = [...known, promoted].sort(compareDrahtVersions).at(-1);
	return newest === promoted ? ["latest"] : [];
}

function git(args, options = {}) {
	return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

export function listTags(root) {
	const output = git(["for-each-ref", "--format=%(refname:short)\t%(creatordate:iso-strict)", "refs/tags/v*"], { cwd: root });
	return output
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [tag, iso] = line.split("\t");
			return { tag, createdAt: iso ? new Date(iso) : undefined };
		});
}

function defaultRun(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed${options.capture ? `: ${(result.stderr || result.stdout).trim()}` : ""}`);
	}
	return result.stdout ?? "";
}

/**
 * Promote one candidate. Every side effect goes through `run`, so the
 * sequence is testable without git, npm, or GitHub.
 */
export async function promoteOne(candidate, { root, dryRun = false, run = defaultRun, log = console.log, waitForRelease = waitForVerifiedRelease, stamp = setVersion, assertStamped = assertReleaseVersions, packages = topologicallySortPublicPackages(loadWorkspaces(root)) }) {
	const { from, tag, version } = candidate;
	const sourceCommit = run("git", ["rev-parse", `${from}^{commit}`], { cwd: root, capture: true }).trim();
	log(`→ ${from} (${sourceCommit.slice(0, 9)}) → ${tag}`);
	if (dryRun) {
		log("  (dry-run: no tag, build, or publish)");
		return { tag, version, sourceCommit, published: [] };
	}

	const previousRef = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, capture: true }).trim();
	run("git", ["checkout", "--detach", sourceCommit], { cwd: root });
	try {
		stamp(root, version);
		run("bun", ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root });
		assertStamped(root, version);
		run("git", ["add", "-A"], { cwd: root });
		run("git", ["commit", "-m", `release: v${version} (promotes ${from})`], { cwd: root });
		run("git", ["tag", tag], { cwd: root });
		const commit = run("git", ["rev-parse", "HEAD"], { cwd: root, capture: true }).trim();
		run("git", ["push", "origin", tag], { cwd: root });

		run("bun", ["install", "--frozen-lockfile", "--ignore-scripts", "--linker", "hoisted"], { cwd: root });
		run("bun", ["run", "build"], { cwd: root });
		log(`  waiting for the verified GitHub release of ${tag}`);
		await waitForRelease({ tag, version, commit });
		run("node", ["scripts/check-install-publishable.mjs"], { cwd: root });
		run("node", ["scripts/publish-workspaces.mjs", "--access", "public", "--tag", PROMOTED_DIST_TAG], { cwd: root });

		const published = [];
		for (const entry of packages) {
			const name = entry.pkg.name;
			const raw = run("npm", ["view", name, "versions", "--json"], { cwd: root, capture: true });
			const versions = JSON.parse(raw || "[]");
			for (const distTag of distTagPlan(Array.isArray(versions) ? versions : [versions], version)) {
				run("npm", ["dist-tag", "add", `${name}@${version}`, distTag], { cwd: root });
			}
			published.push(name);
		}
		log(`  published ${published.length} packages as ${version}`);
		return { tag, version, sourceCommit, commit, published };
	} finally {
		run("git", ["checkout", previousRef === "HEAD" ? "-" : previousRef], { cwd: root });
	}
}

export async function promoteDailyReleases({ root, tags = listTags(root), now = new Date(), minAgeMs, only, dryRun = false, log = console.log, ...deps } = {}) {
	let candidates = findPromotionCandidates(tags, { now, minAgeMs });
	if (only) candidates = candidates.filter((candidate) => candidate.from === only);
	if (candidates.length === 0) {
		log("Nothing to promote: every finished day already has its bare version.");
		return [];
	}
	const results = [];
	for (const candidate of candidates) results.push(await promoteOne(candidate, { root, dryRun, log, ...deps }));
	return results;
}

const isMain = resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
	const args = process.argv.slice(2);
	const valueAfter = (flag) => {
		const index = args.indexOf(flag);
		return index === -1 ? undefined : args[index + 1];
	};
	const hours = valueAfter("--min-age-hours");
	promoteDailyReleases({
		root: process.cwd(),
		dryRun: args.includes("--dry-run"),
		only: valueAfter("--only"),
		minAgeMs: hours === undefined ? undefined : Number(hours) * 60 * 60 * 1000,
	}).then(
		(results) => {
			for (const result of results) console.log(`${result.tag} ← ${result.sourceCommit.slice(0, 9)}${result.commit ? ` (${result.commit.slice(0, 9)})` : ""}`);
		},
		(error) => {
			console.error(error.message);
			process.exit(1);
		},
	);
}
