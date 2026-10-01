import assert from "node:assert/strict";
import { test } from "node:test";
import {
	PROMOTED_DIST_TAG,
	compareDrahtVersions,
	distTagPlan,
	findPromotionCandidates,
	parseDrahtTag,
	promoteDailyReleases,
	promoteOne,
} from "./promote-daily-release.mjs";

const at = (iso) => new Date(iso);

test("parseDrahtTag reads bare and suffixed CalVer tags and rejects the rest", () => {
	assert.deepEqual(parseDrahtTag("v2026.9.5-2"), { tag: "v2026.9.5-2", day: "2026.9.5", dayKey: 20260905, suffix: 2, version: "2026.9.5-2" });
	assert.equal(parseDrahtTag("v2026.9.5").suffix, null);
	assert.equal(parseDrahtTag("v0.85.0"), null, "upstream semver tags are not draht releases");
	assert.equal(parseDrahtTag("v2026.9.5-rc.1"), null);
});

test("compareDrahtVersions orders like semver: by day, bare above every -N, then by N", () => {
	const sorted = ["2026.9.5-2", "2026.9.6-1", "2026.9.5", "2026.9.5-1", "2026.8.30"].sort(compareDrahtVersions);
	assert.deepEqual(sorted, ["2026.8.30", "2026.9.5-1", "2026.9.5-2", "2026.9.5", "2026.9.6-1"]);
});

test("findPromotionCandidates picks the newest -N of each finished day that has no bare tag", () => {
	const tags = [
		{ tag: "v2026.9.3-1", createdAt: at("2026-09-03T10:00:00Z") },
		{ tag: "v2026.9.3-2", createdAt: at("2026-09-03T18:00:00Z") },
		{ tag: "v2026.9.4-1", createdAt: at("2026-09-04T09:00:00Z") },
		{ tag: "v2026.9.4", createdAt: at("2026-09-05T03:00:00Z") },
		{ tag: "v2026.9.5-1", createdAt: at("2026-09-05T08:00:00Z") },
		{ tag: "v0.85.0", createdAt: at("2026-09-04T10:00:00Z") },
	];
	const candidates = findPromotionCandidates(tags, { now: at("2026-09-05T12:00:00Z") });
	assert.deepEqual(candidates, [{ day: "2026.9.3", from: "v2026.9.3-2", fromVersion: "2026.9.3-2", version: "2026.9.3", tag: "v2026.9.3" }]);
});

test("findPromotionCandidates waits for the newest -N to age before closing a day", () => {
	const tags = [{ tag: "v2026.9.4-3", createdAt: at("2026-09-04T23:30:00Z") }];
	assert.deepEqual(findPromotionCandidates(tags, { now: at("2026-09-05T02:00:00Z") }), []);
	assert.equal(findPromotionCandidates(tags, { now: at("2026-09-05T06:00:00Z") }).length, 1);
	assert.equal(findPromotionCandidates(tags, { now: at("2026-09-05T02:00:00Z"), minAgeMs: 0 }).length, 1);
});

test("findPromotionCandidates never touches today, and returns a backlog oldest first", () => {
	const tags = [
		{ tag: "v2026.9.5-1", createdAt: at("2026-09-05T01:00:00Z") },
		{ tag: "v2026.9.2-1", createdAt: at("2026-09-02T01:00:00Z") },
		{ tag: "v2026.8.31-4", createdAt: at("2026-08-31T01:00:00Z") },
	];
	const candidates = findPromotionCandidates(tags, { now: at("2026-09-05T23:00:00Z") });
	assert.deepEqual(
		candidates.map((c) => c.tag),
		["v2026.8.31", "v2026.9.2"],
	);
});

test("distTagPlan moves latest only when the bare version is the newest thing published", () => {
	assert.deepEqual(distTagPlan(["2026.9.4-1", "2026.9.5-1", "2026.9.5-2"], "2026.9.5"), ["latest"]);
	assert.deepEqual(distTagPlan(["2026.9.5-1", "2026.9.6-1"], "2026.9.5"), [], "a newer day's -1 keeps latest");
	assert.deepEqual(distTagPlan(["2026.9.5-1", "1.0.0-not-draht"], "2026.9.5"), ["latest"], "foreign versions are ignored");
});

test("promoteOne runs the release sequence in order and restores the checkout", async () => {
	const calls = [];
	const run = (command, args, options = {}) => {
		calls.push([command, ...args].join(" "));
		if (command === "git" && args[0] === "rev-parse" && args[1] === "v2026.9.5-2^{commit}") return "a".repeat(40);
		if (command === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
		if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return "b".repeat(40);
		if (command === "npm" && args[0] === "view") return JSON.stringify(["2026.9.5-1", "2026.9.5-2"]);
		return "";
	};
	const waited = [];
	const stamped = [];
	const result = await promoteOne(
		{ from: "v2026.9.5-2", tag: "v2026.9.5", version: "2026.9.5" },
		{
			root: "/repo",
			run,
			log: () => {},
			waitForRelease: async (args) => waited.push(args),
			stamp: (root, version) => stamped.push([root, version]),
			assertStamped: () => {},
			packages: [{ pkg: { name: "@draht/coding-agent" } }, { pkg: { name: "@draht/ai" } }],
		},
	);
	assert.deepEqual(stamped, [["/repo", "2026.9.5"]]);
	assert.deepEqual(waited, [{ tag: "v2026.9.5", version: "2026.9.5", commit: "b".repeat(40) }]);
	assert.deepEqual(result.published, ["@draht/coding-agent", "@draht/ai"]);

	const order = (needle) => calls.findIndex((call) => call.includes(needle));
	assert.ok(order("git checkout --detach") < order("git commit -m release: v2026.9.5 (promotes v2026.9.5-2)"));
	assert.ok(order("git tag v2026.9.5") < order("git push origin v2026.9.5"));
	assert.ok(order("git push origin v2026.9.5") < order("bun run build"));
	assert.ok(order("bun run build") < order(`publish-workspaces.mjs --access public --tag ${PROMOTED_DIST_TAG}`));
	assert.ok(order(`--tag ${PROMOTED_DIST_TAG}`) < order("npm dist-tag add @draht/coding-agent@2026.9.5 latest"));
	assert.ok(calls.includes("npm dist-tag add @draht/ai@2026.9.5 latest"));
	assert.ok(!calls.some((call) => call.startsWith("git push origin main")), "main is never pushed by a promotion");
	assert.equal(calls.at(-1), "git checkout main", "the checkout is restored even after success");
});

test("promoteOne dry-run only reads the source commit", async () => {
	const calls = [];
	const run = (command, args) => {
		calls.push([command, ...args].join(" "));
		return "c".repeat(40);
	};
	const result = await promoteOne({ from: "v2026.9.5-1", tag: "v2026.9.5", version: "2026.9.5" }, { root: "/repo", dryRun: true, run, log: () => {}, packages: [] });
	assert.deepEqual(calls, ["git rev-parse v2026.9.5-1^{commit}"]);
	assert.deepEqual(result.published, []);
});

test("promoteDailyReleases reports an empty backlog without running anything", async () => {
	const logs = [];
	const results = await promoteDailyReleases({
		root: "/repo",
		tags: [{ tag: "v2026.9.5-1", createdAt: at("2026-09-05T01:00:00Z") }],
		now: at("2026-09-05T12:00:00Z"),
		run: () => {
			throw new Error("must not run");
		},
		log: (line) => logs.push(line),
	});
	assert.deepEqual(results, []);
	assert.match(logs.join("\n"), /Nothing to promote/);
});
