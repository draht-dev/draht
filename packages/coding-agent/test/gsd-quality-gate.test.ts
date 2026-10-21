import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
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
	repoFiles: TempRepoFile[];
	tscScriptContent?: string;
	testRunnerContent?: string;
	lintRunnerContent?: string;
	typeScriptConfig?: boolean;
	commandFailure?: { command: "npx tsc" | "npm test"; code?: string; signal?: string };
}

const cleanups: Array<() => void> = [];
const qualityGates = [
	{ name: "coding-agent", path: "../hooks/gsd/draht-quality-gate.js" },
	{ name: "draht-claude", path: "../../draht-claude/scripts/gsd-quality-gate.cjs" },
	{ name: "draht-codex", path: "../../draht-codex/scripts/gsd-quality-gate.cjs" },
].map((gate) => ({
	...gate,
	source: readFileSync(fileURLToPath(new URL(gate.path, import.meta.url)), "utf-8"),
}));
const defaultTypeScriptScriptContent = "#!/usr/bin/env node\nprocess.exit(0);\n";
const checksRuntimeSource = readFileSync(new URL("../hooks/checks/checks-runtime.cjs", import.meta.url), "utf8");

afterEach(() => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		cleanup?.();
	}
});

// The command shims are POSIX executables; never fall through to a real Windows package manager.
describe.skipIf(process.platform === "win32").each(qualityGates)("$name quality gate hook", (gate) => {
	function createFixture(options: QualityGateFixtureOptions) {
		return createQualityGateFixture(gate.source, options);
	}

	it("runs the real hook in an isolated temp repo", () => {
		const repo = createFixture({
			repoFiles: [createPassingTestFile()],
		});

		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Quality gate passed");
	});

	it("fails loudly for failing tests in strict mode", () => {
		const repo = createFixture({
			repoFiles: [createFailingTestFile()],
		});

		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Quality Gate FAILED");
		expect(result.stdout).toContain("1 test(s) failing");
	});

	it("fails when TypeScript compilation reports errors even if tests pass", () => {
		const repo = createFixture({
			repoFiles: [createPassingTestFile(), createTypeScriptErrorSourceFile()],
			tscScriptContent: createFailingTypeScriptScript(),
		});

		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Quality Gate FAILED");
		expect(result.stdout).toContain("TypeScript error(s)");
		expect(result.stdout).toContain("error TS2322");
	});

	it.each([
		{ name: "silent exit", content: "process.exit(7);" },
		{ name: "unrecognized reporter", content: 'console.error("FAIL test/example.test.ts"); process.exit(1);' },
		{ name: "misleading zero-failure summary", content: 'console.log("0 fail"); process.exit(2);' },
	])("rejects a failed test command with $name", ({ content }) => {
		const repo = createFixture({ repoFiles: [], testRunnerContent: content });
		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Test command failed");
		expect(result.stdout).not.toContain("Quality gate passed");
	});

	it("rejects a TypeScript command failure without a TypeScript diagnostic", () => {
		const repo = createFixture({
			repoFiles: [],
			tscScriptContent: "#!/usr/bin/env node\nprocess.exit(7);\n",
			testRunnerContent: "process.exit(0);",
		});
		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("TypeScript command failed (exit 7)");
		expect(result.stdout).not.toContain("Quality gate passed");
	});

	for (const command of ["npx tsc", "npm test"] as const) {
		it.each([
			{ code: "ETIMEDOUT", signal: "SIGTERM", reason: "timed out" },
			{ code: undefined, signal: "SIGTERM", reason: "signal SIGTERM" },
			{ code: "ENOENT", signal: undefined, reason: "ENOENT" },
		])(`rejects ${command} process errors ($reason)`, ({ code, signal, reason }) => {
			const repo = createFixture({
				repoFiles: [],
				testRunnerContent: "process.exit(0);",
				commandFailure: { command, code, signal },
			});
			const result = runQualityGate(repo.repoPath);

			expect(result.status).toBe(1);
			expect(result.stdout).toContain(`command failed (${reason})`);
			expect(result.stdout).not.toContain("Quality gate passed");
		});
	}

	it("records unsuccessful checks as warnings when the project selects advisory mode", () => {
		const repo = createFixture({
			repoFiles: [{ path: ".planning/config.json", content: '{"hooks":{"qualityGateStrict":false}}' }],
			testRunnerContent: "process.exit(7);",
		});
		const result = runQualityGate(repo.repoPath, []);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Test command failed (exit 7)");
		expect(result.stdout).toContain("warning(s)");
		expect(result.stdout).not.toContain("Quality gate passed");
	});

	it("does not run TypeScript in a project without a compiler configuration", () => {
		const repo = createFixture({
			repoFiles: [],
			typeScriptConfig: false,
			testRunnerContent: "process.exit(0);",
			commandFailure: { command: "npx tsc", code: "ENOENT" },
		});
		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("TypeScript check skipped: no tsconfig.json");
	});

	it("finds a TypeScript configuration in a parent directory", () => {
		const repo = createFixture({
			repoFiles: [],
			testRunnerContent: "process.exit(0);",
			commandFailure: { command: "npx tsc", code: "ENOENT" },
		});
		const nested = join(repo.repoPath, "nested");
		mkdirSync(nested);
		const result = runQualityGate(repo.repoPath, ["--strict"], nested);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("TypeScript command failed (ENOENT)");
	});

	it("runs configured lint from a nested working directory in the same package", () => {
		const repo = createFixture({
			repoFiles: [{ path: "biome.json", content: "{}" }],
			lintRunnerContent: "process.exit(7);",
		});
		const nested = join(repo.repoPath, "nested");
		mkdirSync(nested);
		const result = runQualityGate(repo.repoPath, ["--strict", "--checks-only", "--no-tests"], nested);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Lint issues");
		expect(result.stdout).not.toContain("Lint check skipped");
	});

	it("does not inherit an ancestor lint configuration past the nearest package", () => {
		const repo = createFixture({
			repoFiles: [
				{ path: "biome.json", content: "{}" },
				{ path: "nested/package.json", content: '{"private":true}' },
			],
			lintRunnerContent: "process.exit(7);",
		});
		const nested = join(repo.repoPath, "nested", "src");
		mkdirSync(nested);
		const result = runQualityGate(repo.repoPath, ["--strict", "--checks-only", "--no-tests"], nested);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Lint check skipped: no applicable lint script or Biome configuration");
		expect(result.stdout).not.toContain("Lint issues");
	});

	it("runs a package lint script without requiring Biome or injecting Biome-only flags", () => {
		const repo = createFixture({
			repoFiles: [{ path: "package.json", content: '{"scripts":{"lint":"eslint ."}}' }],
			lintRunnerContent: "process.exit(7);",
		});
		const result = runQualityGate(repo.repoPath, ["--checks-only", "--no-tests"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Lint issues");
	});

	it("recognizes Biome JSONC configuration", () => {
		const repo = createFixture({
			repoFiles: [{ path: "biome.jsonc", content: "{}" }],
			lintRunnerContent: "process.exit(7);",
		});
		const result = runQualityGate(repo.repoPath, ["--checks-only", "--no-tests"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Lint issues");
	});

	it("skips tests explicitly when the project has no test script", () => {
		const repo = createFixture({
			repoFiles: [{ path: "package.json", content: '{"private":true}' }],
			testRunnerContent: "process.exit(7);",
		});
		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Tests skipped: no package test script");
	});

	it("runs a failing ancestor test script from a nested working directory", () => {
		const repo = createFixture({ repoFiles: [], testRunnerContent: "process.exit(7);" });
		const nested = join(repo.repoPath, "nested");
		mkdirSync(nested);
		const result = runQualityGate(repo.repoPath, ["--strict"], nested);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Test command failed (exit 7)");
		expect(result.stdout).not.toContain("Tests skipped");
	});

	it("does not inherit an ancestor test script past a nested package without tests", () => {
		const repo = createFixture({
			repoFiles: [{ path: "nested/package.json", content: '{"private":true}' }],
			testRunnerContent: "process.exit(7);",
		});
		const result = runQualityGate(repo.repoPath, ["--strict"], join(repo.repoPath, "nested"));

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Tests skipped: no package test script");
		expect(result.stdout).not.toContain("Test command failed");
	});

	it("fails rather than skipping tests when the package configuration cannot be read", () => {
		const repo = createFixture({ repoFiles: [{ path: "package.json", content: "{" }] });
		const result = runQualityGate(repo.repoPath);

		expect(result.status).toBe(1);
		expect(result.combinedOutput).toMatch(/Test command failed|ERR_INVALID_PACKAGE_CONFIG/);
		expect(result.stdout).not.toContain("Tests skipped");
		expect(result.stdout).not.toContain("Quality gate passed");
	});

	it("preserves the explicit test skip", () => {
		const repo = createFixture({ repoFiles: [], testRunnerContent: "process.exit(7);" });
		const result = runQualityGate(repo.repoPath, ["--strict", "--no-tests"]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Quality gate passed");
	});

	it("uses explicit project checks without inferring an additional full test suite", () => {
		const repo = createFixture({
			repoFiles: [
				{
					path: ".draht/checks.json",
					content: JSON.stringify({
						checks: [{ name: "project", command: [process.execPath, "-e", "process.exit(0)"] }],
					}),
				},
			],
			testRunnerContent: "process.exit(7);",
			tscScriptContent: "#!/usr/bin/env node\nprocess.exit(8);\n",
		});
		const result = runQualityGate(repo.repoPath, ["--checks-only"]);
		expect(result.status, result.combinedOutput).toBe(0);
		expect(result.stdout).toContain("Project checks passed");
		expect(result.stdout).not.toContain("Test command failed");
	});

	it("retains optional manual heuristics when the project defines its own checks", () => {
		const repo = createFixture({
			repoFiles: [
				{
					path: ".draht/checks.json",
					content: JSON.stringify({
						checks: [{ name: "project", command: [process.execPath, "-e", "process.exit(0)"] }],
					}),
				},
				{ path: "src/debug.ts", content: "console.log('debug');" },
			],
			testRunnerContent: "process.exit(7);",
		});
		const result = runQualityGate(repo.repoPath);
		expect(result.status, result.combinedOutput).toBe(0);
		expect(result.stdout).toContain("console.log found");
		expect(result.stdout).not.toContain("Test command failed");
	});

	it("checks-only skips workflow heuristics while the full gate retains them", () => {
		const repo = createFixture({
			repoFiles: [
				{ path: ".planning/config.json", content: '{"hooks":{"tddMode":"strict"}}' },
				{ path: ".planning/DOMAIN-MODEL.md", content: "## Ubiquitous Language\n- Known: documented term\n" },
				{
					path: "src/payments/order.ts",
					content: [
						'import { stock } from "../inventory/stock";',
						"export interface UndocumentedDomain {}",
						"console.log(stock);",
						"// TODO: document the domain",
					].join("\n"),
				},
			],
			testRunnerContent: "process.exit(0);",
		});
		const stage = spawnSync("git", ["add", "src/payments/order.ts"], { cwd: repo.repoPath, encoding: "utf-8" });
		expect(stage.status, stage.stderr).toBe(0);

		const full = runQualityGate(repo.repoPath);
		const checks = runQualityGate(repo.repoPath, ["--strict", "--checks-only"]);

		expect(full.status).toBe(1);
		expect(checks.status).toBe(0);
		for (const diagnostic of [
			"console.log found",
			"not in domain glossary",
			"cross-context import(s)",
			"TDD health",
			"TODO/FIXME comment(s)",
		]) {
			expect(full.stdout).toContain(diagnostic);
			expect(checks.stdout).not.toContain(diagnostic);
		}
	});

	it("checks-only independently rejects configured type, lint, and test failures without GSD", () => {
		const repo = createFixture({
			repoFiles: [{ path: "biome.json", content: "{}" }],
			tscScriptContent: "#!/usr/bin/env node\nprocess.exit(7);\n",
			lintRunnerContent: "process.exit(8);",
			testRunnerContent: "process.exit(9);",
		});
		const result = runQualityGate(repo.repoPath, ["--strict", "--checks-only"]);

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("TypeScript command failed (exit 7)");
		expect(result.stdout).toContain("Lint issues");
		expect(result.stdout).toContain("Test command failed (exit 9)");
	});

	if (gate.name === "coding-agent") {
		it("runs the native .js entrypoint directly within its shipped package boundary", () => {
			const repo = createFixture({ repoFiles: [], testRunnerContent: "process.exit(7);" });
			const entrypoint = fileURLToPath(new URL(gate.path, import.meta.url));
			const result = runQualityGate(
				repo.repoPath,
				["--strict", "--checks-only", "--no-tests"],
				repo.repoPath,
				entrypoint,
			);

			expect(result.status, result.combinedOutput).toBe(0);
			expect(result.stdout).toContain("Quality gate passed");
		});
	}
});

function createQualityGateFixture(source: string, options: QualityGateFixtureOptions) {
	const repo = createTempGitRepo();
	cleanups.push(repo.cleanup);

	writeRepoFiles(repo.repoPath, [
		createPackageJsonFile(),
		...(options.typeScriptConfig === false ? [] : [{ path: "tsconfig.json", content: "{}" }]),
		{ path: "hooks/draht-quality-gate.cjs", content: source },
		{ path: "hooks/checks-runtime.cjs", content: checksRuntimeSource },
		{ path: "checks/checks-runtime.cjs", content: checksRuntimeSource },
		createTestRunnerFile(options.testRunnerContent),
		{ path: "scripts/run-lint.mjs", content: options.lintRunnerContent ?? "process.exit(0);" },
		createTypeScriptShimFile(options.tscScriptContent),
		...createRunnerShims(),
		createProcessFailurePreload(options.commandFailure),
		...options.repoFiles,
	]);

	return repo;
}

function createPackageJsonFile(): TempRepoFile {
	return {
		path: "package.json",
		content: JSON.stringify({
			name: "quality-gate-fixture",
			private: true,
			scripts: {
				test: "node ./scripts/run-tests.mjs",
			},
		}),
	};
}

function createTestRunnerFile(content?: string): TempRepoFile {
	return {
		path: "scripts/run-tests.mjs",
		content:
			content ??
			[
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
	};
}

function createTypeScriptShimFile(tscScriptContent = defaultTypeScriptScriptContent): TempRepoFile {
	return {
		path: "node_modules/.bin/tsc",
		content: tscScriptContent,
		executable: true,
	};
}

function createRunnerShims(): TempRepoFile[] {
	// Resolve only fixture-local runners: no package manager, downloads, or repository suite.
	return [
		{ name: "npx", script: "node_modules/.bin/tsc" },
		{ name: "npm", script: "scripts/run-tests.mjs" },
	].map(({ name, script }) => ({
		path: `bin/${name}`,
		executable: true,
		content: [
			"#!/usr/bin/env node",
			'const { spawnSync } = require("node:child_process");',
			'const { join } = require("node:path");',
			`const script = (process.argv[2] === "run" && process.argv[3] === "lint") || process.argv.includes("biome") ? "scripts/run-lint.mjs" : ${JSON.stringify(script)};`,
			'const result = spawnSync(process.execPath, [join(__dirname, "..", script)], { stdio: "inherit" });',
			"process.exit(result.status ?? 1);",
		].join("\n"),
	}));
}

function createProcessFailurePreload(failure: QualityGateFixtureOptions["commandFailure"]): TempRepoFile {
	return {
		path: "process-failure.cjs",
		// Inject failures at the OS boundary so timeout coverage does not wait for the real 120 s limit.
		content: failure
			? [
					'const cp = require("node:child_process");',
					"const original = cp.execSync;",
					`const failure = ${JSON.stringify(failure)};`,
					"cp.execSync = function(command, options) {",
					"  if (command.startsWith(failure.command)) {",
					'    throw Object.assign(new Error("fixture process failure"), failure, { status: null, stdout: "", stderr: "" });',
					"  }",
					"  return original(command, options);",
					"};",
				].join("\n")
			: "",
	};
}

function runQualityGate(
	repoPath: string,
	args = ["--strict"],
	cwd = repoPath,
	entrypoint = join(repoPath, "hooks/draht-quality-gate.cjs"),
): QualityGateRunResult {
	const result = spawnSync(
		process.execPath,
		["--require", join(repoPath, "process-failure.cjs"), entrypoint, ...args],
		{
			cwd,
			encoding: "utf-8",
			env: { ...process.env, PATH: `${join(repoPath, "bin")}${delimiter}${process.env.PATH}` },
		},
	);

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
	return createNodeTestFile("passing", "assert.equal(1, 1);");
}

function createFailingTestFile(): TempRepoFile {
	return createNodeTestFile("failing", "assert.equal(1, 2);");
}

function createNodeTestFile(name: string, assertion: string): TempRepoFile {
	return {
		path: `test/${name}.test.js`,
		content: [
			'import test from "node:test";',
			'import assert from "node:assert/strict";',
			"",
			`test("${name} fixture", () => {`,
			`\t${assertion}`,
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
		'console.log("npm notice run npx");',
		'console.error(\'src/broken.ts(1,7): error TS2322: Type "string" is not assignable to type "number".\');',
		"process.exit(1);",
	].join("\n");
}
