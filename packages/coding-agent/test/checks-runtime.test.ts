import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const runtimes = [
	["coding-agent", "../hooks/checks/checks-runtime.cjs"],
	["draht-claude", "../../draht-claude/scripts/checks-runtime.cjs"],
	["draht-codex", "../../draht-codex/scripts/checks-runtime.cjs"],
].map(([name, relative]) => ({ name, script: fileURLToPath(new URL(relative, import.meta.url)) }));

interface CheckResult {
	status: "passed" | "failed" | "skipped";
	configured: boolean;
	summary: string;
	checks: Array<{ name: string; status: "passed" | "failed" | "cached"; reason?: string; output?: string }>;
}

interface CheckConfig {
	name: string;
	command: string[];
	inputs?: string[];
	cwd?: string;
	timeoutMs?: number;
	cache?: boolean;
}

describe.each(runtimes)("$name project checks runtime", ({ script }) => {
	let fixture: string;
	let cwd: string;
	let marker: string;

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), "draht-checks-"));
		cwd = join(fixture, "repo");
		marker = join(fixture, "runs.txt");
		mkdirSync(cwd);
		execFileSync("git", ["init", "--quiet"], { cwd });
		write("src/example.py", "original\n");
	});

	afterEach(() => rmSync(fixture, { recursive: true, force: true }));

	function write(file: string, content: string) {
		const absolute = join(cwd, file);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, content);
	}

	function configure(checks: CheckConfig[] = [check()]) {
		write(".draht/checks.json", JSON.stringify({ checks }));
	}

	function check(overrides: Partial<CheckConfig> = {}): CheckConfig {
		return {
			name: "source check",
			command: [process.execPath, "-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run\\n')`],
			inputs: ["src"],
			...overrides,
		};
	}

	function run(options: { force?: boolean; directory?: string; preload?: string } = {}) {
		const args: string[] = [];
		if (options.preload) {
			const preload = join(fixture, "preload.cjs");
			writeFileSync(preload, options.preload);
			args.push("--require", preload);
		}
		args.push(script, "--cwd", options.directory ?? cwd, "--json");
		if (options.force) args.push("--force");
		const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 10000 });
		expect(result.error, result.stderr).toBeUndefined();
		const data: CheckResult = JSON.parse(result.stdout);
		expect(result.status, result.stderr).toBe(data.status === "failed" ? 1 : 0);
		return data;
	}

	it("does not infer commands when the project has no check configuration", () => {
		write("package.json", '{"scripts":{"test":"a-command-that-must-not-run"}}');
		expect(run()).toMatchObject({ status: "skipped", configured: false });
	});

	it("reuses successful evidence until an input changes", () => {
		configure();
		expect(run().checks[0].status).toBe("passed");
		expect(run().checks[0].status).toBe("cached");
		write("src/example.py", "changed\n");
		expect(run().checks[0].status).toBe("passed");
		expect(readFileSync(marker, "utf8")).toBe("run\nrun\n");
	});

	it.each(["src/", "./src/", "./"])("tracks changes for directory input %s", (input) => {
		configure([check({ inputs: [input] })]);
		expect(run().checks[0].status).toBe("passed");
		expect(run().checks[0].status).toBe("cached");
		write("src/example.py", "changed\n");
		expect(run().checks[0].status).toBe("passed");
		expect(readFileSync(marker, "utf8")).toBe("run\nrun\n");
	});

	it.each([
		{ boundary: "symlink", input: "vendor", configRoot: "." },
		{ boundary: "symlink", input: "vendor/src", configRoot: "." },
		{ boundary: "untracked symlink", input: "vendor/src", configRoot: "." },
		{ boundary: "ignored symlink", input: "vendor", configRoot: "." },
		{ boundary: "ignored symlink", input: "vendor/src", configRoot: "." },
		{ boundary: "submodule", input: "vendor", configRoot: "." },
		{ boundary: "submodule", input: "vendor/src", configRoot: "." },
		{ boundary: "symlink", input: "vendor/src", configRoot: "nested" },
		{ boundary: "submodule", input: "vendor/src", configRoot: "nested" },
	])(
		"does not reuse checks for $input across a $boundary boundary in $configRoot",
		({ boundary, input, configRoot }) => {
			cwd = join(cwd, configRoot);
			write("src/example.py", "original\n");
			const dependency = join(fixture, "dependency");
			mkdirSync(join(dependency, "src"), { recursive: true });
			writeFileSync(join(dependency, "src/example.py"), "valid\n");
			if (boundary !== "submodule") {
				symlinkSync(dependency, join(cwd, "vendor"), "junction");
				if (boundary === "symlink") execFileSync("git", ["add", "vendor"], { cwd });
				if (boundary === "ignored symlink") write(".gitignore", "vendor\n");
			} else {
				execFileSync("git", ["init", "--quiet"], { cwd: dependency });
				execFileSync("git", ["add", "src/example.py"], { cwd: dependency });
				execFileSync(
					"git",
					["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"],
					{ cwd: dependency },
				);
				execFileSync(
					"git",
					["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", dependency, "vendor"],
					{
						cwd,
					},
				);
			}
			configure([
				check({
					name: "dependency source",
					inputs: [input],
					command: [
						process.execPath,
						"-e",
						"process.exit(require('node:fs').readFileSync('vendor/src/example.py', 'utf8') === 'valid\\n' ? 0 : 1)",
					],
				}),
				check(),
			]);
			expect(run().checks.map((entry) => entry.status)).toEqual(["passed", "passed"]);
			write("vendor/src/example.py", "broken\n");
			expect(run().checks.map((entry) => entry.status)).toEqual(["failed", "cached"]);
			expect(readFileSync(marker, "utf8")).toBe("run\n");
		},
	);

	it("does not invalidate a scoped check for unrelated documentation", () => {
		configure();
		run();
		write("readme.md", "unrelated\n");
		expect(run().checks[0].status).toBe("cached");
	});

	it("invalidates evidence when the command configuration changes", () => {
		configure();
		run();
		configure([check({ timeoutMs: 9000 })]);
		expect(run().checks[0].status).toBe("passed");
	});

	it("includes every project file when inputs are omitted", () => {
		configure([check({ inputs: undefined })]);
		run();
		write("readme.md", "new project input\n");
		expect(run().checks[0].status).toBe("passed");
	});

	it("ignores dependency directories but includes explicit ignored input files", () => {
		write(".gitignore", "node_modules/\ngenerated.schema\n");
		configure([check({ inputs: undefined })]);
		run();
		write("node_modules/dependency/index.js", "changed dependency\n");
		expect(run().checks[0].status).toBe("cached");
		configure([check({ inputs: ["generated.schema"] })]);
		write("generated.schema", "first");
		run();
		write("generated.schema", "second");
		expect(run().checks[0].status).toBe("passed");
	});

	it("invalidates additions, deletions, and renames with unusual file names", () => {
		configure();
		run();
		write('src/new line\n"quoted".py', "added");
		expect(run().checks[0].status).toBe("passed");
		renameSync(join(cwd, 'src/new line\n"quoted".py'), join(cwd, "src/renamed.py"));
		expect(run().checks[0].status).toBe("passed");
		rmSync(join(cwd, "src/renamed.py"));
		expect(run().checks[0].status).toBe("passed");
	});

	it("validates committed non-JavaScript work and reuses identical committed content", () => {
		configure();
		execFileSync("git", ["add", "src/example.py", ".draht/checks.json"], { cwd });
		execFileSync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"],
			{ cwd },
		);
		expect(run().checks[0].status).toBe("passed");
		write("src/example.py", "committed change\n");
		execFileSync("git", ["add", "src/example.py"], { cwd });
		execFileSync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "change"],
			{ cwd },
		);
		expect(run().checks[0].status).toBe("passed");
		expect(run().checks[0].status).toBe("cached");
	});

	it("retries failed evidence on every attempt and reports actual process failure", () => {
		configure([check({ command: [process.execPath, "-e", "console.log('0 fail'); process.exit(7)"] })]);
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(run()).toMatchObject({
				status: "failed",
				checks: [{ status: "failed", reason: "exit 7", output: "0 fail\n" }],
			});
		}
	});

	it.each([
		["signal", "process.kill(process.pid, 'SIGTERM')", "SIGTERM"],
		["timeout", "setTimeout(() => {}, 5000)", "ETIMEDOUT"],
	])("rejects a %s", (_label, code, reason) => {
		configure([check({ command: [process.execPath, "-e", code], timeoutMs: 100 })]);
		expect(run()).toMatchObject({ status: "failed", checks: [{ reason }] });
	});

	it("rejects launch errors and unknown process statuses", () => {
		configure([check({ command: ["draht-missing-check-command"] })]);
		expect(run()).toMatchObject({ status: "failed", checks: [{ reason: "ENOENT" }] });
		configure();
		expect(run({ preload: 'require("node:child_process").spawnSync = () => ({status:null})' })).toMatchObject({
			status: "failed",
			checks: [{ reason: "unknown exit" }],
		});
	});

	it("runs checks independently after a failure", () => {
		configure([check({ name: "failure", command: [process.execPath, "-e", "process.exit(1)"] }), check()]);
		expect(run().checks.map((entry) => entry.status)).toEqual(["failed", "passed"]);
		expect(existsSync(marker)).toBe(true);
	});

	it("supports force and cache:false for checks dependent on external state", () => {
		configure();
		run();
		expect(run({ force: true }).checks[0].status).toBe("passed");
		configure([check({ cache: false })]);
		run();
		expect(run().checks[0].status).toBe("passed");
	});

	it("does not retain a cached success after a forced check fails", () => {
		configure();
		run();
		expect(run({ force: true, preload: 'require("node:child_process").spawnSync = () => ({status:1})' }).status).toBe(
			"failed",
		);
		expect(run().checks[0].status).toBe("passed");
	});

	it("rejects passing commands that changed their own checked inputs", () => {
		configure([
			check({
				command: [process.execPath, "-e", "require('node:fs').writeFileSync('src/example.py', String(Date.now()))"],
			}),
		]);
		expect(run()).toMatchObject({
			status: "failed",
			checks: [{ reason: "Check inputs changed during verification; run again" }],
		});
	});

	it("invalidates an earlier successful check when a later command changes its inputs", () => {
		configure([
			check(),
			check({
				name: "formatter",
				cache: false,
				command: [process.execPath, "-e", "require('node:fs').writeFileSync('src/example.py', String(Date.now()))"],
			}),
		]);
		const result = run();
		expect(result.status).toBe("failed");
		expect(result.checks[0]).toMatchObject({
			status: "failed",
			reason: "Check inputs changed during verification; run again",
		});
	});

	it("invalidates evidence if a command changes configuration outside its input scope", () => {
		configure([
			check({ command: [process.execPath, "-e", "require('node:fs').appendFileSync('.draht/checks.json', ' ') "] }),
		]);
		expect(run()).toMatchObject({
			status: "failed",
			checks: [{ reason: "Check inputs changed during verification; run again" }],
		});
	});

	it("does not launch further checks after the total command budget expires", () => {
		configure();
		const result = run({ preload: "let now = 0; Date.now = () => (now += 200000);" });
		expect(result).toMatchObject({ status: "failed", checks: [{ reason: "Total check time limit reached" }] });
		expect(existsSync(marker)).toBe(false);
	});

	it("finds ancestor configuration and runs each command from its declared package", () => {
		mkdirSync(join(cwd, "nested", "package"), { recursive: true });
		configure([check({ cwd: "nested/package", command: [process.execPath, "-e", "console.log(process.cwd())"] })]);
		const result = run({ directory: join(cwd, "nested") });
		expect(result.checks[0].output?.trim()).toBe(join(cwd, "nested", "package"));
	});

	it("runs configured checks without Git without pretending to cache evidence", () => {
		rmSync(join(cwd, ".git"), { recursive: true, force: true });
		configure();
		expect(run().checks[0].status).toBe("passed");
		expect(run().checks[0].status).toBe("passed");
	});

	it("fails on Git inspection errors instead of skipping configured verification", () => {
		configure();
		expect(
			run({
				preload:
					'require("node:child_process").execFileSync = () => { throw new Error("cannot inspect worktree") }',
			}),
		).toMatchObject({ status: "failed", configured: true });
	});

	it.each([
		"{",
		'{"checks":[]}',
		'{"checks":[{"name":"bad","command":"echo bad"}]}',
		'{"checks":[{"name":"bad","command":["node"],"cwd":"../outside"}]}',
	])("rejects invalid configuration %s", (config) => {
		write(".draht/checks.json", config);
		expect(run()).toMatchObject({ status: "failed", configured: true });
	});

	it("allows explicit opt-out without requiring a planning directory", () => {
		write(".draht/checks.json", '{"enabled":false}');
		expect(run()).toMatchObject({ status: "skipped", configured: true });
		expect(existsSync(join(cwd, ".planning"))).toBe(false);
	});
});
