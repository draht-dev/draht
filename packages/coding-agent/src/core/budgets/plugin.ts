import { BUDGET_GUIDANCE } from "../builtins/budget-guidance.ts";
import {
	auditBudget,
	beginTask,
	budgetConfigured,
	checkBudget,
	clearStopFailures,
	recordStopFailure,
} from "./runtime.ts";
import { previewTool } from "./tools.ts";
import type { ProposedBudgetFile } from "./workspace.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "list_directory"]);
/** Only a prompt the user submits starts a new task; the agent cannot submit one. */
const RESET_PROMPT = /^(?:\/(?:draht:)?budget|\$draht:budget)\s+new$/;
/** Matches the native host: three repair attempts, then completion is allowed and reported as over budget. */
const MAX_REPAIR_ATTEMPTS = 3;

/** Edits the host would reject run anyway and report the host's own error; the audit after the tool still applies. */
function previewEdit(cwd: string, name: string, args: unknown): ProposedBudgetFile[] | undefined {
	try {
		return previewTool(cwd, name, args);
	} catch {
		return undefined;
	}
}

function field(value: object, key: string): unknown {
	return key in value ? Reflect.get(value, key) : undefined;
}

function text(value: object, key: string): string {
	const found = field(value, key);
	return typeof found === "string" ? found : "";
}

export function runHook(event: string, input: string): void {
	try {
		const value: unknown = JSON.parse(input);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid budget hook payload");
		const cwd = text(value, "cwd") || process.cwd();
		if (event === "SessionStart") {
			const report = beginTask({ cwd });
			if (report.status === "error") process.stdout.write(`${report.summary}\n`);
			else if (report.status !== "disabled") process.stdout.write(`${report.summary}\n${BUDGET_GUIDANCE}\n`);
			return;
		}
		if (event === "UserPromptSubmit") {
			const reset = RESET_PROMPT.test(text(value, "prompt").trim());
			const report = beginTask({ cwd, newTask: reset });
			if (report.status !== "disabled") clearStopFailures(cwd, text(value, "session_id"));
			if (reset && report.status !== "disabled") {
				process.stdout.write(`Budget task reset by the user's command. ${report.summary}\n`);
			} else if (reset || report.status === "failed" || report.status === "error") {
				// The session start already gave the limits; later prompts only carry news the agent must act on.
				process.stdout.write(`${report.summary}\n`);
			}
			return;
		}
		if (event !== "PreToolUse" && event !== "PostToolUse") throw new Error(`Unknown budget hook event: ${event}`);
		const name = text(value, "tool_name");
		if (READ_TOOLS.has(name.split(/[.:]/).at(-1)?.toLowerCase() ?? "")) return;
		if (event === "PostToolUse") {
			const report = auditBudget({ cwd });
			if (report.status === "failed") throw new Error(report.summary);
			return;
		}
		if (!budgetConfigured(cwd)) return;
		const proposed = previewEdit(cwd, name, field(value, "tool_input") ?? field(value, "arguments") ?? {});
		if (!proposed) {
			// Enrolling before a shell command runs keeps its changes out of a new worktree's baseline.
			beginTask({ cwd });
			return;
		}
		const report = checkBudget({ cwd, proposed });
		if (report.status === "failed") throw new Error(report.summary);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}

/**
 * The final gate after project checks. An excess blocks completion for three repair attempts per prompt, then
 * completion proceeds with the excess reported. A broken inspection blocks once, so the agent can fix an invalid
 * configuration or tell the user, and is reported without blocking on the host's retry.
 */
export function stopBudget({ cwd, retry, session = "" }: { cwd: string; retry: boolean; session?: string }): {
	exitCode: 0 | 1 | 2;
	message: string;
} {
	const report = auditBudget({ cwd });
	if (report.status === "failed") {
		const attempt = recordStopFailure(cwd, session);
		if (attempt > MAX_REPAIR_ATTEMPTS) {
			return {
				exitCode: 1,
				message: `Budget verification failed. Automatic repair stopped; this work is not within budget.\n${report.summary}`,
			};
		}
		return {
			exitCode: 2,
			message: `Budget exceeded (repair ${attempt}/${MAX_REPAIR_ATTEMPTS}). Reduce the reported excess while keeping code readable and documentation concise.\n${report.summary}`,
		};
	}
	clearStopFailures(cwd, session);
	if (report.status !== "error") return { exitCode: 0, message: "" };
	if (retry) return { exitCode: 1, message: report.summary };
	return {
		exitCode: 2,
		message: `${report.summary}\nFix .draht/budgets.json if it is invalid; otherwise tell the user to start a new budget task.`,
	};
}
