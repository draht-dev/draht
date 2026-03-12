import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepo } from "./test-utils/git-repo.js";

interface TempRepoFile {
	path: string;
	content: string;
	executable?: boolean;
}

interface QualityGateRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
	combinedOutput: string;
}

interface QualityGateFixtureOptions {
	testFiles: TempRepoFile[];
	tscScriptContent?: string;
}

const cleanups: Array<() => void> = [];
const qualityGateScriptPath = new URL("../hooks/gsd/draht-quality-gate.js", import.meta.url);
const qualityGateScriptSource = readFileSync(fileURLToPath(qualityGateScriptPath), "utf-8");
const defaultTypeScriptScriptContent = "#!/usr/bin/env node\nprocess.exit(0);\n";

afterEach(() => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		cleanup?.();
	}
});

describe("GSD quality gate hook", () => {
	it("runs the real hook in an isolated temp repo", () => {
		const repo = createQualityGateFixture({
			testFiles: [createPassingTestFile()],
		});

		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Quality gate passed");
	});

	it("fails loudly for failing tests in strict mode", () => {
		const repo = createQualityGateFixture({
			testFiles: [createFailingTestFile()],
		});

		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Quality Gate FAILED");
		expect(result.stdout).toContain("1 test(s) failing");
	});

	it("fails when TypeScript compilation reports errors even if tests pass", () => {
		const repo = createQualityGateFixture({
			testFiles: [createPassingTestFile(), createTypeScriptErrorSourceFile()],
			tscScriptContent: createFailingTypeScriptScript(),
		});

		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Quality Gate FAILED");
		expect(result.stdout).toContain("TypeScript error(s)");
		expect(result.stdout).toContain("error TS2322");
	});
});

function createQualityGateFixture(options: QualityGateFixtureOptions) {
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
			path: "hooks/draht-quality-gate.cjs",
			content: qualityGateScriptSource,
			executable: true,
		},
		{
			path: "scripts/run-tests.mjs",
			content: [
				'import { spawnSync } from "node:child_process";',
				"const result = spawnSync(process.execPath, ['--test'], { encoding: 'utf-8' });",
				"if (result.stdout) process.stdout.write(result.stdout);",
				"if (result.stderr) process.stderr.write(result.stderr);",
				"if ((result.status ?? 1) === 0) {",
				"\tconsole.log('0 fail');",
				"} else {",
				"\tconsole.error('1 fail');",
				"}",
				"process.exit(result.status ?? 1);",
			].join("\n"),
		},
		{
			path: "node_modules/.bin/tsc",
			content: options.tscScriptContent ?? defaultTypeScriptScriptContent,
			executable: true,
		},
		...options.testFiles,
	]);

	return repo;
}

function runQualityGate(repoPath: string): QualityGateRunResult {
	const result = spawnSync(process.execPath, [join(repoPath, "hooks/draht-quality-gate.cjs"), "--strict"], {
		cwd: repoPath,
		encoding: "utf-8",
	});

	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		combinedOutput: `${result.stdout}${result.stderr}`,
	};
}

function writeRepoFiles(repoPath: string, files: TempRepoFile[]): void {
	for (const file of files) {
		const filePath = join(repoPath, file.path);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, file.content, "utf-8");
		if (file.executable) {
			chmodSync(filePath, 0o755);
		}
	}
}

function createPassingTestFile(): TempRepoFile {
	return {
		path: "test/passing.test.js",
		content: [
			'import test from "node:test";',
			'import assert from "node:assert/strict";',
			"",
			'test("passing fixture", () => {',
			"\tassert.equal(1, 1);",
			"});",
		].join("\n"),
	};
}

function createFailingTestFile(): TempRepoFile {
	return {
		path: "test/failing.test.js",
		content: [
			'import test from "node:test";',
			'import assert from "node:assert/strict";',
			"",
			'test("failing fixture", () => {',
			"\tassert.equal(1, 2);",
			"});",
		].join("\n"),
	};
}

function createTypeScriptErrorSourceFile(): TempRepoFile {
	return {
		path: "src/broken.ts",
		content: ['const value: number = "not-a-number";', "export { value };"].join("\n"),
	};
}

function createFailingTypeScriptScript(): string {
	return [
		"#!/usr/bin/env node",
		'console.error(\'src/broken.ts(1,7): error TS2322: Type "string" is not assignable to type "number".\');',
		"process.exit(1);",
	].join("\n");
}
