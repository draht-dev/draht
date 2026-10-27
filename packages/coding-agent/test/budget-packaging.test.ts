import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import vocabulary from "gpt-tokenizer/bpeRanks/cl100k_base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countTokens } from "../src/core/budgets/policy.ts";

const ASSET = "budgets-cl100k.json.gz";
const SAMPLES = [
	"",
	"hello world",
	"const x = 1;\r\n",
	"你好世界 — café — e\u0301",
	"🙂👩‍💻",
	"<|endoftext|><|fim_prefix|>",
	"\u0000\uD800\uDFFF",
	"a".repeat(40000),
];

describe.each([
	["coding-agent", "hooks/checks"],
	["draht-claude", "scripts"],
	["draht-codex", "scripts"],
])("%s standalone budget packaging", (host, directory) => {
	const source = resolve("..", host, directory);
	let fixture: string;
	let project: string;
	let runtime: string;
	let asset: string;

	beforeEach(() => {
		fixture = mkdtempSync(join(tmpdir(), "budget-package-"));
		const distribution = join(fixture, "plugin with spaces ' $ `");
		mkdirSync(distribution);
		runtime = join(distribution, "budgets-runtime.cjs");
		asset = join(distribution, ASSET);
		copyFileSync(join(source, "budgets-runtime.cjs"), runtime);
		copyFileSync(join(source, ASSET), asset);
		project = join(fixture, "project");
		mkdirSync(join(project, ".draht"), { recursive: true });
		execFileSync("git", ["init", "--quiet"], { cwd: project });
		writeFileSync(join(project, ".draht/budgets.json"), JSON.stringify({ maxFileTokens: 20000 }));
	});
	afterEach(() => rmSync(fixture, { recursive: true, force: true }));

	it("ships the exact pinned vocabulary as data and keeps JavaScript below 200 KB", () => {
		const decoded: unknown = JSON.parse(gunzipSync(readFileSync(asset)).toString("utf8"));
		expect(decoded).toEqual(vocabulary);
		expect(readFileSync(runtime).byteLength).toBeLessThan(200_000);
	});

	it("counts identically outside the repository without installed dependencies", () => {
		const script = `
const { readFileSync } = require("node:fs");
const { checkBudget } = require(process.argv[1]);
const { cwd, samples } = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(samples.map(content =>
  checkBudget({ cwd, proposed: [{ path: "sample.ts", content }] })
)));
`;
		const result = spawnSync(process.execPath, ["-e", script, runtime], {
			cwd: project,
			input: JSON.stringify({ cwd: project, samples: SAMPLES }),
			encoding: "utf8",
			env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
			timeout: 10000,
		});
		expect(result.error).toBeUndefined();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(
			SAMPLES.map((text) =>
				expect.objectContaining({ status: "passed", usage: { codeTokens: countTokens(text), docTokens: 0 } }),
			),
		);
	});

	it("never reads the vocabulary in a repository without budgets", () => {
		rmSync(asset);
		rmSync(join(project, ".draht"), { recursive: true });
		const result = spawnSync(process.execPath, [runtime, "status"], {
			cwd: project,
			encoding: "utf8",
			timeout: 10000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("not configured");
	});

	it.each(["missing", "invalid gzip", "modified vocabulary"])("refuses an asset that is %s", (failure) => {
		if (failure === "missing") rmSync(asset);
		else if (failure === "invalid gzip") writeFileSync(asset, "not gzip");
		else writeFileSync(asset, gzipSync(JSON.stringify(["different tokens"])));
		expect(spawnSync(process.execPath, [runtime, "status"], { cwd: project, encoding: "utf8" }).status).toBe(0);
		// The vocabulary loads when a change needs measuring.
		writeFileSync(join(project, "change.ts"), "export const value = 1;\n");
		const result = spawnSync(process.execPath, [runtime, "status"], {
			cwd: project,
			encoding: "utf8",
			timeout: 10000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Budget tokenizer vocabulary missing or corrupt");
		expect(result.stdout).not.toContain("Budget task");
	});
});

describe("coding-agent budget command prompt", () => {
	it("ships next to the runtime instead of among the slash-command templates", () => {
		expect(readFileSync(resolve("hooks/checks/budget-command.md"), "utf8")).toContain("<BUDGET_RUNTIME>");
		expect(existsSync(resolve("prompts/commands/budget.md"))).toBe(false);
	});
});
