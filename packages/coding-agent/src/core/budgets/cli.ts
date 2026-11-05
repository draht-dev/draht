import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditBudget, beginTask, checkBudget } from "./runtime.ts";
import { readBudgetConfig } from "./state.ts";
import { budgetPathExists, findBudgetWorkspace, type ProposedBudgetFile } from "./workspace.ts";

export { runHook, stopBudget } from "./plugin.ts";
export { auditBudget, beginTask, budgetConfigured, checkBudget } from "./runtime.ts";

const NEW_TASK_REFUSAL =
	"Only the user can start a new budget task: /budget new in draht, /draht:budget new in Claude Code, or $draht:budget new in Codex";

function parseProposed(value: unknown): ProposedBudgetFile[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("Budget call proposed must be an array");
	return value.map((change: unknown) => {
		if (
			typeof change !== "object" ||
			change === null ||
			!("path" in change) ||
			!("content" in change) ||
			typeof change.path !== "string" ||
			(change.content !== null && typeof change.content !== "string")
		) {
			throw new Error("Invalid budget call change");
		}
		return { path: change.path, content: change.content };
	});
}

/** The native host's channel: one JSON request on stdin, one report on stdout. It cannot start a new task. */
function call(input: string): unknown {
	const value: unknown = JSON.parse(input);
	if (typeof value !== "object" || value === null || !("method" in value) || !("request" in value)) {
		throw new Error("Invalid budget call");
	}
	const { method, request } = value;
	if (typeof request !== "object" || request === null || !("cwd" in request) || typeof request.cwd !== "string") {
		throw new Error("Invalid budget call request");
	}
	if ("newTask" in request) throw new Error(NEW_TASK_REFUSAL);
	const proposed = parseProposed("proposed" in request ? request.proposed : undefined);
	if (method === "beginTask") return beginTask({ cwd: request.cwd });
	if (method === "auditBudget") return auditBudget({ cwd: request.cwd });
	if (method === "checkBudget") return checkBudget({ cwd: request.cwd, proposed });
	throw new Error("Unknown budget call method");
}

if (typeof require !== "undefined" && require.main === module) {
	const [action = "status"] = process.argv.slice(2);
	try {
		if (action === "config") {
			const workspace = findBudgetWorkspace(process.cwd());
			if (!workspace) throw new Error("Budget configuration requires a Git working tree");
			const configPath = join(workspace.root, ".draht", "budgets.json");
			const config = { configPath, exists: budgetPathExists(configPath), ...readBudgetConfig(configPath) };
			process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
		} else if (action === "status") {
			const result = auditBudget({ cwd: process.cwd() });
			(result.status === "error" ? process.stderr : process.stdout).write(`${result.summary}\n`);
			process.exitCode = result.status === "failed" || result.status === "error" ? 2 : 0;
		} else if (action === "call") {
			process.stdout.write(JSON.stringify(call(readFileSync(0, "utf8"))));
		} else if (action === "new") {
			throw new Error(NEW_TASK_REFUSAL);
		} else {
			throw new Error("Usage: node budgets-runtime.cjs [config|status]");
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
