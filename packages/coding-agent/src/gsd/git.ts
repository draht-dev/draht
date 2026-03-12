// GSD Git module — git commit operations for the GSD lifecycle.
// Part of the draht GSD (Get Shit Done) methodology.
// Exported via src/gsd/index.ts and @draht/coding-agent.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface CommitResult {
	hash: string | null;
	tddWarning: boolean;
}

interface ExecutionLogEntry {
	commit: string;
	phase: number;
	plan: number;
	status: "pass" | "tdd-violation";
	task: number;
	timestamp: string;
}

function appendExecutionLog(cwd: string, entry: ExecutionLogEntry): void {
	const planningDir = path.join(cwd, ".planning");
	if (!fs.existsSync(planningDir)) {
		return;
	}
	const logPath = path.join(planningDir, "execution-log.jsonl");
	fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

/**
 * Returns true if any file in the list matches known test file patterns.
 */
export function hasTestFiles(files: string[]): boolean {
	return files.some((f) => /\.(test|spec)\.(ts|tsx|js|jsx)$|_test\.(go|ts)$/.test(f));
}

/**
 * Stage all changes and commit as a task in the GSD methodology.
 * Message format: feat(NN-NN): description
 * Sets tddWarning=true when no test files are in the commit.
 */
export function commitTask(cwd: string, phaseNum: number, planNum: number, description: string): CommitResult {
	const scope = `${String(phaseNum).padStart(2, "0")}-${String(planNum).padStart(2, "0")}`;
	const message = `feat(${scope}): ${description}`;
	try {
		execSync("git add -A", { cwd, stdio: "pipe" });
		execSync(`git commit -m ${JSON.stringify(message)}`, { cwd, stdio: "pipe" });
		const hash = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
		let tddWarning = false;
		try {
			const files = execSync(`git diff-tree --no-commit-id --name-only -r ${hash}`, {
				cwd,
				encoding: "utf-8",
			})
				.trim()
				.split("\n")
				.filter(Boolean);
			tddWarning = !hasTestFiles(files);
		} catch {
			// not a git repo or commit not found
		}
		appendExecutionLog(cwd, {
			commit: hash,
			phase: phaseNum,
			plan: planNum,
			status: tddWarning ? "tdd-violation" : "pass",
			task: 1,
			timestamp: new Date().toISOString(),
		});
		return { hash, tddWarning };
	} catch {
		return { hash: null, tddWarning: false };
	}
}

/**
 * Stage all changes and commit as a docs update.
 * Message format: docs: message
 */
export function commitDocs(cwd: string, message: string): CommitResult {
	const msg = `docs: ${message}`;
	try {
		execSync("git add -A", { cwd, stdio: "pipe" });
		execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd, stdio: "pipe" });
		const hash = execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
		return { hash, tddWarning: false };
	} catch {
		return { hash: null, tddWarning: false };
	}
}
