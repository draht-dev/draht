import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hooks = ["draht-claude", "draht-codex"].map((name) => ({
	name,
	path: fileURLToPath(new URL(`../../${name}/scripts/stop-quality-gate.cjs`, import.meta.url)),
}));

describe.each(hooks)("$name stop quality gate", (hook) => {
	let fixture: string;
	let cwd: string;
	let script: string;
	let marker: string;

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), "draht-stop-gate-"));
		cwd = join(fixture, "repo");
		mkdirSync(cwd);
		execFileSync("git", ["init", "--quiet"], { cwd });
		const scripts = join(fixture, "scripts");
		mkdirSync(scripts);
		script = join(scripts, "stop-quality-gate.cjs");
		copyFileSync(hook.path, script);
		copyFileSync(join(dirname(hook.path), "checks-runtime.cjs"), join(scripts, "checks-runtime.cjs"));
		marker = join(fixture, "gate-run.json");
		writeFileSync(
			join(scripts, "gsd-quality-gate.cjs"),
			`const fs = require("node:fs");
fs.writeFileSync(process.env.DRAHT_TEST_GATE_MARKER, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(process.env.DRAHT_TEST_GATE_STDOUT || "");
process.stderr.write(process.env.DRAHT_TEST_GATE_STDERR || "");
process.exit(Number(process.env.DRAHT_TEST_GATE_EXIT || 0));
`,
		);
	});

	afterEach(() => rmSync(fixture, { recursive: true, force: true }));

	function write(relativePath: string, content = "export const value = 1;\n") {
		const filePath = join(cwd, relativePath);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, content);
	}

	function run(options: { payload?: object; env?: Record<string, string>; preload?: string } = {}) {
		const args: string[] = [];
		if (options.preload) {
			const preload = join(fixture, "preload.cjs");
			writeFileSync(preload, options.preload);
			args.push("--require", preload);
		}
		args.push(script);
		return spawnSync(process.execPath, args, {
			cwd,
			encoding: "utf8",
			input: JSON.stringify({ cwd, ...options.payload }),
			env: { ...process.env, DRAHT_TEST_GATE_MARKER: marker, ...options.env },
			timeout: 10000,
		});
	}

	it("checks untracked source without planning metadata", () => {
		write("source.ts");
		const result = run({ env: { DRAHT_TEST_GATE_EXIT: "1" } });
		expect(result.status, result.stderr).toBe(2);
		expect(result.stderr).toContain("Quality gate failed");
		expect(existsSync(join(cwd, ".planning"))).toBe(false);
		expect(existsSync(marker)).toBe(true);
	});

	it("checks staged source", () => {
		write("source.ts");
		execFileSync("git", ["add", "source.ts"], { cwd });
		expect(run({ env: { DRAHT_TEST_GATE_EXIT: "1" } }).status).toBe(2);
	});

	it.each(["new directory/source.ts", "quoted name 'one'.tsx", "unicode-ä.js"])(
		"checks untracked source path %s",
		(file) => {
			write(file);
			expect(run({ env: { DRAHT_TEST_GATE_EXIT: "1" } }).status).toBe(2);
		},
	);

	it.each([
		["renamed source", "R  docs.md\0source.ts\0", true],
		["renamed destination", "R  destination.ts\0source.md\0", true],
		["renamed documentation", "R  docs/new.md\0source-like.ts/readme.md\0", false],
		["deleted source", " D deleted.ts\0", true],
		["quoted path", '?? source "quoted".ts\0', true],
		["newline path", "?? source\nline.ts\0", true],
	])("parses NUL-delimited status for %s", (_label, status, shouldRun) => {
		const result = run({
			env: { DRAHT_TEST_GATE_EXIT: "1" },
			preload: `const cp = require("node:child_process");
const original = cp.execFileSync;
cp.execFileSync = (command, args, options) => {
  if (command === "git" && args[0] === "status") return ${JSON.stringify(status)};
  return original(command, args, options);
};`,
		});
		expect(result.status, result.stderr).toBe(shouldRun ? 2 : 0);
		expect(existsSync(marker)).toBe(shouldRun);
	});

	it("skips clean repositories", () => {
		expect(run().status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("skips documentation-only changes", () => {
		write("docs/readme.md", "Documentation\n");
		expect(run().status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("skips directories outside Git", () => {
		rmSync(join(cwd, ".git"), { recursive: true, force: true });
		write("source.ts");
		expect(run().status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("honors the explicit project opt-out", () => {
		write("source.ts");
		write(".planning/config.json", JSON.stringify({ hooks: { stopGate: false } }));
		expect(run({ env: { DRAHT_TEST_GATE_EXIT: "1" } }).status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("does not let the host retry flag turn a failed check into a pass", () => {
		write("source.ts");
		expect(run({ payload: { stop_hook_active: true }, env: { DRAHT_TEST_GATE_EXIT: "1" } }).status).toBe(2);
		expect(existsSync(marker)).toBe(true);
	});

	it("runs configured checks for committed non-JavaScript changes without planning", () => {
		write("source.py", "broken\n");
		write(
			".draht/checks.json",
			JSON.stringify({ checks: [{ name: "python fixture", command: [process.execPath, "-e", "process.exit(3)"] }] }),
		);
		execFileSync("git", ["add", "source.py", ".draht/checks.json"], { cwd });
		execFileSync(
			"git",
			["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"],
			{ cwd },
		);
		const result = run({ payload: { stop_hook_active: true } });
		expect(result.status, result.stderr).toBe(2);
		expect(result.stderr).toContain("python fixture (exit 3)");
		expect(existsSync(marker)).toBe(false);
	});

	it("honors a project checks opt-out without planning metadata", () => {
		write("source.ts");
		write(".draht/checks.json", '{"enabled":false}');
		expect(run({ env: { DRAHT_TEST_GATE_EXIT: "1" } }).status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("blocks malformed project check configuration", () => {
		write(".draht/checks.json", "{");
		expect(run().status).toBe(2);
	});

	it("uses the supplied cwd and skips tests without overriding strictness", () => {
		write("source.ts");
		write(".planning/config.json", JSON.stringify({ hooks: { qualityGateStrict: false } }));
		const result = run({ env: { DRAHT_TEST_GATE_STDOUT: "Advisory verification warning\n" } });
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ args: ["--no-tests", "--checks-only"], cwd });
	});

	it("keeps the gate active when optional planning config is malformed", () => {
		write("source.ts");
		write(".planning/config.json", "{");
		expect(run({ env: { DRAHT_TEST_GATE_EXIT: "1" } }).status).toBe(2);
	});

	it("reports bounded output from both streams on failure", () => {
		write("source.ts");
		const result = run({
			env: {
				DRAHT_TEST_GATE_EXIT: "1",
				DRAHT_TEST_GATE_STDOUT: `stdout detail ${"a".repeat(5000)}`,
				DRAHT_TEST_GATE_STDERR: `stderr detail ${"b".repeat(5000)}`,
			},
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("stdout detail");
		expect(result.stderr).toContain("stderr detail");
		expect(result.stderr.length).toBeLessThan(4000);
	});

	it.each([
		[
			"timeout",
			'{ error: Object.assign(new Error("deadline exceeded"), { code: "ETIMEDOUT" }), status: null }',
			"ETIMEDOUT",
		],
		[
			"launch failure",
			'{ error: Object.assign(new Error("cannot spawn"), { code: "ENOENT" }), status: null }',
			"ENOENT",
		],
		["signal", '{ signal: "SIGTERM", status: null }', "SIGTERM"],
		["unknown exit", "{ status: null }", "unknown exit"],
	])("blocks an attempted check after %s", (_label, result, reason) => {
		write("source.ts");
		const outcome = run({ preload: `require("node:child_process").spawnSync = () => (${result});` });
		expect(outcome.status, outcome.stderr).toBe(2);
		expect(outcome.stderr).toContain(reason);
	});

	it("blocks a thrown launch error after verification becomes applicable", () => {
		write("source.ts");
		const result = run({
			preload: 'require("node:child_process").spawnSync = () => { throw new Error("cannot launch gate"); };',
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("cannot launch gate");
	});
});
