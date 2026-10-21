import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const hooks = ["draht-claude", "draht-codex"].map((name) => ({
	name,
	path: fileURLToPath(new URL(`../../${name}/scripts/prompt-context.cjs`, import.meta.url)),
}));

describe.each(hooks)("$name prompt context", (hook) => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "draht-prompt-context-"));
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	function run(state?: string) {
		if (state !== undefined) {
			mkdirSync(join(cwd, ".planning"), { recursive: true });
			writeFileSync(join(cwd, ".planning", "STATE.md"), state);
			writeFileSync(join(cwd, ".planning", "config.json"), JSON.stringify({ hooks: { planningContext: true } }));
		}
		const result = spawnSync(process.execPath, [hook.path], { cwd, encoding: "utf8", timeout: 10000 });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		return result.stdout;
	}

	it.each([
		"## Current Phase: 3 — execution\n## Status: active\n",
		"Current Phase: 3 — execution\nStatus: active\n",
		"## Current Phase\n\n3 — execution\n## Status\n\nactive\nDetails stay in STATE.md.\n",
		"## Current Phase: 3 — execution\r\n## Status:\r\n\r\nactive\r\nDetails stay in STATE.md.\r\n",
	])("keeps the first useful phase and status line (%#)", (state) => {
		expect(run(state)).toBe("[draht] 3 — execution — active\n");
	});

	it("bounds long phase and status paragraphs on every prompt", () => {
		const output = run(
			`## Current Phase: 3 ${"phase detail ".repeat(30)}\n## Status: active ${"detail ".repeat(140)}\n`,
		);
		expect(Array.from(output).length).toBeLessThanOrEqual(196);
		expect(output).toMatch(/^\[draht\] 3 phase detail .*… — active detail .*…\n$/);
		expect(output.split("\n")).toHaveLength(2);
	});

	it("removes terminal escapes and control characters and collapses whitespace", () => {
		const output = run(
			"## Current Phase: 3\t execution\n## Status: \u001b[31mactive\u001b[0m\t\tchecks\u0000 pending\n",
		);
		expect(output).toBe("[draht] 3 execution — active checks pending\n");
	});

	it("does not inject continuation paragraphs or later sections", () => {
		const output = run("## Current Phase: 3\n## Status: active\u2028continuation\n## Blockers\nsecret detail\n");
		expect(output).toBe("[draht] 3 — active\n");
	});

	it.each(["", " \t", "\u0000", "\u001b[0m"])("suppresses blank status content (%#)", (status) => {
		expect(run(`## Current Phase: 3\n## Status: ${status}\n\n## Blockers\nPending decision\n`)).toBe("");
	});

	it("ignores field markers embedded inside prose", () => {
		expect(run("## Current Phase: 3\nA note quoting ## Status: active\n")).toBe("");
	});

	it("stays silent without both fields or a planning state", () => {
		expect(run()).toBe("");
		expect(run("## Status: active\n")).toBe("");
	});
});

describe.each(["draht-claude", "draht-codex"])("%s planning context opt-in", (name) => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "draht-planning-opt-in-"));
		mkdirSync(join(cwd, ".planning"));
		writeFileSync(join(cwd, ".planning", "STATE.md"), "## Current Phase: 3\n## Status: active\n");
		writeFileSync(join(cwd, ".planning", "PROJECT.md"), "## Vision\nExisting project\n");
		writeFileSync(join(cwd, ".planning", "CONTINUE-HERE.md"), "Previous work\n");
	});

	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	function run(script: string) {
		const scriptPath = fileURLToPath(new URL(`../../${name}/scripts/${script}.cjs`, import.meta.url));
		const result = spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8", timeout: 10000 });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		return result.stdout;
	}

	it.each(["session-start", "prompt-context"])(
		"keeps %s silent for existing planning files without opt-in",
		(script) => {
			expect(run(script)).toBe("");
		},
	);

	it.each(["{}", '{"hooks":{"planningContext":false}}', '{"hooks":{"planningContext":"true"}}', "invalid"])(
		"keeps both hooks silent without a boolean opt-in (%#)",
		(config) => {
			writeFileSync(join(cwd, ".planning", "config.json"), config);
			expect(run("session-start")).toBe("");
			expect(run("prompt-context")).toBe("");
		},
	);

	it("surfaces existing planning context when explicitly enabled", () => {
		writeFileSync(join(cwd, ".planning", "config.json"), JSON.stringify({ hooks: { planningContext: true } }));
		const session = run("session-start");
		expect(session).toContain("Phase: 3");
		expect(session).toContain("Vision: Existing project");
		expect(session).toContain("CONTINUE-HERE.md");
		expect(run("prompt-context")).toBe("[draht] 3 — active\n");
	});
});
