import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hooks = [
	{ name: "coding-agent", path: "../hooks/gsd/draht-post-task.js", strictDefault: false, hardStop: false },
	{ name: "draht-claude", path: "../../draht-claude/scripts/gsd-post-task.cjs", strictDefault: true, hardStop: true },
	{ name: "draht-codex", path: "../../draht-codex/scripts/gsd-post-task.cjs", strictDefault: true, hardStop: true },
];

interface LogEntry {
	status: string;
	checks?: { types: string; tests: string };
}

interface Invocation {
	check: string;
	recorded: boolean;
}

describe.skipIf(process.platform === "win32").each(hooks)("$name post-task verification", (hook) => {
	let root: string;
	let cwd: string;
	let bin: string;
	let script: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "draht-post-task-"));
		cwd = root;
		bin = join(cwd, "bin");
		mkdirSync(bin);
		mkdirSync(join(cwd, ".planning"));
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "fixture" } }));
		writeFileSync(join(cwd, ".planning", "STATE.md"), "## Last Activity: before\n");
		// Native hooks also ship as standalone CommonJS assets outside the ESM source package.
		script = join(cwd, "post-task.cjs");
		copyFileSync(fileURLToPath(new URL(hook.path, import.meta.url)), script);
		const shim = join(bin, "command.cjs");
		writeFileSync(
			shim,
			`const fs = require("node:fs");
const check = process.argv.includes("test") ? "tests" : "types";
fs.appendFileSync("commands.jsonl", JSON.stringify({ check, recorded: fs.existsSync(".planning/execution-log.jsonl") }) + "\\n");
process.stdout.write(process.env["OUTPUT_" + check.toUpperCase()] || "");
process.stderr.write(process.env["STDERR_" + check.toUpperCase()] || "");
process.exit(Number(process.env["EXIT_" + check.toUpperCase()] || 0));
`,
		);
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		for (const name of ["npm", "npx", "pnpm", "yarn", "bun"]) {
			const command = join(bin, name);
			writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(shim)} "$@"\n`);
			chmodSync(command, 0o755);
		}
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function run(status = "pass", env: NodeJS.ProcessEnv = {}) {
		return spawnSync(process.execPath, [script, "1", "2", "3", status], {
			cwd,
			encoding: "utf8",
			timeout: 10000,
			env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, ...env },
		});
	}

	function entries(): LogEntry[] {
		return readFileSync(join(cwd, ".planning", "execution-log.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as LogEntry);
	}

	function invocations(): Invocation[] {
		const file = join(cwd, "commands.jsonl");
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Invocation)
			: [];
	}

	it("records success only after both checks pass", () => {
		const result = run();
		expect(result.status, result.stderr).toBe(0);
		expect(invocations()).toEqual([
			{ check: "types", recorded: false },
			{ check: "tests", recorded: false },
		]);
		expect(entries()).toMatchObject([{ status: "pass", checks: { types: "pass", tests: "pass" } }]);
	});

	it("records a silent test failure and respects the existing strict default", () => {
		const result = run("pass", { EXIT_TESTS: "1" });
		expect(result.status).toBe(hook.strictDefault ? 1 : 0);
		expect(entries()).toMatchObject([{ status: "fail", checks: { types: "pass", tests: "fail" } }]);
		expect(result.stdout).not.toContain("passed + types clean");
	});

	it("reports exit status and stderr even when a failing runner prints a stdout banner", () => {
		const result = run("pass", { EXIT_TESTS: "2", OUTPUT_TESTS: "runner banner", STDERR_TESTS: "failed assertion" });
		expect(result.stderr).toContain("exit 2");
		expect(result.stderr).toContain("runner banner");
		expect(result.stderr).toContain("failed assertion");
	});

	it("runs tests after a type-check failure and fails strict verification", () => {
		writeFileSync(join(cwd, ".planning", "config.json"), JSON.stringify({ hooks: { qualityGateStrict: true } }));
		const result = run("pass", { EXIT_TYPES: "2", OUTPUT_TYPES: "compiler unavailable" });
		expect(result.status).toBe(1);
		expect(invocations().map((entry) => entry.check)).toEqual(["types", "tests"]);
		expect(entries()).toMatchObject([{ status: "fail", checks: { types: "fail", tests: "pass" } }]);
		expect(readFileSync(join(cwd, ".planning", "STATE.md"), "utf8")).not.toContain("before");
	});

	it("keeps advisory verification nonblocking without recording a false pass", () => {
		writeFileSync(join(cwd, ".planning", "config.json"), JSON.stringify({ hooks: { qualityGateStrict: false } }));
		const result = run("pass", { EXIT_TESTS: "1", OUTPUT_TESTS: "No test files found" });
		expect(result.status).toBe(0);
		expect(entries()).toMatchObject([{ status: "fail", checks: { types: "pass", tests: "fail" } }]);
	});

	it("explicitly skips unconfigured checks in a documentation-only project", () => {
		rmSync(join(cwd, "tsconfig.json"));
		rmSync(join(cwd, "package.json"));
		const result = run();
		expect(result.status).toBe(0);
		expect(invocations()).toEqual([]);
		expect(entries()).toMatchObject([{ status: "pass", checks: { types: "skip", tests: "skip" } }]);
	});

	it("supports Bun tests without a package test script", () => {
		writeFileSync(join(cwd, "bun.lock"), "");
		writeFileSync(join(cwd, "package.json"), "{}");
		const result = run();
		expect(result.status).toBe(0);
		expect(invocations().map((entry) => entry.check)).toEqual(["types", "tests"]);
	});

	it("runs the nearest ancestor package's failing test script from a nested directory", () => {
		cwd = join(root, "src");
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		const result = run("pass", { EXIT_TESTS: "1" });
		expect(result.status).toBe(hook.strictDefault ? 1 : 0);
		expect(invocations().map((entry) => entry.check)).toEqual(["types", "tests"]);
		expect(entries()).toMatchObject([{ status: "fail", checks: { types: "pass", tests: "fail" } }]);
	});

	it("does not inherit an ancestor test script past the nearest package boundary", () => {
		cwd = join(root, "src");
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), "{}");
		const result = run("pass", { EXIT_TESTS: "1" });
		expect(result.status).toBe(0);
		expect(invocations().map((entry) => entry.check)).toEqual(["types"]);
		expect(entries()).toMatchObject([{ status: "pass", checks: { types: "pass", tests: "skip" } }]);
	});

	it("records malformed package metadata as failure instead of skipping tests", () => {
		writeFileSync(join(cwd, "package.json"), "{");
		const result = run();
		expect(result.status).toBe(hook.strictDefault ? 1 : 0);
		expect(entries()).toMatchObject([{ status: "fail", checks: { types: "pass", tests: "fail" } }]);
	});

	it("preserves an explicitly skipped task without running verification", () => {
		const result = run("skip");
		expect(result.status).toBe(0);
		expect(invocations()).toEqual([]);
		expect(entries()).toMatchObject([{ status: "skip" }]);
	});

	it("does not promote an explicit task failure or run verification", () => {
		const result = run("fail");
		expect(result.status).toBe(0);
		expect(invocations()).toEqual([]);
		expect(entries()).toMatchObject([{ status: "fail" }]);
	});

	it("preserves the task failure retry cap", () => {
		run("fail");
		run("fail");
		const result = run("fail");
		expect(result.status).toBe(hook.hardStop ? 1 : 0);
		expect(entries()).toHaveLength(3);
		expect(`${result.stdout}${result.stderr}`).toContain(
			'draht-tools create-fix-plan 1 2 "Task 3 failed repeatedly"',
		);
		expect(`${result.stdout}${result.stderr}`).not.toContain("draht create-fix-plan");
	});

	it("counts verification failures toward the existing retry cap, including advisory mode", () => {
		writeFileSync(join(cwd, ".planning", "config.json"), JSON.stringify({ hooks: { qualityGateStrict: false } }));
		run("pass", { EXIT_TESTS: "1" });
		run("pass", { EXIT_TESTS: "1" });
		const result = run("pass", { EXIT_TESTS: "1" });
		expect(result.status).toBe(hook.hardStop ? 1 : 0);
		expect(entries().map((entry) => entry.status)).toEqual(["fail", "fail", "fail"]);
	});
});
