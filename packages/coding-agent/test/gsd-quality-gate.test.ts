import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepo } from "./test-utils/git-repo.js";

interface TempRepoFile {
	path: string;
	content: string;
}

interface QualityGateRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

const cleanups: Array<() => void> = [];
const qualityGateScriptPath = new URL("../hooks/gsd/draht-quality-gate.js", import.meta.url);

afterEach(() => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		cleanup?.();
	}
});

describe("GSD quality gate hook", () => {
	it("runs the real hook in an isolated temp repo", () => {
		const repo = createTempGitRepo();
		cleanups.push(repo.cleanup);

		writeRepoFiles(repo.repoPath, [
			{
				path: "package.json",
				content: JSON.stringify({
					name: "quality-gate-fixture",
					private: true,
					scripts: {
						test: "node ./scripts/run-tests.mjs",
					},
				}),
			},
			{
				path: "scripts/run-tests.mjs",
				content: [
					'import { spawnSync } from "node:child_process";',
					"const result = spawnSync(process.execPath, ['--test'], { encoding: 'utf-8' });",
					"if (result.stdout) process.stdout.write(result.stdout);",
					"if (result.stderr) process.stderr.write(result.stderr);",
					"process.exit(result.status ?? 1);",
				].join("\n"),
			},
			{
				path: "test/passing.test.js",
				content: [
					'import test from "node:test";',
					'import assert from "node:assert/strict";',
					"",
					'test("passing fixture", () => {',
					"\tassert.equal(1, 1);",
					"});",
				].join("\n"),
			},
		]);

		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Quality gate passed");
	});
});

function runQualityGate(repoPath: string): QualityGateRunResult {
	const result = spawnSync(process.execPath, [qualityGateScriptPath.pathname, "--strict"], {
		cwd: repoPath,
		encoding: "utf-8",
	});

	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function writeRepoFiles(repoPath: string, files: TempRepoFile[]): void {
	for (const file of files) {
		const filePath = join(repoPath, file.path);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, file.content, "utf-8");
	}
}
