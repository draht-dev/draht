import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const hosts = ["coding-agent", "draht-claude", "draht-codex"];

export const RUNTIME_CHECKS = [
	{
		id: "native-settlement", file: "test/suite/completion-checks.test.ts",
		requiredTests: [
			"does no automatic checks in an unconfigured project",
			"never executes project commands before trust is granted",
			"checks before settlement and gives the model real failure diagnostics to repair",
			"aborts after three failed repairs and leaves a visible failure instead of success",
			"records synchronous runner launch failures and enforces the repair cap",
			"checks edits from later registered settlement handlers before accepting completion",
			"preserves other settlement entries and continuation requests",
			"cancels running checks promptly and starts the next request with a fresh signal",
			"reuses valid evidence then reruns checks after a committed non-JavaScript change",
		].map(title => `automatic project checks ${title}`),
	},
	{
		id: "configured-runtime", file: "test/checks-runtime.test.ts",
		requiredTests: hosts.flatMap(host => [
			"reuses successful evidence until an input changes",
			"invalidates evidence when the command configuration changes",
			"validates committed non-JavaScript work and reuses identical committed content",
			"retries failed evidence on every attempt and reports actual process failure",
			"does not retain a cached success after a forced check fails",
			"invalidates an earlier successful check when a later command changes its inputs",
			"invalidates evidence if a command changes configuration outside its input scope",
		].map(title => `'${host}' project checks runtime ${title}`)),
	},
	{
		id: "plugin-stop", file: "test/plugin-stop-quality-gate.test.ts",
		requiredTests: hosts.slice(1).flatMap(host => [
			"does not let the host retry flag turn a failed check into a pass",
			"runs configured checks for committed non-JavaScript changes without planning",
			"honors a project checks opt-out without planning metadata",
			"blocks malformed project check configuration",
		].map(title => `'${host}' stop quality gate ${title}`)),
	},
];

const SOURCE_PATHS = [
	"packages/coding-agent/eval/drahtbank/runtime-checks.mjs",
	...RUNTIME_CHECKS.map(check => `packages/coding-agent/${check.file}`),
	"packages/coding-agent/test/suite/harness.ts",
	"packages/coding-agent/test/model-runtime-test-utils.ts",
	"packages/coding-agent/test/utilities.ts",
	"packages/coding-agent/test/setup/restore-cwd.ts",
	"packages/coding-agent/test/setup/emitted-build-run.ts",
	"packages/coding-agent/vitest.config.ts",
	"packages/coding-agent/src/config.ts",
	"packages/coding-agent/src/core/builtins/completion-checks.ts",
	"packages/coding-agent/src/core/builtins/index.ts",
	"packages/coding-agent/src/core/agent-session.ts",
	"packages/coding-agent/src/core/agent-session-services.ts",
	"packages/coding-agent/src/core/extensions/runner.ts",
	"packages/coding-agent/src/utils/child-process.ts",
	"packages/ai/src/providers/faux.ts",
	"packages/coding-agent/hooks/checks/checks-runtime.cjs",
	...hosts.slice(1).flatMap(host => [
		`packages/${host}/scripts/checks-runtime.cjs`, `packages/${host}/scripts/stop-quality-gate.cjs`,
	]),
	"package.json", "bun.lock", "packages/coding-agent/package.json",
];

/** Validate the complete selected test run, including named behavioral proofs. */
export function assessRuntimeChecks(value, packageRoot) {
	const errors = [], results = [];
	const reject = message => errors.push(message);
	if (!value || typeof value !== "object" || !Array.isArray(value.testResults)) {
		return { complete: false, passed: false, tests: 0, results, errors: ["Missing Vitest JSON test results"] };
	}
	if (value.testResults.length !== RUNTIME_CHECKS.length) reject("Expected exactly the three selected test files");
	const seenFiles = new Set();
	let tests = 0, passed = 0, failed = 0, skipped = 0, todo = 0;
	for (const proof of RUNTIME_CHECKS) {
		const path = resolve(packageRoot, proof.file);
		const matches = value.testResults.filter(result => result?.name === path);
		if (matches.length !== 1 || !Array.isArray(matches[0]?.assertionResults)) {
			reject(`Missing or duplicate test file: ${proof.file}`); continue;
		}
		seenFiles.add(path);
		const result = matches[0], names = new Set();
		if (!["passed", "failed"].includes(result.status)) reject(`Invalid test-file status: ${proof.file}`);
		if (!result.assertionResults.length) reject(`Empty test file: ${proof.file}`);
		for (const assertion of result.assertionResults) {
			tests++;
			if (typeof assertion?.fullName !== "string" || !assertion.fullName || names.has(assertion.fullName)) reject(`Invalid or duplicate assertion: ${proof.file}`);
			names.add(assertion?.fullName);
			if (assertion?.status === "passed") passed++;
			else if (assertion?.status === "failed") failed++;
			else if (assertion?.status === "todo") todo++;
			else if (["skipped", "pending", "disabled"].includes(assertion?.status)) skipped++;
			else reject(`Invalid assertion status: ${proof.file}`);
		}
		for (const name of proof.requiredTests) if (!names.has(name)) reject(`Missing required proof: ${name}`);
		results.push({ id: proof.id, file: proof.file, status: result.status, tests: result.assertionResults.length,
			requiredProofs: proof.requiredTests.length, failures: result.assertionResults.filter(a => a?.status === "failed").map(a => ({ name: a.fullName, messages: a.failureMessages })) });
	}
	if (seenFiles.size !== value.testResults.length) reject("Unselected test files in report");
	for (const [name, expected] of Object.entries({ numTotalTests: tests, numPassedTests: passed, numFailedTests: failed, numPendingTests: skipped, numTodoTests: todo })) {
		if (value[name] !== expected) reject(`Inconsistent Vitest count: ${name}`);
	}
	if (skipped || todo) reject("Skipped, pending, disabled or todo tests do not establish runtime evidence");
	if (value.numPendingTestSuites !== 0) reject("Pending test suites do not establish runtime evidence");
	const complete = errors.length === 0;
	if (failed || value.numFailedTestSuites !== 0 || value.success !== true || results.some(result => result.status !== "passed")) reject("Runtime checks failed");
	return { complete, passed: errors.length === 0, tests, results, errors };
}

function snapshot(root) {
	return Object.fromEntries(SOURCE_PATHS.map(path => [path, hash(readFileSync(join(root, path)))]));
}

export function runRuntimeChecks(output, options = {}) {
	const root = resolve(options.root ?? ROOT), packageRoot = join(root, "packages/coding-agent");
	output = resolve(output);
	const timeoutMs = options.timeoutMs ?? 180_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("timeoutMs must be from 1 to 3600000");
	if (existsSync(output) && readdirSync(output).length) throw new Error("Choose an empty runtime-checks output directory");
	const sourcesBefore = snapshot(root);
	const packageRequire = createRequire(join(packageRoot, "package.json"));
	const tsx = packageRequire.resolve("tsx/cli"), vitest = packageRequire.resolve("vitest/dist/cli.js");
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && name !== "NODE_OPTIONS"));
	const identity = { node: process.version, platform: process.platform, arch: process.arch, nodeSha256: hash(readFileSync(process.execPath)),
		evaluatorPath: fileURLToPath(import.meta.url), evaluatorSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
		tsxSha256: hash(readFileSync(tsx)), vitestSha256: hash(readFileSync(vitest)),
		tsxVersion: JSON.parse(readFileSync(packageRequire.resolve("tsx/package.json"))).version,
		vitestVersion: JSON.parse(readFileSync(packageRequire.resolve("vitest/package.json"))).version,
		commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim(),
		sourceChanges: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ...SOURCE_PATHS], { cwd: root, env, encoding: "utf8" }).trim() };
	mkdirSync(output, { recursive: true });
	mkdirSync(join(output, "agent-home"));
	const args = [tsx, vitest, "--run", ...RUNTIME_CHECKS.map(proof => proof.file), "--maxWorkers=1", "--no-file-parallelism", "--reporter=json", `--outputFile=${join(output, "vitest.json")}`];
	const command = [process.execPath, ...args];
	Object.assign(env, { DRAHT_OFFLINE: "1", DRAHT_PACKAGE_DIR: packageRoot, DRAHT_CODING_AGENT_DIR: join(output, "agent-home") });
	const startedAt = new Date().toISOString(), started = performance.now();
	const processResult = spawnSync(process.execPath, args, { cwd: packageRoot, env, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
	const elapsedMs = Math.round(performance.now() - started);
	const stdout = processResult.stdout ?? "", stderr = processResult.stderr ?? "";
	writeFileSync(join(output, "stdout.txt"), stdout);
	writeFileSync(join(output, "stderr.txt"), stderr);
	let raw = null, reportError = null;
	try { raw = JSON.parse(readFileSync(join(output, "vitest.json"), "utf8")); } catch (error) { reportError = error.message; }
	const assessment = assessRuntimeChecks(raw, packageRoot);
	let sourcesAfter = null;
	try { sourcesAfter = snapshot(root); } catch (error) { assessment.errors.push(`Source snapshot failed: ${error.message}`); }
	const sourcesStable = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter);
	if (!sourcesStable) assessment.errors.push("Runtime source or test files changed during evaluation");
	if (processResult.status !== 0 || processResult.signal || processResult.error) assessment.errors.push("Vitest process did not complete successfully");
	const report = { schemaVersion: 1, lane: "runtime-checks", startedAt, completedAt: new Date().toISOString(),
		complete: assessment.complete && processResult.status !== null && !processResult.signal && !processResult.error,
		passed: assessment.errors.length === 0, modelCalls: 0, root, packageRoot, identity,
		command, environment: { offline: true, packageDirectory: packageRoot, isolatedAgentDirectory: true, inheritedGitOverridesRemoved: true, inheritedNodeOptionsRemoved: true },
		sourcesBefore, sourcesAfter, sourcesStable, process: { exitCode: processResult.status, signal: processResult.signal, error: processResult.error?.message ?? null, elapsedMs },
		stdoutSha256: hash(stdout), stderrSha256: hash(stderr), vitestSha256: existsSync(join(output, "vitest.json")) ? hash(readFileSync(join(output, "vitest.json"))) : null,
		reportError, tests: assessment.tests, results: assessment.results, errors: assessment.errors,
		limits: ["Source-runtime regression evidence, separate from model prompt quality and resource scores.",
			"Native lifecycle tests use the existing AgentSession harness and faux provider with an explicitly registered completion builtin; they do not launch an installed CLI.",
			"Plugin tests exercise both Stop scripts and actual configured checks; the fallback quality gate is stubbed and host hook registration is not exercised.",
			"Selected source and harness hashes identify these proofs; this is not a dependency-closure attestation or a security sandbox."] };
	json(join(output, "report.json"), report);
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [output, ...rest] = process.argv.slice(2);
		if (!output || ["--help", "-h"].includes(output)) {
			console.log("Usage: node runtime-checks.mjs <empty-output-directory> [--repo <path>]");
		} else {
			if (rest.length && (rest.length !== 2 || rest[0] !== "--repo" || !rest[1])) throw new Error("Expected optional --repo <path>");
			const report = runRuntimeChecks(output, { root: rest[1] });
			console.log(JSON.stringify({ lane: report.lane, complete: report.complete, passed: report.passed, tests: report.tests, report: join(resolve(output), "report.json") }));
			process.exitCode = report.passed ? 0 : 1;
		}
	} catch (error) { console.error(`drahtbank runtime-checks: ${error.message}`); process.exitCode = 1; }
}
