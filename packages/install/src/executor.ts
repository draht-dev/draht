import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendJournal, openTransactions, readJournal } from "./journal.ts";
import { backupsDir, backupsRootDir, stagingDir, stagingRootDir } from "./paths.ts";
import { loadState, saveState } from "./state.ts";
import type {
	ComponentSource,
	ComponentState,
	DoctorFinding,
	InstallState,
	JournalEvent,
	PlanAction,
} from "./types.ts";

/** What a `materialize` callback hands back after writing a component's payload into its staging directory. */
export interface MaterializedComponent {
	/** Absolute path the component's payload should live at once swapped in. */
	targetDir: string;
	/** Files written into the staging directory, path relative to it (and, once swapped, relative to `targetDir`). */
	files: Array<{ path: string; sha256: string }>;
	version: string;
	source: ComponentSource;
}

/** Per-action checkpoint names, fired right after the matching journal event — the fault-injection seam for tests. */
export type CheckpointName = "after-stage" | "after-backup" | "after-swap" | "after-register";

/** Context handed to an optional `register` callback once a component's payload has been swapped into place. */
export interface RegisterContext {
	root: string;
	tx: string;
	targetDir: string;
}

export interface ApplyPlanOptions {
	root: string;
	plan: PlanAction[];
	/** Writes a component's payload into `stagingComponentDir` and reports where it ultimately belongs. */
	materialize: (action: PlanAction, stagingComponentDir: string) => Promise<MaterializedComponent>;
	/** Runs once a component's payload is in place at `targetDir` (e.g. wiring it into a host's config). */
	register?: (action: PlanAction, ctx: RegisterContext) => Promise<void>;
	/** Fault-injection seam: called after each per-action journal event. Throwing here rolls back the whole transaction. */
	checkpoint?: (name: CheckpointName, action?: PlanAction) => void;
}

export interface ApplyPlanResult {
	tx: string;
	state: InstallState;
}

/** Thrown when a transaction rolls back. `failedAction` is the action being applied when the error surfaced, if any. */
export class ApplyError extends Error {
	public readonly tx: string;
	public readonly failedAction?: PlanAction;

	constructor(tx: string, failedAction: PlanAction | undefined, cause: unknown) {
		const causeError = cause instanceof Error ? cause : new Error(String(cause));
		const componentSuffix = failedAction
			? ` while applying "${failedAction.type}" for component "${failedAction.componentId}"`
			: "";
		super(`transaction ${tx} rolled back${componentSuffix}: ${causeError.message}`, { cause: causeError });
		this.name = "ApplyError";
		this.tx = tx;
		this.failedAction = failedAction;
	}
}

function generateTxId(): string {
	return `tx-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

function nowIso(): string {
	return new Date().toISOString();
}

function isExdevError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EXDEV";
}

/** Moves a directory, falling back to recursive copy + remove when `src`/`dest` are on different filesystems. */
function moveDir(src: string, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	try {
		renameSync(src, dest);
	} catch (error) {
		if (!isExdevError(error)) throw error;
		cpSync(src, dest, { recursive: true });
		rmSync(src, { recursive: true, force: true });
	}
}

function removeIfExists(path: string): void {
	if (existsSync(path)) {
		rmSync(path, { recursive: true, force: true });
	}
}

function dirHasEntries(path: string): boolean {
	return existsSync(path) && readdirSync(path).length > 0;
}

interface ActionProgress {
	action: PlanAction;
	stagingComponentDir: string;
	targetDir?: string;
	backedUp: boolean;
	backupDir?: string;
	swapped: boolean;
}

function applyActionToState(state: InstallState, action: PlanAction, materialized: MaterializedComponent): void {
	if (action.type === "remove" || action.type === "delegate-uninstall") {
		delete state.components[action.componentId];
		return;
	}

	// install, update, delegate-install: record (or overwrite) the component's durable state.
	// `effectiveness` starts "unknown": classifying whether a change is live/needs-reload/etc.
	// requires host-specific knowledge this phase's executor doesn't have.
	const nextComponent: ComponentState = {
		id: action.componentId,
		kind: action.kind,
		version: materialized.version,
		source: materialized.source,
		files: materialized.files,
		effectiveness: "unknown",
	};
	state.components[action.componentId] = nextComponent;
}

/** Restores every backed-up/swapped directory this transaction touched, and removes leftover staging directories. */
function rollback(progress: ActionProgress[]): void {
	for (let i = progress.length - 1; i >= 0; i--) {
		const entry = progress[i];
		if (entry.targetDir && (entry.swapped || entry.backedUp)) {
			removeIfExists(entry.targetDir);
			if (entry.backedUp && entry.backupDir && existsSync(entry.backupDir)) {
				moveDir(entry.backupDir, entry.targetDir);
			}
		}
		removeIfExists(entry.stagingComponentDir);
	}
}

/**
 * Applies `plan` as one crash-safe transaction (planned -> per action
 * {staged -> backed-up -> swapped -> registered} -> committed). Every
 * filesystem move is journaled before the matching `checkpoint` call, so
 * throwing from `checkpoint` simulates a crash immediately after that
 * journal line was durably written, exactly like a real process kill.
 *
 * Any thrown error (from `materialize`, `register`, a filesystem operation,
 * or `checkpoint` itself) rolls the *entire* transaction back: every
 * directory this call has backed up or swapped in is restored to its
 * pre-apply contents, every staging leftover is removed, `rolled-back` is
 * journaled, `state.json` is left untouched, and a typed `ApplyError` is
 * thrown wrapping the original cause.
 */
export async function applyPlan(opts: ApplyPlanOptions): Promise<ApplyPlanResult> {
	const { root, plan, materialize, register, checkpoint } = opts;
	const tx = generateTxId();
	const state = loadState(root);
	const progress: ActionProgress[] = [];
	let seq = 0;
	let failedAction: PlanAction | undefined;

	const record = (event: JournalEvent, detail?: unknown): void => {
		seq += 1;
		appendJournal(root, { tx, seq, at: nowIso(), event, detail });
	};

	try {
		record("planned", { actions: plan });

		for (const action of plan) {
			failedAction = action;
			const stagingComponentDir = join(stagingDir(root, tx), action.componentId);
			mkdirSync(stagingComponentDir, { recursive: true });
			const entry: ActionProgress = { action, stagingComponentDir, backedUp: false, swapped: false };
			progress.push(entry);

			const materialized = await materialize(action, stagingComponentDir);
			entry.targetDir = materialized.targetDir;
			record("staged", { componentId: action.componentId, type: action.type, targetDir: materialized.targetDir });
			checkpoint?.("after-stage", action);

			if (existsSync(materialized.targetDir)) {
				const backupComponentDir = join(backupsDir(root, tx), action.componentId);
				moveDir(materialized.targetDir, backupComponentDir);
				entry.backedUp = true;
				entry.backupDir = backupComponentDir;
			}
			record("backed-up", { componentId: action.componentId, backedUp: entry.backedUp });
			checkpoint?.("after-backup", action);

			if (dirHasEntries(stagingComponentDir)) {
				moveDir(stagingComponentDir, materialized.targetDir);
			} else {
				removeIfExists(stagingComponentDir);
			}
			entry.swapped = true;
			record("swapped", { componentId: action.componentId });
			checkpoint?.("after-swap", action);

			if (register) {
				await register(action, { root, tx, targetDir: materialized.targetDir });
			}
			record("registered", { componentId: action.componentId });
			checkpoint?.("after-register", action);

			applyActionToState(state, action, materialized);
		}

		state.lastTx = tx;
		saveState(root, state);
		record("committed");
		removeIfExists(stagingDir(root, tx));
		removeIfExists(backupsDir(root, tx));

		return { tx, state };
	} catch (error) {
		rollback(progress);
		try {
			record("rolled-back", { failedComponentId: failedAction?.componentId });
		} catch {
			// Best-effort: if the journal write itself fails, the ApplyError below still surfaces the real cause.
		}
		removeIfExists(stagingDir(root, tx));
		removeIfExists(backupsDir(root, tx));
		throw new ApplyError(tx, failedAction, error);
	}
}

function listSubdirNames(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/**
 * Doctor-facing scan for transactions a previous process died mid-apply:
 * journal entries with no terminal event, and leftover `staging/`/`backups/`
 * directories (evidence of a crash even when the journal itself was lost or
 * truncated before this could be read). No repair is implemented in this
 * phase — every finding is reported as informational only.
 */
export function detectCrashedTransactions(root: string): DoctorFinding[] {
	const { entries } = readJournal(root);
	const openInJournal = new Set(openTransactions(entries));
	const leftoverStaging = new Set(listSubdirNames(stagingRootDir(root)));
	const leftoverBackups = new Set(listSubdirNames(backupsRootDir(root)));

	const allTxIds = new Set<string>([...openInJournal, ...leftoverStaging, ...leftoverBackups]);

	return [...allTxIds].sort().map((tx) => {
		const reasons: string[] = [];
		if (openInJournal.has(tx)) reasons.push("no terminal journal event");
		if (leftoverStaging.has(tx)) reasons.push("leftover staging directory");
		if (leftoverBackups.has(tx)) reasons.push("leftover backups directory");
		return {
			id: `crashed-transaction:${tx}`,
			severity: "error",
			message: `transaction ${tx} did not complete (${reasons.join("; ")})`,
			repairable: false,
		};
	});
}
