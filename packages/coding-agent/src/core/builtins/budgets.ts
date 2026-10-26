import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { getPackageDir, isBunBinary } from "../../config.ts";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import { splitBom } from "../../utils/text.ts";
import {
	type BoundaryResult,
	type ExtensionAPI,
	isToolCallEventType,
	type ToolCallEvent,
} from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	normalizeToLF,
	restoreLineEndings,
} from "../tools/edit-diff.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { BUDGET_GUIDANCE } from "./budget-guidance.ts";

interface BudgetResult {
	status: "passed" | "failed" | "disabled" | "error";
	summary: string;
	taskId?: string;
}

type ProposedFiles = Array<{ path: string; content: string | null }>;

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MAX_REPAIR_ATTEMPTS = 3;
const CONTEXT_TYPE = "budget-context";
const RUNTIME_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function runtimePath(): string {
	return join(getPackageDir(), "hooks", "checks", "budgets-runtime.cjs");
}

function parseResult(value: unknown): BudgetResult {
	if (
		typeof value !== "object" ||
		value === null ||
		!("status" in value) ||
		!("summary" in value) ||
		(value.status !== "passed" &&
			value.status !== "failed" &&
			value.status !== "disabled" &&
			value.status !== "error") ||
		typeof value.summary !== "string"
	) {
		throw new Error("Invalid budget policy result");
	}
	return {
		status: value.status,
		summary: value.summary,
		...("taskId" in value && typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
	};
}

function failure(error: unknown): BudgetResult {
	return {
		status: "error",
		summary: `Budget check failed: ${error instanceof Error ? error.message : String(error)}`,
	};
}

/** Runs the packaged runtime in a child process, so snapshotting a large repository never blocks the session. */
async function callBudget(
	method: "beginTask" | "checkBudget" | "auditBudget",
	request: { cwd: string; proposed?: ProposedFiles },
	signal?: AbortSignal,
): Promise<BudgetResult> {
	let output = "";
	let errors = "";
	let termination: string | undefined;
	try {
		const child = spawnProcess(isBunBinary ? "node" : process.execPath, [runtimePath(), "call"], {
			cwd: request.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const terminate = (reason: string) => {
			termination ??= reason;
			child.kill("SIGKILL");
		};
		const onAbort = () => terminate("Budget check was cancelled");
		const timeout = setTimeout(() => terminate("Budget check exceeded its 60-second limit"), RUNTIME_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) terminate("Budget check output exceeded 1 MiB");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			errors = `${errors}${chunk.toString()}`.slice(-4000);
		});
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin?.end(JSON.stringify({ method, request }));
		try {
			const code = await waitForChildProcess(child);
			if (termination) return failure(termination);
			if (code !== 0) return failure(`budget runtime exited ${code ?? "without an exit status"}. ${errors}`.trim());
			return parseResult(JSON.parse(output));
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch (error) {
		return failure(error);
	}
}

function loadRuntime() {
	const runtime: unknown = createRequire(import.meta.url)(runtimePath());
	if (
		typeof runtime !== "object" ||
		runtime === null ||
		!("beginTask" in runtime) ||
		!("budgetConfigured" in runtime)
	) {
		throw new Error("Missing budget policy");
	}
	const { beginTask, budgetConfigured } = runtime;
	if (typeof beginTask !== "function" || typeof budgetConfigured !== "function")
		throw new Error("Invalid budget policy");
	return {
		/** Starts a new task in this process: the runtime's command-line interface refuses to, so agents cannot. */
		startNewTask: (cwd: string) => parseResult(beginTask({ cwd, newTask: true })),
		/** A file-system check that lets repositories without budgets skip the runtime process entirely. */
		configured: (cwd: string) => budgetConfigured(cwd) === true,
	};
}

/** Edits the tool itself would reject, or that run on another filesystem, are left to the tool and the audit after it. */
function previewEdit(event: ToolCallEvent, cwd: string): ProposedFiles | undefined {
	if (isToolCallEventType("write", event)) {
		return [{ path: resolveToCwd(event.input.path, cwd), content: event.input.content }];
	}
	if (!isToolCallEventType("edit", event)) return undefined;
	try {
		const path = resolveToCwd(event.input.path, cwd);
		const { bom, text } = splitBom(readFileSync(path, "utf8"));
		const { newContent } = applyEditsToNormalizedContent(normalizeToLF(text), event.input.edits, event.input.path);
		return [{ path, content: bom + restoreLineEndings(newContent, detectLineEnding(text)) }];
	} catch {
		return undefined;
	}
}

/** True when budget guidance reached the context after the last compaction. */
function hasBudgetContext(entries: readonly SessionEntry[]): boolean {
	const compaction = entries.findLastIndex((entry) => entry.type === "compaction");
	return entries
		.slice(compaction + 1)
		.some((entry) => entry.type === "custom_message" && entry.customType === CONTEXT_TYPE);
}

function configurationPrompt(request: string): string {
	const packageDir = getPackageDir();
	const body = stripFrontmatter(readFileSync(join(packageDir, "hooks", "checks", "budget-command.md"), "utf8"));
	const runtime = runtimePath().replace(/["\\$`]/g, (character) => `\\${character}`);
	return body.replaceAll("<BUDGET_RUNTIME>", () => runtime).replaceAll("$ARGUMENTS", () => request);
}

export default function budgetsBuiltin(pi: ExtensionAPI) {
	let runtime: ReturnType<typeof loadRuntime> | undefined;
	const local = () => {
		runtime ??= loadRuntime();
		return runtime;
	};
	// Budgets are opt-in, so a run checks nothing until its start finds a configured repository.
	let active = false;
	let repairAttempts = 0;
	const preflighted = new Set<string>();

	pi.on("before_agent_start", async (_event, ctx) => {
		repairAttempts = 0;
		try {
			active = local().configured(ctx.cwd);
		} catch {
			// The runtime process reports why the packaged policy cannot load.
			active = true;
		}
		if (!active) return;
		const result = await callBudget("beginTask", { cwd: ctx.cwd }, ctx.signal);
		active = result.status !== "disabled";
		if (!active) return;
		const informed = hasBudgetContext(ctx.sessionManager.getBranch());
		if (informed && result.status === "passed") return;
		const guided = informed || result.status === "error" ? result.summary : `${result.summary}\n${BUDGET_GUIDANCE}`;
		return { message: { customType: CONTEXT_TYPE, content: guided, display: false, details: result } };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!active) return;
		const proposed = previewEdit(event, ctx.cwd);
		if (!proposed) return;
		const result = await callBudget("checkBudget", { cwd: ctx.cwd, proposed }, ctx.signal);
		if (result.status === "failed") return { block: true, reason: result.summary };
		if (result.status === "passed") preflighted.add(event.toolCallId);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!active || READ_ONLY_TOOLS.has(event.toolName)) return;
		// A write or edit whose preflight passed wrote exactly the content that was checked.
		if (preflighted.delete(event.toolCallId)) return;
		const result = await callBudget("auditBudget", { cwd: ctx.cwd }, ctx.signal);
		if (result.status !== "failed") return;
		return { content: [...event.content, { type: "text", text: result.summary }] };
	});

	pi.on("agent_before_settle", async (event, ctx): Promise<BoundaryResult | undefined> => {
		if (!active || event.outcome !== "completed") return;
		const result = await callBudget("auditBudget", { cwd: ctx.cwd }, ctx.signal);
		if (result.status === "passed" || result.status === "disabled") return;
		const continueRun = result.status === "failed" && repairAttempts < MAX_REPAIR_ATTEMPTS && !ctx.signal?.aborted;
		let content: string;
		if (continueRun) {
			repairAttempts++;
			content = `Budget exceeded (repair ${repairAttempts}/${MAX_REPAIR_ATTEMPTS}). Reduce the reported excess while keeping code readable and documentation concise.\n${result.summary}`;
		} else if (result.status === "failed") {
			content = `Budget verification failed. Automatic repair stopped; this work is not within budget.\n${result.summary}`;
		} else {
			content = `Budget verification could not run, so this work is not checked against the budget. Fix .draht/budgets.json or start a new task with /budget new.\n${result.summary}`;
		}
		if (!continueRun) {
			ctx.ui.notify(content, "error");
			ctx.abort();
		}
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: "budgets", content, display: true, details: result },
			],
			continue: event.continue || continueRun,
		};
	});

	pi.registerCommand("budget", {
		description: "Configure file budgets, show status, or start a new shared task with /budget new",
		handler: async (args, ctx) => {
			const request = args.trim() || "configure";
			const action = /^configure(?:\s|$)/.test(request) ? "configure" : request;
			if (action !== "configure" && action !== "status" && action !== "new") {
				ctx.ui.notify("Usage: /budget [configure|status|new]", "error");
				return;
			}
			if (action !== "status" && !ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the active run to finish before configuring budgets or starting a new task.",
					"error",
				);
				return;
			}
			if (action === "configure") {
				pi.sendUserMessage(configurationPrompt(request), { expandPromptTemplates: false });
				await ctx.waitForIdle();
				return;
			}
			let result: BudgetResult;
			try {
				result =
					action === "new"
						? local().startNewTask(ctx.cwd)
						: await callBudget("auditBudget", { cwd: ctx.cwd }, ctx.signal);
			} catch (error) {
				result = failure(error);
			}
			pi.sendMessage({ customType: "budget-status", content: result.summary, display: true, details: result });
		},
	});
}
