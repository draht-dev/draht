import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPackageDir } from "../../src/config.ts";
import type { BudgetLimits } from "../../src/core/budgets/policy.ts";
import { auditBudget } from "../../src/core/budgets/runtime.ts";
import completionChecksBuiltin from "../../src/core/builtins/completion-checks.ts";
import { CORE_BUILTIN_EXTENSIONS } from "../../src/core/builtins/index.ts";
import {
	createHarness,
	createTestUiContext,
	getMessageText,
	getToolResult,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

describe("native task budgets", () => {
	const harnesses: Harness[] = [];
	const fixtureDirectories: string[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function setup(
		limits: Partial<BudgetLimits> = { maxFileTokens: 30, maxCodeTokens: 1000, maxDocTokens: 50 },
		laterExtensions: NonNullable<HarnessOptions["extensionFactories"]> = [],
		git = true,
	) {
		const harness = await createHarness({
			extensionFactories: [
				...CORE_BUILTIN_EXTENSIONS.flatMap((extension) =>
					typeof extension !== "function" && extension.name === "budgets"
						? [{ factory: extension.factory, path: "builtin:budgets" }]
						: [],
				),
				...laterExtensions,
			],
		});
		harnesses.push(harness);
		if (git) execFileSync("git", ["init", "--quiet"], { cwd: harness.tempDir });
		mkdirSync(join(harness.tempDir, ".draht"));
		writeFileSync(join(harness.tempDir, ".draht", "budgets.json"), JSON.stringify(limits));
		return harness;
	}

	function reports(harness: Harness): string[] {
		return harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom_message" && entry.customType === "budgets" ? [getMessageText(entry)] : [],
			);
	}

	it.each([
		{ command: "/budget", request: "configure" },
		{ command: "/budget configure", request: "configure" },
		{ command: "/budget configure code=3000 docs=700", request: "configure code=3000 docs=700" },
	])("starts guided configuration from $command without writing choices", async ({ command, request }) => {
		const harness = await setup();
		const config = join(harness.tempDir, ".draht", "budgets.json");
		unlinkSync(config);
		harness.setResponses([
			() => {
				expect(existsSync(config)).toBe(false);
				return fauxAssistantMessage("Use 5,000 code tokens and 1,500 documentation tokens per file?");
			},
		]);
		await harness.session.prompt(command);
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		await harness.session.waitForIdle();
		const prompt = getUserTexts(harness).at(-1) ?? "";
		expect(prompt).toContain(`Request: ${request}`);
		expect(prompt).toContain(join(getPackageDir(), "hooks", "checks", "budgets-runtime.cjs"));
		expect(prompt).toContain("configPath");
		expect(prompt).toContain("Never reset the task automatically");
		expect(prompt).not.toContain("<BUDGET_RUNTIME>");
		expect(prompt).not.toContain("$ARGUMENTS");
		expect(existsSync(config)).toBe(false);
	});

	it("keeps status and explicit new commands local without triggering a model", async () => {
		const harness = await setup();
		await harness.session.prompt("/budget status");
		const before = auditBudget({ cwd: harness.tempDir });
		await harness.session.prompt("/budget new");
		const after = auditBudget({ cwd: harness.tempDir });
		expect(harness.faux.state.callCount).toBe(0);
		expect(before.taskId).toBeTruthy();
		expect(after.taskId).not.toBe(before.taskId);
	});

	it("refuses guided configuration and task reset while the agent is busy", async () => {
		const harness = await setup();
		const notifications: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		const config = join(harness.tempDir, ".draht", "budgets.json");
		const contents = readFileSync(config, "utf8");
		const before = auditBudget({ cwd: harness.tempDir });
		harness.setResponses([
			async () => {
				for (const command of ["/budget", "/budget configure", "/budget new"])
					await harness.session.prompt(command);
				return fauxAssistantMessage("Existing task continued.");
			},
		]);
		await harness.session.prompt("continue working");
		expect(harness.faux.state.callCount).toBe(1);
		expect(notifications.filter((message) => message.includes("active run"))).toHaveLength(3);
		expect(readFileSync(config, "utf8")).toBe(contents);
		expect(auditBudget({ cwd: harness.tempDir }).taskId).toBe(before.taskId);
	});

	it("guides a nested session to the repository configuration without resetting its active task", async () => {
		const harness = await setup({ maxFileTokens: 5000, maxDocFileTokens: 1500, maxCodeTokens: 1000 }, [], false);
		const repository = mkdtempSync(join(tmpdir(), "budget-guided-"));
		fixtureDirectories.push(repository);
		const nested = join(repository, "nested");
		renameSync(harness.tempDir, nested);
		symlinkSync(nested, harness.tempDir, process.platform === "win32" ? "junction" : "dir");
		renameSync(join(nested, ".draht"), join(repository, ".draht"));
		execFileSync("git", ["init", "--quiet"], { cwd: repository });
		const configPath = join(repository, ".draht", "budgets.json");
		const contents = readFileSync(configPath, "utf8");
		const before = auditBudget({ cwd: harness.tempDir });
		expect(before.status, before.summary).toBe("passed");
		const runtimePath = join(getPackageDir(), "hooks", "checks", "budgets-runtime.cjs");
		const command = `node '${runtimePath.replaceAll("'", "'\\''")}' config`;
		const configCall = () => fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
		harness.setResponses([
			configCall(),
			() => {
				const discovered: unknown = JSON.parse(getMessageText(getToolResult(harness, "bash")));
				expect(discovered).toMatchObject({ configPath, exists: true });
				expect(readFileSync(configPath, "utf8")).toBe(contents);
				return fauxAssistantMessage("Which per-file limits do you want?");
			},
		]);
		await harness.session.prompt("/budget configure");
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(2));
		await harness.session.waitForIdle();
		const selected = {
			enabled: true,
			maxFileTokens: 3000,
			maxDocFileTokens: 700,
			maxCodeTokens: null,
			maxDocTokens: null,
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: configPath, content: JSON.stringify(selected) })], {
				stopReason: "toolUse",
			}),
			configCall(),
			fauxAssistantMessage("Saved for the next explicit /budget new."),
		]);
		await harness.session.prompt("Use 3000 code and 700 documentation tokens per file, with task limits disabled.");
		expect(getToolResult(harness, "write").isError).not.toBe(true);
		const validated: unknown = JSON.parse(getMessageText(getToolResult(harness, "bash")));
		expect(validated).toMatchObject({ configPath, limits: { maxFileTokens: 3000, maxDocFileTokens: 700 } });
		expect(readFileSync(configPath, "utf8")).toBe(JSON.stringify(selected));
		expect(existsSync(join(nested, ".draht", "budgets.json"))).toBe(false);
		const after = auditBudget({ cwd: harness.tempDir });
		expect(after.taskId).toBe(before.taskId);
		expect(after.limits).toEqual(before.limits);
		expect(after.usage.codeTokens).toBeGreaterThan(before.usage.codeTokens);
	});

	it("rejects an oversized native write before creating the file", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("write", { path: "large.ts", content: "export const value = 1;\n".repeat(50) })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("The write exceeded the file budget."),
		]);
		await harness.session.prompt("implement");
		expect(existsSync(join(harness.tempDir, "large.ts"))).toBe(false);
		expect(getToolResult(harness, "write").isError).toBe(true);
		expect(getMessageText(getToolResult(harness, "write"))).toMatch(/budget/i);
	});

	it("previews fuzzy multi-edits with the same BOM and line endings as the edit tool", async () => {
		const harness = await setup();
		const path = join(harness.tempDir, "existing.ts");
		writeFileSync(path, "\uFEFFconst value = “before”;\r\nconst keep = 1;\r\n");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "existing.ts",
						edits: [
							{ oldText: '"before"', newText: '"after"' },
							{ oldText: "const keep = 1;", newText: "const keep = 2;" },
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("updated"),
		]);
		await harness.session.prompt("update");
		expect(getToolResult(harness, "edit").isError).not.toBe(true);
		const updated = '\uFEFFconst value = "after";\r\nconst keep = 2;\r\n';
		expect(readFileSync(path, "utf8")).toBe(updated);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "existing.ts",
						edits: [{ oldText: '"after"', newText: `"${"word ".repeat(100)}"` }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The edit exceeded the file budget."),
		]);
		await harness.session.prompt("expand");
		expect(getToolResult(harness, "edit").isError).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(updated);
	});

	it("shares a code allowance across prompts and resets only on the idle user command", async () => {
		const harness = await setup({ maxFileTokens: 1000, maxCodeTokens: 50, maxDocTokens: 50 });
		const content = "const value = 1;\n".repeat(5);
		for (const path of ["first.ts", "second.ts"]) {
			harness.setResponses([
				async () => {
					if (path === "second.ts") await harness.session.prompt("/budget new");
					return fauxAssistantMessage([fauxToolCall("write", { path, content })], { stopReason: "toolUse" });
				},
				fauxAssistantMessage("checked"),
			]);
			await harness.session.prompt(`write ${path}`);
		}
		expect(readFileSync(join(harness.tempDir, "first.ts"), "utf8")).toBe(content);
		expect(existsSync(join(harness.tempDir, "second.ts"))).toBe(false);
		const calls = harness.faux.state.callCount;
		await harness.session.prompt("/budget new");
		expect(harness.faux.state.callCount).toBe(calls);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "second.ts", content })], { stopReason: "toolUse" }),
			fauxAssistantMessage("written"),
		]);
		await harness.session.prompt("write second.ts");
		expect(readFileSync(join(harness.tempDir, "second.ts"), "utf8")).toBe(content);
	});

	it("gives budget guidance once per conversation branch and keeps /budget out of the prompt templates", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const contexts = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "budget-context");
		expect(contexts).toHaveLength(1);
		expect(getMessageText(contexts[0])).toContain("ceilings, not targets");
		expect(harness.session.promptTemplates.map(({ name }) => name)).not.toContain("budget");
	});

	it("separates documentation from code and leaves chat unrestricted", async () => {
		const harness = await setup({ maxDocFileTokens: 10 });
		const reply = "Explanatory text. ".repeat(1000);
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toMatch(/budget/i);
				expect(JSON.stringify(context.messages)).toContain("cohesive");
				return fauxAssistantMessage(
					[fauxToolCall("write", { path: "guide.md", content: "Documentation. ".repeat(100) })],
					{
						stopReason: "toolUse",
					},
				);
			},
			fauxAssistantMessage([fauxToolCall("write", { path: "small.ts", content: "export const value = 1;\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(reply),
		]);
		await harness.session.prompt("write code and documentation");
		expect(existsSync(join(harness.tempDir, "guide.md"))).toBe(false);
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "toolResult" &&
					message.isError &&
					getMessageText(message).includes("documentation tokens exceed file ceiling 10"),
			),
		).toBe(true);
		expect(existsSync(join(harness.tempDir, "small.ts"))).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "assistant" && getMessageText(message) === reply),
		).toBe(true);
	});

	it("audits real shell changes and refuses completion after three failed repairs", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", {
						command: `node -e 'require("node:fs").writeFileSync("shell.ts", "export const value = 1;\\n".repeat(50))'`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			...Array.from({ length: 4 }, () => fauxAssistantMessage("done")),
		]);
		await harness.session.prompt("implement with a shell command");
		expect(readFileSync(join(harness.tempDir, "shell.ts"), "utf8")).toContain("export const value");
		// The command itself succeeded; the budget report rides along without marking it failed.
		expect(getToolResult(harness, "bash").isError).not.toBe(true);
		expect(getMessageText(getToolResult(harness, "bash"))).toMatch(/budget exceeded/i);
		expect(reports(harness)).toHaveLength(4);
		expect(reports(harness)[0]).toContain("repair 1/3");
		expect(reports(harness).at(-1)).toContain("this work is not within budget");
		expect(harness.session.isIdle).toBe(true);
	});

	it("allows a shell repair after detecting excess changes", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", {
						command: `node -e 'require("node:fs").writeFileSync("shell.ts", "export const value = 1;\\n".repeat(50))'`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'export const value = 1;\\n' > shell.ts" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("reduced"),
		]);
		await harness.session.prompt("implement and reduce");
		expect(readFileSync(join(harness.tempDir, "shell.ts"), "utf8")).toBe("export const value = 1;\n");
		expect(getToolResult(harness, "bash").isError).not.toBe(true);
		expect(reports(harness)).toEqual([]);
	});

	it("checks mutations made by later settlement handlers", async () => {
		const harness = await setup(undefined, [
			(pi) => {
				pi.on("agent_before_settle", (_event, ctx) => {
					writeFileSync(join(ctx.cwd, "late.ts"), "export const value = 1;\n".repeat(50));
				});
			},
		]);
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
		await harness.session.prompt("implement");
		expect(reports(harness)).toHaveLength(4);
		expect(reports(harness).at(-1)).toContain("this work is not within budget");
	});

	it("audits after completion-check commands have changed files", async () => {
		const harness = await setup(undefined, [{ factory: completionChecksBuiltin, path: "builtin:completion-checks" }]);
		writeFileSync(
			join(harness.tempDir, ".draht", "checks.json"),
			JSON.stringify({
				checks: [
					{
						name: "generate",
						command: [
							process.execPath,
							"-e",
							'require("node:fs").writeFileSync("generated.ts", "export const value = 1;\\n".repeat(50))',
						],
						cache: false,
					},
				],
			}),
		);
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
		await harness.session.prompt("verify");
		expect(readFileSync(join(harness.tempDir, "generated.ts"), "utf8")).toContain("export const value");
		expect(reports(harness)).toHaveLength(4);
		expect(reports(harness).at(-1)).toContain("this work is not within budget");
	});

	it("keeps tools available when configured budgets cannot run outside Git, but reports the unchecked work", async () => {
		const harness = await setup(undefined, [], false);
		writeFileSync(join(harness.tempDir, "existing.ts"), "export const value = 1;\n");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "existing.ts" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "new.ts", content: "export const other = 2;\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("written"),
		]);
		await harness.session.prompt("inspect and edit");
		expect(getToolResult(harness, "read").isError).not.toBe(true);
		expect(getToolResult(harness, "write").isError).not.toBe(true);
		expect(existsSync(join(harness.tempDir, "new.ts"))).toBe(true);
		expect(reports(harness)).toHaveLength(1);
		expect(reports(harness)[0]).toContain("could not run");
		expect(reports(harness)[0]).toContain("Git working tree");
	});

	it("reports an unparsable configuration without forcing repair turns", async () => {
		const harness = await setup();
		writeFileSync(join(harness.tempDir, ".draht", "budgets.json"), "{");
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("verify");
		expect(harness.faux.state.callCount).toBe(1);
		expect(reports(harness)).toHaveLength(1);
		expect(reports(harness)[0]).toContain("could not run");
		expect(harness.session.isIdle).toBe(true);
	});

	it("adds nothing to the prompt or the tools in a repository without budget configuration", async () => {
		const harness = await setup();
		unlinkSync(join(harness.tempDir, ".draht", "budgets.json"));
		const content = "export const value = 1;\n".repeat(50);
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("File budgets");
				return fauxAssistantMessage([fauxToolCall("write", { path: "large.ts", content })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("written"),
		]);
		await harness.session.prompt("write a file");
		expect(getToolResult(harness, "write").isError).not.toBe(true);
		expect(readFileSync(join(harness.tempDir, "large.ts"), "utf8")).toBe(content);
		expect(reports(harness)).toEqual([]);
		const ledger = readdirSync(join(harness.tempDir, ".git")).filter((name) => name.startsWith("draht-budgets"));
		expect(ledger).toEqual([]);
	});

	it("lets an edit the tool will reject report the tool's own error", async () => {
		const harness = await setup();
		writeFileSync(join(harness.tempDir, "existing.ts"), "export const value = 1;\n");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("edit", { path: "existing.ts", edits: [{ oldText: "missing text", newText: "other" }] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The edit did not match."),
		]);
		await harness.session.prompt("edit");
		const result = getToolResult(harness, "edit");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).not.toMatch(/budget/i);
	});
});
