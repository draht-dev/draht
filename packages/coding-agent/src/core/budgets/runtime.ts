import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
	type BudgetEvaluation,
	type BudgetMeasures,
	evaluateBudget,
	exceededSummary,
	worsenedIssues,
} from "./evaluation.ts";
import { excludeMatcher, isAlwaysExcluded } from "./exclusions.ts";
import { type BudgetLimits, DEFAULT_BUDGET_LIMITS } from "./policy.ts";
import { snapshotWorkspace, type WorkspaceSnapshot } from "./snapshot.ts";
import {
	BUDGET_TASK_MARKER,
	type BudgetLedger,
	type BudgetParticipant,
	type BudgetSnapshot,
	type BudgetState,
	budgetContentHash,
	budgetLedger,
	clearBudgetTask,
	markBudgetTask,
	readBudgetCache,
	readBudgetConfig,
	readBudgetState,
	removeBudgetCache,
	withBudgetLock,
	writeBudgetCache,
	writeBudgetState,
} from "./state.ts";
import {
	type BudgetWorkspace,
	budgetFilePath,
	budgetPathExists,
	canonicalBudgetPath,
	findBudgetWorkspace,
	generatedPaths,
	headCommit,
	mayHaveBudgets,
	type ProposedBudgetFile,
} from "./workspace.ts";

export interface BudgetReport {
	status: "passed" | "failed" | "disabled" | "error";
	taskId?: string;
	summary: string;
	violations: string[];
	usage: { codeTokens: number; docTokens: number };
	limits: BudgetLimits;
}

interface BudgetLocation {
	workspace: BudgetWorkspace;
	ledger: BudgetLedger;
	configPath: string;
}

const NOT_CONFIGURED = "Budgets are not configured for this repository";
const MEASURES_CACHE = "measures";

export function checkBudget(options: { cwd: string; proposed?: ProposedBudgetFile[] }): BudgetReport {
	return inspectBudget(options);
}

export function auditBudget(options: { cwd: string }): BudgetReport {
	return inspectBudget(options);
}

export function beginTask(options: { cwd: string; newTask?: boolean }): BudgetReport {
	return inspectBudget(options);
}

function quietReport(status: "disabled" | "error", summary: string): BudgetReport {
	return {
		status,
		summary,
		violations: status === "error" ? [summary] : [],
		usage: { codeTokens: 0, docTokens: 0 },
		limits: DEFAULT_BUDGET_LIMITS,
	};
}

function configAbove(cwd: string): boolean {
	let start = resolve(cwd);
	try {
		start = realpathSync(cwd);
	} catch {
		// A missing directory is checked by its literal path.
	}
	for (let directory = start; ; directory = dirname(directory)) {
		if (budgetPathExists(join(directory, ".draht", "budgets.json"))) return true;
		if (dirname(directory) === directory) return false;
	}
}

/** Budgets are opt-in: a repository takes part once it has a configuration file or an active task. */
function locateBudget(cwd: string): BudgetLocation | undefined {
	if (!mayHaveBudgets(cwd, BUDGET_TASK_MARKER)) return undefined;
	let workspace: BudgetWorkspace | undefined;
	try {
		workspace = findBudgetWorkspace(cwd);
	} catch (error) {
		if (configAbove(cwd)) throw error;
		return undefined;
	}
	if (!workspace) {
		if (configAbove(cwd)) throw new Error("Budgets require a Git working tree");
		return undefined;
	}
	const location = {
		workspace,
		ledger: budgetLedger(workspace.commonDir),
		configPath: join(workspace.root, ".draht", "budgets.json"),
	};
	return budgetPathExists(location.configPath) || budgetPathExists(location.ledger.marker) ? location : undefined;
}

export function budgetConfigured(cwd: string): boolean {
	try {
		return locateBudget(cwd) !== undefined;
	} catch {
		// Inspecting the budget reports the failure.
		return true;
	}
}

function excludedPaths(workspace: BudgetWorkspace, state: BudgetState, attributes: string | null) {
	const matches = excludeMatcher(state.exclude);
	return (paths: string[]): Set<string> => {
		const generated = generatedPaths(workspace, attributes, paths);
		return new Set(paths.filter((path) => isAlwaysExcluded(path) || matches(path) || generated.has(path)));
	};
}

function takeSnapshot(
	location: BudgetLocation,
	workspace: BudgetWorkspace,
	state: BudgetState,
	participant: Pick<BudgetParticipant, "attributes" | "baseline" | "current">,
): WorkspaceSnapshot {
	return snapshotWorkspace({
		workspace,
		directory: location.ledger.directory,
		cacheName: `files-${createHash("sha256").update(workspace.root).digest("hex").slice(0, 32)}`,
		excluded: excludedPaths(workspace, state, participant.attributes),
		additionalPaths: [...Object.keys(participant.baseline), ...Object.keys(participant.current)],
	});
}

/** Reading the configuration before clearing keeps the previous task when the new configuration is invalid. */
function startTask(location: BudgetLocation): BudgetState | string {
	const config = budgetPathExists(location.configPath) ? readBudgetConfig(location.configPath) : undefined;
	clearBudgetTask(location.ledger);
	if (!config) return NOT_CONFIGURED;
	if (!config.enabled) return "Budgets are disabled by .draht/budgets.json";
	return { version: 2, taskId: randomUUID(), limits: config.limits, exclude: config.exclude, worktrees: [] };
}

function enroll(location: BudgetLocation, state: BudgetState): BudgetParticipant | undefined {
	const { workspace } = location;
	if (state.worktrees.some(({ root, removed }) => root === workspace.root && !removed)) return undefined;
	const attributes = headCommit(workspace);
	const { files } = takeSnapshot(location, workspace, state, { attributes, baseline: {}, current: {} });
	// Projected edits change the current snapshot, so it must not share the baseline's object.
	const participant = { root: workspace.root, attributes, removed: false, baseline: files, current: { ...files } };
	state.worktrees.push(participant);
	return participant;
}

function sameSnapshot(left: BudgetSnapshot, right: BudgetSnapshot): boolean {
	const paths = Object.keys(left);
	return (
		paths.length === Object.keys(right).length &&
		paths.every((path) => Object.hasOwn(right, path) && left[path] === right[path])
	);
}

/** Updates every other worktree's snapshot and reports whether the ledger changed. */
function refreshWorktrees(location: BudgetLocation, state: BudgetState, enrolled?: BudgetParticipant): boolean {
	let changed = false;
	for (const participant of state.worktrees) {
		if (participant.removed || participant === enrolled) continue;
		const workspace =
			participant.root === location.workspace.root
				? location.workspace
				: budgetPathExists(participant.root)
					? findBudgetWorkspace(participant.root)
					: undefined;
		if (workspace?.commonDir !== location.workspace.commonDir || workspace.root !== participant.root) {
			participant.removed = true;
			changed = true;
			continue;
		}
		const { files, unmeasured } = takeSnapshot(location, workspace, state, participant);
		// While out of the budget, a starting file counts as unchanged; once back, it is measured against its start.
		const unchanged = unmeasured.flatMap(
			(path): Array<[string, string]> =>
				Object.hasOwn(participant.baseline, path) ? [[path, participant.baseline[path]]] : [],
		);
		const current = unchanged.length ? Object.fromEntries([...Object.entries(files), ...unchanged]) : files;
		if (sameSnapshot(current, participant.current)) continue;
		participant.current = current;
		changed = true;
	}
	return changed;
}

function isLedgerFile(ledger: BudgetLedger, target: string): boolean {
	return [ledger.directory, ledger.marker, ledger.lock].some(
		(path) => target === path || target.startsWith(`${path}${sep}`),
	);
}

function projectBudget(location: BudgetLocation, state: BudgetState, cwd: string, proposed: ProposedBudgetFile[]) {
	const participant = state.worktrees.find(({ root, removed }) => root === location.workspace.root && !removed);
	if (!participant) throw new Error("Budget worktree was not enrolled");
	const targets = new Map<string, string | null>();
	const ledgerEdits: string[] = [];
	for (const change of proposed) {
		const target = canonicalBudgetPath(cwd, change.path);
		if (isLedgerFile(location.ledger, target)) ledgerEdits.push(change.path);
		const path = budgetFilePath(location.workspace, target);
		if (path !== undefined) targets.set(path, change.content);
	}
	const excluded = excludedPaths(location.workspace, state, participant.attributes)([...targets.keys()]);
	const content = new Map<string, string>();
	for (const [path, text] of targets) {
		if (excluded.has(path)) continue;
		if (text === null) {
			delete participant.current[path];
			continue;
		}
		const hash = budgetContentHash(text);
		content.set(hash, text);
		// A property definition keeps a file named __proto__ an ordinary snapshot entry.
		Object.defineProperty(participant.current, path, {
			value: hash,
			configurable: true,
			enumerable: true,
			writable: true,
		});
	}
	return { content, ledgerEdits };
}

function parseMeasures(value: unknown): BudgetMeasures | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const measures: BudgetMeasures = new Map();
	for (const [key, entry] of Object.entries(value)) {
		if (!Array.isArray(entry) || entry.length !== 4) return undefined;
		const [addedTokens, deletedTokens, fileTokens, baselineTokens] = entry;
		if (![addedTokens, deletedTokens, fileTokens, baselineTokens].every(Number.isSafeInteger)) return undefined;
		measures.set(key, { addedTokens, deletedTokens, fileTokens, baselineTokens });
	}
	return measures;
}

/** Keeps the measurements this inspection used, once it had to compute new ones. */
function saveMeasures(directory: string, ...evaluations: BudgetEvaluation[]): void {
	if (!evaluations.some(({ measured }) => measured)) return;
	const entries = new Map(evaluations.flatMap(({ measures }) => [...measures]));
	writeBudgetCache(
		directory,
		MEASURES_CACHE,
		Object.fromEntries(
			Array.from(entries, ([key, value]) => [
				key,
				[value.addedTokens, value.deletedTokens, value.fileTokens, value.baselineTokens],
			]),
		),
	);
}

function inspectBudget({
	cwd,
	newTask = false,
	proposed,
}: {
	cwd: string;
	newTask?: boolean;
	proposed?: ProposedBudgetFile[];
}): BudgetReport {
	try {
		const location = locateBudget(cwd);
		if (!location) return quietReport("disabled", NOT_CONFIGURED);
		return withBudgetLock(location.ledger.lock, () => {
			const existing = newTask ? undefined : readBudgetState(location.ledger);
			const state = existing ?? startTask(location);
			if (typeof state === "string") return quietReport("disabled", state);
			const enrolled = enroll(location, state);
			if (refreshWorktrees(location, state, enrolled) || enrolled || !existing) {
				writeBudgetState(location.ledger, state);
			}
			if (!existing) markBudgetTask(location.ledger, state.taskId);
			const directory = location.ledger.directory;
			const currentRoot = location.workspace.root;
			const cached = readBudgetCache(directory, MEASURES_CACHE, parseMeasures);
			const actual = evaluateBudget(directory, state, { currentRoot, measures: cached });
			if (!proposed?.length) {
				saveMeasures(directory, actual);
				return actual.report;
			}
			const { content, ledgerEdits } = projectBudget(location, state, cwd, proposed);
			if (ledgerEdits.length) {
				saveMeasures(directory, actual);
				const violations = ledgerEdits.map((path) => `${path}: budget ledger files change only through a new task`);
				return { ...actual.report, status: "failed", violations, summary: exceededSummary(violations) };
			}
			const measures = new Map([...(cached ?? []), ...actual.measures]);
			const projected = evaluateBudget(directory, state, { currentRoot, projected: content, measures });
			saveMeasures(directory, actual, projected);
			const worsened = worsenedIssues(actual, projected);
			if (worsened.length) {
				const violations = worsened.map(({ message }) => message);
				return { ...projected.report, status: "failed", violations, summary: exceededSummary(violations) };
			}
			return projected.report.status === "failed"
				? { ...projected.report, status: "passed", summary: `Change accepted; ${projected.report.summary}` }
				: projected.report;
		});
	} catch (error) {
		return quietReport(
			"error",
			`Budget inspection failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function stopCacheName(session: string): string {
	return `stop-${createHash("sha256").update(session).digest("hex").slice(0, 32)}`;
}

function parseStopFailures(value: unknown): number | undefined {
	return typeof value === "object" && value !== null && "failures" in value && Number.isSafeInteger(value.failures)
		? Number(value.failures)
		: undefined;
}

/**
 * Counts a failed final audit for one host session; returns how many in a row have failed since its last prompt.
 * A count that cannot be stored reads as unbounded, so completion stops blocking instead of looping.
 */
export function recordStopFailure(cwd: string, session: string): number {
	try {
		const location = locateBudget(cwd);
		if (!location) return 0;
		const name = stopCacheName(session);
		const failures = (readBudgetCache(location.ledger.directory, name, parseStopFailures) ?? 0) + 1;
		writeBudgetCache(location.ledger.directory, name, { failures });
		return failures;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** Best effort: a budget that cannot be located has no count to clear, and its inspection reports why. */
export function clearStopFailures(cwd: string, session: string): void {
	try {
		const location = locateBudget(cwd);
		if (location) removeBudgetCache(location.ledger.directory, stopCacheName(session));
	} catch {
		// The inspection reports the failure.
	}
}
