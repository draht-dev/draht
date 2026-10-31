import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

	it("runs the real focused source-runtime proofs offline and preserves their evidence", async () => {
		const output = mkdtempSync(join(tmpdir(), "drahtbank-runtime-"));
		temporary.push(output);
		vi.stubEnv("DRAHT_PACKAGE_DIR", join(output, "wrong-package"));
		vi.stubEnv("GIT_DIR", join(output, "wrong-git-dir"));
		const report = await runRuntimeChecks(output, { root, timeoutMs: 150_000 });
		// The nested run reports through vitest.json, so its failures never reach stderr.
		const failures = report.results.flatMap((result) => result.failures);
		expect(
			report.errors,
			`${readFileSync(join(output, "stderr.txt"), "utf8")}\n${JSON.stringify(failures, null, 2)}`,
		).toEqual([]);
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
		await expect(runRuntimeChecks(output, { root })).rejects.toThrow("empty");
	}, 180_000);

	it("refuses existing output before launching or changing evidence", async () => {
		const output = mkdtempSync(join(tmpdir(), "drahtbank-runtime-existing-"));
		temporary.push(output);
		writeFileSync(join(output, "evidence"), "keep");
		await expect(runRuntimeChecks(output, { root })).rejects.toThrow("empty");
		expect(readFileSync(join(output, "evidence"), "utf8")).toBe("keep");
	});

	it("records a timed-out runner as incomplete evidence", async () => {
		const output = mkdtempSync(join(tmpdir(), "drahtbank-runtime-timeout-"));
		temporary.push(output);
		const report = await runRuntimeChecks(output, { root, timeoutMs: 1 });
		expect(report).toMatchObject({ complete: false, passed: false, process: { exitCode: null } });
		expect(report.process.error).toContain("ETIMEDOUT");
		expect(report.errors).toContain("Vitest process did not complete successfully");
	});

	it.each(["hoisted", "package-local"])("resolves real runner packages with %s Vitest", async (layout) => {
		const fixture = mkdtempSync(join(tmpdir(), "drahtbank-runtime-dependencies-"));
		temporary.push(fixture);
		const fixturePackage = join(fixture, "packages/coding-agent");
		mkdirSync(fixturePackage, { recursive: true });
		for (const host of ["ai", "draht-claude", "draht-codex"]) {
			symlinkSync(join(root, "packages", host), join(fixture, "packages", host), "junction");
		}
		for (const directory of ["eval", "hooks", "src", "test"]) {
			symlinkSync(join(packageRoot, directory), join(fixturePackage, directory), "junction");
		}
		for (const file of ["package.json", "vitest.config.ts"]) {
			copyFileSync(join(packageRoot, file), join(fixturePackage, file));
		}
		for (const file of ["package.json", "bun.lock"]) copyFileSync(join(root, file), join(fixture, file));
		const installed = createRequire(import.meta.url);
		const tsxManifest = installed.resolve("tsx/package.json");
		const vitestManifest = installed.resolve("vitest/package.json");
		const vitestModules = join(layout === "hoisted" ? fixture : fixturePackage, "node_modules");
		mkdirSync(join(fixture, "node_modules"));
		mkdirSync(vitestModules, { recursive: true });
		cpSync(dirname(tsxManifest), join(fixture, "node_modules/tsx"), { recursive: true });
		cpSync(dirname(vitestManifest), join(vitestModules, "vitest"), { recursive: true });
		expect(existsSync(join(fixture, "node_modules/vitest"))).toBe(layout === "hoisted");
		execFileSync("git", ["init", "--quiet"], { cwd: fixture });
		execFileSync(
			"git",
			[
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"--allow-empty",
				"--quiet",
				"-m",
				"fixture",
			],
			{ cwd: fixture },
		);
		// Resolve and fingerprint the real dependencies before exercising the timeout path.
		const report = await runRuntimeChecks(join(fixture, "output"), { root: fixture, timeoutMs: 1 });
		expect(report.command.slice(1, 3)).toEqual([
			join(fixture, "node_modules/tsx/dist/cli.mjs"),
			join(vitestModules, "vitest/dist/cli.js"),
		]);
		expect(report.identity).toMatchObject({
			tsxVersion: JSON.parse(readFileSync(tsxManifest, "utf8")).version,
			vitestVersion: JSON.parse(readFileSync(vitestManifest, "utf8")).version,
			tsxSha256: hash(readFileSync(installed.resolve("tsx/cli"), "utf8")),
			vitestSha256: hash(readFileSync(installed.resolve("vitest/dist/cli.js"), "utf8")),
		});
		expect(report).toMatchObject({ root: fixture, packageRoot: fixturePackage, complete: false, passed: false });
		expect(report.process.error).toContain("ETIMEDOUT");
	});
});
