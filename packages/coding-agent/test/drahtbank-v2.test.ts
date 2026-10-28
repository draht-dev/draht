import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type Adapter, prepareBank, readManifest, runBank } from "../eval/drahtbank/bank.mjs";
import { CASES } from "../eval/drahtbank/cases-v2.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const directories: string[] = [];
const variants = ["verbose", "pruning", "frontier", "hybrid"].map((id) => ({
	id,
	ref: id === "hybrid" ? null : "HEAD",
}));
function directory() {
	const path = mkdtempSync(join(tmpdir(), "drahtbank-v2-"));
	directories.push(path);
	return path;
}
function prepare() {
	const output = directory();
	const manifest = prepareBank(output, { root, suite: "2", cases: ["mode-feature"], variants });
	return { output, manifest };
}
function adapter(native: boolean, wrongIdentity = false): Adapter {
	const script = join(directory(), "runner.mjs");
	const finalText = "The check passed according to my report.\nSTATUS: DONE_WITH_CONCERNS";
	writeFileSync(
		script,
		native
			? `import {createIsolation} from ${JSON.stringify(new URL("../eval/drahtbank/isolation.mjs", import.meta.url).href)};
const isolation=await createIsolation(process.cwd());
console.log(JSON.stringify({type:"drahtbank_isolation",schemaVersion:1,policy:"fixture-root-v1",toolOperationsVersion:"fixture-operations-v1",workspace:isolation.workspace,evidence:isolation.evidence}));
const message = ${JSON.stringify({ role: "assistant", provider: wrongIdentity ? "different" : "fixture", model: "fixture", content: [{ type: "text", text: finalText }], stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })}; for (const event of [{type:'agent_start'},{type:'message_end',message},{type:'agent_end',messages:[message]}]) console.log(JSON.stringify(event));`
			: `console.log(${JSON.stringify(JSON.stringify({ finalText }))});`,
	);
	return {
		format: native ? "draht-jsonl" : "json",
		command: [process.execPath, script],
		provider: "fixture",
		model: "fixture",
		settings: {},
		timeoutMs: 3000,
	};
}
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Drahtbank v2 matrix and evidence", () => {
	it("preserves the frozen v1 case identity", () => {
		const manifest = prepareBank(directory(), { root, cases: ["feature"] });
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.suiteSha256).toBe("0062167bd80d9beee535fe13e7b827a32baa304d89c2a5336beb9550531ba781");
	});
	it("pins four variants and balances each order position over four repetitions", () => {
		const output = directory();
		const manifest = prepareBank(output, {
			root,
			suite: "2",
			variants,
			cases: ["mode-feature"],
			repeats: 4,
			orderOffset: 1,
		});
		expect(readManifest(output)).toEqual(manifest);
		expect(manifest.trials).toHaveLength(16);
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		expect(manifest.variants?.map((variant) => variant.ref)).toEqual([head, head, head, null]);
		for (const position of [0, 1, 2, 3])
			expect(
				new Set(manifest.trials.filter((_, index) => index % 4 === position).map((trial) => trial.variant)).size,
			).toBe(4);
		for (const trial of manifest.trials) expect(trial.promptCommit).toBe(trial.variant === "hybrid" ? null : head);
	});
	it("loads the selected skills and commands in all host layouts", () => {
		const output = directory();
		const manifest = prepareBank(output, {
			root,
			suite: "2",
			variants,
			hosts: ["coding-agent", "draht-claude", "draht-codex"],
			cases: ["advisor-precedence", "triage-diagnosis"],
		});
		for (const trial of manifest.trials) {
			if (trial.caseId === "advisor-precedence") {
				expect(trial.promptPath).toContain("skills/model-tiering/SKILL.md");
				expect(trial.promptSurface).toBe(trial.host === "coding-agent" ? "canonical-skill" : "package-asset");
			} else {
				expect(trial.promptPath).toMatch(/(?:commands\/triage\.md|skills\/triage\/command\.md)$/);
				const task = readFileSync(join(output, "control", trial.id, "task.md"), "utf8");
				expect(task).toContain("[triage:");
				expect(task).not.toContain("End your response with exactly one status line using the appropriate outcome");
			}
		}
	});
	it("keeps held-out cases out of the default screen", () => {
		const screen = prepareBank(directory(), { root, suite: "2", variants });
		const held = prepareBank(directory(), { root, suite: "2", split: "holdout", variants });
		expect(screen.caseIds.every((id) => CASES.find((entry) => entry.id === id)?.split === "screen")).toBe(true);
		expect(held.caseIds.length).toBeGreaterThan(0);
		expect(held.caseIds.every((id) => !screen.caseIds.includes(id))).toBe(true);
		expect(() => prepareBank(directory(), { root, suite: "2", variants, cases: [held.caseIds[0]] })).toThrow(
			"requested split",
		);
	});
	it("rejects altered source metadata and suite hashes", () => {
		const { output, manifest } = prepare();
		manifest.trials[0].promptCommit = null;
		writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest));
		expect(() => readManifest(output)).toThrow("source metadata");
		manifest.suiteSha256 = "0".repeat(64);
		writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest));
		expect(() => readManifest(output)).toThrow("changed benchmark suite");
	});
	it.each(
		[
			[{ id: "only", ref: "HEAD" }],
			[
				{ id: "same", ref: "HEAD" },
				{ id: "same", ref: null },
			],
			[
				{ id: "../escape", ref: "HEAD" },
				{ id: "hybrid", ref: null },
			],
		].map((choices) => ({ choices })),
	)("rejects invalid variant matrices", ({ choices }) => {
		expect(() => prepareBank(directory(), { root, suite: "2", variants: choices })).toThrow();
	});
	it("keeps generic verification unknown and separates valid cautious status from broken code", async () => {
		const { output } = prepare();
		const report = await runBank(output, adapter(false));
		for (const result of report.results) {
			expect(result.executionPassed).toBe(true);
			expect(result.statusSyntaxPassed).toBe(true);
			expect(result.statusSemanticPassed).toBe(true);
			expect(result.behaviorPassed).toBe(false);
			expect(result.evidencePassed).toBeNull();
			expect(result.passed).toBe(false);
		}
		expect(report.summary.variants.hybrid.axes?.evidencePassed.unknownOrNotApplicable).toBe(1);
	});
	it("does not credit final prose as executed verification", async () => {
		const { output } = prepare();
		const report = await runBank(output, adapter(true));
		expect(report.results.every((result) => result.executionPassed && result.evidencePassed === false)).toBe(true);
	});
	it("keeps behavior unmeasured when unsafe scope changes prevent acceptance execution", async () => {
		const { output } = prepare();
		const runner = adapter(false);
		const script = runner.command[1];
		writeFileSync(
			script,
			`${readFileSync(script, "utf8")}\nimport {writeFileSync} from 'node:fs';writeFileSync('extra.txt','unrequested');`,
		);
		const report = await runBank(output, runner);
		for (const result of report.results) {
			expect(result.scopePassed).toBe(false);
			expect(result.behaviorPassed).toBeNull();
		}
		expect(report.summary.variants.hybrid.axes?.behaviorPassed.unknownOrNotApplicable).toBe(1);
	});
	it("rejects native model identity drift independently of valid output", async () => {
		const { output } = prepare();
		const report = await runBank(output, adapter(true, true));
		expect(report.results.every((result) => !result.executionPassed && result.identity?.passed === false)).toBe(true);
	});
	it("exposes v2 case splits through the CLI", () => {
		const run = spawnSync(
			process.execPath,
			[
				join(root, "packages/coding-agent/bin/drahtbank.mjs"),
				"list",
				"--suite",
				"2",
				"--split",
				"holdout",
				"--json",
			],
			{ cwd: directory(), encoding: "utf8" },
		);
		expect(run.status, run.stderr).toBe(0);
		const catalog = JSON.parse(run.stdout);
		expect(catalog.cases.length).toBeGreaterThan(0);
		expect(catalog.cases.every((entry: { split: string }) => entry.split === "holdout")).toBe(true);
	});
});
