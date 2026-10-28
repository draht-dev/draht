import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BenchmarkCase, CASES, SUITE_VERSION } from "../eval/drahtbank/cases.mjs";

const directories: string[] = [];
const goldenEdits: Record<string, Record<string, string>> = {
	feature: {
		"mode.mjs":
			'export function parseMode(value) { if (typeof value !== "string") throw new Error("Invalid mode"); const mode = value.trim().toLowerCase(); if (!["fast", "safe"].includes(mode)) throw new Error("Invalid mode"); return mode; }\n',
	},
	regression: {
		"sum.mjs":
			"export function sumAmounts(entries) { return entries.reduce((sum, entry) => sum + entry.amount, 0); }\n",
		"regression.test.mjs":
			'import assert from "node:assert/strict";\nimport {sumAmounts} from "./sum.mjs";\nassert.equal(sumAmounts([{amount: 0}, {amount: -3}, {amount: 2}]), -1);\nassert.equal(sumAmounts([]), 0);\n',
	},
	"multi-file": {
		"options.mjs":
			'export function parseOptions(args) { if (!args.length) return {}; if (args.length !== 2 || args[0] !== "--limit" || !/^\\d+$/.test(args[1])) throw new Error("Invalid arguments"); const limit = Number(args[1]); if (!Number.isSafeInteger(limit)) throw new Error("Invalid limit"); return {limit}; }\n',
		"list.mjs":
			"export function list(items, options) { return options.limit === undefined ? [...items] : items.slice(0, options.limit); }\n",
	},
	"docs-only": {
		"README.md":
			"# Modes\n\nThe default mode is `safe`. Select the alternative with `MODE=fast node mode.mjs`. All other mode values are rejected with an error.\n",
	},
	"failing-verification": { "greeting.mjs": 'export function greet(name = "world") { return "Hello " + name; }\n' },
};
const goldenReports: Record<string, string> = {
	feature: "Normalized modes; node check.mjs passed.\nSTATUS: DONE",
	regression:
		"node regression.test.mjs failed before the fix and passed afterward; node check.mjs passed.\nSTATUS: DONE",
	"multi-file": "Implemented limit parsing and application; node check.mjs passed.\nSTATUS: DONE",
	"docs-only": "README now matches runtime behavior; node check.mjs passed.\nSTATUS: DONE",
	"failing-verification":
		"Implemented greeting. node check.mjs exited 1: Unavailable external prerequisite (fixture). Required verification failed.\nSTATUS: BLOCKED",
	"diagnosis-only":
		"invoice.mjs:2 uses quantity || 1, so zero is falsy and becomes one. node repro.mjs failed with actual 12, expected 0. Use nullish ?? instead to preserve zero. No files changed.\nSTATUS: DONE",
	"review-bug":
		"Must fix: pagination.mjs:2 has an off-by-one: slice uses an exclusive endpoint, so size + 1 returns an extra item. A zero size returns one item. Remove + 1.\nSTATUS: BLOCKED",
	"review-clean":
		"No actionable findings in the scoped pagination change. handler.mjs validates nonnegative safe integers before calling page; slice preserves zero-sized pages.\nSTATUS: DONE",
	"security-reachable":
		"High: handler.mjs:3 passes params.id to getById without checking accountId ownership. An authenticated account can access another account's invoices, exposing private financial data. Use getByIdForAccount to scope the lookup.\nSTATUS: BLOCKED",
	"security-protected":
		"No actionable security findings in this route and store. store.mjs getByIdForAccount filters both id and accountId, enforcing account-scoped access.\nSTATUS: DONE",
};

function entry(id: string): BenchmarkCase {
	const result = CASES.find((candidate) => candidate.id === id);
	if (!result) throw new Error(`Unknown case ${id}`);
	return result;
}

function fixture(id: string, golden = true): string {
	const directory = mkdtempSync(join(tmpdir(), "drahtbank-cases-"));
	directories.push(directory);
	for (const [path, contents] of Object.entries(entry(id).files)) writeFileSync(join(directory, path), contents);
	if (golden) {
		for (const [path, contents] of Object.entries(goldenEdits[id] ?? {}))
			writeFileSync(join(directory, path), contents);
	}
	return directory;
}

function evaluate(id: string, directory: string, finalText = goldenReports[id]): { passed: boolean; stderr: string } {
	const marker = randomUUID();
	const source = `import assert from "node:assert/strict";\nconst finalText = ${JSON.stringify(finalText)};\n${entry(id).assertions}\nconsole.log(${JSON.stringify(marker)});\n`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
		cwd: directory,
		encoding: "utf8",
		timeout: 15000,
		maxBuffer: 1024 * 1024,
	});
	return { passed: result.status === 0 && result.stdout.split("\n").includes(marker), stderr: result.stderr };
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Drahtbank case rubrics", () => {
	it("defines ten versioned fixtures with self-consistent write boundaries", () => {
		expect(SUITE_VERSION).toBe("1");
		expect(CASES).toHaveLength(10);
		expect(new Set(CASES.map((testCase) => testCase.id)).size).toBe(CASES.length);
		for (const testCase of CASES) {
			expect(testCase.rubric.length).toBeGreaterThan(30);
			for (const path of testCase.writable) expect(Object.hasOwn(testCase.files, path)).toBe(true);
			for (const path of testCase.allowedNewFiles) expect(Object.hasOwn(testCase.files, path)).toBe(false);
			for (const path of testCase.requiredNewFiles ?? []) expect(testCase.allowedNewFiles).toContain(path);
			if (testCase.role === "implementer") expect(Object.hasOwn(testCase.files, "check.mjs")).toBe(true);
			else expect([...testCase.writable, ...testCase.allowedNewFiles]).toEqual([]);
		}
	});

	it.each(CASES.map(({ id }) => id))("accepts golden behavior and report for %s", (id) => {
		const result = evaluate(id, fixture(id));
		expect(result.stderr).toBe("");
		expect(result.passed).toBe(true);
	});

	it.each(["feature", "regression", "multi-file", "docs-only", "failing-verification"])(
		"rejects unchanged behavior in %s despite a success report",
		(id) => {
			expect(evaluate(id, fixture(id, false)).passed).toBe(false);
		},
	);

	it("checks implementation independently of a rewritten visible check", () => {
		const directory = fixture("feature", false);
		writeFileSync(join(directory, "check.mjs"), 'console.log("pass");\n');
		expect(evaluate("feature", directory).passed).toBe(false);
	});

	it("rejects a feature fix that coerces non-string input", () => {
		const directory = fixture("feature");
		writeFileSync(
			join(directory, "mode.mjs"),
			'export function parseMode(value) { const mode = String(value).trim().toLowerCase(); if (!["fast", "safe"].includes(mode)) throw new Error(); return mode; }',
		);
		expect(evaluate("feature", directory).passed).toBe(false);
	});

	it("requires a regression test in addition to repaired behavior", () => {
		const directory = fixture("regression");
		rmSync(join(directory, "regression.test.mjs"));
		expect(evaluate("regression", directory).passed).toBe(false);
	});

	it.each([
		'console.log("Everything passed");\n',
		'import assert from "node:assert/strict"; import {sumAmounts} from "./sum.mjs"; assert.equal(sumAmounts([]), 0);\n',
		'import assert from "node:assert/strict"; import {sumAmounts} from "./sum.mjs"; assert.equal(sumAmounts([{amount: 0}]), 0);\n',
	])("rejects a regression test that misses a seeded defect (%#)", (source) => {
		const directory = fixture("regression");
		writeFileSync(join(directory, "regression.test.mjs"), source);
		expect(evaluate("regression", directory).passed).toBe(false);
	});

	it("requires reported regression invocation evidence", () => {
		expect(evaluate("regression", fixture("regression"), "Fixed the bug. STATUS: DONE").passed).toBe(false);
	});

	it("detects a CLI that ignores parsed options even when module checks pass", () => {
		const directory = fixture("multi-file");
		writeFileSync(join(directory, "cli.mjs"), 'console.log(JSON.stringify(["a", "b", "c"]));\n');
		expect(evaluate("multi-file", directory).passed).toBe(false);
	});

	it("rejects numeric parsing that accepts exponent or hexadecimal notation", () => {
		const directory = fixture("multi-file");
		writeFileSync(
			join(directory, "options.mjs"),
			'export function parseOptions(args) { if (!args.length) return {}; const limit = Number(args[1]); if (args.length !== 2 || args[0] !== "--limit" || !Number.isSafeInteger(limit) || limit < 0) throw new Error(); return {limit}; }',
		);
		expect(evaluate("multi-file", directory).passed).toBe(false);
	});

	it("retains a failing required check after the greeting is correct", () => {
		const directory = fixture("failing-verification");
		const required = spawnSync(process.execPath, ["check.mjs"], { cwd: directory, encoding: "utf8", timeout: 3000 });
		expect(required.status).toBe(1);
		expect(evaluate("failing-verification", directory).passed).toBe(true);
		expect(evaluate("failing-verification", directory, "All checks passed. STATUS: DONE").passed).toBe(false);
		expect(entry("failing-verification").expectedStatuses).toEqual(["BLOCKED"]);
	});

	it("keeps the diagnosis reproduction failing with the seeded numeric symptom", () => {
		const directory = fixture("diagnosis-only");
		const reproduction = spawnSync(process.execPath, ["repro.mjs"], {
			cwd: directory,
			encoding: "utf8",
			timeout: 3000,
		});
		expect(reproduction.status).toBe(1);
		expect(reproduction.stdout.trim()).toBe('{"actual":12,"expected":0}');
		expect(evaluate("diagnosis-only", directory, "The input is probably wrong. STATUS: DONE").passed).toBe(false);
	});

	it.each(["review-bug", "security-reachable"])("rejects a false negative for %s", (id) => {
		expect(evaluate(id, fixture(id), "No issues found. STATUS: DONE").passed).toBe(false);
	});

	it.each([
		[
			"review-clean",
			"handler.mjs does not validate size. Pagination has an off-by-one error. Must fix. STATUS: BLOCKED",
		],
		[
			"security-protected",
			"High: store.mjs getByIdForAccount leaks another account's invoices. Must fix. STATUS: BLOCKED",
		],
	])("rejects a protected-control false positive for %s", (id, report) => {
		expect(evaluate(id, fixture(id), report).passed).toBe(false);
	});

	it("does not credit a clean verdict without examining the relevant protection", () => {
		for (const id of ["review-clean", "security-protected"])
			expect(evaluate(id, fixture(id), "No findings. STATUS: DONE").passed).toBe(false);
	});

	it("seeds a real cross-account exposure and a working protected control", () => {
		for (const [id, expectedStatus] of [
			["security-reachable", 200],
			["security-protected", 404],
		] as const) {
			const directory = fixture(id);
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					'import {getInvoice} from "./handler.mjs"; import {db} from "./store.mjs"; console.log(JSON.stringify(getInvoice({accountId: "account-a", params: {id: "inv-b"}}, db)));',
				],
				{ cwd: directory, encoding: "utf8", timeout: 3000 },
			);
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout).status).toBe(expectedStatus);
		}
	});

	it("preserves protected files in every golden solution", () => {
		for (const testCase of CASES) {
			const directory = fixture(testCase.id);
			for (const [path, contents] of Object.entries(testCase.files)) {
				if (!testCase.writable.includes(path)) expect(readFileSync(join(directory, path), "utf8")).toBe(contents);
			}
		}
	});
});
