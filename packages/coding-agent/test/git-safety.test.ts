import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findGitSafetyViolation } from "../hooks/checks/git-safety.cjs";

describe("literal Git safety policy", () => {
	it.each([
		"git push --force origin main",
		"git push -f origin main",
		"git push -uf origin main",
		"git push origin +HEAD:main",
		"git push -- origin +HEAD:main",
		"git push --force-with-lease",
		"git push --force-w",
		"git push --force-w=refs/heads/main:abc123",
		"git push --force-with-lease=refs/heads/main:abc123",
		"git push --force-if-includes",
		"git push --force-if",
		"git commit --no-verify -m change",
		"git commit --no-veri -m change",
		"git commit -n -m change",
		"git commit -anmchange",
		"git push --no-verify",
		"git push --no-veri",
		"git merge --no-verify branch",
		"git -C '/a b' -c core.hooksPath=/dev/null commit -m change",
		"git -ccore.hooksPath=/tmp commit -m change",
		"git --config-env=core.hooksPath=HOOKS commit -m change",
		"HUSKY=0 git commit -m change",
		"env HUSKY=0 git commit -m change",
		"env -u TOKEN git push -f",
		"command git push -f",
		"sudo -u user git push -f",
		"/usr/bin/git push --force",
		"git status && git push -f",
		"git status; git commit --no-verify",
		"sh -c 'git push --force'",
		"bash -lc 'git commit -n'",
		"echo $(git push -f)",
		'echo "$(git push -f)"',
		"echo `git push -f`",
		"g'it' pu\"sh\" --force",
		"git push \\\n--force",
		"(git push -f)",
		"git push --force # comment",
		"if git push --force; then echo pushed; fi",
		"if ready; then git push --force; fi",
		"if ready; then echo ready; else git commit -n; fi",
		"while git push --force; do echo retry; done",
		"until git push --force; do echo retry; done",
		"! git push --force",
	])("rejects %s", (command) => {
		expect(findGitSafetyViolation(command)).toBeTypeOf("string");
	});

	it.each([
		"git push origin main",
		"git push --dry-run",
		"git commit -m change",
		"git commit -amchange",
		"git commit -m '--no-verify'",
		"git commit -amno-verify",
		"git push -o '--force' origin main",
		"git log --oneline",
		"git diff --force",
		"echo 'git push --force'",
		'printf "%s" "git commit -n"',
		"rg -- '--no-verify' README.md",
		"# git push --force\ngit status",
		"git push origin main # --force",
		"git push --force-with-lease=refs/heads/saga-lock: origin HEAD:refs/heads/saga-lock",
		"git push --force-w=refs/heads/saga-lock: origin HEAD:refs/heads/saga-lock",
		"git -c color.ui=false push origin main",
		"git commit -- --no-verify",
		"git push --dry-run origin main",
	])("allows %s", (command) => {
		expect(findGitSafetyViolation(command)).toBeUndefined();
	});
});

describe.each(["draht-claude", "draht-codex"])("%s Git hook", (pkg) => {
	const script = resolve("..", pkg, "scripts/git-safety-hook.cjs");
	it("blocks an unsafe command and provides actionable feedback", () => {
		const result = spawnSync(process.execPath, [script], {
			input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -f" } }),
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("normal push");
	});
	it("accepts a safe command through the exec_command input shape", () => {
		const result = spawnSync(process.execPath, [script], {
			input: JSON.stringify({ tool_name: "exec_command", tool_input: { cmd: "git push origin main" } }),
			encoding: "utf8",
		});
		expect(result.status).toBe(0);
	});
	it("fails visibly on malformed hook input", () => {
		const result = spawnSync(process.execPath, [script], { input: "{", encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("could not inspect");
	});
	it("ships the guard in the shell PreToolUse hook", () => {
		const hooks = JSON.parse(readFileSync(resolve("..", pkg, "hooks/hooks.json"), "utf8"));
		expect(hooks.hooks.PreToolUse).toContainEqual(
			expect.objectContaining({
				matcher: "Bash|bash|exec_command|shell_command",
				hooks: [expect.objectContaining({ command: expect.stringContaining("git-safety-hook.cjs") })],
			}),
		);
	});
});
