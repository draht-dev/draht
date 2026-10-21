import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessRuntimeChecks, RUNTIME_CHECKS, runRuntimeChecks } from "../eval/drahtbank/runtime-checks.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const temporary: string[] = [];
const hash = (contents: string) => createHash("sha256").update(contents).digest("hex");

function fixtureReport() {
	const testResults = RUNTIME_CHECKS.map((proof) => ({
		name: join(packageRoot, proof.file),
		status: "passed",
		assertionResults: proof.requiredTests.map((fullName) => ({
			fullName,
			status: "passed",
			failureMessages: [] as string[],
		})),
	}));
	const count = testResults.reduce((sum, result) => sum + result.assertionResults.length, 0);
	return {
		success: true,
		numTotalTests: count,
		numPassedTests: count,
		numFailedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		testResults,
	};
}

afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Drahtbank runtime evidence", () => {
	it("accepts the complete named proofs and reconciled assertion counts", () => {
		expect(assessRuntimeChecks(fixtureReport(), packageRoot)).toMatchObject({
			complete: true,
			passed: true,
			errors: [],
		});
	});

	it.each([null, {}, { success: true, testResults: [] }])("rejects absent or empty evidence: %j", (value) => {
		expect(assessRuntimeChecks(value, packageRoot).passed).toBe(false);
	});

	it("rejects a missing proof even when the runner reports success and consistent counts", () => {
		const report = fixtureReport();
		report.testResults[0].assertionResults.pop();
		report.numPassedTests--;
		report.numTotalTests--;
		expect(assessRuntimeChecks(report, packageRoot).errors).toEqual(
			expect.arrayContaining([expect.stringContaining("Missing required proof")]),
		);
	});

	it.each(["skipped", "pending", "disabled", "todo"])("does not accept %s proofs", (status) => {
		const report = fixtureReport();
		report.testResults[0].assertionResults[0].status = status;
		report.numPassedTests--;
		if (status === "todo") report.numTodoTests++;
		else report.numPendingTests++;
		expect(assessRuntimeChecks(report, packageRoot)).toMatchObject({ complete: false, passed: false });
	});

	it("records a completed failed proof without treating it as success", () => {
		const report = fixtureReport();
		report.success = false;
		report.testResults[0].status = "failed";
		report.testResults[0].assertionResults[0].status = "failed";
		report.testResults[0].assertionResults[0].failureMessages = ["Expected repair to run"];
		report.numPassedTests--;
		report.numFailedTests++;
		expect(assessRuntimeChecks(report, packageRoot)).toMatchObject({
			complete: true,
			passed: false,
			results: [{ failures: [{ messages: ["Expected repair to run"] }] }, {}, {}],
		});
	});

	it("rejects duplicate files, duplicate assertions and forged totals", () => {
		const duplicateFile = fixtureReport();
		duplicateFile.testResults[1] = duplicateFile.testResults[0];
		expect(assessRuntimeChecks(duplicateFile, packageRoot).passed).toBe(false);
		const duplicateAssertion = fixtureReport();
		duplicateAssertion.testResults[0].assertionResults[1] = duplicateAssertion.testResults[0].assertionResults[0];
		expect(assessRuntimeChecks(duplicateAssertion, packageRoot).passed).toBe(false);
		const incorrectCount = fixtureReport();
		incorrectCount.numPassedTests++;
		expect(assessRuntimeChecks(incorrectCount, packageRoot).passed).toBe(false);
	});

	it("rejects malformed assertions and suite failures despite a declared success", () => {
		const malformed = fixtureReport();
		const value: unknown = {
			...malformed,
			testResults: [{ ...malformed.testResults[0], assertionResults: [null] }, ...malformed.testResults.slice(1)],
		};
		expect(assessRuntimeChecks(value, packageRoot).passed).toBe(false);
		const failedSuite = fixtureReport();
		failedSuite.numFailedTestSuites = 1;
		expect(assessRuntimeChecks(failedSuite, packageRoot).passed).toBe(false);
	});

	it("runs the real focused source-runtime proofs offline and preserves their evidence", () => {
		const output = mkdtempSync(join(tmpdir(), "drahtbank-runtime-"));
		temporary.push(output);
		vi.stubEnv("DRAHT_PACKAGE_DIR", join(output, "wrong-package"));
		vi.stubEnv("GIT_DIR", join(output, "wrong-git-dir"));
		const report = runRuntimeChecks(output, { root, timeoutMs: 150_000 });
		expect(report.errors, readFileSync(join(output, "stderr.txt"), "utf8")).toEqual([]);
		expect(report).toMatchObject({
			complete: true,
			passed: true,
			modelCalls: 0,
			sourcesStable: true,
			process: { exitCode: 0, signal: null, error: null },
		});
		expect(report.results.map((result) => result.id)).toEqual(RUNTIME_CHECKS.map((proof) => proof.id));
		expect(report.tests).toBeGreaterThanOrEqual(
			RUNTIME_CHECKS.reduce((sum, proof) => sum + proof.requiredTests.length, 0),
		);
		expect(report.sourcesBefore["packages/coding-agent/src/core/builtins/completion-checks.ts"]).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(report.stdoutSha256).toBe(hash(readFileSync(join(output, "stdout.txt"), "utf8")));
		expect(report.vitestSha256).toBe(hash(readFileSync(join(output, "vitest.json"), "utf8")));
		expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8"))).toEqual(report);
		expect(() => runRuntimeChecks(output, { root })).toThrow("empty");
	}, 180_000);

	it("refuses existing output before launching or changing evidence", () => {
		const output = mkdtempSync(join(tmpdir(), "drahtbank-runtime-existing-"));
		temporary.push(output);
		writeFileSync(join(output, "evidence"), "keep");
		expect(() => runRuntimeChecks(output, { root })).toThrow("empty");
		expect(readFileSync(join(output, "evidence"), "utf8")).toBe("keep");
	});

	it("records a timed-out runner as incomplete evidence", () => {
		const output = mkdtempSync(join(tmpdir(), "drahtbank-runtime-timeout-"));
		temporary.push(output);
		const report = runRuntimeChecks(output, { root, timeoutMs: 1 });
		expect(report).toMatchObject({ complete: false, passed: false, process: { exitCode: null } });
		expect(report.process.error).toContain("ETIMEDOUT");
		expect(report.errors).toContain("Vitest process did not complete successfully");
	});
});
