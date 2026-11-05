import { type BudgetLimits, budgetChange, type MeasuredTokens, measureTokens } from "./policy.ts";
import { pairRenames } from "./renames.ts";
import type { BudgetReport } from "./runtime.ts";
import { type BudgetSnapshot, type BudgetState, readBudgetContent } from "./state.ts";

export interface BudgetIssue {
	key: string;
	excess: number;
	message: string;
}

/** Token measurements keyed by baseline and current content hash, so the same change is tokenized once. */
export type BudgetMeasures = Map<string, MeasuredTokens>;

export interface BudgetEvaluation {
	report: BudgetReport;
	issues: BudgetIssue[];
	/** The measurements this evaluation used, and whether it had to compute any. */
	measures: BudgetMeasures;
	measured: boolean;
}

const SUMMARY_ISSUES = 10;

export function exceededSummary(messages: readonly string[]): string {
	const hidden = messages.length - SUMMARY_ISSUES;
	return `Budget exceeded: ${messages.slice(0, SUMMARY_ISSUES).join("; ")}${hidden > 0 ? `; and ${hidden} more` : ""}`;
}

function own(snapshot: BudgetSnapshot, path: string): string | undefined {
	return Object.hasOwn(snapshot, path) ? snapshot[path] : undefined;
}

export function evaluateBudget(
	directory: string,
	state: BudgetState,
	options: {
		currentRoot?: string;
		projected?: ReadonlyMap<string, string>;
		measures?: ReadonlyMap<string, MeasuredTokens>;
	} = {},
): BudgetEvaluation {
	const projected = options.projected ?? new Map<string, string>();
	const known = options.measures ?? new Map<string, MeasuredTokens>();
	const measures: BudgetMeasures = new Map();
	let measured = false;
	const content = (hash: string | undefined) =>
		hash && projected.has(hash) ? (projected.get(hash) ?? null) : readBudgetContent(directory, hash);
	const measure = (beforeHash: string | undefined, afterHash: string | undefined): MeasuredTokens => {
		const key = `${beforeHash ?? ""}:${afterHash ?? ""}`;
		let value = measures.get(key) ?? known.get(key);
		if (!value) {
			value = measureTokens(content(beforeHash), content(afterHash));
			measured = true;
		}
		measures.set(key, value);
		return value;
	};
	const usage = { codeTokens: 0, docTokens: 0 };
	const issues: BudgetIssue[] = [];
	const seen = new Set<string>();
	for (const participant of state.worktrees) {
		const elsewhere = options.currentRoot !== undefined && participant.root !== options.currentRoot;
		const where = elsewhere ? ` in worktree ${participant.root}` : "";
		const paths = new Set([...Object.keys(participant.baseline), ...Object.keys(participant.current)]);
		const deleted: Array<[string, string]> = [];
		const added: Array<[string, string]> = [];
		for (const path of paths) {
			const before = own(participant.baseline, path);
			const after = own(participant.current, path);
			if (before && !after) deleted.push([path, before]);
			if (after && !before) added.push([path, after]);
		}
		const renames = pairRenames(deleted, added, (hash) => content(hash) ?? "");
		const moved = new Set(renames.values());
		for (const path of paths) {
			if (moved.has(path)) continue;
			const beforeHash = own(participant.baseline, renames.get(path) ?? path);
			const afterHash = own(participant.current, path);
			if (beforeHash === afterHash) continue;
			const change = budgetChange(path, measure(beforeHash, afterHash), state.limits);
			// A removed worktree's files cannot be repaired any more, so only its usage still counts.
			if (change.fileLimitExceeded && !participant.removed) {
				const label = change.category === "docs" ? "documentation" : "code";
				issues.push({
					key: JSON.stringify([participant.root, path]),
					excess: change.fileTokens - change.fileCeiling,
					message: `${path}${where}: ${change.fileTokens} ${label} tokens exceed file ceiling ${change.fileCeiling}`,
				});
			}
			const fingerprint = JSON.stringify([path, beforeHash, afterHash]);
			if (seen.has(fingerprint)) continue;
			seen.add(fingerprint);
			usage[change.category === "code" ? "codeTokens" : "docTokens"] += change.addedTokens + change.deletedTokens;
		}
	}
	for (const [key, label, used, limit] of [
		["code", "code", usage.codeTokens, state.limits.maxCodeTokens],
		["docs", "documentation", usage.docTokens, state.limits.maxDocTokens],
	] satisfies Array<[string, string, number, number | null]>) {
		if (limit === null || used <= limit) continue;
		issues.push({ key, excess: used - limit, message: `${used} changed ${label} tokens exceed task limit ${limit}` });
	}
	const violations = issues.map(({ message }) => message);
	return {
		issues,
		measures,
		measured,
		report: {
			status: issues.length ? "failed" : "passed",
			taskId: state.taskId,
			summary: issues.length ? exceededSummary(violations) : budgetUsageSummary(usage, state.limits),
			violations,
			usage,
			limits: state.limits,
		},
	};
}

function budgetUsageSummary(usage: BudgetReport["usage"], limits: BudgetLimits): string {
	const parts = [
		`File budgets (cl100k_base): code files <= ${limits.maxFileTokens} tokens`,
		`documentation files <= ${limits.maxDocFileTokens} tokens`,
		`files already over a ceiling may grow by ${limits.maxOversizedGrowthTokens} tokens`,
	];
	if (limits.maxCodeTokens !== null) parts.push(`code ${usage.codeTokens}/${limits.maxCodeTokens} changed tokens`);
	if (limits.maxDocTokens !== null) {
		parts.push(`documentation ${usage.docTokens}/${limits.maxDocTokens} changed tokens`);
	}
	return parts.join("; ");
}

/** Issues a proposed change creates or enlarges; edits that leave every existing excess unchanged or smaller pass. */
export function worsenedIssues(
	current: Pick<BudgetEvaluation, "issues">,
	proposed: Pick<BudgetEvaluation, "issues">,
): BudgetIssue[] {
	const existing = new Map(current.issues.map(({ key, excess }) => [key, excess]));
	return proposed.issues.filter(({ key, excess }) => excess > (existing.get(key) ?? 0));
}
