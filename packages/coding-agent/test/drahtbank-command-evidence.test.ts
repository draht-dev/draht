import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BenchmarkCaseV2, CASES } from "../eval/drahtbank/cases-v2.mjs";
import { gradeResponse } from "../eval/drahtbank/grading-v2.mjs";

function fixtureCase(id: string): BenchmarkCaseV2 {
	const entry = CASES.find((item) => item.id === id);
	if (!entry) throw new Error(`Missing ${id} fixture`);
	return entry;
}
const testCase = fixtureCase("mode-feature");
const directories: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function call(id: string, command: string, output = "CHECK:PASS\n", exitCode: number | null = 0, args = {}) {
	return [
		{ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command, ...args } },
		{
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			isError: exitCode !== 0,
			result: { content: [{ type: "text", text: output }], structuredContent: { exit_code: exitCode } },
		},
	];
}

function grade(events: object[], workspace = "/fixture", entry = testCase, status = "DONE") {
	return gradeResponse(entry, {
		finalText: `Observed the check.\nSTATUS: ${status}`,
		stdout: events.map((event) => JSON.stringify(event)).join("\n"),
		format: "draht-jsonl",
		workspace,
	});
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Drahtbank literal verification-command evidence", () => {
	it.each([
		(workspace: string) => `cd ${quote(workspace)} && node check.mjs`,
		(workspace: string) => `cd -- ${quote(workspace)} && 'node' "./check.mjs"`,
		(workspace: string) => `node ${quote(join(workspace, "check.mjs"))}`,
		() => "  \"node\"\t  'check.mjs'  ",
		() => "no\\de check\\.mjs",
		() => "node \\\ncheck.mjs",
		() => "cd . && node ./check.mjs",
		() => "cd ./ && node check.mjs",
	])("credits an observed equivalent invocation (%#)", (commandFor) => {
		const workspace = mkdtempSync(join(tmpdir(), "drahtbank quoted ' workspace-"));
		directories.push(workspace);
		writeFileSync(join(workspace, "check.mjs"), 'console.log("CHECK:PASS");\n');
		const command = commandFor(workspace);
		const observed = spawnSync("bash", ["--noprofile", "--norc", "-c", command], {
			cwd: workspace,
			encoding: "utf8",
			timeout: 3000,
		});
		expect(observed.status, observed.stderr).toBe(0);
		const result = grade(call("actual", command, observed.stdout + observed.stderr, observed.status), workspace);
		expect(result).toMatchObject({
			evidencePassed: true,
			evidence: { matched: [{ id: "node check.mjs", toolCallId: "actual" }], missing: [], unverifiable: [] },
		});
	});

	it.each([
		'echo "node check.mjs"',
		"false && node check.mjs",
		"true || node check.mjs",
		"node check.mjs || true",
		"node check.mjs; true",
		'cd /fixture && node check.mjs; echo "exit=$?"',
		"node check.mjs | cat",
		"node check.mjs &",
		"node check.mjs\ntrue",
		"node check.mjs && node check.mjs",
		"cd /other && node check.mjs",
		"cd /fixture; node check.mjs",
		"cd /fixture/child/.. && node check.mjs",
		"node child/../check.mjs",
		"node /other/check.mjs",
		"node './check.mjs; true'",
		"node check.mjs extra",
		"NODE_OPTIONS=--require=./fake.cjs node check.mjs",
		"env node check.mjs",
		"node --require ./fake.cjs check.mjs",
		"node $(echo check.mjs)",
		"node `echo check.mjs`",
		'node "$CHECK"',
		"node check.mjs > output.txt",
		"node check.mjs 2>&1",
		"(node check.mjs)",
		"bash -c 'node check.mjs'",
		"node check.mjs # unknown suffix",
		'node "check.mjs',
		"node check.mjs\\",
	])("does not infer an executed check from unsupported syntax: %s", (command) => {
		expect(grade(call("unsupported", command)).evidencePassed).toBe(false);
	});

	it("does not trust unsupported model-supplied working-directory arguments", () => {
		for (const args of [{ cwd: "/other" }, { workdir: "/other" }, { cwd: null }, { workdir: 1 }]) {
			expect(grade(call("fake-cwd", "node check.mjs", "CHECK:PASS", 0, args)).evidencePassed).toBe(false);
		}
	});

	it("requires observed output and the actual exit code for a wrapped check", () => {
		for (const [output, exitCode] of [
			["", 0],
			["CHECK:PASS", 1],
			["CHECK:PASS", null],
		] as const) {
			expect(grade(call("missing-proof", "cd /fixture && node check.mjs", output, exitCode)).evidencePassed).toBe(
				false,
			);
		}
	});

	it("preserves required nonzero outcomes and their BLOCKED contract", () => {
		const blocked = fixtureCase("blocked-check");
		const events = call("blocked", "cd /fixture && node ./check.mjs", "CHECK:EXTERNAL_UNAVAILABLE", 1);
		expect(grade(events, "/fixture", blocked, "BLOCKED")).toMatchObject({
			evidencePassed: true,
			statusSemanticPassed: true,
		});
		expect(grade(events, "/fixture", blocked).statusSemanticPassed).toBe(false);
	});

	it("never credits an approval-denied equivalent invocation", () => {
		const result = grade(
			call("denied", "cd /fixture && node check.mjs", "Command requires approval; no UI available", null),
		);
		expect(result.evidencePassed).toBe(false);
		expect(result.evidence.denied).toEqual([{ toolCallId: "denied", tool: "bash" }]);
	});

	it("does not mistake an executed failure mentioning approval for a denied check", () => {
		const result = grade([
			...call("pass", "node check.mjs"),
			...call("fail", "cd /fixture && node check.mjs", "AssertionError: requires approval", 1),
		]);
		expect(result).toMatchObject({
			evidencePassed: false,
			statusSemanticPassed: false,
			evidence: { denied: [], matched: [], missing: ["node check.mjs"] },
		});
	});

	it("keeps later wrapped failures and incomplete retries from being hidden by earlier success", () => {
		const passed = call("pass", "node check.mjs");
		const failed = call("fail", "cd /fixture && node check.mjs", "AssertionError", 1);
		expect(grade([...passed, ...failed])).toMatchObject({
			evidencePassed: false,
			statusSemanticPassed: false,
			evidence: { matched: [], missing: ["node check.mjs"] },
		});
		expect(grade([...failed, ...call("incomplete", "'node' check.mjs", "", null)]).statusSemanticPassed).toBe(false);
		expect(grade([...failed, ...call("retry", "cd . && node ./check.mjs")])).toMatchObject({
			evidencePassed: true,
			statusSemanticPassed: true,
		});
	});

	it("does not credit wrapped verification before a later edit", () => {
		const events = [
			...call("before", "cd /fixture && node check.mjs"),
			{ type: "tool_execution_start", toolCallId: "edit", toolName: "edit", args: { path: "mode.mjs" } },
			{ type: "tool_execution_end", toolCallId: "edit", toolName: "edit", isError: false },
		];
		expect(grade(events).evidencePassed).toBe(false);
		expect(grade([...events, ...call("after", "cd /fixture && node check.mjs")]).evidencePassed).toBe(true);
	});

	it("keeps overlapping equivalent attempts unknown", () => {
		const first = call("first", "node check.mjs");
		const second = call("second", "cd /fixture && node check.mjs");
		const result = grade([first[0], second[0], first[1], second[1]]);
		expect(result.evidencePassed).toBeNull();
		expect(result.evidence.unverifiable).toContain(
			"Overlapping required-check attempts require trace audit: node check.mjs",
		);
	});

	it("keeps unknown shell effects separate from a recognized check", () => {
		const result = grade([
			...call("unknown", 'node -e \'require("fs").writeFileSync("extra", "x")\'', ""),
			...call("check", "cd /fixture && node check.mjs"),
		]);
		expect(result.evidence.matched).toHaveLength(1);
		expect(result.evidencePassed).toBeNull();
	});

	it("recognizes literal read-only sequences without mistaking their output for verification", () => {
		const reads = call("read", "ls -la; cat check.mjs; nl -ba mode.mjs", "CHECK:PASS");
		expect(grade(reads).evidencePassed).toBe(false);
		expect(grade([...reads, ...call("check", "node check.mjs")]).evidencePassed).toBe(true);
	});

	it("rejects command expansion hidden in read-only-looking syntax", () => {
		for (const command of ['cat "$(touch extra)"', "cat `touch extra`", "cat x > extra", "ls; touch extra"]) {
			expect(grade([...call("unknown", command, ""), ...call("check", "node check.mjs")]).evidencePassed).toBeNull();
		}
	});
});
