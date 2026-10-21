import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grade, prepare } from "../eval/frontier-prompts.mjs";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("paired prompt pilot grading", () => {
	it("detects incomplete behavior even when the model reports success", () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-prompt-eval-"));
		dirs.push(dir);
		prepare(dir, "HEAD");
		expect(() => prepare(dir, "HEAD")).toThrow("existing pilot work will not be overwritten");
		writeFileSync(
			join(dir, "candidate/feature/result.json"),
			JSON.stringify({
				status: "done",
				checks: [{ command: "node check.mjs", exitCode: 0 }],
				summary: "Reported success",
			}),
		);
		const result = grade(dir).find(
			(entry: { variant: string; case: string }) => entry.variant === "candidate" && entry.case === "feature",
		);
		expect(result?.accepted).toBe(false);
		expect(result?.reportMatches).toBe(true);
	});

	it("checks behavior independently and rejects tampering with the required check", () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-prompt-eval-"));
		dirs.push(dir);
		prepare(dir, "HEAD");
		const fixture = join(dir, "candidate/feature");
		writeFileSync(
			join(fixture, "mode.mjs"),
			'export function parseMode(value) { if(typeof value !== "string") throw new Error(); const mode=value.trim().toLowerCase(); if(!["fast","safe"].includes(mode)) throw new Error(); return mode; }\n',
		);
		const before = grade(dir).find(
			(entry: { variant: string; case: string }) => entry.variant === "candidate" && entry.case === "feature",
		);
		expect(before?.accepted).toBe(true);
		writeFileSync(join(fixture, "check.mjs"), "// disabled\n");
		const after = grade(dir).find(
			(entry: { variant: string; case: string }) => entry.variant === "candidate" && entry.case === "feature",
		);
		expect(after?.acceptanceExit).toBe(0);
		expect(after?.accepted).toBe(false);
		expect(after?.checkUnchanged).toBe(false);
	});

	it("does not equate successful acceptance with passing a known failed required check", () => {
		const dir = mkdtempSync(join(tmpdir(), "draht-prompt-eval-"));
		dirs.push(dir);
		prepare(dir, "HEAD");
		const fixture = join(dir, "candidate/failing-verification");
		writeFileSync(join(fixture, "greeting.mjs"), 'export function greet(name="world") { return "Hello " + name; }\n');
		writeFileSync(
			join(fixture, "result.json"),
			JSON.stringify({ status: "done", checks: [{ command: "node check.mjs", exitCode: 0 }] }),
		);
		const result = grade(dir).find(
			(entry: { variant: string; case: string }) =>
				entry.variant === "candidate" && entry.case === "failing-verification",
		);
		expect(result?.accepted).toBe(true);
		expect(result?.reportMatches).toBe(false);
		expect(readFileSync(join(fixture, "check.mjs"), "utf8")).toContain("process.exitCode = 1");
	});
});
