import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Adapter,
	gradeBank,
	HOSTS,
	type PrepareOptions,
	prepareBank,
	readManifest,
	runBank,
	runProcess,
	summarize,
	validateAdapter,
} from "../eval/drahtbank/bank.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const directories: string[] = [];
const fixedMode =
	'export function parseMode(value) { if (typeof value !== "string") throw new Error("Invalid mode"); const mode = value.trim().toLowerCase(); if (!["fast", "safe"].includes(mode)) throw new Error("Invalid mode"); return mode; }\n';
const fixFeature = `writeFileSync(join(request.workspace, "mode.mjs"), ${JSON.stringify(fixedMode)});`;
const done = 'console.log(JSON.stringify({finalText: "Implemented and checked.\\nSTATUS: DONE"}));';

function directory() {
	const path = mkdtempSync(join(tmpdir(), "drahtbank-core-"));
	directories.push(path);
	return path;
}

function bank(options: PrepareOptions = {}) {
	const output = directory();
	const manifest = prepareBank(output, { root, cases: ["feature"], ...options });
	return { output, manifest };
}

function adapter(body = `${fixFeature}\n${done}`, timeoutMs = 3000): Adapter {
	const script = join(directory(), "adapter.mjs");
	writeFileSync(
		script,
		`import assert from "node:assert/strict";\nimport {readFileSync, writeFileSync, rmSync, symlinkSync} from "node:fs";\nimport {join} from "node:path";\nconst request = JSON.parse(readFileSync(0, "utf8"));\n${body}\n`,
	);
	return {
		format: "json",
		command: [process.execPath, script],
		provider: "fixture-provider",
		model: "fixture-model",
		settings: { temperature: 0, enabled: true },
		timeoutMs,
	};
}

afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Drahtbank preparation", () => {
	it("snapshots committed baseline and current host prompts with content hashes and alternating pairs", () => {
		const { output, manifest } = bank({ hosts: HOSTS, cases: ["feature", "diagnosis-only"], repeats: 2 });
		const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		expect(manifest.baselineCommit).toBe(revision);
		expect(manifest.candidateCommit).toBeNull();
		expect(manifest.trials).toHaveLength(24);
		expect(readManifest(output)).toEqual(manifest);
		for (const trial of manifest.trials) {
			const role = trial.caseId === "feature" ? "implementer" : "debugger";
			expect(trial.promptPath).toBe(`packages/${trial.host}/agents/${role}.md`);
			const expected =
				trial.variant === "baseline"
					? execFileSync("git", ["show", `${revision}:${trial.promptPath}`], { cwd: root, encoding: "utf8" })
					: readFileSync(join(root, trial.promptPath), "utf8");
			const prompt = readFileSync(join(output, "control", trial.id, "prompt.md"), "utf8");
			expect(prompt).toBe(expected);
			expect(trial.promptSha256).toBe(createHash("sha256").update(expected).digest("hex"));
			expect(trial.promptBytes).toBe(Buffer.byteLength(expected));
			const task = readFileSync(join(output, "control", trial.id, "task.md"), "utf8");
			expect(trial.taskSha256).toBe(createHash("sha256").update(task).digest("hex"));
			expect(task).toContain(join(output, "workspaces", trial.id));
		}
		for (const host of HOSTS) {
			const order = manifest.trials.filter((trial) => trial.host === host).map((trial) => trial.variant);
			expect(order).toEqual([
				"baseline",
				"candidate",
				"candidate",
				"baseline",
				"candidate",
				"baseline",
				"baseline",
				"candidate",
			]);
		}
	});

	it("can pin the candidate revision and a custom repository prompt path", () => {
		const { manifest } = bank({ baseline: "HEAD", candidate: "HEAD", prompt: "skills/debugging-workflow/SKILL.md" });
		expect(manifest.candidateCommit).toBe(manifest.baselineCommit);
		expect(manifest.trials[0].promptSha256).toBe(manifest.trials[1].promptSha256);
		expect(manifest.trials.every((trial) => trial.promptPath === "skills/debugging-workflow/SKILL.md")).toBe(true);
	});

	it("refuses to replace an existing bank", () => {
		const { output } = bank();
		const before = readFileSync(join(output, "manifest.json"), "utf8");
		expect(() => prepareBank(output, { root, cases: ["feature"] })).toThrow("will not be overwritten");
		expect(readFileSync(join(output, "manifest.json"), "utf8")).toBe(before);
	});

	it.each<PrepareOptions>([
		{ hosts: [] },
		{ hosts: ["coding-agent", "coding-agent"] },
		{ cases: [] },
		{ cases: ["feature", "feature"] },
		{ cases: ["missing-case"] },
		{ repeats: 0 },
		{ repeats: 1.5 },
		{ repeats: 101 },
		{ prompt: "../outside.md" },
		{ prompt: "/absolute.md" },
	])("rejects invalid selections before writing a manifest: %j", (options) => {
		const output = directory();
		expect(() => prepareBank(output, { root, cases: ["feature"], ...options })).toThrow();
		expect(existsSync(join(output, "manifest.json"))).toBe(false);
	});

	it("rejects a changed or incomplete trial matrix", () => {
		const { output, manifest } = bank();
		manifest.trials.pop();
		writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest));
		expect(() => readManifest(output)).toThrow("Incomplete benchmark matrix");
	});
});

describe("Drahtbank execution and independent grading", () => {
	it.each([false, true])(
		"prevents parent Git discovery for nested fixtures (inherited overrides: %s)",
		async (inheritOverrides) => {
			const parent = directory();
			execFileSync("git", ["init", "--quiet", parent]);
			writeFileSync(join(parent, "parent-only.txt"), "Parent checkout content\n");
			const output = join(parent, ".artifacts", "bank");
			const manifest = prepareBank(output, { root, cases: ["feature"] });
			const workspace = join(output, "workspaces", manifest.trials[0].id);
			expect(
				execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: workspace, encoding: "utf8" }).trim(),
			).toBe(realpathSync(parent));
			const runner = adapter(`
import {spawnSync} from "node:child_process";
import {mkdirSync, realpathSync} from "node:fs";
import {dirname} from "node:path";
const nested = join(request.workspace, "nested");
mkdirSync(nested);
try {
  for (const cwd of [request.workspace, nested]) {
    for (const args of [["status", "--short"], ["diff"], ["rev-parse", "--show-toplevel"]]) {
      const run = spawnSync("git", args, {cwd, encoding: "utf8"});
      assert.notEqual(run.status, 0, "Git must not discover the parent checkout: " + args.join(" "));
      assert.equal(run.stdout, "");
    }
  }
} finally {
  rmSync(nested, {recursive: true});
}
assert.equal(process.env.GIT_CEILING_DIRECTORIES, dirname(realpathSync(request.workspace)));
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_PREFIX", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]) {
  assert.equal(process.env[name], undefined, name + " must not be inherited");
}
${fixFeature}
${done}`);
			const configuration = join(directory(), "adapter.json");
			writeFileSync(configuration, JSON.stringify(runner));
			const overrides = inheritOverrides
				? {
						GIT_DIR: join(parent, ".git"),
						GIT_WORK_TREE: parent,
						GIT_COMMON_DIR: join(parent, ".git"),
						GIT_INDEX_FILE: join(parent, ".git", "index"),
						GIT_OBJECT_DIRECTORY: join(parent, ".git", "objects"),
						GIT_ALTERNATE_OBJECT_DIRECTORIES: join(parent, ".git", "objects"),
						GIT_CONFIG: join(parent, ".git", "config"),
						GIT_CONFIG_PARAMETERS: `'core.worktree=${parent}'`,
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: "core.worktree",
						GIT_CONFIG_VALUE_0: parent,
						GIT_PREFIX: "parent-prefix/",
						GIT_CEILING_DIRECTORIES: tmpdir(),
						GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
					}
				: {};
			const executed = spawnSync(
				process.execPath,
				[
					join(root, "packages/coding-agent/bin/drahtbank.mjs"),
					"run",
					output,
					"--adapter",
					configuration,
					"--json",
				],
				{
					cwd: parent,
					encoding: "utf8",
					timeout: 10_000,
					env: { ...process.env, ...overrides },
				},
			);
			const runnerErrors = manifest.trials.map((trial) =>
				readFileSync(join(output, "control", trial.id, "stderr.txt"), "utf8"),
			);
			expect(executed.status, executed.stderr + runnerErrors.join("\n")).toBe(0);
			const report = JSON.parse(executed.stdout);
			expect(report.summary.paired.bothPassed).toBe(1);
			for (const trial of manifest.trials) {
				const execution = JSON.parse(readFileSync(join(output, "control", trial.id, "execution.json"), "utf8"));
				expect(execution.process.gitEnvironment).toEqual({
					policy: "fixture-ceiling-v1",
					ceilingDirectory: dirname(realpathSync(join(output, "workspaces", trial.id))),
				});
			}
		},
	);

	it("passes correct code through a hermetic adapter and records only observed telemetry", async () => {
		const { output } = bank();
		const runner = adapter(`
assert.equal(request.provider, "fixture-provider");
assert.equal(request.model, "fixture-model");
assert.deepEqual(request.settings, {temperature: 0, enabled: true});
assert.equal(request.prompt, readFileSync(request.promptFile, "utf8"));
assert.equal(request.task, readFileSync(request.taskFile, "utf8"));
assert.equal(process.cwd(), request.workspace);
${fixFeature}
console.log(JSON.stringify({finalText: "STATUS: DONE", usage: {inputTokens: 31, outputTokens: 7, costUsd: 0.001}, toolCalls: 2}));`);
		const progress: number[] = [];
		const report = await runBank(output, runner, (entry) => progress.push(entry.index));
		expect(progress).toEqual([1, 2]);
		expect(report.results.every((result) => result.passed)).toBe(true);
		expect(report.summary.paired.bothPassed).toBe(1);
		expect(report.summary.comparableRunner).toBe(true);
		for (const result of report.results) {
			expect(result.telemetrySource).toBe("adapter-reported");
			expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(result.acceptance?.exitCode).toBe(0);
			expect(existsSync(join(output, "control", result.id, "stdout.txt"))).toBe(true);
		}
		expect(report.summary.variants.candidate.metrics.inputTokens).toEqual({ observed: 1, total: 31, median: 31 });
		expect(report.summary.variants.candidate.metrics.cacheReadTokens).toEqual({
			observed: 0,
			total: null,
			median: null,
		});
		expect(JSON.parse(readFileSync(join(output, "report.json"), "utf8"))).toEqual(report);
		await expect(runBank(output, runner)).rejects.toThrow("rather than overwriting trials");
	});

	it("does not equate a DONE report with correct behavior", async () => {
		const { output } = bank();
		const report = await runBank(output, adapter(done));
		for (const result of report.results) {
			expect(result.executionPassed).toBe(true);
			expect(result.statusPassed).toBe(true);
			expect(result.acceptancePassed).toBe(false);
			expect(result.passed).toBe(false);
		}
	});

	it("does not credit a manually repaired workspace to an earlier failed execution", async () => {
		const { output, manifest } = bank();
		const initial = await runBank(output, adapter(done));
		expect(initial.results.every((result) => result.evidenceIntact && !result.acceptancePassed)).toBe(true);
		for (const trial of manifest.trials) writeFileSync(join(output, "workspaces", trial.id, "mode.mjs"), fixedMode);
		const regraded = await gradeBank(output);
		for (const result of regraded.results) {
			expect(result.acceptancePassed).toBe(true);
			expect(result.evidenceIntact).toBe(false);
			expect(result.executionPassed).toBe(false);
			expect(result.passed).toBe(false);
			expect(result.failure).toBe("Execution artifacts changed or incomplete");
		}
	});

	it.each(["stdout.txt", "stderr.txt"])("rejects altered saved runner output: %s", async (filename) => {
		const { output, manifest } = bank();
		const initial = await runBank(output, adapter());
		expect(initial.results.every((result) => result.passed)).toBe(true);
		for (const trial of manifest.trials) {
			writeFileSync(
				join(output, "control", trial.id, filename),
				JSON.stringify({ finalText: "Different report.\nSTATUS: DONE" }),
			);
		}
		const regraded = await gradeBank(output);
		for (const result of regraded.results) {
			expect(result.acceptancePassed).toBe(true);
			expect(result.evidenceIntact).toBe(false);
			expect(result.executionPassed).toBe(false);
			expect(result.passed).toBe(false);
		}
	});

	it("rejects an early zero exit before acceptance assertions finish", async () => {
		const { output } = bank();
		const source = "process.exit(0); export function parseMode(value) { return value; }";
		const report = await runBank(
			output,
			adapter(`writeFileSync(join(request.workspace, "mode.mjs"), ${JSON.stringify(source)});\n${done}`),
		);
		for (const result of report.results) {
			expect(result.acceptance?.exitCode).toBe(0);
			expect(result.acceptancePassed).toBe(false);
			expect(result.passed).toBe(false);
		}
	});

	it.each([
		[
			"protected check",
			'writeFileSync(join(request.workspace, "check.mjs"), "// bypassed");',
			"Changed protected file: check.mjs",
		],
		["missing original", 'rmSync(join(request.workspace, "mode.mjs"));', "Missing original file: mode.mjs"],
		[
			"out-of-scope file",
			'writeFileSync(join(request.workspace, "extra.txt"), "unrequested");',
			"Out-of-scope file: extra.txt",
		],
		[
			"symbolic link",
			'symlinkSync("mode.mjs", join(request.workspace, "linked.mjs"));',
			"Unsupported file type: linked.mjs",
		],
	])("rejects %s changes even with otherwise correct code", async (_name, mutation, violation) => {
		const { output } = bank();
		const report = await runBank(output, adapter(`${fixFeature}\n${mutation}\n${done}`));
		for (const result of report.results) {
			expect(result.scopeViolations).toContain(violation);
			expect(result.scopePassed).toBe(false);
			expect(result.passed).toBe(false);
		}
	});

	it("rejects changed prompt control artifacts before launching an adapter", async () => {
		const { output, manifest } = bank();
		writeFileSync(join(output, "control", manifest.trials[0].id, "prompt.md"), "changed prompt");
		await expect(runBank(output, adapter())).rejects.toThrow("Changed control artifacts");
		expect(existsSync(join(output, "control", manifest.trials[0].id, "execution.json"))).toBe(false);
	});

	it.each(["changed implementation", "extra file", "symlink workspace"])(
		"rejects a contaminated starting fixture before any adapter starts: %s",
		async (mutation) => {
			const { output, manifest } = bank();
			const workspace = join(output, "workspaces", manifest.trials[1].id);
			if (mutation === "changed implementation") writeFileSync(join(workspace, "mode.mjs"), fixedMode);
			else if (mutation === "extra file") writeFileSync(join(workspace, "extra.txt"), "contamination");
			else {
				rmSync(workspace, { recursive: true });
				symlinkSync(join(output, "workspaces", manifest.trials[0].id), workspace, "dir");
			}
			await expect(runBank(output, adapter())).rejects.toThrow(
				/Workspace differs from prepared fixture|Workspace must be a regular directory/,
			);
			for (const trial of manifest.trials) {
				expect(existsSync(join(output, "control", trial.id, "execution.json"))).toBe(false);
			}
		},
	);

	it("checks each fixture again immediately before execution", async () => {
		const { output, manifest } = bank();
		await expect(
			runBank(output, adapter(), ({ index, trial }) => {
				if (index === 2) writeFileSync(join(output, "workspaces", trial.id, "mode.mjs"), fixedMode);
			}),
		).rejects.toThrow("Workspace differs from prepared fixture");
		expect(existsSync(join(output, "control", manifest.trials[0].id, "execution.json"))).toBe(true);
		expect(existsSync(join(output, "control", manifest.trials[1].id, "execution.json"))).toBe(false);
	});

	it("rejects prompt tampering during a run", async () => {
		const { output } = bank();
		const report = await runBank(
			output,
			adapter(`${fixFeature}\nwriteFileSync(request.promptFile, "tampered");\n${done}`),
		);
		expect(report.results.every((result) => result.acceptancePassed)).toBe(true);
		expect(report.results.every((result) => !result.executionPassed && !result.passed)).toBe(true);
	});

	it.each([
		["nonzero process", `${fixFeature}\n${done}\nprocess.exitCode = 9;`],
		["malformed JSON", `${fixFeature}\nconsole.log("not JSON");`],
		[
			"explicit runner error",
			`${fixFeature}\nconsole.log(JSON.stringify({finalText: "STATUS: DONE", error: "provider failed"}));`,
		],
	])("rejects %s despite correct acceptance behavior", async (_name, script) => {
		const { output } = bank();
		const report = await runBank(output, adapter(script));
		expect(report.results.every((result) => result.acceptancePassed)).toBe(true);
		expect(report.results.every((result) => !result.executionPassed && !result.passed)).toBe(true);
	});

	it("terminates a timed-out adapter and records the failure", async () => {
		const { output } = bank();
		const report = await runBank(output, adapter("setInterval(() => {}, 1000);", 100));
		for (const result of report.results) {
			expect(result.failure).toBe("Process timed out");
			expect(result.executionPassed).toBe(false);
			expect(result.passed).toBe(false);
		}
	});

	it("records a launch failure without inventing telemetry", async () => {
		const { output } = bank();
		const runner = adapter();
		runner.command = [join(directory(), "missing-executable")];
		const report = await runBank(output, runner);
		expect(report.results.every((result) => !result.executionPassed && !result.passed)).toBe(true);
		expect(report.results.every((result) => result.failure !== null)).toBe(true);
		expect(report.summary.variants.baseline.metrics.inputTokens).toEqual({ observed: 0, total: null, median: null });
	});

	it.each(["STATUS: DONE\nSTATUS: DONE", "STATUS: DONE\nActually, unfinished", "Finished without a status"])(
		"requires one terminal status marker: %s",
		async (finalText) => {
			const { output } = bank();
			const report = await runBank(
				output,
				adapter(`${fixFeature}\nconsole.log(JSON.stringify({finalText: ${JSON.stringify(finalText)}}));`),
			);
			expect(report.results.every((result) => result.acceptancePassed)).toBe(true);
			expect(report.results.every((result) => result.status === null && !result.passed)).toBe(true);
		},
	);

	it("grades unfinished banks as missing execution instead of completed work", async () => {
		const { output } = bank();
		const report = await gradeBank(output);
		expect(report.results.every((result) => result.failure === "No completed execution")).toBe(true);
		expect(report.results.every((result) => !result.passed)).toBe(true);
		expect(report.summary.comparableRunner).toBe(false);
	});

	it("detects paired regressions and keeps absent usage unknown", async () => {
		const { output } = bank({ repeats: 2 });
		const report = await runBank(
			output,
			adapter(`if (request.workspace.endsWith("-baseline")) { ${fixFeature} }\n${done}`),
		);
		expect(report.summary.paired.total).toBe(2);
		expect(report.summary.paired.regressions).toHaveLength(2);
		expect(report.summary.paired.improvements).toEqual([]);
		expect(report.summary.paired.bothPassed).toBe(0);
		expect(report.summary.paired.medianElapsedDeltaMsOnPairedPasses).toBeNull();
		expect(report.summary.variants.baseline.passed).toBe(2);
		expect(report.summary.variants.candidate.passed).toBe(0);
		for (const variant of ["baseline", "candidate"] as const) {
			expect(report.summary.variants[variant].metrics.inputTokens).toEqual({
				observed: 0,
				total: null,
				median: null,
			});
			expect(report.summary.variants[variant].metrics.toolCalls).toEqual({ observed: 0, total: null, median: null });
		}
	});

	it("does not produce a paired timing delta when elapsed telemetry is absent", async () => {
		const { output } = bank();
		const report = await runBank(output, adapter());
		const results = report.results.map((result) => ({ ...result, elapsedMs: null }));
		expect(summarize(results).paired.medianElapsedDeltaMsOnPairedPasses).toBeNull();
	});
});

describe("Drahtbank process limits", () => {
	it("uses the physical parent as the Git ceiling when a fixture is reached through a symlink", async () => {
		const parent = directory();
		execFileSync("git", ["init", "--quiet", parent]);
		const workspace = join(parent, "fixture");
		mkdirSync(workspace);
		const alias = join(directory(), "workspace-link");
		symlinkSync(workspace, alias, "dir");
		const result = await runProcess(["git", "status", "--short"], { cwd: alias, timeoutMs: 3000 });
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(result.gitEnvironment.ceilingDirectory).toBe(realpathSync(parent));
	});

	it("refuses a ceiling that Git would interpret as multiple paths", async () => {
		const workspace = join(directory(), `parent${delimiter}segment`, "fixture");
		mkdirSync(workspace, { recursive: true });
		await expect(
			runProcess([process.execPath, "-e", "process.exit(0)"], { cwd: workspace, timeoutMs: 3000 }),
		).rejects.toThrow("Git ceiling path-list delimiter");
	});

	it.runIf(process.platform !== "win32")(
		"bounds timeout when a detached descendant retains runner stdout",
		async () => {
			const cwd = directory();
			const pidFile = join(cwd, "descendant.pid");
			const script = join(cwd, "parent.mjs");
			writeFileSync(
				script,
				`
import {spawn} from "node:child_process";
import {writeFileSync} from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], {detached: true, stdio: ["ignore", "inherit", "inherit"]});
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref();
process.exit(0);
`,
			);
			try {
				const started = performance.now();
				const result = await runProcess([process.execPath, script], { cwd, timeoutMs: 500 });
				expect(existsSync(pidFile)).toBe(true);
				expect(result.timedOut).toBe(true);
				expect(result.error).toBe("Process timed out");
				expect(result.elapsedMs).toBeLessThan(2000);
				expect(performance.now() - started).toBeLessThan(2000);
			} finally {
				if (existsSync(pidFile)) {
					const pid = Number(readFileSync(pidFile, "utf8"));
					if (Number.isSafeInteger(pid) && pid > 0) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							/* The bounded descendant may already have exited. */
						}
					}
				}
			}
		},
		8000,
	);

	it("bounds captured output and fails the runner at the output limit", async () => {
		const result = await runProcess(
			[process.execPath, "-e", 'process.stdout.write("x".repeat(11 * 1024 * 1024)); setInterval(() => {}, 1000);'],
			{ cwd: directory(), timeoutMs: 3000 },
		);
		expect(result.error).toBe("Process output exceeded 10 MiB");
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBeNull();
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(10 * 1024 * 1024);
	});
});

describe("Drahtbank adapter configuration", () => {
	it.each([
		{ format: "invalid" },
		{ command: [] },
		{ command: ["node", "\0"] },
		{ model: "" },
		{ provider: " " },
		{ settings: { temperature: Number.NaN } },
		{ timeoutMs: 0 },
		{ timeoutMs: 3_600_001 },
	])("rejects invalid adapter configuration: %j", (invalid) => {
		expect(() => validateAdapter({ ...adapter(), ...invalid })).toThrow();
	});
});

describe("Drahtbank CLI", () => {
	function cli(args: string[]) {
		return spawnSync(process.execPath, [join(root, "packages/coding-agent/bin/drahtbank.mjs"), ...args], {
			cwd: directory(),
			encoding: "utf8",
			timeout: 10_000,
		});
	}

	it("provides help and a machine-readable case catalog without a repository or model", () => {
		const help = cli(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Drahtbank");
		const list = cli(["list", "--json"]);
		expect(list.status).toBe(0);
		const catalog = JSON.parse(list.stdout);
		expect(catalog.hosts).toEqual(HOSTS);
		expect(catalog.cases).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "feature", role: "implementer" })]),
		);
	});

	it.each([
		["unknown"],
		["list", "--unrecognized"],
		["list", "--json", "--json"],
		["list", "unexpected-directory"],
		["prepare"],
		["prepare", "example", "--baseline"],
		["run", "example"],
	])("returns an error for malformed invocation: %j", (...args) => {
		const result = cli(args);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("drahtbank:");
	});

	it("prepares, fails an unfinished grade, runs a local adapter, and reports saved results", () => {
		const output = directory();
		const prepared = cli(["prepare", output, "--repo", root, "--cases", "feature", "--json"]);
		expect(prepared.status).toBe(0);
		expect(JSON.parse(prepared.stdout).trials).toHaveLength(2);
		const unfinished = cli(["grade", output, "--json"]);
		expect(unfinished.status).toBe(1);
		expect(JSON.parse(unfinished.stdout).summary.variants.candidate.passed).toBe(0);
		const configuration = join(directory(), "adapter.json");
		writeFileSync(configuration, JSON.stringify(adapter()));
		const executed = cli(["run", output, "--adapter", configuration, "--json"]);
		expect(executed.status, executed.stderr).toBe(0);
		expect(JSON.parse(executed.stdout).summary.paired.bothPassed).toBe(1);
		expect(executed.stderr).toContain("[2/2]");
		const saved = cli(["report", output, "--json"]);
		expect(saved.status).toBe(0);
		expect(JSON.parse(saved.stdout)).toEqual(JSON.parse(executed.stdout));
		const human = cli(["report", output]);
		expect(human.status).toBe(0);
		expect(human.stdout).toContain("baseline: 1/1 passed");
		expect(human.stdout).toContain("inputTokens: unknown");
	});
});
