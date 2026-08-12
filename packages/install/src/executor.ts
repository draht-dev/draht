import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendJournal, openTransactions, readJournal } from "./journal.ts";
import { backupsDir, backupsRootDir, stagingDir, stagingRootDir } from "./paths.ts";
import { loadState, saveState } from "./state.ts";
import type {
	ComponentSource,
	ComponentState,
	DelegatedInstall,
	DoctorFinding,
	Effectiveness,
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
	/** When the change takes effect. Defaults to `"unknown"` — the executor never guesses host semantics. */
	effectiveness?: Effectiveness;
	/** Whether the component's host registration succeeded, recorded by the caller's `register` callback. */
	registered?: boolean;
}

/**
 * What a `delegate` callback reports after an external mechanism (a package
 * manager) has installed or removed a component. There is no target directory
 * and no file manifest: the engine does not own those bytes and must not claim
 * hash-level knowledge of them.
 */
export interface DelegatedComponent {
	version: string;
	source: ComponentSource;
	delegated: DelegatedInstall;
	effectiveness?: Effectiveness;
}

/** Per-action checkpoint names, fired right after the matching journal event — the fault-injection seam for tests. */
export type CheckpointName = "after-stage" | "after-backup" | "after-swap" | "after-register";

/** Context handed to an optional `register` callback once a component's payload has been swapped into place. */
export interface RegisterContext {
	root: string;
	tx: string;
	targetDir: string;
}

/**
 * What a `register` callback may report back. Every field is optional: a
 * callback that reports nothing leaves the executor's conservative defaults in
 * place rather than having a value guessed for it.
 */
export interface RegisterUpdate {
	registered?: boolean;
	effectiveness?: Effectiveness;
}

export interface ApplyPlanOptions {
	root: string;
	plan: PlanAction[];
	/** Writes a component's payload into `stagingComponentDir` and reports where it ultimately belongs. */
	materialize: (
		action: PlanAction,
		stagingComponentDir: string,
		context: { noteExternalEffect: (description: string) => void },
	) => Promise<MaterializedComponent>;
	/**
	 * Runs once a component's payload is in place at `targetDir` (e.g. wiring it
	 * into a host's config). May report how the change takes effect; anything it
	 * omits keeps the executor's conservative default.
	 */
	register?: (action: PlanAction, ctx: RegisterContext) => Promise<RegisterUpdate | undefined>;
	/** Carries out a `delegate-install`/`delegate-uninstall` action through an external mechanism. */
	delegate?: (action: PlanAction) => Promise<DelegatedComponent>;
	/** Fault-injection seam: called after each per-action journal event. Throwing here rolls back the whole transaction. */
	checkpoint?: (name: CheckpointName, action?: PlanAction) => void;
	/** Aborts the transaction between actions when the process is asked to stop. */
	signal?: AbortSignal;
}

export interface ApplyPlanResult {
	tx: string;
	state: InstallState;
}

/** Thrown when a transaction rolls back. `failedAction` is the action being applied when the error surfaced, if any. */
export class ApplyError extends Error {
	public readonly tx: string;
	public readonly failedAction?: PlanAction;
	/**
	 * Effects this rollback could NOT undo — currently only delegated
	 * package-manager installs, whose artifacts the engine does not own. Callers
	 * must surface these verbatim: a rollback that silently leaves an external
	 * global install in place while reporting "rolled back" is a lie.
	 */
	public readonly unrolledEffects: string[];

	constructor(tx: string, failedAction: PlanAction | undefined, cause: unknown, unrolledEffects: string[] = []) {
		const causeError = cause instanceof Error ? cause : new Error(String(cause));
		const componentSuffix = failedAction
			? ` while applying "${failedAction.type}" for component "${failedAction.componentId}"`
			: "";
		const unrolledSuffix = unrolledEffects.length > 0 ? ` (${unrolledEffects.join("; ")})` : "";
		super(`transaction ${tx} rolled back${componentSuffix}: ${causeError.message}${unrolledSuffix}`, {
			cause: causeError,
		});
		this.name = "ApplyError";
		this.tx = tx;
		this.failedAction = failedAction;
		this.unrolledEffects = unrolledEffects;
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
	/** Set for delegated actions: an external effect the engine cannot undo. */
	delegated?: DelegatedInstall;
	/** Host/package-manager effects the filesystem rollback cannot prove it undid. */
	externalEffects: string[];
}

function applyActionToState(
	state: InstallState,
	action: PlanAction,
	outcome: MaterializedComponent | DelegatedComponent,
): void {
	if (action.type === "remove" || action.type === "delegate-uninstall") {
		delete state.components[action.componentId];
		return;
	}

	// install, update, delegate-install: record (or overwrite) the component's
	// durable state. A delegated component has no engine-owned file manifest, so
	// `files` stays empty rather than being invented.
	const delegated = "delegated" in outcome ? outcome.delegated : undefined;
	const nextComponent: ComponentState = {
		id: action.componentId,
		kind: action.kind,
		version: outcome.version,
		source: outcome.source,
		files: "files" in outcome ? outcome.files : [],
		effectiveness: outcome.effectiveness ?? "unknown",
	};
	if (delegated) nextComponent.delegated = delegated;
	if ("registered" in outcome && outcome.registered !== undefined) nextComponent.registered = outcome.registered;
	state.components[action.componentId] = nextComponent;
}

/**
 * Restores every backed-up/swapped directory this transaction touched, removes
 * leftover staging directories, and reports the effects it could not undo.
 */
function rollback(progress: ActionProgress[]): string[] {
	const unrolled: string[] = [];
	for (let i = progress.length - 1; i >= 0; i--) {
		const entry = progress[i];
		if (entry.delegated) {
			unrolled.push(
				`${entry.delegated.packageName} was installed by ${entry.delegated.method} and was NOT rolled back: the engine does not own artifacts an external package manager installed`,
			);
		}
		unrolled.push(...entry.externalEffects);
		if (entry.targetDir && (entry.swapped || entry.backedUp)) {
			removeIfExists(entry.targetDir);
			if (entry.backedUp && entry.backupDir && existsSync(entry.backupDir)) {
				moveDir(entry.backupDir, entry.targetDir);
			}
		}
		removeIfExists(entry.stagingComponentDir);
	}
	return unrolled;
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
	const { root, plan, materialize, register, delegate, checkpoint, signal } = opts;
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

			// Stopping is checked between actions only: a half-applied action has
			// no safe interruption point, so an abort waits for the current one to
			// finish and then rolls the whole transaction back.
			if (signal?.aborted) {
				throw new Error("interrupted before applying the remaining actions");
			}

			if (action.type === "delegate-install" || action.type === "delegate-uninstall") {
				if (!delegate) {
					throw new Error(`plan contains "${action.type}" but no delegate callback was provided`);
				}
				const entry: ActionProgress = {
					action,
					stagingComponentDir: join(stagingDir(root, tx), action.componentId),
					backedUp: false,
					swapped: false,
					// Only an install leaves an external artifact behind; an uninstall
					// that already succeeded has nothing to un-remove.
					externalEffects: [
						`external package-manager ${action.type} for ${action.componentId} may have changed the machine and was NOT rolled back: inspect and reconcile it before retrying`,
					],
				};
				progress.push(entry);
				const delegated = await delegate(action);
				if (action.type === "delegate-install") {
					entry.delegated = delegated.delegated;
					entry.externalEffects = [];
				} else {
					entry.externalEffects = [
						`${delegated.delegated.packageName} was uninstalled by ${delegated.delegated.method} and was NOT restored: reconcile the external package manager before retrying`,
					];
				}
				record("registered", {
					componentId: action.componentId,
					type: action.type,
					delegated: delegated.delegated,
				});
				checkpoint?.("after-register", action);
				applyActionToState(state, action, delegated);
				continue;
			}

			const stagingComponentDir = join(stagingDir(root, tx), action.componentId);
			mkdirSync(stagingComponentDir, { recursive: true });
			const entry: ActionProgress = {
				action,
				stagingComponentDir,
				backedUp: false,
				swapped: false,
				externalEffects: [],
			};
			progress.push(entry);

			const materialized = await materialize(action, stagingComponentDir, {
				noteExternalEffect: (description) => entry.externalEffects.push(description),
			});
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
				// Registration is outside the filesystem transaction. Record the
				// possible effect before calling the host because it may mutate and
				// then fail; a later action can also fail after registration succeeds.
				entry.externalEffects.push(
					`host registration for ${action.componentId} may have changed and was NOT rolled back: inspect and reconcile its host before retrying`,
				);
				// A register callback may report how the change takes effect and
				// whether the host accepted it; those go into durable state instead
				// of the executor guessing.
				const outcome = await register(action, { root, tx, targetDir: materialized.targetDir });
				if (outcome) {
					if (outcome.effectiveness !== undefined) materialized.effectiveness = outcome.effectiveness;
					if (outcome.registered !== undefined) materialized.registered = outcome.registered;
				}
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
		const unrolledEffects = rollback(progress);
		try {
			record("rolled-back", { failedComponentId: failedAction?.componentId, unrolledEffects });
		} catch {
			// Best-effort: if the journal write itself fails, the ApplyError below still surfaces the real cause.
		}
		removeIfExists(stagingDir(root, tx));
		removeIfExists(backupsDir(root, tx));
		throw new ApplyError(tx, failedAction, error, unrolledEffects);
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
