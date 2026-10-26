import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseExcludes } from "./exclusions.ts";
import { type BudgetLimits, DEFAULT_BUDGET_LIMITS, parseBudgetLimits } from "./policy.ts";
import { budgetPathExists, isBudgetRelativePath } from "./workspace.ts";

export { withBudgetLock } from "./locking.ts";

/** Repository-relative path to the hash of its stored content. */
export type BudgetSnapshot = Record<string, string>;

export interface BudgetParticipant {
	root: string;
	/** Commit whose .gitattributes decide which files are linguist-generated; null before the first commit. */
	attributes: string | null;
	removed: boolean;
	baseline: BudgetSnapshot;
	current: BudgetSnapshot;
}

export interface BudgetState {
	version: 2;
	taskId: string;
	limits: BudgetLimits;
	exclude: string[];
	worktrees: BudgetParticipant[];
}

export interface BudgetConfig {
	enabled: boolean;
	limits: BudgetLimits;
	exclude: string[];
}

/** The marker sits outside the ledger directory, so deleting that directory cannot silently start a new task. */
export interface BudgetLedger {
	directory: string;
	marker: string;
	lock: string;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const LEDGER_RESET_HINT = "the user must start a new task with the budget new command";

/** The task marker's name inside the Git common directory. */
export const BUDGET_TASK_MARKER = "draht-budgets.task";

export function budgetLedger(commonDir: string): BudgetLedger {
	return {
		directory: join(commonDir, "draht-budgets"),
		marker: join(commonDir, BUDGET_TASK_MARKER),
		lock: join(commonDir, "draht-budgets.lock"),
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

/** Refuses symlinks and special files, so a committed link cannot point the reader at a device or a secret. */
function readRegularFile(path: string, maxBytes = Number.POSITIVE_INFINITY): string {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if (hasCode(error, "ELOOP")) throw new Error(`Budget file must not be a symlink: ${path}`);
		throw error;
	}
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) throw new Error(`Budget file must be a regular file: ${path}`);
		if (stat.size > maxBytes) throw new Error(`Budget file exceeds ${maxBytes} bytes: ${path}`);
		return readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

export function readBudgetConfig(path: string): BudgetConfig {
	const value: unknown = budgetPathExists(path) ? JSON.parse(readRegularFile(path, MAX_CONFIG_BYTES)) : {};
	if (!record(value)) throw new Error("Budget configuration must be an object");
	const { enabled = true, exclude = [], ...limits } = value;
	if (typeof enabled !== "boolean") throw new Error("Budget enabled must be a boolean");
	return { enabled, limits: parseBudgetLimits(limits), exclude: parseExcludes(exclude) };
}

function parseSnapshot(value: unknown): BudgetSnapshot {
	if (!record(value)) throw new Error("Invalid budget snapshot");
	const entries: Array<[string, string]> = [];
	for (const [path, hash] of Object.entries(value)) {
		if (!isBudgetRelativePath(path) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error("Invalid budget snapshot entry");
		}
		entries.push([path, hash]);
	}
	return Object.fromEntries(entries);
}

function parseCommit(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
		throw new Error("Invalid budget worktree attributes commit");
	}
	return value;
}

function parseParticipant(value: unknown): BudgetParticipant {
	if (
		!record(value) ||
		typeof value.root !== "string" ||
		!isAbsolute(value.root) ||
		typeof value.removed !== "boolean"
	) {
		throw new Error("Invalid budget worktree");
	}
	return {
		root: value.root,
		attributes: parseCommit(value.attributes),
		removed: value.removed,
		baseline: parseSnapshot(value.baseline),
		current: parseSnapshot(value.current),
	};
}

export function readBudgetState(ledger: BudgetLedger): BudgetState | undefined {
	const path = join(ledger.directory, "task.json");
	const hasState = budgetPathExists(path);
	const hasMarker = budgetPathExists(ledger.marker);
	if (!hasState && !hasMarker) return undefined;
	if (!hasState || !hasMarker) throw new Error(`Budget task ledger is incomplete; ${LEDGER_RESET_HINT}`);
	const value: unknown = JSON.parse(readRegularFile(path));
	if (
		!record(value) ||
		value.version !== 2 ||
		typeof value.taskId !== "string" ||
		!value.taskId ||
		!Array.isArray(value.worktrees) ||
		!record(value.limits) ||
		Object.keys(value.limits).length !== Object.keys(DEFAULT_BUDGET_LIMITS).length
	) {
		throw new Error("Invalid budget task ledger");
	}
	if (readRegularFile(ledger.marker, 256) !== value.taskId) {
		throw new Error(`Budget task ledger does not match its task marker; ${LEDGER_RESET_HINT}`);
	}
	const worktrees = value.worktrees.map(parseParticipant);
	const active = worktrees.filter(({ removed }) => !removed).map(({ root }) => root);
	if (new Set(active).size !== active.length) throw new Error("Duplicate budget worktrees in ledger");
	return {
		version: 2,
		taskId: value.taskId,
		limits: parseBudgetLimits(value.limits),
		exclude: parseExcludes(value.exclude),
		worktrees,
	};
}

function writeAtomically(path: string, content: string): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

export function writeBudgetState(ledger: BudgetLedger, state: BudgetState): void {
	mkdirSync(ledger.directory, { recursive: true, mode: 0o700 });
	writeAtomically(join(ledger.directory, "task.json"), JSON.stringify(state));
}

export function markBudgetTask(ledger: BudgetLedger, taskId: string): void {
	writeAtomically(ledger.marker, taskId);
}

/** Removes the task with every stored snapshot, which also discards objects a previous task left behind. */
export function clearBudgetTask(ledger: BudgetLedger): void {
	rmSync(ledger.marker, { force: true });
	rmSync(ledger.directory, { recursive: true, force: true });
}

export function budgetContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Stores content under its hash, once, and returns the hash. */
export function storeBudgetObject(directory: string, content: string): string {
	const hash = budgetContentHash(content);
	const object = join(directory, "objects", hash);
	if (!budgetPathExists(object)) {
		mkdirSync(join(directory, "objects"), { recursive: true, mode: 0o700 });
		writeAtomically(object, content);
	}
	return hash;
}

/** Caches only speed up inspections, so a missing or damaged cache reads as empty. */
export function readBudgetCache<T>(
	directory: string,
	name: string,
	parse: (value: unknown) => T | undefined,
): T | undefined {
	try {
		return parse(JSON.parse(readFileSync(join(directory, "cache", `${name}.json`), "utf8")));
	} catch {
		return undefined;
	}
}

export function writeBudgetCache(directory: string, name: string, value: unknown): void {
	mkdirSync(join(directory, "cache"), { recursive: true, mode: 0o700 });
	writeAtomically(join(directory, "cache", `${name}.json`), JSON.stringify(value));
}

export function removeBudgetCache(directory: string, name: string): void {
	rmSync(join(directory, "cache", `${name}.json`), { force: true });
}

export function readBudgetContent(directory: string, hash: string | undefined): string | null {
	if (!hash) return null;
	const content = readFileSync(join(directory, "objects", hash), "utf8");
	if (budgetContentHash(content) !== hash) throw new Error(`Corrupt budget content ${hash}; ${LEDGER_RESET_HINT}`);
	return content;
}
