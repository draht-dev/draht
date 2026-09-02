/**
 * SOAK LOG — the append-only, rotating, restart-surviving JSONL that a long-run
 * verdict reads back weeks later.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FILE FORMAT CONTRACT (v1)
 * ─────────────────────────────────────────────────────────────────────────────
 * This comment is the contract, not a description of this implementation. A
 * second writer — the daemon half, which lives on the far side of a package
 * boundary that forbids importing this package — must be implementable from
 * this section alone. Do NOT export a shared module across that boundary; the
 * two halves agree on these bytes and on nothing else.
 *
 * LOCATION
 *   <agentDir>/soak/                          directory, mode 0700
 *   <agentDir>/soak/<stem>.jsonl              the ACTIVE file, mode 0600
 *   <agentDir>/soak/<stem>-<gen>.jsonl        a ROTATED generation, mode 0600
 *   <agentDir>/soak/<stem>.rotate.lock        the rotation lock, mode 0600
 *
 *   `<agentDir>` is the coding agent's config dir (honours DRAHT_CODING_AGENT_DIR).
 *   `<stem>` names the WRITING HALF, one file per half: "session" for a session
 *   process, "daemon" for the gateway/daemon process. The halves observe
 *   different events from different lifecycles; they are never interleaved into
 *   one file and are joined by `sessionId`/`wall` at verdict time.
 *   `<gen>` is `<compact-utc>-<pid>-<counter>` and is UNIQUE FOREVER — a
 *   generation name is never reused, so a rotation can never clobber evidence.
 *   Example: `session-20260822T114530123Z-40321-0.jsonl`.
 *
 * RECORDS
 *   One JSON object per line, UTF-8, terminated by "\n". No trailing commas, no
 *   pretty printing, no multi-line values. Every record carries:
 *     level      "info" | "warn" | "error"   (matches the gateway logger shape)
 *     timestamp  ISO-8601 string             (matches the gateway logger shape)
 *     event      string                      (see SOAK_EVENTS)
 *     v          1                           (this format version)
 *     wall       Date.now() milliseconds
 *     mono       performance.now() milliseconds
 *     uptimeMs   process.uptime() * 1000
 *     pid        writing process id
 *     rss        process.memoryUsage().rss bytes
 *   plus whatever fields the event carries. The fields above are stamped LAST,
 *   after the event's own: a caller field that collides with one of them is
 *   dropped rather than honoured, because a record whose `pid` or `wall` came
 *   from a call site is a record the reader classifies as malformed and drops.
 *   `sessionId` is present on every
 *   record a session process writes; prompt/permission records additionally
 *   carry `requestId`, so this stream can be JOINED against the durable
 *   per-session permission rows without duplicating any decision here.
 *
 *   All three clocks are recorded on every record on purpose. A frozen process
 *   (SIGSTOP/SIGCONT, and by extension a suspended host) shows up as a WALL-CLOCK
 *   GAP between consecutive heartbeats, not as divergence between the clocks —
 *   measured, all three advanced identically across a 2,677 ms stop. Recording
 *   all three costs nothing and leaves the question answerable if a real lid-close
 *   behaves differently.
 *
 * APPENDING
 *   One open("a", 0600) / write / close per record. NOT a held descriptor: this
 *   writer reports an fd gauge, and holding its own fd would perturb the metric
 *   it publishes. Concurrent appends from many processes are safe because each
 *   record is a single write() to an O_APPEND descriptor.
 *
 *   NO fsync. Measured 4.0–4.7 ms per record under Node against 0.017–0.025 ms
 *   under Bun; on seams that fire per client attach and per prompt that is a
 *   hot-path cost, and it would give materially different guarantees on the
 *   runtime this product actually ships as (a Bun-compiled binary). The tolerated
 *   failure is the loss of the last few records on a hard power cut; the reader
 *   is torn-tail tolerant, so that loss costs one line, never the file.
 *
 * ROTATION (the part that loses data if done naively — measured)
 *   A two-slot `rename(f, f.1)` scheme under 8 concurrent writers lost 11,148 of
 *   12,000 records. The scheme below lost ZERO across 8 generations. Implement
 *   EXACTLY this order:
 *     1. after appending, fstat the descriptor you just wrote through: that
 *        yields both the size and the INODE you filled;
 *     2. if size < maxFileBytes, stop;
 *     3. open(lockPath, "wx", 0600). EEXIST means another writer is rotating:
 *        give up silently and let the next append retry. (A lock whose mtime is
 *        older than the stale window is debris and may be removed once.)
 *     4. stat the active path again and COMPARE THE INODE against step 1. A
 *        different inode means another writer already rotated the file you
 *        filled: release the lock and stop. This comparison is the whole
 *        correctness argument — without it, two writers rotate in sequence and
 *        the second one renames away a fresh file that other writers are still
 *        appending to.
 *     5. rename the active path to a UNIQUE generation name.
 *     6. prune (see RETENTION), then append ONE `rotation` record to the new
 *        active file naming the generation just closed and everything pruned.
 *     7. unlink the lock.
 *
 *   A writer holding a descriptor across step 5 keeps writing into the renamed
 *   inode. That is not loss: the reader reads every generation, so those records
 *   are still found. It is why generation files may keep growing after rotation
 *   and why file order — not byte order across files — is the only ordering the
 *   reader promises.
 *
 * RETENTION
 *   Two gates, BOTH must permit a delete:
 *     • a byte cap over the directory (maxTotalBytes), and
 *     • a retention FLOOR: a generation whose newest write is younger than
 *       `retentionFloorMs` (default 14 days) is NEVER pruned, even when the byte
 *       cap says prune.
 *   A byte-only cap sized for a quiet week silently rotates away the first days
 *   of a busy one, and a multi-week soak verdict would destroy its own evidence.
 *   When the floor blocks a prune the log simply grows; that is the intended
 *   trade. Every prune is named in the `rotation` record written into the
 *   surviving file, so a gap in the evidence is VISIBLE rather than invisible.
 *
 * HARD RULES FOR ANY IMPLEMENTATION
 *   • NEVER write to stdout or stderr. Not a warning, not a stack trace. The TUI
 *     owns the terminal, and a default-on session's streams are asserted
 *     byte-identical to a feature-off run; one stray line breaks that.
 *   • NEVER throw into a caller. Every failure is swallowed; the last one is
 *     retained on the instance for a debugger to look at, and that is all.
 *   • The soak directory is OUTSIDE the session store on purpose, which is what
 *     exempts it from the byte-identity claim.
 */

import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";

/** Format version stamped on every record as `v`. */
export const SOAK_FORMAT_VERSION = 1;

/** Directory under the agent dir that holds every soak file. */
export const SOAK_DIR_NAME = "soak";

/** File stem for the half a session process writes. */
export const SOAK_STEM_SESSION = "session";

/** File stem for the half the daemon writes (a separate implementation of this same contract). */
export const SOAK_STEM_DAEMON = "daemon";

/**
 * Canonical event names. Kept as a frozen map rather than a union type so a call
 * site can add a field — or a new event — without editing this file.
 */
export const SOAK_EVENTS = Object.freeze({
	SOCKET_BIND: "socket_bind",
	SOCKET_REBIND: "socket_rebind",
	SOCKET_TEARDOWN: "socket_teardown",
	CLIENT_ATTACH: "client_attach",
	CLIENT_DETACH: "client_detach",
	CLIENT_REJECTED: "client_rejected",
	PROMPT_REJECTED: "prompt_rejected",
	SOCKETS_REAPED: "sockets_reaped",
	HEARTBEAT: "heartbeat",
	ROTATION: "rotation",
});

/** Severity, matching the gateway logger's vocabulary so both streams parse the same way. */
export type SoakLevel = "info" | "warn" | "error";

/** Arbitrary caller-supplied fields. */
export type SoakFields = Record<string, unknown>;

/** One parsed record. The named fields are guaranteed by the contract; the rest are event-specific. */
export interface SoakRecord extends SoakFields {
	level: SoakLevel;
	timestamp: string;
	event: string;
	v: number;
	wall: number;
	mono: number;
	uptimeMs: number;
	pid: number;
	rss?: number;
	sessionId?: string;
	requestId?: string;
}

/** Directory counts for the sockets dir, gathered with one readdir (1.12 ms for 553 entries). */
export interface SocketDirCounts {
	sockCount: number;
	lockCount: number;
}

export interface SoakLogOptions {
	/** Soak directory. Defaults to `<agentDir>/soak`. */
	dir?: string;
	/** File stem naming the writing half. Defaults to `session`. */
	stem?: string;
	/** Rotate once the active file reaches this many bytes. */
	maxFileBytes?: number;
	/** Prune oldest generations once the directory exceeds this many bytes — subject to the retention floor. */
	maxTotalBytes?: number;
	/** Never prune a generation whose newest write is younger than this. */
	retentionFloorMs?: number;
	/** Heartbeat period used by {@link SoakLog.startHeartbeat}. */
	heartbeatMs?: number;
	/** Sockets directory used for the sock/lock gauges. Defaults to `<agentDir>/sockets`. */
	socketsDir?: string;
	/** Stamped on every record when set. */
	sessionId?: string;
	/** Live client count for the heartbeat, when the caller can supply one. */
	clientCount?: () => number;
	/** Injectable clock, for tests. */
	now?: () => number;
	/**
	 * TEST SEAM. Invoked under the rotation lock, immediately before the active
	 * path is re-stat'd — i.e. inside the exact window another process's rotation
	 * can land in.
	 *
	 * It exists because the inode re-check is otherwise UNFALSIFIABLE: the size
	 * guard one line below it hides the check under any load a test can generate
	 * (measured — dropping the inode comparison entirely left 8 processes x 1,500
	 * records byte-for-byte identical, same generation count). A guard no test can
	 * kill is a guard that will be deleted by someone who reads it as dead code, so
	 * the window is made addressable rather than left to chance. Undefined in
	 * production, where it costs one property read per rotation.
	 */
	onRotateWindow?: () => void;
}

/** 4 MiB per generation: ~20k records of the size these events produce. */
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;

/** 64 MiB across the whole directory before the byte gate opens. */
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** 14 days: a 7-day soak plus a full week of slack before its first day can be pruned. */
const DEFAULT_RETENTION_FLOOR_MS = 14 * 24 * 60 * 60 * 1000;

/** One heartbeat a minute: fine enough to see a sleep/wake gap, coarse enough to be free. */
const DEFAULT_HEARTBEAT_MS = 60_000;

/** A rotation lock older than this was left by a process that died mid-rotation. */
const LOCK_STALE_MS = 30_000;

/** Every soak file — active and rotated alike — carries this suffix. */
const GENERATION_SUFFIX = ".jsonl";

/** `process.memoryUsage().rss`, or 0 if the runtime refuses. Works under Node and Bun. */
export function currentRss(): number {
	try {
		return process.memoryUsage().rss;
	} catch {
		return 0;
	}
}

/**
 * Milliseconds since this process started, from `process.uptime()`.
 *
 * The in-tree `time()` helper cannot supply this: it compiles itself out unless
 * DRAHT_TIMING=1, so a soak run would carry no startup delta at all.
 */
export function startupDeltaMs(): number {
	try {
		return Math.round(process.uptime() * 1000);
	} catch {
		return 0;
	}
}

/**
 * Open descriptor gauge: open /dev/null, record the descriptor number POSIX hands
 * back (always the lowest free one), close it. 0.04 ms, and it tracks fd growth
 * exactly.
 *
 * Deliberately NOT `lsof` (176–200 ms, 4,000x more — and `lsof -p <pid> -U` ORs
 * its selectors and returns every socket on the machine; the correct form is
 * `lsof -a -p <pid> -U`). Deliberately NOT `process.getActiveResourcesInfo()`,
 * which reports 20 under Node with 20 live listeners and 0 under Bun with the
 * same 20 — and the shipped draht is a Bun-compiled binary.
 */
export function fdGauge(): number {
	let fd: number | undefined;
	try {
		fd = openSync("/dev/null", "r");
		return fd;
	} catch {
		return -1;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* swallowed: the gauge must never disturb the caller */
			}
		}
	}
}

/** Counts `.sock` and `.lock` entries with one readdir. Never `lsof`. */
export function socketDirCounts(socketsDir: string): SocketDirCounts {
	let sockCount = 0;
	let lockCount = 0;
	try {
		for (const entry of readdirSync(socketsDir)) {
			if (entry.endsWith(".sock")) sockCount++;
			else if (entry.endsWith(".lock")) lockCount++;
		}
	} catch {
		/* no sockets dir yet: both gauges are honestly zero */
	}
	return { sockCount, lockCount };
}

/** Default soak directory for this process. */
export function getSoakDir(): string {
	return join(getAgentDir(), SOAK_DIR_NAME);
}

/**
 * The rotating soak writer.
 *
 * Every public method swallows every failure — a soak log that can break a
 * session is worse than no soak log — and NOTHING here writes to stdout or
 * stderr under any condition.
 */
export class SoakLog {
	readonly dir: string;
	readonly stem: string;
	readonly activePath: string;
	readonly lockPath: string;

	readonly #maxFileBytes: number;
	readonly #maxTotalBytes: number;
	readonly #retentionFloorMs: number;
	readonly #heartbeatMs: number;
	readonly #socketsDir: string;
	readonly #now: () => number;
	readonly #onRotateWindow: (() => void) | undefined;

	#sessionId: string | undefined;
	#clientCount: (() => number) | undefined;
	#dirReady = false;
	#generationCounter = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	/** Last swallowed failure, retained for a debugger. Never printed. */
	lastError: unknown;

	constructor(options: SoakLogOptions = {}) {
		let dir: string;
		let socketsDir: string;
		try {
			dir = options.dir ?? getSoakDir();
			socketsDir = options.socketsDir ?? join(getAgentDir(), "sockets");
		} catch (error) {
			// getAgentDir() reads the environment and can in principle throw; a
			// constructor that throws would take the session with it.
			this.lastError = error;
			dir = options.dir ?? join(".", SOAK_DIR_NAME);
			socketsDir = options.socketsDir ?? join(".", "sockets");
		}
		this.dir = dir;
		this.stem = options.stem ?? SOAK_STEM_SESSION;
		this.activePath = join(this.dir, `${this.stem}${GENERATION_SUFFIX}`);
		this.lockPath = join(this.dir, `${this.stem}.rotate.lock`);
		this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
		this.#retentionFloorMs = options.retentionFloorMs ?? DEFAULT_RETENTION_FLOOR_MS;
		this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
		this.#socketsDir = socketsDir;
		this.#now = options.now ?? Date.now;
		this.#sessionId = options.sessionId;
		this.#clientCount = options.clientCount;
		this.#onRotateWindow = options.onRotateWindow;
	}

	/** Stamp every subsequent record with this session id. */
	setSessionId(sessionId: string | undefined): void {
		this.#sessionId = sessionId;
	}

	/** Supply a live client count for the heartbeat. */
	setClientCountProvider(provider: (() => number) | undefined): void {
		this.#clientCount = provider;
	}

	/**
	 * Append one record. This is the whole write API: a new event or a new field
	 * needs no change to this file.
	 *
	 * `fields` may therefore carry ANY name, including one the contract reserves.
	 * A collision loses: the contract's value is stamped over it. The one
	 * exception is `sessionId` on a writer that has none of its own — the daemon
	 * half writes about sessions it does not belong to — where the caller's value
	 * stands.
	 */
	record(event: string, fields: SoakFields = {}, level: SoakLevel = "info"): void {
		try {
			this.#write(event, fields, level, true);
		} catch (error) {
			this.lastError = error;
		}
	}

	/**
	 * Write one heartbeat now.
	 *
	 * Edge events cannot answer "how many days did this run", "did the host
	 * sleep", or "did fds grow" — only a periodic record can, so the heartbeat is
	 * part of the record set, not a nicety.
	 */
	heartbeat(fields: SoakFields = {}): void {
		try {
			const counts = socketDirCounts(this.#socketsDir);
			let clientCount: number | undefined;
			try {
				clientCount = this.#clientCount?.();
			} catch (error) {
				this.lastError = error;
			}
			this.#write(
				SOAK_EVENTS.HEARTBEAT,
				{
					// Same rule as #write: the measured gauges are stamped over a
					// caller field of the same name, never under it. A heartbeat whose
					// fdGauge came from its call site measures nothing.
					...fields,
					fdGauge: fdGauge(),
					sockCount: counts.sockCount,
					lockCount: counts.lockCount,
					...(clientCount === undefined ? {} : { clientCount }),
				},
				"info",
				true,
			);
		} catch (error) {
			this.lastError = error;
		}
	}

	/**
	 * Start the periodic heartbeat. The timer is `unref`'d, so it fires while the
	 * process is alive and does not by itself keep the process alive — the idiom
	 * the fleet route already uses. Idempotent.
	 */
	startHeartbeat(intervalMs: number = this.#heartbeatMs): void {
		try {
			if (this.#timer) return;
			const timer = setInterval(() => this.heartbeat(), intervalMs);
			(timer as { unref?: () => void }).unref?.();
			this.#timer = timer;
		} catch (error) {
			this.lastError = error;
		}
	}

	/** Stop the periodic heartbeat. Idempotent. */
	stopHeartbeat(): void {
		try {
			if (!this.#timer) return;
			clearInterval(this.#timer);
			this.#timer = undefined;
		} catch (error) {
			this.lastError = error;
		}
	}

	// ── internals ────────────────────────────────────────────────────────────

	#write(event: string, fields: SoakFields, level: SoakLevel, mayRotate: boolean): void {
		this.#ensureDir();
		const record: SoakRecord = {
			// CALLER FIELDS FIRST, and the contract's fields last, so a caller can
			// never shadow one. `record()` promises that a new event or a new field
			// needs no edit to this file, which makes every call site free to pick a
			// field name — and `pid` is an entirely plausible one at a socket seam,
			// where the `.lock` files already carry one. Spread the other way round,
			// `record("client_attach", { pid: "not-a-pid" })` writes a line the
			// reader then rejects as malformed and drops: the seam that reported the
			// event disappears from the evidence instead of failing loudly.
			...fields,
			level,
			timestamp: new Date(this.#now()).toISOString(),
			event,
			v: SOAK_FORMAT_VERSION,
			wall: this.#now(),
			mono: Math.round(performance.now() * 1000) / 1000,
			uptimeMs: startupDeltaMs(),
			pid: process.pid,
			rss: currentRss(),
			...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
		};
		const line = `${JSON.stringify(record)}\n`;
		const filled = this.#append(line);
		if (mayRotate && filled && filled.size >= this.#maxFileBytes) {
			this.#rotate(filled.ino);
		}
	}

	/**
	 * One open/write/close. The fstat before the close is what makes rotation
	 * safe: it yields the size AND the inode of the file this record actually
	 * landed in, so the rotator can prove it is renaming the file it filled.
	 */
	#append(line: string): { size: number; ino: number } | undefined {
		let fd: number | undefined;
		try {
			fd = openSync(this.activePath, "a", 0o600);
			const buf = Buffer.from(line, "utf8");
			let offset = 0;
			while (offset < buf.length) {
				const written = writeSync(fd, buf, offset, buf.length - offset);
				if (written <= 0) break;
				offset += written;
			}
			const st = fstatSync(fd);
			return { size: st.size, ino: Number(st.ino) };
		} catch (error) {
			this.lastError = error;
			return undefined;
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch (error) {
					this.lastError = error;
				}
			}
		}
	}

	#ensureDir(): void {
		if (this.#dirReady) return;
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		this.#dirReady = true;
	}

	/**
	 * Lock-guarded, inode-checked, unique-generation rotation. See the contract at
	 * the top of this file; the ORDER of the steps is the correctness argument and
	 * must not be rearranged.
	 */
	#rotate(filledIno: number): void {
		let lockFd: number | undefined;
		try {
			lockFd = this.#claimRotationLock();
			if (lockFd === undefined) return; // another writer is rotating; next append retries

			if (this.#onRotateWindow) {
				try {
					this.#onRotateWindow();
				} catch (error) {
					this.lastError = error;
				}
			}

			let current: { size: number; ino: number };
			try {
				const st = statSync(this.activePath);
				current = { size: st.size, ino: Number(st.ino) };
			} catch {
				return; // already renamed away by someone else
			}
			// THE INODE CHECK: rotate the file THIS record landed in, or rotate
			// nothing. Another writer that rotated while we queued for the lock has
			// already replaced the active path, and renaming its fresh file away is
			// closing a generation nobody filled.
			//
			// Honest note on its weight: with unique generation names the size guard
			// below covers the common case, so this line is defence in depth rather
			// than the thing standing between the log and data loss. It is what keeps
			// the scheme correct if the cap is ever raised at runtime or the size
			// guard is ever relaxed, and `onRotateWindow` exists so it can be killed
			// by a test instead of surviving as unfalsifiable code.
			if (current.ino !== filledIno) return;
			if (current.size < this.#maxFileBytes) return;

			const generation = this.#nextGenerationPath();
			renameSync(this.activePath, generation);

			const pruned = this.#prune();
			// Into the SURVIVING file, so a pruned gap is visible rather than invisible.
			this.#write(
				SOAK_EVENTS.ROTATION,
				{
					rotatedTo: generation.slice(this.dir.length + 1),
					rotatedBytes: current.size,
					maxFileBytes: this.#maxFileBytes,
					maxTotalBytes: this.#maxTotalBytes,
					retentionFloorMs: this.#retentionFloorMs,
					pruned: pruned.names,
					prunedBytes: pruned.bytes,
					retainedByFloor: pruned.retainedByFloor,
				},
				"info",
				false,
			);
		} catch (error) {
			this.lastError = error;
		} finally {
			if (lockFd !== undefined) {
				try {
					closeSync(lockFd);
				} catch (error) {
					this.lastError = error;
				}
				try {
					unlinkSync(this.lockPath);
				} catch (error) {
					this.lastError = error;
				}
			}
		}
	}

	/** `wx` exclusive create — the idiom the socket lock already uses. Undefined means "someone else holds it". */
	#claimRotationLock(): number | undefined {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const fd = openSync(this.lockPath, "wx", 0o600);
				try {
					writeSync(fd, `${process.pid}\n${new Date(this.#now()).toISOString()}\n`);
				} catch (error) {
					this.lastError = error;
				}
				return fd;
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
					this.lastError = error;
					return undefined;
				}
			}
			// A lock that has sat far longer than any rotation takes was left by a
			// process that died mid-rotation. Remove it once, then retry.
			try {
				const st = statSync(this.lockPath);
				if (this.#now() - st.mtimeMs < LOCK_STALE_MS) return undefined;
				unlinkSync(this.lockPath);
			} catch {
				return undefined;
			}
		}
		return undefined;
	}

	/** Unique forever: compact UTC stamp + pid + a per-process counter, and never an existing path. */
	#nextGenerationPath(): string {
		for (;;) {
			const stamp = new Date(this.#now()).toISOString().replace(/[-:.]/g, "");
			const name = `${this.stem}-${stamp}-${process.pid}-${this.#generationCounter++}${GENERATION_SUFFIX}`;
			const candidate = join(this.dir, name);
			try {
				statSync(candidate);
			} catch {
				return candidate; // does not exist
			}
		}
	}

	/**
	 * Byte cap AND retention floor, both of which must permit a delete. Returns
	 * what went, what it weighed, and how many generations the floor saved — all
	 * of which land in the rotation record.
	 */
	#prune(): { names: string[]; bytes: number; retainedByFloor: number } {
		const names: string[] = [];
		let bytes = 0;
		let retainedByFloor = 0;
		try {
			const generations = listGenerationFiles(this.dir, this.stem);
			let total = 0;
			for (const gen of generations) total += gen.size;
			try {
				total += statSync(this.activePath).size;
			} catch {
				/* no active file right now; it is about to be created */
			}
			const now = this.#now();
			for (const gen of generations) {
				if (total <= this.#maxTotalBytes) break;
				if (now - gen.mtimeMs < this.#retentionFloorMs) {
					// The floor wins over the byte cap, always. Growing is the intended
					// trade: a soak verdict that prunes its own first days is worthless.
					retainedByFloor++;
					continue;
				}
				try {
					unlinkSync(gen.path);
					names.push(gen.name);
					bytes += gen.size;
					total -= gen.size;
				} catch (error) {
					this.lastError = error;
				}
			}
		} catch (error) {
			this.lastError = error;
		}
		return { names, bytes, retainedByFloor };
	}
}

/** One rotated generation on disk. */
export interface SoakGenerationFile {
	name: string;
	path: string;
	size: number;
	mtimeMs: number;
}

/**
 * Every rotated generation for `stem`, oldest first.
 *
 * Ordered by the timestamp embedded in the NAME, not by mtime: a straggler
 * writer still holding a descriptor keeps appending to a generation after it was
 * renamed, which moves its mtime but not its place in the sequence.
 */
export function listGenerationFiles(dir: string, stem: string): SoakGenerationFile[] {
	const prefix = `${stem}-`;
	const files: SoakGenerationFile[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return files;
	}
	for (const name of entries) {
		if (!name.startsWith(prefix) || !name.endsWith(GENERATION_SUFFIX)) continue;
		const path = join(dir, name);
		try {
			const st = statSync(path);
			if (!st.isFile()) continue;
			files.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
		} catch {
			/* vanished between readdir and stat; another writer pruned it */
		}
	}
	files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return files;
}

let singleton: SoakLog | undefined;

/**
 * Process-wide soak log for the session half.
 *
 * Constructed lazily so importing this module costs nothing and creates no
 * directory; the first record makes the directory.
 */
export function getSoakLog(): SoakLog {
	if (!singleton) singleton = new SoakLog();
	return singleton;
}

/** Replace the process-wide log (tests, and the daemon half if it ever shares a process). */
export function setSoakLog(log: SoakLog | undefined): void {
	singleton?.stopHeartbeat();
	singleton = log;
}
