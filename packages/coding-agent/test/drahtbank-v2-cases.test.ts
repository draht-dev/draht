import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BenchmarkCaseV2,
	CASES,
	GRADING_SOURCES,
	gradeResponse,
	SUITE_VERSION,
} from "../eval/drahtbank/cases-v2.mjs";

const directories: string[] = [];
const golden: Record<string, Record<string, string>> = {
	"mode-feature": {
		"mode.mjs":
			'export function parseMode(value){if(typeof value!=="string")throw Error();const mode=value.trim().toLowerCase();if(!["quiet","loud"].includes(mode))throw Error();return mode;}',
	},
	"merge-regression": {
		"labels.mjs": "export function unionLabels(groups){return [...new Set(groups.flat())];}",
		"regression.test.mjs":
			'import assert from "node:assert/strict";import {unionLabels} from "./labels.mjs";assert.deepEqual(unionLabels([["a"],["a","b"]]),["a","b"]);assert.deepEqual(unionLabels([]),[]);',
	},
	"blocked-check": { "label.mjs": 'export function formatLabel(name="untitled"){return "Label: "+name;}' },
	"advisor-precedence": {
		"count.mjs":
			'export function parseCount(value){if(typeof value!=="string"||!/^\\d+$/.test(value))throw Error();const n=Number(value);if(!Number.isSafeInteger(n))throw Error();return n;}',
	},
	"utf8-stream": {
		"decode.mjs": 'export function decodeChunks(chunks){return Buffer.concat(chunks).toString("utf8");}',
	},
	"lease-release": {
		"lease.mjs":
			"export function release(leases,key,token){return leases.has(key)&&leases.get(key).token===token ? leases.delete(key) : false;}",
	},
};

function entry(id: string): BenchmarkCaseV2 {
	const result = CASES.find((item) => item.id === id);
	if (!result) throw new Error(`Unknown case: ${id}`);
	return result;
}

function fixture(id: string, applyGolden = true): string {
	const directory = mkdtempSync(join(tmpdir(), "drahtbank-v2-cases-"));
	directories.push(directory);
	for (const [name, source] of Object.entries(entry(id).files)) writeFileSync(join(directory, name), source);
	if (applyGolden)
		for (const [name, source] of Object.entries(golden[id] ?? {})) writeFileSync(join(directory, name), source);
	return directory;
}

function finalText(testCase: BenchmarkCaseV2, prose = "Observed the fixture behavior."): string {
	const record = testCase.responseContract ? `RESULT: ${JSON.stringify(testCase.responseContract)}\n` : "";
	const status = testCase.expectedStatuses[0];
	const terminal = testCase.outputContract === "triage" ? `[${status}]` : `STATUS: ${status}`;
	return `${prose}\n${record}${terminal}`;
}

function call(id: string, toolName: string, args: object, output = "", exitCode: number | null = 0, isError = false) {
	return [
		{ type: "tool_execution_start", toolCallId: id, toolName, args },
		{
			type: "tool_execution_end",
			toolCallId: id,
			toolName,
			isError,
			result: { content: [{ type: "text", text: output }], structuredContent: { exit_code: exitCode } },
		},
	];
}
const trace = (events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
const checkEvents = () => call("check", "bash", { command: "node check.mjs" }, "CHECK:PASS\n");

function actualTrace(testCase: BenchmarkCaseV2, directory: string): string {
	const events: object[] = [];
	for (const [index, requirement] of testCase.evidenceRequirements.entries()) {
		const [, ...args] = requirement.command.split(" ");
		const result = spawnSync(process.execPath, args, { cwd: directory, encoding: "utf8", timeout: 3000 });
		expect(result.signal).toBeNull();
		expect(result.status).toBe(requirement.exitCode);
		events.push(
			...call(
				`check-${index}`,
				"bash",
				{ command: requirement.command },
				result.stdout + result.stderr,
				result.status,
				result.status !== 0,
			),
		);
	}
	return trace(events);
}

function behavior(id: string, directory: string): { passed: boolean; stderr: string } {
	const source = `import assert from "node:assert/strict";\n${entry(id).assertions}\nconsole.log("BEHAVIOR:PASS");`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
		cwd: directory,
		encoding: "utf8",
		timeout: 15000,
	});
	return { passed: result.status === 0 && result.stdout.split("\n").includes("BEHAVIOR:PASS"), stderr: result.stderr };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Drahtbank v2 independent case axes", () => {
	it("separates ten screen cases from six unexposed fixture families", () => {
		expect(SUITE_VERSION).toBe("2");
		expect(GRADING_SOURCES).toEqual(["cases-v2.mjs", "grading-v2.mjs"]);
		expect(CASES.filter((item) => item.split === "screen")).toHaveLength(10);
		expect(CASES.filter((item) => item.split === "holdout")).toHaveLength(6);
		expect(new Set(CASES.map((item) => item.id)).size).toBe(CASES.length);
		for (const testCase of CASES) {
			expect(testCase.assertions).not.toContain("finalText");
			expect(testCase.responseInstructions).toContain(
				testCase.outputContract === "triage" ? "[triage:bug]" : "STATUS: DONE",
			);
			for (const requirement of testCase.evidenceRequirements)
				expect(testCase.responseInstructions).toContain(requirement.command);
			for (const file of testCase.writable) expect(testCase.files).toHaveProperty(file);
		}
	});

	it.each(CASES.map(({ id }) => id))("accepts golden behavior and actual command evidence for %s", (id) => {
		const testCase = entry(id),
			directory = fixture(id);
		const observed = actualTrace(testCase, directory);
		const result = behavior(id, directory);
		expect(result, result.stderr).toMatchObject({ passed: true });
		const grade = gradeResponse(testCase, {
			finalText: finalText(testCase),
			stdout: observed,
			format: "draht-jsonl",
			workspace: directory,
		});
		expect(grade).toMatchObject({
			responseFormatPassed: true,
			evidencePassed: true,
			statusSyntaxPassed: true,
			statusSemanticPassed: true,
			traceScopeViolations: [],
		});
		if (testCase.responseContract) expect(grade.findingsPassed).toBe(true);
		for (const [name, source] of Object.entries(testCase.files)) {
			if (!testCase.writable.includes(name)) expect(readFileSync(join(directory, name), "utf8")).toBe(source);
		}
	});

	it.each(Object.keys(golden))("rejects unrepaired behavior in %s independently of status prose", (id) => {
		expect(behavior(id, fixture(id, false)).passed).toBe(false);
	});

	it("rejects the advisor's plausible but contract-breaking implementation", () => {
		const directory = fixture("advisor-precedence");
		writeFileSync(join(directory, "count.mjs"), "export function parseCount(value){return parseInt(value,10);}");
		expect(behavior("advisor-precedence", directory).passed).toBe(false);
	});

	it.each([
		{
			name: "default TextDecoder strips the leading BOM",
			source:
				'export function decodeChunks(chunks){const decoder=new TextDecoder("utf-8");return chunks.map(chunk=>decoder.decode(chunk,{stream:true})).join("")+decoder.decode();}',
			passed: false,
		},
		{
			name: "TextDecoder with ignoreBOM preserves it",
			source:
				'export function decodeChunks(chunks){const decoder=new TextDecoder("utf-8",{ignoreBOM:true});return chunks.map(chunk=>decoder.decode(chunk,{stream:true})).join("")+decoder.decode();}',
			passed: true,
		},
		{
			name: "StringDecoder preserves it",
			source:
				'import {StringDecoder} from "node:string_decoder";export function decodeChunks(chunks){const decoder=new StringDecoder("utf8");return chunks.map(chunk=>decoder.write(chunk)).join("")+decoder.end();}',
			passed: true,
		},
	])("discloses and verifies BOM compatibility: $name", ({ source, passed }) => {
		const directory = fixture("utf8-stream");
		writeFileSync(join(directory, "decode.mjs"), source);
		expect(behavior("utf8-stream", directory).passed).toBe(passed);
		const result = spawnSync(process.execPath, ["check.mjs"], { cwd: directory, encoding: "utf8", timeout: 3000 });
		expect(result.signal).toBeNull();
		expect(result.status).toBe(passed ? 0 : 1);
		expect(entry("utf8-stream").task).toContain("Preserve a leading U+FEFF");
	});

	it("discloses conditional verdict mapping without supplying the review answer", () => {
		for (const id of ["expiry-review-bug", "expiry-review-clean", "record-security-open", "cache-review"]) {
			expect(entry(id).responseInstructions).toContain(
				"use verdict findings when supported current defects exist, otherwise clear",
			);
		}
		expect(entry("expiry-review-bug").responseInstructions).toBe(entry("expiry-review-clean").responseInstructions);
		expect(entry("record-security-open").responseInstructions).toBe(
			entry("record-security-protected").responseInstructions,
		);
		expect(entry("async-diagnosis").responseInstructions).toContain("use verdict diagnosis");
		expect(entry("triage-intentional").responseInstructions).toContain(
			"use verdict bug for a bug classification and other for a feature request",
		);
	});

	it.each([
		{ id: "expiry-review-bug", file: "expiry.mjs", line: 2, facts: { before: true, atBoundary: true, after: false } },
		{
			id: "record-security-open",
			file: "route.mjs",
			line: 3,
			facts: { ownStatus: 200, foreignStatus: 200, anonymousStatus: 401 },
		},
		{
			id: "cache-review",
			file: "cache.mjs",
			line: 3,
			facts: { first: "red", second: "red", expectedSecond: "blue" },
		},
	])("accepts completion of a supported read-only finding in $id", ({ id, file, line, facts }) => {
		const testCase = entry(id),
			directory = fixture(id);
		const input = { stdout: actualTrace(testCase, directory), format: "draht-jsonl" as const, workspace: directory };
		const response = { verdict: "findings", findings: [{ file, line }], facts };
		expect(
			gradeResponse(testCase, { ...input, finalText: `RESULT: ${JSON.stringify(response)}\nSTATUS: DONE` }),
		).toMatchObject({
			responseFormatPassed: true,
			findingsPassed: true,
			evidencePassed: true,
			statusSemanticPassed: true,
		});
		expect(testCase.responseInstructions).toContain("even when defects were found");
		const alternate = { ...response, verdict: "bug" };
		expect(
			gradeResponse(testCase, { ...input, finalText: `RESULT: ${JSON.stringify(alternate)}\nSTATUS: DONE` }),
		).toMatchObject({ responseFormatPassed: true, findingsPassed: false, statusSemanticPassed: true });
	});

	it.each([
		'console.log("ok");',
		'import assert from "node:assert/strict";import {unionLabels} from "./labels.mjs";assert.deepEqual(unionLabels([]),[]);',
		'import assert from "node:assert/strict";import {unionLabels} from "./labels.mjs";assert.deepEqual(unionLabels([["a"],["a"]]),["a"]);',
	])("rejects vacuous or incomplete regression tests (%#)", (source) => {
		const directory = fixture("merge-regression");
		writeFileSync(join(directory, "regression.test.mjs"), source);
		expect(behavior("merge-regression", directory).passed).toBe(false);
	});

	it("keeps blocked verification separate from correct preserved behavior", () => {
		const testCase = entry("blocked-check"),
			directory = fixture(testCase.id);
		const stdout = actualTrace(testCase, directory);
		expect(behavior(testCase.id, directory).passed).toBe(true);
		const grade = gradeResponse(testCase, {
			finalText: "Check failed.\nSTATUS: DONE",
			stdout,
			format: "draht-jsonl",
			workspace: directory,
		});
		expect(grade).toMatchObject({ evidencePassed: true, statusSyntaxPassed: true, statusSemanticPassed: false });
	});

	it("accepts cautious completion without converting it into a behavioral defect", () => {
		const grade = gradeResponse(entry("mode-feature"), {
			finalText: "Optional checks unavailable.\nSTATUS: DONE_WITH_CONCERNS",
			stdout: trace(checkEvents()),
			format: "draht-jsonl",
			workspace: "/fixture",
		});
		expect(grade).toMatchObject({ statusSyntaxPassed: true, statusSemanticPassed: true, evidencePassed: true });
	});

	it("rejects an extra malformed terminal marker before a valid one", () => {
		const grade = gradeResponse(entry("mode-feature"), {
			finalText: "STATUS: FAILED\nSTATUS: DONE",
			stdout: trace(checkEvents()),
			format: "draht-jsonl",
			workspace: "/fixture",
		});
		expect(grade.statusSyntaxPassed).toBe(false);
	});

	it.each([
		"No supported security findings.",
		"I found no current vulnerability.",
		"Optional hardening: add future rate limits.",
	])("does not grade clean verdict wording: %s", (prose) => {
		const testCase = entry("record-security-protected"),
			directory = fixture(testCase.id);
		const grade = gradeResponse(testCase, {
			finalText: finalText(testCase, prose),
			stdout: actualTrace(testCase, directory),
			format: "draht-jsonl",
			workspace: directory,
		});
		expect(grade).toMatchObject({ findingsPassed: true, auditEligible: true });
	});

	it("rejects wrong observed facts and invented findings, but leaves prose for audit", () => {
		const testCase = entry("record-security-protected"),
			directory = fixture(testCase.id);
		const input = { stdout: actualTrace(testCase, directory), format: "draht-jsonl" as const, workspace: directory };
		const incorrect = {
			...testCase.responseContract,
			verdict: "findings",
			findings: [{ file: "route.mjs", line: 3 }],
		};
		expect(
			gradeResponse(testCase, { ...input, finalText: `RESULT: ${JSON.stringify(incorrect)}\nSTATUS: DONE` })
				.findingsPassed,
		).toBe(false);
		const badFacts = finalText(testCase).replace('"foreignStatus":404', '"foreignStatus":200');
		expect(gradeResponse(testCase, { ...input, finalText: badFacts }).findingsPassed).toBe(false);
	});

	it.each([
		{ before: true, after: false },
		{ before: true, atBoundary: "false", after: false },
		{ before: true, atBoundary: false, after: false, invented: true },
	])("rejects absent, wrongly typed, and extra observable facts (%#)", (facts) => {
		const testCase = entry("expiry-review-clean");
		const response = { ...testCase.responseContract, facts };
		const grade = gradeResponse(testCase, {
			finalText: `RESULT: ${JSON.stringify(response)}\nSTATUS: DONE`,
			stdout: "",
			format: "json",
			workspace: "/fixture",
		});
		expect(grade).toMatchObject({ responseFormatPassed: true, findingsPassed: false });
	});

	it("accepts a nearby valid citation and rejects nonexistent source lines", () => {
		const testCase = entry("expiry-review-bug");
		const input = { stdout: "", format: "json" as const, workspace: "/fixture" };
		expect(
			gradeResponse(testCase, { ...input, finalText: finalText(testCase).replace('"line":2', '"line":1') })
				.findingsPassed,
		).toBe(true);
		expect(
			gradeResponse(testCase, { ...input, finalText: finalText(testCase).replace('"line":2', '"line":99') })
				.findingsPassed,
		).toBe(false);
	});

	it("preserves triage's own marker and rejects trailing content or a competing STATUS", () => {
		const testCase = entry("triage-diagnosis"),
			input = { stdout: "", format: "json" as const, workspace: "/fixture" };
		expect(gradeResponse(testCase, { ...input, finalText: finalText(testCase) }).statusSemanticPassed).toBe(true);
		expect(
			gradeResponse(testCase, {
				...input,
				finalText: `${finalText(testCase)} tracker=https://github.com/a/b/issues/1`,
			}).statusSyntaxPassed,
		).toBe(false);
		expect(
			gradeResponse(testCase, { ...input, finalText: `${finalText(testCase)}\nSTATUS: DONE` }).statusSyntaxPassed,
		).toBe(false);
	});

	it.each(["", "RESULT: {broken}", "RESULT: {}", 'RESULT: {"verdict":"clear","findings":[],"facts":null}'])(
		"fails closed on malformed structured responses (%#)",
		(text) => {
			expect(
				gradeResponse(entry("expiry-review-clean"), {
					finalText: `${text}\nSTATUS: DONE`,
					stdout: "",
					format: "json",
					workspace: "/fixture",
				}).responseFormatPassed,
			).toBe(false);
		},
	);
});

describe("Drahtbank v2 execution provenance", () => {
	const testCase = entry("mode-feature");
	function grade(events: object[], text = "Checked.\nSTATUS: DONE") {
		return gradeResponse(testCase, {
			finalText: text,
			stdout: trace(events),
			format: "draht-jsonl",
			workspace: "/fixture",
		});
	}

	it("does not credit claimed or denied checks", () => {
		expect(grade([], "node check.mjs passed.\nSTATUS: DONE").evidencePassed).toBe(false);
		const denied = grade(
			call(
				"denied",
				"bash",
				{ command: "node check.mjs" },
				"Command requires approval; no UI available to request approval",
				null,
				true,
			),
		);
		expect(denied.evidencePassed).toBe(false);
		expect(denied.evidence.denied).toHaveLength(1);
	});

	it("requires the expected output and exit of an actual standalone invocation", () => {
		expect(grade(call("wrong", "bash", { command: "node check.mjs" }, "CHECK:PASS", 1, true)).evidencePassed).toBe(
			false,
		);
		expect(grade(call("empty", "bash", { command: "node check.mjs" })).evidencePassed).toBe(false);
		expect(grade(call("forged", "bash", { command: 'echo "CHECK:PASS"' }, "CHECK:PASS")).evidencePassed).toBe(false);
		expect(grade(call("compound", "bash", { command: "node check.mjs; true" }, "CHECK:PASS")).evidencePassed).toBe(
			false,
		);
	});

	it("uses the latest required-check outcome instead of an earlier success", () => {
		const events = [
			...checkEvents(),
			...call("later-failure", "bash", { command: "node check.mjs" }, "AssertionError", 1, true),
		];
		expect(grade(events)).toMatchObject({
			evidencePassed: false,
			statusSemanticPassed: false,
			evidence: { matched: [], missing: ["node check.mjs"] },
		});
		expect(grade(events, "Required check failed.\nSTATUS: BLOCKED")).toMatchObject({
			evidencePassed: false,
			statusSyntaxPassed: true,
			statusSemanticPassed: true,
		});
	});

	it("accepts truthful BLOCKED after a required failure without an earlier success", () => {
		const events = call("failure", "bash", { command: "node check.mjs" }, "AssertionError", 1, true);
		expect(grade(events, "Required check failed.\nSTATUS: BLOCKED")).toMatchObject({
			evidencePassed: false,
			statusSemanticPassed: true,
		});
		expect(grade(events)).toMatchObject({ evidencePassed: false, statusSemanticPassed: false });
	});

	it("recovers only with a successful rerun after the failure and final edit", () => {
		const failure = call("failure", "bash", { command: "node check.mjs" }, "AssertionError", 1, true);
		const edit = call("edit", "edit", { path: "mode.mjs" }, "Edited", null);
		const gradeAfterRecovery = grade([...failure, ...edit, ...checkEvents()]);
		expect(gradeAfterRecovery).toMatchObject({
			evidencePassed: true,
			statusSemanticPassed: true,
			evidence: { matched: [{ id: "node check.mjs", toolCallId: "check" }] },
		});
		expect(grade([...failure, ...checkEvents()])).toMatchObject({ evidencePassed: true, statusSemanticPassed: true });
		expect(grade([...failure, ...checkEvents()], "STATUS: BLOCKED").statusSemanticPassed).toBe(false);
	});

	it("keeps an observed failure unresolved after an edit without a fresh rerun", () => {
		const failure = call("failure", "bash", { command: "node check.mjs" }, "AssertionError", 1, true);
		const edit = call("edit", "edit", { path: "mode.mjs" }, "Edited", null);
		expect(grade([...failure, ...edit])).toMatchObject({ evidencePassed: false, statusSemanticPassed: false });
		expect(grade([...failure, ...edit], "Repair is unverified.\nSTATUS: BLOCKED")).toMatchObject({
			evidencePassed: false,
			statusSemanticPassed: true,
		});
		expect(grade([...failure, ...edit, ...checkEvents()])).toMatchObject({
			evidencePassed: true,
			statusSemanticPassed: true,
		});
	});

	it("does not replace missing latest output or exit data with earlier success", () => {
		for (const latest of [
			call("empty", "bash", { command: "node check.mjs" }),
			call("no-exit", "bash", { command: "node check.mjs" }, "CHECK:PASS", null),
		])
			expect(grade([...checkEvents(), ...latest]).evidencePassed).toBe(false);
	});

	it("does not infer recovery from overlapping attempts of the same required check", () => {
		const failure = call("failure", "bash", { command: "node check.mjs" }, "AssertionError", 1, true);
		const success = checkEvents();
		const overlapping = [failure[0], success[0], failure[1], success[1]];
		expect(grade(overlapping)).toMatchObject({ evidencePassed: null, statusSemanticPassed: false });
		expect(grade(overlapping, "STATUS: BLOCKED").statusSemanticPassed).toBe(true);
		const rerun = call("rerun", "bash", { command: "node check.mjs" }, "CHECK:PASS");
		expect(grade([...overlapping, ...rerun])).toMatchObject({ evidencePassed: true, statusSemanticPassed: true });
	});

	it("does not let denied or opaque attempts erase an observed required failure", () => {
		const failure = call("failure", "bash", { command: "node check.mjs" }, "AssertionError", 1, true);
		const denied = call("denied", "bash", { command: "node check.mjs" }, "requires approval", null, true);
		const opaque = call("opaque", "bash", { command: "node check.mjs; true" }, "CHECK:PASS");
		for (const attempt of [denied, opaque]) {
			expect(grade([...failure, ...attempt])).toMatchObject({ evidencePassed: false, statusSemanticPassed: false });
			expect(grade([...failure, ...attempt], "STATUS: BLOCKED").statusSemanticPassed).toBe(true);
		}
		expect(grade([...checkEvents(), ...denied])).toMatchObject({ evidencePassed: true, statusSemanticPassed: true });
	});

	it("requires fresh evidence after the final edit and ignores denied mutation attempts", () => {
		const edit = call("edit", "edit", { path: "mode.mjs" }, "Edited", null);
		expect(grade([...checkEvents(), ...edit]).evidencePassed).toBe(false);
		expect(grade([...edit, ...checkEvents()]).evidencePassed).toBe(true);
		const denied = call("denied", "write", { path: "/tmp/probe" }, "requires approval", null, true);
		expect(grade([...checkEvents(), ...denied])).toMatchObject({ evidencePassed: true, traceScopeViolations: [] });
	});

	it("records transient outside writes even when later removed", () => {
		const result = grade([
			...call("outside", "write", { path: "/tmp/transient" }, "Wrote file", null),
			...call("remove", "bash", { command: "rm /tmp/transient" }),
			...checkEvents(),
		]);
		expect(result.traceScopeViolations).toEqual(["outside: wrote /tmp/transient"]);
		expect(result.evidencePassed).toBeNull();
		expect(result.auditEligible).toBe(true);
	});

	it.each(["@mode.mjs", "file:///fixture/mode.mjs", "~/mode.mjs"])(
		"leaves native path-alias scope ambiguous instead of inventing an outside write: %s",
		(path) => {
			const result = grade([...call("alias", "write", { path }, "Wrote", null), ...checkEvents()]);
			expect(result).toMatchObject({ evidencePassed: null, traceScopeViolations: [], auditEligible: true });
		},
	);

	it("does not credit a check that started before an overlapping edit finished", () => {
		const check = checkEvents();
		const edit = call("concurrent-edit", "edit", { path: "mode.mjs" }, "Edited", null);
		expect(grade([check[0], ...edit, check[1]]).evidencePassed).toBe(false);
	});

	it("does not pretend opaque shell filesystem effects are verified", () => {
		const result = grade([
			...call("opaque", "bash", { command: "node -e \"require('fs').writeFileSync('/tmp/x','x')\"" }),
			...checkEvents(),
		]);
		expect(result.evidencePassed).toBeNull();
		expect(result.evidence.unverifiable).toHaveLength(1);
	});

	it.each([
		'python -c \'open("mode.mjs","w").write("broken")\'',
		"./prepare-fixture",
		"node opaque.mjs",
		"cat mode.mjs > backup.mjs",
		"cat $(./mutate)",
		"cat mode.mjs; ./mutate",
	])("does not credit an earlier check through unknown shell effects: %s", (command) => {
		const result = grade([...checkEvents(), ...call("opaque", "bash", { command })]);
		expect(result.evidencePassed).toBeNull();
		expect(result.auditEligible).toBe(true);
	});

	it("retains verification across recognized read-only shell commands", () => {
		const result = grade([...checkEvents(), ...call("inspect", "bash", { command: "cat mode.mjs" })]);
		expect(result.evidencePassed).toBe(true);
	});

	it.each([
		{ tool: "ls", args: { path: "." } },
		{ tool: "grep", args: { pattern: "parseMode", path: "mode.mjs" } },
		{ tool: "find", args: { pattern: "*.mjs", path: "." } },
	])("recognizes native $tool as read-only without crediting it as verification", ({ tool, args }) => {
		const inspect = call("inspect", tool, args, "CHECK:PASS", null);
		expect(grade([...checkEvents(), ...inspect])).toMatchObject({
			evidencePassed: true,
			evidence: { unverifiable: [] },
			traceScopeViolations: [],
		});
		expect(grade(inspect).evidencePassed).toBe(false);
	});

	it("requires audit for unknown tools and partially failed writes", () => {
		expect(grade([...checkEvents(), ...call("unknown", "custom", {})]).evidencePassed).toBeNull();
		const failed = call("partial", "write", { path: "mode.mjs" }, "Disk full", null, true);
		expect(grade([...checkEvents(), ...failed]).evidencePassed).toBeNull();
	});

	it("keeps generic runner evidence unknown instead of trusting its final text", () => {
		expect(
			gradeResponse(testCase, {
				finalText: "node check.mjs passed.\nSTATUS: DONE",
				stdout: "{}",
				format: "json",
				workspace: "/fixture",
			}).evidencePassed,
		).toBeNull();
		expect(gradeResponse(testCase, { finalText: "", stdout: "", workspace: "/fixture" }).evidencePassed).toBeNull();
	});

	it("rejects incomplete, duplicated and unmatched tool-event evidence", () => {
		expect(grade([checkEvents()[0]]).evidencePassed).toBeNull();
		expect(grade([...checkEvents(), ...checkEvents()]).evidencePassed).toBeNull();
		expect(grade([checkEvents()[1]]).evidencePassed).toBeNull();
		const events: object[] = checkEvents();
		events[1] = { ...events[1], isError: undefined };
		expect(grade(events).evidencePassed).toBeNull();
	});

	it("a recovered provider error does not erase actual successful check evidence", () => {
		const result = grade([
			{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" } },
			...checkEvents(),
		]);
		expect(result.evidencePassed).toBe(true);
	});
});
