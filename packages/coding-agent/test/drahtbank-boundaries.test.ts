import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInvocation } from "../eval/drahtbank/adapters.mjs";
import { type Adapter, gradeBank, prepareBank, runBank } from "../eval/drahtbank/bank.mjs";
import type * as IsolationModule from "../eval/drahtbank/isolation.mjs";
import { createIsolation } from "../eval/drahtbank/isolation.mjs";

vi.mock("../eval/drahtbank/isolation.mjs", async (importOriginal) => {
	const actual = await importOriginal<typeof IsolationModule>();
	return { ...actual, createIsolation: vi.fn(actual.createIsolation) };
});

const root = fileURLToPath(new URL("../../..", import.meta.url));
const temporary: string[] = [];
function directory() {
	const path = mkdtempSync(join(tmpdir(), "drahtbank-boundary-"));
	temporary.push(path);
	return path;
}
function bank() {
	const output = directory();
	const manifest = prepareBank(output, { root, suite: "2", cases: ["mode-feature"] });
	return { output, manifest };
}
function runner(source: string, format: Adapter["format"] = "json"): Adapter {
	const script = join(directory(), "runner.mjs");
	writeFileSync(script, source);
	return { format, command: [process.execPath, script], provider: "fixture", model: "fixture", settings: {} };
}
afterEach(() => {
	vi.mocked(createIsolation).mockReset();
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Drahtbank enforced boundaries", () => {
	it("disables native builtins and loads only the benchmark tool extension", () => {
		const adapter = runner("", "draht-jsonl");
		const invocation = buildInvocation(
			{ ...adapter, settings: {} },
			{
				workspace: "/fixture",
				promptFile: "/control/prompt.md",
				taskFile: "/control/task.md",
				prompt: "",
				task: "",
			},
		);
		expect(invocation.command).toContain("--no-builtin-tools");
		const extensionIndex = invocation.command.indexOf("--extension");
		expect(extensionIndex).toBeGreaterThan(0);
		expect(invocation.command[extensionIndex + 1]).toMatch(/isolated-tools\.ts$/);
		expect(invocation.command).toContain("--no-extensions");
	});

	it("cannot execute model-produced grading code that writes outside its fixture", async () => {
		const { output } = bank();
		const outside = join(directory(), "escaped.txt");
		const implementation = `import {writeFileSync} from "node:fs";
export function parseMode(value) {
  writeFileSync(${JSON.stringify(outside)}, "escaped");
  if(typeof value !== "string") throw Error("Invalid mode");
  const mode=value.trim().toLowerCase();
  if(mode!=="quiet" && mode!=="loud") throw Error("Invalid mode");
  return mode;
}`;
		const adapter = runner(`import {writeFileSync} from "node:fs";
writeFileSync("mode.mjs",${JSON.stringify(implementation)});
console.log(JSON.stringify({finalText:"STATUS: DONE_WITH_CONCERNS"}));`);
		const report = await runBank(output, adapter);
		expect(existsSync(outside)).toBe(false);
		for (const grade of report.results) {
			expect(grade.behaviorPassed).toBe(false);
			expect(grade.acceptance?.stderr).toMatch(/ENOENT|EACCES|EROFS|EPERM/);
		}
	});

	it("rejects native output without an isolation readiness record", async () => {
		const { output } = bank();
		const message = {
			role: "assistant",
			provider: "fixture",
			model: "fixture",
			content: [{ type: "text", text: "STATUS: DONE_WITH_CONCERNS" }],
			stopReason: "stop",
		};
		const adapter = runner(
			`for(const event of [{type:"agent_start"},{type:"message_end",message:${JSON.stringify(message)}},{type:"agent_end"}])console.log(JSON.stringify(event));`,
			"draht-jsonl",
		);
		const report = await runBank(output, adapter);
		expect(report.results.every((row) => row.executionPassed === false)).toBe(true);
		expect(report.results.every((row) => row.failure?.includes("isolation"))).toBe(true);
	});

	it.each(["wrong-workspace", "wrong-worker", "old-runtime", "late", "duplicate"])(
		"rejects %s native readiness records",
		async (scenario) => {
			const { output } = bank();
			const source = `import {createIsolation} from ${JSON.stringify(new URL("../eval/drahtbank/isolation.mjs", import.meta.url).href)};
const isolation=await createIsolation(process.cwd());
const receipt={type:"drahtbank_isolation",schemaVersion:1,policy:"fixture-root-v1",toolOperationsVersion:"fixture-operations-v1",workspace:isolation.workspace,evidence:isolation.evidence};
const message={role:"assistant",provider:"fixture",model:"fixture",content:[{type:"text",text:"STATUS: DONE_WITH_CONCERNS"}],stopReason:"stop"};
const scenario=${JSON.stringify(scenario)};
if(scenario==="wrong-workspace") receipt.workspace+="/other";
if(scenario==="wrong-worker") receipt.evidence.workerSha256="0".repeat(64);
if(scenario==="old-runtime") delete receipt.toolOperationsVersion;
const events=scenario==="late"?[{type:"agent_start"},receipt]:[receipt,{type:"agent_start"}];
if(scenario==="duplicate") events.push(receipt);
events.push({type:"message_end",message},{type:"agent_end"});
for(const event of events)console.log(JSON.stringify(event));`;
			const report = await runBank(output, runner(source, "draht-jsonl"));
			for (const grade of report.results) {
				expect(grade.executionPassed).toBe(false);
				expect(grade.isolation?.passed).toBe(false);
				expect(grade.failure).toContain("isolation");
			}
		},
	);

	it("fails before launching the native adapter when isolation prerequisites are missing", async () => {
		const { output, manifest } = bank();
		const marker = join(directory(), "runner-started");
		const adapter = runner(
			`import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(marker)},"started");console.log(JSON.stringify({type:"agent_end"}));`,
			"draht-jsonl",
		);
		vi.mocked(createIsolation).mockRejectedValueOnce(new Error("Drahtbank isolation unavailable: unshare denied"));
		await expect(runBank(output, adapter)).rejects.toThrow(/isolation|sandbox|unshare|executable|runtime/i);
		expect(existsSync(marker)).toBe(false);
		expect(manifest.trials.some((trial) => existsSync(join(output, "control", trial.id, "execution.json")))).toBe(
			false,
		);
		expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).suiteSha256).toBe(manifest.suiteSha256);
	});

	it("reports unavailable grading isolation as infrastructure failure without inventing scope violations", async () => {
		const { output } = bank();
		await runBank(output, runner('console.log(JSON.stringify({finalText:"STATUS: DONE_WITH_CONCERNS"}));'));
		vi.mocked(createIsolation).mockRejectedValue(new Error("Drahtbank isolation unavailable: unshare denied"));
		const report = await gradeBank(output);
		for (const grade of report.results) {
			expect(grade.passed).toBe(false);
			expect(grade.behaviorPassed).toBeNull();
			expect(grade.scopePassed).toBe(true);
			expect(grade.failure).toContain("Acceptance isolation failed:");
		}
	});
});
