import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "./errors.ts";
import { appendJournal, openTransactions, readJournal } from "./journal.ts";
import { backupsDir, backupsRootDir, stagingDir, stagingRootDir } from "./paths.ts";
import { assertNoSymlinkPivot, assertSafeComponentId, assertSafeTarget, type TargetBounds } from "./safety.ts";
import { loadState, StateCorruptError } from "./state.ts";
import type { JournalEntry } from "./types.ts";

export interface RecoveryEntry {
	tx: string;
	componentId: string;
	targetDir: string;
	/**
	 * `restore-backup` — the previous payload was moved aside and must be put
	 * back. `remove-target` — a fresh install was swapped in with nothing to
	 * restore, so the half-installed payload must go. `none` — nothing was
	 * swapped; only staging leftovers need clearing.
	 */
	action: "restore-backup" | "remove-target" | "none";
}

export interface RecoveryAssessment {
	/** Whether every open transaction can be safely undone from durable journal detail alone. */
	recoverable: boolean;
	/** Open transaction ids, sorted. */
	transactions: string[];
	/** Open journal transaction already confirmed durable by state.lastTx; finalize without rollback. */
	finalizeCommitted: string[];
	entries: RecoveryEntry[];
	/** Reasons automatic recovery is refused. Non-empty means a human must intervene. */
	blockers: string[];
}

export interface RecoveryResult {
	recovered: boolean;
	transactions: string[];
	entries: RecoveryEntry[];
	notes: string[];
}

interface TxComponentInfo {
	componentId: string;
	targetDir?: string;
	swapped: boolean;
	swapIntended: boolean;
	backedUp?: boolean;
	externalEffects: string[];
}

function collectPerTransaction(entries: JournalEntry[]): Map<string, Map<string, TxComponentInfo>> {
	const byTx = new Map<string, Map<string, TxComponentInfo>>();

	for (const entry of entries) {
		const detail = (entry.detail ?? {}) as Record<string, unknown>;
		const componentId = typeof detail.componentId === "string" ? detail.componentId : null;
		if (!componentId) continue;

		let components = byTx.get(entry.tx);
		if (!components) {
			components = new Map();
			byTx.set(entry.tx, components);
		}
		let info = components.get(componentId);
		if (!info) {
			info = { componentId, swapped: false, swapIntended: false, externalEffects: [] };
			components.set(componentId, info);
		}

		if (entry.event === "staged" && typeof detail.targetDir === "string") info.targetDir = detail.targetDir;
		if (entry.event === "backed-up") info.backedUp = detail.backedUp === true;
		if (entry.event === "swap-intent") {
			info.swapIntended = true;
			if (typeof detail.targetDir === "string") info.targetDir = detail.targetDir;
		}
		if (entry.event === "swapped") info.swapped = true;
		if (entry.event === "external-intent" && typeof detail.description === "string") {
			info.externalEffects.push(detail.description);
		}
	}

	return byTx;
}

function listSubdirNames(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
}

/**
 * Decides, from durable evidence only, whether every interrupted transaction
 * can be undone automatically.
 *
 * Recovery is refused — never guessed — when the journal's tail is torn, when
 * the journal cannot be read, when a leftover backup directory belongs to a
 * transaction the journal never recorded (its contents are someone's original
 * data with no recorded destination), or when a recorded target directory
 * fails the same safety validation an install would apply.
 */
export function assessCrashedTransactions(root: string, bounds: TargetBounds): RecoveryAssessment {
	const blockers: string[] = [];
	const entries: RecoveryEntry[] = [];

	let journalEntries: JournalEntry[] = [];
	let torn = false;
	try {
		const read = readJournal(root);
		journalEntries = read.entries;
		torn = read.torn;
	} catch (error) {
		return {
			recoverable: false,
			transactions: [],
			finalizeCommitted: [],
			entries: [],
			blockers: [`the transaction journal cannot be read: ${(error as Error).message}`],
		};
	}
	if (torn) {
		blockers.push(
			"the transaction journal has a torn final line, so the last recorded step is incomplete and automatic recovery is refused",
		);
	}

	let committedTx: string | undefined;
	try {
		committedTx = loadState(root).lastTx;
	} catch (error) {
		if (error instanceof StateCorruptError) {
			blockers.push(
				`state.json is corrupt, so recovery cannot tell which transaction last committed: ${error.message}`,
			);
		} else {
			throw error;
		}
	}

	const allOpenInJournal = openTransactions(journalEntries);
	const finalizeCommitted = committedTx && allOpenInJournal.includes(committedTx) ? [committedTx] : [];
	const openInJournal = allOpenInJournal.filter((tx) => tx !== committedTx);
	const leftoverStaging = listSubdirNames(stagingRootDir(root));
	const leftoverBackups = listSubdirNames(backupsRootDir(root));
	const known = new Set(journalEntries.map((entry) => entry.tx));

	for (const tx of leftoverBackups) {
		if (!known.has(tx)) {
			blockers.push(
				`backups/${tx} holds a previous payload but the journal never recorded transaction ${tx}, so its destination is unknown`,
			);
		}
	}

	const perTx = collectPerTransaction(journalEntries);
	const transactions = [...new Set([...openInJournal, ...leftoverStaging, ...leftoverBackups])]
		.filter((tx) => tx !== committedTx)
		.sort();

	for (const tx of transactions) {
		const components = perTx.get(tx);
		if (!components) continue;
		for (const info of components.values()) {
			if (info.externalEffects.length > 0) {
				blockers.push(
					`transaction ${tx} may have changed external host/package-manager state for "${info.componentId}": ${info.externalEffects.join("; ")}`,
				);
			}
			try {
				assertSafeComponentId(info.componentId);
			} catch (error) {
				blockers.push(`transaction ${tx} recorded an unsafe component id: ${(error as Error).message}`);
				continue;
			}

			const backupPath = join(backupsDir(root, tx), info.componentId);
			const hasBackup = existsSync(backupPath);

			if (!info.swapped && !info.swapIntended && !hasBackup) {
				entries.push({ tx, componentId: info.componentId, targetDir: info.targetDir ?? "", action: "none" });
				continue;
			}

			if (!info.targetDir) {
				blockers.push(
					`transaction ${tx} swapped component "${info.componentId}" but the journal never recorded its target directory`,
				);
				continue;
			}
			try {
				assertSafeTarget(info.targetDir, bounds);
				assertNoSymlinkPivot(info.targetDir, bounds.home);
			} catch (error) {
				blockers.push(`transaction ${tx} recorded an unsafe target: ${(error as Error).message}`);
				continue;
			}

			entries.push({
				tx,
				componentId: info.componentId,
				targetDir: info.targetDir,
				action: hasBackup ? "restore-backup" : "remove-target",
			});
		}
	}

	return { recoverable: blockers.length === 0, transactions, finalizeCommitted, entries, blockers };
}

function moveDir(src: string, dest: string): void {
	mkdirSync(dirname(dest), { recursive: true });
	try {
		renameSync(src, dest);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		cpSync(src, dest, { recursive: true });
		rmSync(src, { recursive: true, force: true });
	}
}

/**
 * Undoes every interrupted transaction, restoring each component's previous
 * payload from its durable backup (or removing a half-installed fresh payload
 * that had no previous version), then clearing the transaction's staging and
 * backup directories and journaling it as rolled back.
 *
 * `state.json` is never rewritten here: a transaction that did not reach its
 * commit never wrote state in the first place, so undoing its filesystem
 * effects is enough to make state and disk agree again.
 *
 * Throws when `assessCrashedTransactions` reports a blocker — this function
 * never proceeds on partial evidence.
 */
export function recoverCrashedTransactions(root: string, bounds: TargetBounds): RecoveryResult {
	const assessment = assessCrashedTransactions(root, bounds);
	if (!assessment.recoverable) {
		throw new CliError(
			"unrecoverable-transaction",
			`refusing to recover interrupted transactions automatically: ${assessment.blockers.join("; ")}`,
			{ detail: { blockers: assessment.blockers } },
		);
	}
	if (assessment.transactions.length === 0 && assessment.finalizeCommitted.length === 0) {
		return { recovered: true, transactions: [], entries: [], notes: [] };
	}

	const notes: string[] = [];
	for (const tx of assessment.finalizeCommitted) {
		rmSync(stagingDir(root, tx), { recursive: true, force: true });
		rmSync(backupsDir(root, tx), { recursive: true, force: true });
		appendJournal(root, {
			tx,
			seq: Number.MAX_SAFE_INTEGER,
			at: new Date().toISOString(),
			event: "committed",
			detail: { recoveredBy: "draht-install", stateConfirmed: true, pid: process.pid },
		});
		notes.push(`finalized state-confirmed committed transaction ${tx}`);
	}
	// Reverse order mirrors the executor's own rollback: the last component the
	// crashed transaction touched is the first one put back.
	for (const entry of [...assessment.entries].reverse()) {
		if (entry.action !== "none") {
			assertSafeTarget(entry.targetDir, bounds);
			assertNoSymlinkPivot(entry.targetDir, bounds.home);
		}
		if (entry.action === "restore-backup") {
			const backupPath = join(backupsDir(root, entry.tx), entry.componentId);
			rmSync(entry.targetDir, { recursive: true, force: true });
			assertSafeTarget(entry.targetDir, bounds);
			assertNoSymlinkPivot(entry.targetDir, bounds.home);
			moveDir(backupPath, entry.targetDir);
			notes.push(`restored ${entry.componentId} from the backup transaction ${entry.tx} left behind`);
		} else if (entry.action === "remove-target") {
			rmSync(entry.targetDir, { recursive: true, force: true });
			notes.push(`removed the half-installed ${entry.componentId} payload transaction ${entry.tx} left behind`);
		}
	}

	for (const tx of assessment.transactions) {
		rmSync(stagingDir(root, tx), { recursive: true, force: true });
		rmSync(backupsDir(root, tx), { recursive: true, force: true });
		appendJournal(root, {
			tx,
			// Recovery appends after everything the crashed process wrote; a high
			// sequence number keeps this the last event for that transaction
			// without having to re-read and count the crashed process's writes.
			seq: Number.MAX_SAFE_INTEGER,
			at: new Date().toISOString(),
			event: "rolled-back",
			detail: { recoveredBy: "draht-install", pid: process.pid },
		});
	}

	return {
		recovered: true,
		transactions: [...assessment.finalizeCommitted, ...assessment.transactions],
		entries: assessment.entries,
		notes,
	};
}
