import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe.each(["draht-claude", "draht-codex"])("%s budget hooks", (host) => {
	let cwd: string;
	const script = resolve("..", host, "scripts/budgets-hook.cjs");
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "budget-hooks-"));
		execFileSync("git", ["init", "--quiet"], { cwd });
		mkdirSync(join(cwd, ".draht"));
		writeFileSync(
			join(cwd, ".draht/budgets.json"),
			JSON.stringify({ maxFileTokens: 10, maxCodeTokens: 30, maxDocTokens: 10 }),
		);
		// The stop gate's own type and lint checks are out of scope here; its final budget audit still runs.
		mkdirSync(join(cwd, ".planning"));
		writeFileSync(join(cwd, ".planning/config.json"), JSON.stringify({ hooks: { stopGate: false } }));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	function run(path: string, args: string[], payload: Record<string, unknown>) {
		const result = spawnSync(process.execPath, [path, ...args], {
			cwd,
			input: JSON.stringify({ cwd, ...payload }),
			encoding: "utf8",
			timeout: 10000,
		});
		expect(result.error).toBeUndefined();
		return result;
	}
	const hook = (event: string, payload: Record<string, unknown> = {}) => run(script, [event], payload);
	const stop = (payload: Record<string, unknown> = {}) =>
		run(resolve("..", host, "scripts/stop-quality-gate.cjs"), [], payload);
	it("enforces budgets independently of optional planning hooks", () => {
		const manifest = JSON.parse(readFileSync(resolve("..", host, "hooks/hooks.json"), "utf8"));
		for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]) {
			expect(manifest.hooks[event]).toContainEqual(
				expect.objectContaining({
					matcher: "",
					hooks: expect.arrayContaining([
						expect.objectContaining({ command: expect.stringContaining(`budgets-hook.cjs" ${event}`) }),
					]),
				}),
			);
		}
		const stopCommands = JSON.stringify(manifest.hooks.Stop);
		expect(stopCommands).toContain("stop-quality-gate.cjs");
		expect(stopCommands).not.toContain("budgets-hook.cjs");
	});

	it("stays silent and stores nothing in a repository without budget configuration", () => {
		rmSync(join(cwd, ".draht"), { recursive: true });
		const start = hook("SessionStart");
		expect(start).toMatchObject({ status: 0, stdout: "", stderr: "" });
		const content = "const x = 1;\n".repeat(100);
		expect(hook("PreToolUse", { tool_name: "Write", tool_input: { file_path: "large.ts", content } }).status).toBe(0);
		writeFileSync(join(cwd, "large.ts"), content);
		expect(hook("PostToolUse", { tool_name: "Write" }).status).toBe(0);
		expect(stop().status).toBe(0);
		expect(readdirSync(join(cwd, ".git")).filter((name) => name.startsWith("draht-budgets"))).toEqual([]);
	});

	it("rejects a projected large write without creating the file", () => {
		expect(hook("SessionStart").status).toBe(0);
		const result = hook("PreToolUse", {
			tool_name: "Write",
			tool_input: { file_path: "large.ts", content: "const x = 1;\n".repeat(10) },
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("file ceiling 10");
		expect(existsSync(join(cwd, "large.ts"))).toBe(false);
	});

	it("enforces documentation file limits independently of optional task totals", () => {
		writeFileSync(join(cwd, ".draht/budgets.json"), JSON.stringify({ maxDocFileTokens: 10 }));
		const start = hook("SessionStart");
		expect(start.status).toBe(0);
		expect(start.stdout).toContain("cohesive");
		const result = hook("PreToolUse", {
			tool_name: "Write",
			tool_input: { file_path: "guide.md", content: "excessive documentation ".repeat(20) },
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("documentation tokens exceed file ceiling 10");
		writeFileSync(join(cwd, "guide.md"), "excessive documentation ".repeat(20));
		expect(stop().status).toBe(2);
		writeFileSync(join(cwd, "guide.md"), "Use the documented command.\n");
		expect(stop().status).toBe(0);
	});

	it("preflights Codex apply_patch including free-form input", () => {
		hook("UserPromptSubmit");
		const result = hook("PreToolUse", {
			tool_name: "apply_patch",
			tool_input: `*** Begin Patch\n*** Add File: large.ts\n${"+const x = 1;\n".repeat(10)}*** End Patch`,
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("file ceiling 10");
	});

	it("detects shell-written docs at post-tool and every Stop attempt", () => {
		hook("SessionStart");
		writeFileSync(join(cwd, "notes.md"), "more documentation ".repeat(20));
		expect(hook("PostToolUse", { tool_name: "exec_command" }).status).toBe(2);
		expect(stop().status).toBe(2);
		expect(stop({ stop_hook_active: true }).status).toBe(2);
		// A new prompt may ask for repair, but must not silently buy a new allowance.
		expect(hook("UserPromptSubmit", { prompt: "keep working" }).status).toBe(0);
		expect(stop().status).toBe(2);
	});

	it("allows repair commands while refusing successful completion", () => {
		hook("SessionStart");
		writeFileSync(join(cwd, "notes.md"), "too much text ".repeat(20));
		expect(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "edit notes.md" } }).status).toBe(0);
		expect(hook("PreToolUse", { tool_name: "Read", tool_input: { file_path: "notes.md" } }).status).toBe(0);
		expect(stop().status).toBe(2);
	});

	it("lets edits outside the measured files and edits the host will reject run, but not ledger edits", () => {
		writeFileSync(join(cwd, ".gitignore"), ".env\n");
		hook("SessionStart");
		const large = "const x = 1;\n".repeat(10);
		const outside = join(tmpdir(), "budget-hooks-outside.md");
		for (const file_path of [outside, ".env"]) {
			expect(hook("PreToolUse", { tool_name: "Write", tool_input: { file_path, content: large } }).status).toBe(0);
		}
		const unmatched = { file_path: ".gitignore", old_string: "missing", new_string: large };
		expect(hook("PreToolUse", { tool_name: "Edit", tool_input: unmatched }).status).toBe(0);
		const ledger = { file_path: ".git/draht-budgets/task.json", content: "{}" };
		const refused = hook("PreToolUse", { tool_name: "Write", tool_input: ledger });
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain("ledger");
	});

	it.each(["/draht:budget new", "/budget new", "$draht:budget new"])(
		"starts a new task only when the user's whole prompt is %s",
		(prompt) => {
			hook("SessionStart");
			writeFileSync(join(cwd, "notes.md"), "too much text ".repeat(20));
			expect(stop().status).toBe(2);
			expect(hook("UserPromptSubmit", { prompt: `please run ${prompt} later` }).status).toBe(0);
			expect(stop().status).toBe(2);
			const reset = hook("UserPromptSubmit", { prompt });
			expect(reset.stdout).toContain("Budget task reset by the user's command");
			expect(stop().status).toBe(0);
		},
	);

	it("gives guidance at session start and later prompts only news the agent must act on", () => {
		expect(hook("SessionStart").stdout).toContain("ceilings, not targets");
		expect(hook("UserPromptSubmit", { prompt: "continue" }).stdout).toBe("");
		writeFileSync(join(cwd, "notes.md"), "too much text ".repeat(20));
		const prompt = hook("UserPromptSubmit", { prompt: "continue" });
		expect(prompt.stdout).toContain("documentation tokens exceed");
		expect(prompt.stdout).not.toContain("ceilings, not targets");
	});

	it("stops blocking completion after three repair attempts and counts again after the next prompt", () => {
		hook("SessionStart");
		writeFileSync(join(cwd, "notes.md"), "too much text ".repeat(20));
		const session = { session_id: "session-1" };
		for (const attempt of [1, 2, 3]) {
			const result = stop({ ...session, stop_hook_active: attempt > 1 });
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(`repair ${attempt}/3`);
		}
		const given = stop({ ...session, stop_hook_active: true });
		expect(given.status).toBe(1);
		expect(given.stderr).toContain("this work is not within budget");
		expect(stop({ session_id: "session-2" }).stderr).toContain("repair 1/3");
		hook("UserPromptSubmit", { ...session, prompt: "fix it" });
		expect(stop(session).stderr).toContain("repair 1/3");
	});

	it("refuses a new task through the runtime's call channel", () => {
		hook("SessionStart");
		const runtime = resolve("..", host, "scripts/budgets-runtime.cjs");
		const call = spawnSync(process.execPath, [runtime, "call"], {
			cwd,
			input: JSON.stringify({ method: "beginTask", request: { cwd, newTask: true } }),
			encoding: "utf8",
		});
		expect(call.status).toBe(2);
		expect(call.stderr).toContain("Only the user can start a new budget task");
		const status = spawnSync(process.execPath, [runtime, "call"], {
			cwd,
			input: JSON.stringify({ method: "auditBudget", request: { cwd } }),
			encoding: "utf8",
		});
		expect(JSON.parse(status.stdout)).toMatchObject({ status: "passed" });
	});

	it("ships a status CLI that refuses to start a new task for the agent", () => {
		hook("SessionStart");
		writeFileSync(join(cwd, "notes.md"), "too much text ".repeat(20));
		const runtime = resolve("..", host, "scripts/budgets-runtime.cjs");
		const status = spawnSync(process.execPath, [runtime, "status"], { cwd, encoding: "utf8" });
		expect(status.status).toBe(2);
		expect(status.stdout).toContain("documentation tokens");
		const reset = spawnSync(process.execPath, [runtime, "new"], { cwd, encoding: "utf8" });
		expect(reset.status).toBe(2);
		expect(reset.stderr).toContain("Only the user can start a new budget task");
		expect(stop().status).toBe(2);
	});

	it("blocks completion once on a broken inspection without blocking tools, then reports it on retry", () => {
		const malformed = spawnSync(process.execPath, [script, "PreToolUse"], { cwd, input: "{", encoding: "utf8" });
		expect(malformed.status).toBe(2);
		writeFileSync(join(cwd, ".draht/budgets.json"), '{"maxFileTokens": "unlimited"}');
		expect(hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "echo x > a.ts" } }).status).toBe(0);
		const first = stop();
		expect(first.status).toBe(2);
		expect(first.stderr).toContain("Fix .draht/budgets.json");
		const retry = stop({ stop_hook_active: true });
		expect(retry.status).toBe(1);
		expect(retry.stderr).toContain("maxFileTokens");
	});

	it("audits changes made by the final project check before accepting completion", () => {
		writeFileSync(
			join(cwd, ".draht/checks.json"),
			JSON.stringify({
				checks: [
					{
						name: "formatter",
						command: [
							process.execPath,
							"-e",
							"require('node:fs').writeFileSync('large.ts', 'const x = 1;\\n'.repeat(10))",
						],
						inputs: [".draht/checks.json"],
					},
				],
			}),
		);
		hook("SessionStart");
		const result = stop();
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("file ceiling 10");
	});
});

describe.each([
	["coding-agent", "hooks/checks/budgets-runtime.cjs"],
	["draht-claude", "scripts/budgets-runtime.cjs"],
	["draht-codex", "scripts/budgets-runtime.cjs"],
])("%s budget configuration CLI", (host, entry) => {
	let cwd: string;
	const runtime = resolve("..", host, entry);
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "budget-config-"));
		execFileSync("git", ["init", "--quiet"], { cwd });
		mkdirSync(join(cwd, "nested"));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	function command(action: string) {
		return spawnSync(process.execPath, [runtime, action], { cwd: join(cwd, "nested"), encoding: "utf8" });
	}
	it("locates the repository configuration from a nested session without starting a task", () => {
		const result = command("config");
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			configPath: join(cwd, ".draht/budgets.json"),
			exists: false,
			enabled: true,
			limits: {
				maxFileTokens: 5000,
				maxDocFileTokens: 1500,
				maxCodeTokens: null,
				maxDocTokens: null,
				maxOversizedGrowthTokens: 250,
			},
			exclude: [],
		});
		expect(existsSync(join(cwd, ".draht"))).toBe(false);
		expect(existsSync(join(cwd, ".git/draht-budgets"))).toBe(false);
	});
	it("validates saved choices independently of the active task without resetting its allowance", () => {
		mkdirSync(join(cwd, ".draht"));
		const configPath = join(cwd, ".draht/budgets.json");
		writeFileSync(configPath, JSON.stringify({ maxFileTokens: 5000 }));
		expect(command("status").status).toBe(0);
		const taskPath = join(cwd, ".git/draht-budgets/task.json");
		const original = readFileSync(taskPath, "utf8");
		writeFileSync(configPath, JSON.stringify({ maxFileTokens: 3000, maxDocFileTokens: 800, maxDocTokens: 2000 }));
		const config = command("config");
		expect(config.status).toBe(0);
		expect(JSON.parse(config.stdout)).toMatchObject({
			exists: true,
			limits: { maxFileTokens: 3000, maxDocFileTokens: 800, maxDocTokens: 2000 },
		});
		expect(readFileSync(taskPath, "utf8")).toBe(original);
		expect(command("status").stdout).toContain("code files <= 5000");
		const reset = spawnSync(
			process.execPath,
			[
				"-e",
				"process.stdout.write(require(process.argv[1]).beginTask({ cwd: process.argv[2], newTask: true }).summary)",
				runtime,
				cwd,
			],
			{ encoding: "utf8" },
		);
		expect(reset.stdout).toContain("code files <= 3000");
	});
	it("rejects malformed settings and non-Git sessions without creating configuration", () => {
		mkdirSync(join(cwd, ".draht"));
		const configPath = join(cwd, ".draht/budgets.json");
		writeFileSync(configPath, JSON.stringify({ maxDocFileTokens: 0 }));
		expect(command("config").status).toBe(2);
		expect(command("config").stderr).toContain("maxDocFileTokens");
		rmSync(join(cwd, ".git"), { recursive: true });
		expect(command("config").status).toBe(2);
		expect(command("config").stderr).toContain("Git working tree");
		expect(readFileSync(configPath, "utf8")).toBe('{"maxDocFileTokens":0}');
	});
});
