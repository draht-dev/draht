/**
 * Past sessions, read by their FIRST LINE ONLY (R35-ALWAYS.6).
 *
 * The draht binary writes one JSONL per session under
 * `<agent dir>/sessions/<cwd-slug>/<ts>_<uuid>.jsonl`, and appends to it for the
 * life of that session. Line 1 is a header and is immutable once written:
 *
 *   {"type":"session","version":3,"id":"<uuid>","timestamp":"<ISO>","cwd":"<abs>"}
 *
 * (`parentSession` is the only other field observed on the real store, and
 * `version` is the FILE FORMAT version — it is 3 on every file ever written and
 * carries no build marker, which is why "was this session recorded by a build
 * that predates socket registration?" has no discriminator here and is answered
 * elsewhere, by the absence of a live socket.)
 *
 * Measured on the real store 2026-08-22: 1,686 slug directories (634 of them
 * empty), 1,854 session files, 375,769,231 bytes, largest single file 35.8 MB.
 * Header bytes: min 136, p50 213, p99 431, max 433 — so ONE 4 KB page read is
 * always enough, and this module never reads a second one. Whole-file
 * enumeration over the same store moves 375.76 MB and ~194 MB of RSS; this
 * moves 7.59 MB and keeps nothing but headers.
 *
 * ## Two traps this store sets, both of which are handled on purpose
 *
 * 1. **Not every `*.jsonl` is a session.** `<session>.jsonl.checkpoints.jsonl`
 *    sidecars live beside the sessions, end in `.jsonl`, and contain no session
 *    header anywhere. Filtering on the suffix reports 1,864 sessions where there
 *    are 1,854. The filter here is "line 1 parses AND `type === 'session'`",
 *    never the filename.
 * 2. **The slug directory is a BUCKET KEY, not an identity.** The binary builds
 *    it as `--${cwd.replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`, collapsing
 *    `/`, `\` and `:` to `-` while leaving a literal `-` alone — so
 *    `/a/b-c/d` and `/a/b/c-d` slugify identically and land in ONE directory.
 *    The slug is lossy and irreversible. Project identity is read from the
 *    header's `cwd`, which is present on every file in the store.
 *
 * ## Why this duplicates `readSessionHeader` instead of importing it
 *
 * `scripts/check-geist-boundary.mjs` forbids `packages/geist-core` from
 * importing `@draht/coding-agent` (R31-FOUND.4), so this is a bounded re-write
 * of `coding-agent/src/core/session-manager.ts`'s header reader in the shape
 * `socket-sessions.ts` already established next door. The duplication is the
 * price of the boundary. It is also *narrower* than the original on purpose:
 * the kernel's reader will scan up to 1 MB for a header, this one reads exactly
 * one 4 KB page and gives up, because the whole point of the budget below is
 * that no history file is ever read past its first line.
 *
 * ## The budget, stated as an invariant rather than as milliseconds
 *
 * Warm wall-clock is a page-cache measurement and rots as the store grows. What
 * holds on any machine, at any corpus size, is PER FILE PER ENUMERATION:
 *
 *   ≤ 1 open · ≤ 4,096 bytes read · ≤ 2 stats
 *
 * {@link HistoryIndex} counts all three ({@link HistoryScanCounters}) and hands
 * the count back with every page, so the acceptance can assert the invariant
 * instead of asserting a stopwatch.
 */

import {
	type BigIntStats,
	closeSync,
	type Dirent,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { AGENT_DIR_ENV } from "./socket-sessions.js";

/** Directory name the agent directory holds its session JSONLs in. */
export const SESSIONS_DIR_NAME = "sessions";

/**
 * The one page a header is allowed to occupy.
 *
 * The largest header ever written to the real store is 433 bytes; 4,096 is the
 * same figure the kernel's reader uses for its chunk buffer. A first line that
 * does not fit in this page is not treated as a session — see
 * {@link HistoryIndex.readHeader}. Raising this number is a budget violation,
 * not a robustness improvement.
 */
export const HISTORY_HEADER_READ_BYTES = 4096;

/** Rows a caller gets back if it asks for no `limit`. */
export const DEFAULT_HISTORY_LIMIT = 50;

/** The most rows one page may carry, however large a `limit` is asked for. */
export const MAX_HISTORY_LIMIT = 500;

/**
 * Where this machine's past sessions live.
 *
 * Mirrors {@link resolveSocketDir} deliberately, including its env convention:
 * one `DRAHT_CODING_AGENT_DIR` relocates the sockets and the sessions together,
 * so a test can point a spawned draht and a daemon at one throwaway directory.
 *
 * @param env - Environment to read. Defaults to this process's.
 */
export function resolveSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env[AGENT_DIR_ENV];
	if (agentDir) return join(agentDir, SESSIONS_DIR_NAME);
	const home = env.HOME ?? homedir();
	return join(home, ".draht", "agent", SESSIONS_DIR_NAME);
}

/**
 * One past session, as its own header describes it.
 *
 * Deliberately raw. `origin`, `attachable`, `resumable` and `status` are NOT
 * here and must not be added: merging a history row against the live socket
 * fleet, and the wire schema that carries the merged shape, are owned by a
 * later task (R35-ALWAYS.7, R35-ALWAYS.8). This module answers exactly one
 * question — "what sessions has this machine recorded?" — and answering a
 * second one here would put two owners on one shape.
 *
 * THE JOIN KEY, for whoever writes that merge: it is {@link id}. A live session
 * publishes `<id>.sock` where `id` is the session header's own id
 * (`coding-agent/src/core/socket-server/session-integration.ts`). But the join
 * MISSES IN BOTH DIRECTIONS — on the real machine today, every live `.sock`
 * names an id with no session file anywhere in the store — so a merge must
 * treat "live id with no history row" and "history row with no live socket" as
 * ordinary, never as corruption.
 */
export interface HistorySession {
	/** The header's `id`. The join key to a live `<id>.sock`. */
	id: string;
	/** The header's `cwd`: the project. NOT derived from the slug directory. */
	cwd: string;
	/** The header's `timestamp`, ISO-8601, as written. */
	startedAt: string;
	/** Absolute path of the JSONL. */
	path: string;
	/** File mtime in milliseconds — the sort key, not the header's timestamp. */
	mtimeMs: number;
	/** File mtime in nanoseconds. The sort key at full resolution. */
	mtimeNs: bigint;
}

/**
 * What one enumeration actually touched.
 *
 * This is the load-bearing half of the budget: the acceptance for R35-ALWAYS.6
 * asserts over these numbers rather than over a stopwatch, because
 * "≤ 4,096 bytes per file" is true on a cold machine and on a ten-year-old
 * store, and "48 ms" is true on neither.
 *
 * Reported per enumeration, not cumulatively, so "after touching exactly one
 * directory, only that directory was re-read" is a statement about
 * {@link directoriesRead} and {@link headerReads} on a single request.
 */
export interface HistoryScanCounters {
	/** Slug directories seen in the store. */
	directoriesScanned: number;
	/** Slug directories whose contents were actually listed (a cache miss). */
	directoriesRead: number;
	/** Candidate `*.jsonl` files considered, sidecars included. */
	filesSeen: number;
	/** `stat(2)` calls on files. The per-file budget allows 2; this uses 1. */
	fileStats: number;
	/** `stat(2)` calls on directories. */
	directoryStats: number;
	/** Files opened to read a header. Never more than one open per file. */
	headerReads: number;
	/** Bytes read from session files, in total. */
	bytesRead: number;
	/** The most bytes read from any ONE file. Must never exceed 4,096. */
	maxFileBytesRead: number;
	/** Files whose first line parsed as a session header. */
	headersParsed: number;
	/** Files rejected because line 1 was not a session header (the sidecars). */
	nonSessionFiles: number;
}

/** One page of history, plus the receipts for how it was obtained. */
export interface HistoryPage {
	/** The rows on this page, newest file first. */
	sessions: HistorySession[];
	/** Rows matching the filter across all pages. */
	total: number;
	/** Opaque cursor for the next page, or `null` when this page is the last. */
	nextCursor: string | null;
	/** What this enumeration touched. See {@link HistoryScanCounters}. */
	counters: HistoryScanCounters;
}

/** How a caller asks for a page. */
export interface HistoryPageQuery {
	/**
	 * Absolute project path, matched against the header's `cwd`.
	 *
	 * NOT matched against the slug directory: the slug is lossy, and two
	 * genuinely different projects can share one.
	 */
	project?: string | undefined;
	/** Rows to return. Defaults to 50, clamped to 500. */
	limit?: number | undefined;
	/** A `nextCursor` from a previous page. */
	cursor?: string | undefined;
}

/** Raised when a caller hands back a cursor this index did not issue. */
export class HistoryCursorError extends Error {
	constructor(cursor: string) {
		super(`not a history cursor: ${cursor}`);
		this.name = "HistoryCursorError";
	}
}

/** The two fields a session header must carry to be usable. */
interface SessionHeader {
	id: string;
	cwd: string;
	startedAt: string;
}

/** A slug directory as it looked when it was last listed. */
interface DirectoryEntry {
	/** Directory mtime at nanosecond resolution, as a decimal string. */
	mtimeNs: string;
	/** The `*.jsonl` names it held. Sidecars included; they are filtered later. */
	names: string[];
}

/**
 * A memoized header.
 *
 * ONE DELIBERATE DIFFERENCE from `DeviceRegistry`'s `FileIdentity`
 * (`pairing/device-registry.ts`), which is the model this copies: that writer
 * replaces its file by `rename(2)`, so the inode alone is decisive and size and
 * mtime are only belt-and-braces. Session JSONLs are the opposite — they are
 * APPENDED IN PLACE for the whole life of a session, so size and mtime move
 * constantly while line 1 never changes. Including them in the identity would
 * re-read the header of every live session on every enumeration and prove
 * nothing. The inode is therefore the WHOLE identity here, and that is sound
 * precisely because the only bytes this memo describes are immutable ones.
 */
interface HeaderMemo {
	ino: string;
	header: SessionHeader | null;
}

function emptyCounters(): HistoryScanCounters {
	return {
		directoriesScanned: 0,
		directoriesRead: 0,
		filesSeen: 0,
		fileStats: 0,
		directoryStats: 0,
		headerReads: 0,
		bytesRead: 0,
		maxFileBytesRead: 0,
		headersParsed: 0,
		nonSessionFiles: 0,
	};
}

/** A path in the one form two spellings of the same directory agree on. */
function canonicalProject(path: string): string {
	const resolved = normalize(resolve(path));
	return resolved.length > 1 && resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

function encodeCursor(row: HistorySession): string {
	return Buffer.from(`${row.mtimeNs}|${row.path}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { mtimeNs: bigint; path: string } {
	let decoded: string;
	try {
		decoded = Buffer.from(cursor, "base64url").toString("utf8");
	} catch {
		throw new HistoryCursorError(cursor);
	}
	const separator = decoded.indexOf("|");
	if (separator <= 0) throw new HistoryCursorError(cursor);
	const path = decoded.slice(separator + 1);
	if (path.length === 0) throw new HistoryCursorError(cursor);
	try {
		return { mtimeNs: BigInt(decoded.slice(0, separator)), path };
	} catch {
		throw new HistoryCursorError(cursor);
	}
}

/**
 * Newest first, ties broken by path descending.
 *
 * The tie-break is not decoration: 1,854 files written by a test fixture in one
 * loop share an mtime freely, and a sort with no total order pages
 * non-deterministically — the same row appears on two pages and another appears
 * on none.
 */
function newestFirst(left: HistorySession, right: HistorySession): number {
	if (left.mtimeNs !== right.mtimeNs) return left.mtimeNs > right.mtimeNs ? -1 : 1;
	if (left.path === right.path) return 0;
	return left.path > right.path ? -1 : 1;
}

/** Whether `row` sorts strictly after the position a cursor names. */
function after(row: HistorySession, cursor: { mtimeNs: bigint; path: string }): boolean {
	if (row.mtimeNs !== cursor.mtimeNs) return row.mtimeNs < cursor.mtimeNs;
	return row.path < cursor.path;
}

/**
 * The machine's session history, enumerated by header and cached in memory.
 *
 * ## Two levels, both in memory, both per daemon process
 *
 * NOTHING IS PERSISTED. A disk index under `~/.draht` would be a second
 * unbounded artifact needing its own ownership and hygiene story
 * (R35-ALWAYS.3), to save a rebuild that costs roughly 0.5–2 s once per daemon
 * start.
 *
 * **Level 1 — per slug DIRECTORY, keyed on directory mtime.** A directory's
 * mtime moves when a file is added or removed and NEVER when one is appended
 * to, so an unchanged directory is skipped without a `readdir` — including all
 * 634 empty ones — and a day's growth costs O(changed directories).
 *
 * **Level 2 — per FILE, keyed on inode, and it never invalidates.** Line 1 is
 * immutable once written, so a header that has been read once is correct
 * forever. See {@link HeaderMemo} for why the inode alone is the identity here
 * when `DeviceRegistry` needs three fields.
 *
 * What the directory cache does NOT save is the per-file `stat`: a session
 * being appended to right now moves its own mtime without touching its
 * directory's, and mtime is the sort key, so every known file is stat'd on
 * every enumeration. That is one stat per file — inside the ≤2 budget — and it
 * is what keeps a live session at the top of the list.
 */
export class HistoryIndex {
	private readonly sessionsDir: string;
	private directories = new Map<string, DirectoryEntry>();
	private headers = new Map<string, HeaderMemo>();

	constructor(sessionsDir: string) {
		this.sessionsDir = sessionsDir;
	}

	/** One page of history, matching {@link HistoryPageQuery}. */
	page(query: HistoryPageQuery = {}): HistoryPage {
		const { rows, counters } = this.enumerate();

		const project = query.project === undefined ? undefined : canonicalProject(query.project);
		const matching = project === undefined ? rows : rows.filter((row) => canonicalProject(row.cwd) === project);

		const limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.trunc(query.limit ?? DEFAULT_HISTORY_LIMIT)));

		let start = 0;
		if (query.cursor !== undefined && query.cursor !== "") {
			const position = decodeCursor(query.cursor);
			const index = matching.findIndex((row) => after(row, position));
			start = index === -1 ? matching.length : index;
		}

		const sessions = matching.slice(start, start + limit);
		const last = sessions[sessions.length - 1];
		const nextCursor = last !== undefined && start + sessions.length < matching.length ? encodeCursor(last) : null;

		return { sessions, total: matching.length, nextCursor, counters };
	}

	/**
	 * Every recorded session, newest file first.
	 *
	 * Runs on every call. What the caches remove is the `readdir` of an
	 * unchanged directory and the `open` of an already-known file, not the walk
	 * itself — a walk that were skipped wholesale could not notice a directory
	 * appearing.
	 */
	enumerate(): { rows: HistorySession[]; counters: HistoryScanCounters } {
		const counters = emptyCounters();
		const rows: HistorySession[] = [];
		if (!existsSync(this.sessionsDir)) return { rows, counters };

		let entries: Dirent[];
		try {
			entries = readdirSync(this.sessionsDir, { withFileTypes: true });
		} catch {
			// Unreadable store: report no history rather than failing the request
			// that asked for it, exactly as the socket projection next door does.
			return { rows, counters };
		}

		// Rebuilt rather than mutated, so a slug directory or a session file that
		// has been deleted falls out of both caches instead of accumulating for
		// the life of the daemon.
		const directories = new Map<string, DirectoryEntry>();
		const headers = new Map<string, HeaderMemo>();

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = join(this.sessionsDir, entry.name);
			counters.directoriesScanned++;

			let dirMtimeNs: string;
			try {
				dirMtimeNs = String(statSync(dirPath, { bigint: true }).mtimeNs);
				counters.directoryStats++;
			} catch {
				continue;
			}

			const cached = this.directories.get(dirPath);
			let names: string[];
			if (cached !== undefined && cached.mtimeNs === dirMtimeNs) {
				names = cached.names;
			} else {
				counters.directoriesRead++;
				try {
					names = readdirSync(dirPath).filter((name) => name.endsWith(".jsonl"));
				} catch {
					names = [];
				}
			}
			directories.set(dirPath, { mtimeNs: dirMtimeNs, names });

			for (const name of names) {
				const filePath = join(dirPath, name);
				counters.filesSeen++;

				let stats: BigIntStats;
				try {
					stats = statSync(filePath, { bigint: true });
					counters.fileStats++;
				} catch {
					// Deleted between the listing and the stat.
					continue;
				}

				const ino = String(stats.ino);
				const memo = this.headers.get(filePath);
				let header: SessionHeader | null;
				if (memo !== undefined && memo.ino === ino) {
					header = memo.header;
				} else {
					header = this.readHeader(filePath, counters);
				}
				headers.set(filePath, { ino, header });
				if (header === null) {
					counters.nonSessionFiles++;
					continue;
				}
				counters.headersParsed++;

				rows.push({
					id: header.id,
					cwd: header.cwd,
					startedAt: header.startedAt,
					path: filePath,
					mtimeMs: Number(stats.mtimeMs),
					mtimeNs: stats.mtimeNs,
				});
			}
		}

		this.directories = directories;
		this.headers = headers;
		rows.sort(newestFirst);
		return { rows, counters };
	}

	/**
	 * Line 1 of one file, or `null` if line 1 is not a session header.
	 *
	 * Exactly one `open`, exactly one `read` of at most one 4 KB page, no second
	 * page ever. A first line that does not fit in that page is reported as "not
	 * a session" rather than chased: the largest header the real store has ever
	 * produced is 433 bytes, so a 4 KB line is a corrupt or foreign file, and
	 * reading further to find out would break the invariant this whole module
	 * exists to hold.
	 *
	 * `null` also covers the `<session>.jsonl.checkpoints.jsonl` sidecars, whose
	 * first line parses cleanly as JSON and is simply not `type: "session"`.
	 * That is the filter — the filename never is.
	 */
	private readHeader(filePath: string, counters: HistoryScanCounters): SessionHeader | null {
		let fd: number;
		try {
			fd = openSync(filePath, "r");
		} catch {
			// Unreadable or vanished: not a session, and not a reason to fail the
			// other 1,853.
			return null;
		}
		counters.headerReads++;
		try {
			const buffer = Buffer.allocUnsafe(HISTORY_HEADER_READ_BYTES);
			const bytesRead = readSync(fd, buffer, 0, HISTORY_HEADER_READ_BYTES, 0);
			counters.bytesRead += bytesRead;
			counters.maxFileBytesRead = Math.max(counters.maxFileBytesRead, bytesRead);
			if (bytesRead === 0) return null;

			// Bounded to what was actually read: `allocUnsafe` leaves whatever was
			// in the page before, and searching past `bytesRead` finds newlines
			// that are not in the file.
			const filled = buffer.subarray(0, bytesRead);
			const newline = filled.indexOf(0x0a);
			if (newline === -1 && bytesRead === HISTORY_HEADER_READ_BYTES) return null;
			const line = filled.toString("utf8", 0, newline === -1 ? bytesRead : newline);
			return parseSessionHeader(line);
		} catch {
			return null;
		} finally {
			closeSync(fd);
		}
	}
}

/**
 * A header, or `null` — never a throw.
 *
 * `type === "session"` is the whole test, plus the two fields a row cannot be
 * built without. `version` is deliberately not checked: it is the file format
 * version, it is 3 on every file in the store, and a future 4 that still opens
 * with a session header is history too.
 */
function parseSessionHeader(line: string): SessionHeader | null {
	const trimmed = line.trim();
	if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown };
	if (record.type !== "session") return null;
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	if (typeof record.cwd !== "string" || record.cwd.length === 0) return null;
	return {
		id: record.id,
		cwd: record.cwd,
		startedAt: typeof record.timestamp === "string" ? record.timestamp : "",
	};
}
