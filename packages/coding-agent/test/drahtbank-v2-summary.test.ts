import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Grade, summarize } from "../eval/drahtbank/bank.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const directories: string[] = [];
const variants = ["verbose", "pruning", "frontier", "hybrid"];

function result(variant: string, repetition: number, overrides: Partial<Grade> = {}): Grade {
	return {
		id: `${repetition}-coding-agent-feature-${variant}`,
		host: "coding-agent",
		caseId: "feature",
		repetition,
		variant,
		promptPath: "packages/coding-agent/agents/implementer.md",
		promptSha256: "0".repeat(64),
		promptBytes: 100,
		taskSha256: "0".repeat(64),
		initialWorkspaceSha256: "0".repeat(64),
		passed: true,
		executionPassed: true,
		evidenceIntact: true,
		acceptancePassed: true,
		statusPassed: true,
		status: "DONE",
		scopePassed: true,
		scopeViolations: [],
		failure: null,
		acceptance: null,
		elapsedMs: 100,
		usage: null,
		toolCalls: null,
		telemetrySource: "adapter-reported",
		adapter: { format: "json", command: ["fixture"], provider: "fixture", model: "fixture" },
		behaviorPassed: true,
		evidencePassed: true,
		statusSyntaxPassed: true,
		statusSemanticPassed: true,
		responseFormatPassed: true,
		findingsPassed: null,
		...overrides,
	};
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Drahtbank v2 paired summaries", () => {
	it("compares every variant against the first by fixture identity and separates axes", () => {
		const rows = [
			result("hybrid", 2, { elapsedMs: 70 }),
			result("verbose", 1, { evidencePassed: false }),
			result("frontier", 1),
			result("pruning", 1),
			result("verbose", 2, { passed: false, behaviorPassed: false, evidencePassed: null }),
			result("hybrid", 1, { passed: false, evidencePassed: false, statusSemanticPassed: false }),
			result("pruning", 2),
			result("frontier", 2),
		];
		const summary = summarize(rows, variants);
		expect(
			summary.comparisons.map(({ baselineVariant, candidateVariant }) => [baselineVariant, candidateVariant]),
		).toEqual([
			["verbose", "pruning"],
			["verbose", "frontier"],
			["verbose", "hybrid"],
		]);
		const hybrid = summary.comparisons[2];
		expect(hybrid.matchedPairs).toBe(2);
		expect(hybrid.strict.regressions.map(({ repetition }) => repetition)).toEqual([1]);
		expect(hybrid.strict.improvements.map(({ repetition }) => repetition)).toEqual([2]);
		expect(hybrid.axes.behaviorPassed.regressions).toEqual([]);
		expect(hybrid.axes.behaviorPassed.improvements.map(({ repetition }) => repetition)).toEqual([2]);
		expect(hybrid.axes.statusSemanticPassed.regressions.map(({ repetition }) => repetition)).toEqual([1]);
		expect(hybrid.axes.evidencePassed).toMatchObject({ total: 1, bothFailed: 1, unknownOrNotApplicable: 1 });
		expect(hybrid.axes.evidencePassed.improvements).toEqual([]);
		expect(hybrid.axes.findingsPassed).toMatchObject({ total: 0, unknownOrNotApplicable: 2 });
		expect(summary.paired.total).toBe(0);
	});

	it("reports missing counterparts without inventing regressions", () => {
		const summary = summarize([result("baseline", 1), result("hybrid", 2)], ["baseline", "hybrid"]);
		expect(summary.paired.regressions).toEqual([]);
		expect(summary.paired.total).toBe(0);
		expect(summary.comparisons[0]).toMatchObject({ matchedPairs: 0, unpairedBaseline: 1, unpairedCandidate: 1 });
		expect(summary.comparisons[0].strict.regressions).toEqual([]);
	});

	it("retains the baseline/candidate paired interface and timing", () => {
		const summary = summarize([
			result("candidate", 1, { elapsedMs: 75 }),
			result("baseline", 1),
			result("baseline", 2),
			result("candidate", 2, { passed: false }),
		]);
		expect(summary.paired).toMatchObject({ total: 2, bothPassed: 1, medianElapsedDeltaMsOnPairedPasses: -25 });
		expect(summary.paired.regressions.map(({ repetition }) => repetition)).toEqual([2]);
		expect(summary.comparisons[0].strict).toEqual(summary.paired);
	});
});

describe("Drahtbank v2 CLI explanations", () => {
	it("prints pair comparisons and every new failing axis", () => {
		const directory = mkdtempSync(join(tmpdir(), "drahtbank-summary-"));
		directories.push(directory);
		const rows = [
			result("verbose", 1),
			result("hybrid", 1, { passed: false, evidencePassed: false }),
			result("hybrid", 2, { passed: false, findingsPassed: false }),
			result("hybrid", 3, { passed: false, responseFormatPassed: false }),
			result("hybrid", 4, { passed: false, statusSyntaxPassed: false }),
			result("hybrid", 5, { passed: false, statusSemanticPassed: false }),
			result("hybrid", 6, { passed: false, evidencePassed: null }),
		];
		writeFileSync(
			join(directory, "report.json"),
			JSON.stringify({ suiteVersion: "2", results: rows, summary: summarize(rows, ["verbose", "hybrid"]) }),
		);
		const run = spawnSync(
			process.execPath,
			[join(root, "packages/coding-agent/bin/drahtbank.mjs"), "report", directory],
			{ encoding: "utf8" },
		);
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toContain(
			"Compare verbose -> hybrid: 1 matched pairs; strict 1 regressions, 0 improvements; unmatched 0/5",
		);
		for (const [repetition, reason] of [
			[1, "evidence"],
			[2, "findings"],
			[3, "response format"],
			[4, "status syntax"],
			[5, "status semantics"],
			[6, "strict gate (see JSON axes)"],
		]) {
			expect(run.stdout).toContain(`FAIL ${repetition}-coding-agent-feature-hybrid: ${reason}`);
		}
	});
});
