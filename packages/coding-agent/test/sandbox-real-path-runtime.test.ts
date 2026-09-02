/**
 * R44-SBX.3 under **both** runtimes this package ships to.
 *
 * The suite runs under vitest/node, but `draht`'s released binaries are built
 * with `bun build --compile` (`packages/coding-agent` -> `build:binary`), and the
 * two runtimes disagree about `fs.realpathSync.native`:
 *
 * ```
 * fixture: <project>/link -> <outside>/sub
 * realpathSync.native("<project>/link/..")  node 26 -> <outside>   (POSIX)
 *                                          bun 1.4 -> <project>   (lexical)
 * ```
 *
 * Phase 44's `real-path.ts` handed the raw spelling to `realpathSync.native` and
 * documented that the OS "gets it right". Under bun it does not, and the
 * consequence was concrete: `isPathWritable(policy, "<project>/link/../evil.txt")`
 * answered **true** in every shipped binary for a path the kernel writes to
 * `<outside>/evil.txt`. A node-only test could not see it.
 *
 * So the assertions live in `test-utils/sandbox-real-path-probe.ts`, which is a
 * framework-free module, and this file executes them twice: in-process (node)
 * and as a subprocess under `bun`. The two answer sets are compared field by
 * field, so a future runtime divergence fails here rather than shipping.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	REAL_PATH_PROBE_MARKER,
	type RealPathProbeResult,
	runRealPathProbe,
} from "./test-utils/sandbox-real-path-probe.ts";

const probePath = fileURLToPath(new URL("./test-utils/sandbox-real-path-probe.ts", import.meta.url));

function lookupOnPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Runs the probe under another runtime and returns what it reported. */
function runProbeUnder(bin: string): { result: RealPathProbeResult; status: number | null } {
	const run = spawnSync(bin, [probePath], { encoding: "utf8", timeout: 120_000 });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const index = output.lastIndexOf(REAL_PATH_PROBE_MARKER);
	if (index === -1) {
		throw new Error(
			`the probe produced no result under ${bin} (status ${run.status}, error ${run.error?.message ?? "none"}): ${output.slice(-800)}`,
		);
	}
	const line = output.slice(index + REAL_PATH_PROBE_MARKER.length).split("\n", 1)[0] ?? "";
	return { result: JSON.parse(line) as RealPathProbeResult, status: run.status };
}

function failed(result: RealPathProbeResult): string[] {
	return result.checks
		.filter((check) => !check.ok)
		.map((check) => `${check.name}: expected ${check.expected}, got ${check.actual}`);
}

describe("real-path resolution is correct under every runtime that ships it (R44-SBX.3)", () => {
	it("holds in-process, under the runtime the test suite itself uses", () => {
		const result = runRealPathProbe();
		expect(failed(result)).toEqual([]);
		// Positive control: a probe that asserted nothing would also report no failures.
		expect(result.checks.length).toBeGreaterThanOrEqual(12);
	});

	it("holds under bun, which is what `bun build --compile` puts in the released binary", () => {
		const bun = lookupOnPath("bun");
		// Not skipped when bun is missing: the shipped artefact is a bun build, and a
		// silently-skipped check is how a runtime-specific escape reaches a release.
		// CI installs bun (`.github/workflows/ci.yml`), as does `bun install` locally.
		expect(bun, "bun must be on PATH: the released draht binaries are compiled with it").not.toBeNull();

		const { result, status } = runProbeUnder(bun as string);
		expect(result.runtime).toMatch(/^bun /);
		expect(failed(result)).toEqual([]);
		expect(status).toBe(0);
	});

	it("gives bit-identical answers under node and bun, so neither can drift", () => {
		const bun = lookupOnPath("bun");
		expect(bun).not.toBeNull();

		const here = runRealPathProbe();
		const there = runProbeUnder(bun as string).result;
		const flatten = (result: RealPathProbeResult) =>
			Object.fromEntries(result.checks.map((check) => [check.name, check.actual]));

		expect(flatten(there)).toEqual(flatten(here));
	});
});
