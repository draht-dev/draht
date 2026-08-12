import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { journalPath } from "./paths.ts";
import { type InstallState, type JournalEntry, JournalEntrySchema } from "./types.ts";

/** Result of `readJournal`: every fully-written record, plus whether the final line was torn (an interrupted append). */
export interface ReadJournalResult {
	entries: JournalEntry[];
	torn: boolean;
	/** Unterminated final bytes, retained only so recovery can bind a torn terminal append to durable state. */
	tornTail?: string;
}

/**
 * Appends one journal entry as a single JSON line. Opened in append mode
 * (`O_APPEND`, the same semantics `appendFileSync` uses) so this write can
 * never clobber a previous line, then fsynced before the fd is closed so the
 * line survives a crash immediately after this call returns.
 */
export function appendJournal(root: string, entry: JournalEntry): void {
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = journalPath(root);
	const line = `${JSON.stringify(entry)}\n`;

	// 0600 applies only when this open creates the file; an existing journal
	// keeps whatever mode it already had.
	const fd = openSync(path, "a", 0o600);
	try {
		writeSync(fd, line);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Reads every journal entry from `root`. A crash mid-`appendJournal` can
 * leave the final line without its trailing newline (or with a truncated
 * JSON payload); that specific case is tolerated — the partial tail is
 * dropped and `torn: true` is reported — rather than failing the whole read.
 * A malformed line anywhere else in the file is a genuine corruption, not an
 * expected torn tail, and throws.
 */
export function readJournal(root: string): ReadJournalResult {
	const path = journalPath(root);
	if (!existsSync(path)) {
		return { entries: [], torn: false };
	}

	const raw = readFileSync(path, "utf8");
	if (raw.length === 0) {
		return { entries: [], torn: false };
	}

	const endsWithNewline = raw.endsWith("\n");
	const lines = raw.split("\n");
	let torn = false;
	let tornTail: string | undefined;
	if (endsWithNewline) {
		lines.pop(); // trailing "" left by split() after the final "\n"
	} else {
		tornTail = lines.pop(); // unterminated tail from an interrupted append
		torn = true;
	}

	const entries: JournalEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "") continue;
		entries.push(parseJournalLine(line, path, i + 1));
	}

	return { entries, torn, tornTail };
}

/** Removes only an unterminated crash tail, preserving and fsyncing every complete JSONL record. */
export function discardTornJournalTail(root: string): void {
	const path = journalPath(root);
	if (!existsSync(path)) return;
	const raw = readFileSync(path);
	if (raw.length === 0 || raw[raw.length - 1] === 0x0a) return;
	const lastNewline = raw.lastIndexOf(0x0a);
	const fd = openSync(path, "r+");
	try {
		ftruncateSync(fd, lastNewline + 1);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function parseJournalLine(line: string, path: string, lineNumber: number): JournalEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`journal at ${path} has malformed JSON on line ${lineNumber}: ${reason}`);
	}
	const result = JournalEntrySchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`journal at ${path} has an invalid entry on line ${lineNumber}: ${result.error.message}`);
	}
	return result.data;
}

function lastEventPerTx(entries: JournalEntry[]): Map<string, JournalEntry> {
	const lastByTx = new Map<string, JournalEntry>();
	for (const entry of entries) {
		const current = lastByTx.get(entry.tx);
		if (!current || entry.seq >= current.seq) {
			lastByTx.set(entry.tx, entry);
		}
	}
	return lastByTx;
}

const TERMINAL_EVENTS = new Set(["committed", "rolled-back"]);

/** Transaction ids from `entries` whose last recorded event isn't `committed` or `rolled-back`, sorted for determinism. */
export function openTransactions(entries: JournalEntry[]): string[] {
	const open: string[] = [];
	for (const [tx, last] of lastEventPerTx(entries)) {
		if (!TERMINAL_EVENTS.has(last.event)) {
			open.push(tx);
		}
	}
	return open.sort();
}

/** Per-transaction status: `"committed"`/`"rolled-back"` mirrors the journal's terminal event; anything else is `"open"`. */
export type TxStatus = "committed" | "rolled-back" | "open";

/**
 * Reconstructs commit/rollback status per transaction. `baseState.lastTx`
 * (if set) seeds the result as `"committed"` — `state.json` is only ever
 * saved with `lastTx` pointing at a transaction that genuinely finished — so
 * a transaction still reads as committed even if the journal that recorded
 * it was later rotated away. Every transaction id `entries` mentions then
 * gets its own status from its last recorded event.
 */
export function replayState(entries: JournalEntry[], baseState: InstallState): Record<string, TxStatus> {
	const statusByTx = new Map<string, TxStatus>();
	if (baseState.lastTx) {
		statusByTx.set(baseState.lastTx, "committed");
	}
	for (const [tx, last] of lastEventPerTx(entries)) {
		if (last.event === "committed") {
			statusByTx.set(tx, "committed");
		} else if (last.event === "rolled-back") {
			statusByTx.set(tx, "rolled-back");
		} else {
			statusByTx.set(tx, "open");
		}
	}
	return Object.fromEntries(statusByTx);
}
