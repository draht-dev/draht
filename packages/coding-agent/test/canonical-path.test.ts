import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CANONICAL_PATH_PROBE_MARKER,
	type CanonicalPathProbeResult,
	runCanonicalPathProbe,
} from "./test-utils/canonical-path-probe.ts";

const probePath = fileURLToPath(new URL("./test-utils/canonical-path-probe.ts", import.meta.url));

function lookupOnPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function runProbeUnder(bin: string): CanonicalPathProbeResult {
	const run = spawnSync(bin, [probePath], { encoding: "utf8", timeout: 120_000 });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const index = output.lastIndexOf(CANONICAL_PATH_PROBE_MARKER);
	if (index === -1) {
		throw new Error(`the probe produced no result under ${bin} (status ${run.status}): ${output.slice(-800)}`);
	}
	return JSON.parse(output.slice(index + CANONICAL_PATH_PROBE_MARKER.length).split("\n", 1)[0] ?? "");
}

function failures(result: CanonicalPathProbeResult): string[] {
	return result.checks.filter((c) => !c.ok).map((c) => `${c.name}: expected ${c.expected}, got ${c.actual}`);
}

describe("canonical-path holds under every runtime that ships it", () => {
	it("holds in-process, under the runtime the suite uses", () => {
		const result = runCanonicalPathProbe();
		expect(failures(result)).toEqual([]);
		// Positive control: a probe that asserted nothing would also report no failures.
		expect(result.checks.length).toBeGreaterThanOrEqual(16);
	});

	it("holds under bun, which is what `bun build --compile` puts in the released binary", () => {
		const bun = lookupOnPath("bun");
		expect(bun, "bun must be on PATH: the released draht binaries are compiled with it").not.toBeNull();
		const result = runProbeUnder(bun as string);
		expect(result.runtime).toMatch(/^bun /);
		expect(failures(result)).toEqual([]);
	});

	it("gives the same answers under node and bun, so neither can drift", () => {
		const bun = lookupOnPath("bun");
		expect(bun).not.toBeNull();
		const flatten = (r: CanonicalPathProbeResult) => r.checks.map((c) => `${c.name}=${c.actual}`);
		expect(flatten(runProbeUnder(bun as string))).toEqual(flatten(runCanonicalPathProbe()));
	});
});
