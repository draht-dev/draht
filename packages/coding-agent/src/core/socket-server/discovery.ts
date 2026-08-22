/**
 * Socket Session Discovery
 *
 * Scans the sockets directory to find all running attachable sessions.
 *
 * ── OWNERSHIP AND HYGIENE RULES (R35-ALWAYS.3, R35-ALWAYS.4) ───────────────────
 *
 * These rules are implemented TWICE on purpose: here, and synchronously in
 * `packages/geist-core/src/attach/socket-sessions.ts`, which may not import this
 * package across the geist boundary gate. `scripts/check-geist-protocol.mjs`'s
 * mirror clause only covers the relayed FRAMES — it does not cover any of this —
 * so the two files have to be changed together by hand. They had already drifted
 * once (this file used to shield a lock from the orphan sweep before it had
 * established that `<id>.sock` was a socket at all); that drift is fixed here.
 *
 *   O1. OURS OR INVISIBLE. An entry whose file uid is not this process's uid, or
 *       whose lock names a live process we cannot signal (`kill` → EPERM, i.e. it
 *       belongs to another user), is never listed and never dialled. Before this,
 *       a world-writable sockets directory holding a 0666 socket and a lock naming
 *       root's pid 1 was listed as a live attachable session by both readers and
 *       would have been dialled by the bridge; the 0700 directory mode was the
 *       only thing in the way, and nothing asserted it.
 *   O2. FOREIGN IS NOT REAPED HERE. A read must not destroy what it cannot
 *       interpret, and a fleet scan runs on an HTTP request. Foreign entries are
 *       skipped. `SocketServer.start()` is the one place allowed to remove them,
 *       and only after it has asserted the directory really is ours and owner-only
 *       — which makes a foreign file inside it debris by construction.
 *   O3. EPERM STILL MEANS ALIVE. `kill(pid, 0)` → EPERM says the process exists.
 *       It is never read as dead, so another user's live session is never reaped.
 *       What changed is that "alive" no longer implies "ours".
 *   O4. DEBRIS. Two classes used to be immortal — a `.sock` with no `.lock`, and a
 *       regular file named `<id>.sock` — because both readers `continue`d past
 *       them without reaping. Two such orphans had been sitting in the real
 *       `~/.draht/agent/sockets` since 2026-08-21. Both are now reaped once they
 *       are older than {@link DEBRIS_GRACE_MS}, which no legitimate transient
 *       state survives: the lock is claimed BEFORE the socket is bound, and
 *       teardown removes the socket BEFORE the lock, so a socket without a lock is
 *       never a normal intermediate state in either direction.
 *   O5. A LOCK CANNOT PREDATE THE BOOT. See {@link lockIsPreBootDebris}.
 */

import type { Stats } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import type { SocketSessionInfo } from "./types.js";

/**
 * How long a file has to sit untouched before it counts as debris rather than as
 * a transient another starter is in the middle of creating.
 *
 * Deliberately the same number as `UNWRITTEN_LOCK_STALE_MS` in `socket-server.ts`
 * and `DEBRIS_GRACE_MS` in geist-core's `socket-sessions.ts`. It is duplicated
 * rather than imported for the boundary reason at the top of this file.
 */
export const DEBRIS_GRACE_MS = 10_000;

/**
 * Slack on the boot-time comparison in {@link lockIsPreBootDebris}.
 *
 * `Date.now()` is wall clock and `os.uptime()` is elapsed-since-boot, so their
 * difference moves whenever the clock is stepped. Five minutes is far more than
 * NTP ever steps in one go and far less than the gap between a lock written
 * before a reboot and the reboot itself.
 */
const PRE_BOOT_SLACK_MS = 300_000;

/** What this process may do about the process a lock names. */
export type PidOwnership =
	/** Alive and signallable by us: a session this user is running. */
	| "ours"
	/** Alive, but `kill` says EPERM — it belongs to another user. */
	| "foreign"
	/** No such process. */
	| "dead";

/**
 * Who owns the process a lock names.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the pid could be
 * signalled. EPERM is the discriminator that costs nothing: a process this uid
 * could have started is always signallable by this uid, so EPERM means alive AND
 * not ours. That single distinction is what R35-ALWAYS.3 rests on — without it a
 * lock naming root's pid 1 reads as a live session of ours forever.
 */
export function pidOwnership(pid: number): PidOwnership {
	if (!Number.isInteger(pid) || pid <= 0) return "dead";
	try {
		process.kill(pid, 0);
		return "ours";
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM" ? "foreign" : "dead";
	}
}

/**
 * Check if a process with the given PID is running.
 *
 * Uses `process.kill(pid, 0)` which doesn't actually send a signal,
 * but throws if the process doesn't exist.
 *
 * EPERM means the process exists but belongs to another user: alive, and still
 * reported as alive (O3). Callers that also care WHOSE it is ask
 * {@link pidOwnership} instead.
 */
export function isProcessRunning(pid: number): boolean {
	return pidOwnership(pid) !== "dead";
}

/** This process's uid, or null off POSIX where the concept does not exist. */
export function currentUid(): number | null {
	return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Whether a directory entry belongs to this uid. Always true off POSIX. */
function ownedByUs(info: Stats, uid: number | null): boolean {
	return uid === null || info.uid === uid;
}

/** Whether a file has sat untouched long enough to count as debris. */
function olderThanGrace(info: Stats, now: number): boolean {
	return now - info.mtimeMs > DEBRIS_GRACE_MS;
}

/** Epoch milliseconds at which this machine booted. */
function bootEpochMs(): number {
	return Date.now() - uptime() * 1000;
}

/**
 * A lock recording a process that started before this machine last booted.
 *
 * This is the answer to "bound readable-pid locks" (R35-ALWAYS.4). The two
 * candidates were recording the owner's start time and comparing it, or putting a
 * blanket age bound on readable-pid locks. **A blanket age bound is rejected**: a
 * draht session legitimately runs for days, and reaping a live session's lock is
 * worse than the leak it cures — the id becomes claimable while the socket is
 * still bound, and two processes end up appending to one session JSONL.
 *
 * So the lock carries the owning process's start time as a 4th line, and the only
 * comparison made is the one that cannot produce a false positive on a live
 * session: nothing running now started before the last boot. That covers the
 * dominant real-world source of pid recycling — a reboot recycles every pid at
 * once, which is how a lock naming pid 1 comes to poison a session id forever.
 *
 * Line 3 (the ISO creation time) is used when line 4 is absent, so the locks
 * already on disk from older builds are covered too. Old 3-line locks still parse:
 * the length floor stays at 3.
 *
 * NOT covered: a same-uid pid recycled without a reboot. That needs the owner's
 * real start time from the OS, which costs a subprocess per lock on a path that
 * runs on every fleet read.
 */
function lockIsPreBootDebris(lock: ParsedLock, bootMs: number): boolean {
	return lock.startedAtMs !== null && lock.startedAtMs < bootMs - PRE_BOOT_SLACK_MS;
}

interface ParsedLock {
	pid: number;
	cwd: string;
	createdAt: Date;
	/** Owner's process start time in epoch ms, from line 4, or line 3 as a floor. */
	startedAtMs: number | null;
}

/** Parse a lock file's contents, or null when it says nothing trustworthy. */
function parseLock(contents: string): ParsedLock | null {
	const lines = contents.trim().split("\n");
	// Three lines is still the contract. A 4th line is additive; a build that does
	// not write one is read exactly as before.
	if (lines.length < 3) return null;
	const pid = Number.parseInt(lines[0], 10);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const createdAt = new Date(lines[2]);
	const fromLine4 = lines.length >= 4 ? Number.parseInt(lines[3], 10) : Number.NaN;
	const startedAtMs = Number.isFinite(fromLine4)
		? fromLine4
		: Number.isFinite(createdAt.getTime())
			? createdAt.getTime()
			: null;
	return { pid, cwd: lines[1], createdAt, startedAtMs };
}

/** Read and parse a lock file, or null when it is missing or half-written. */
async function readLock(lockPath: string): Promise<ParsedLock | null> {
	try {
		return parseLock(await readFile(lockPath, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * Discover all running socket-based sessions.
 *
 * Scans the socket directory for .sock files and reads their corresponding
 * .lock files to extract metadata (PID, cwd, createdAt).
 *
 * Only sessions belonging to this uid are returned, and reaping follows the rules
 * at the top of this file: dead-owner pairs, pre-boot locks, lockless sockets and
 * non-socket `<id>.sock` files go; anything foreign, fresh, or unreadable stays.
 *
 * @param socketDir - Directory containing socket files
 * @returns Array of discovered session info
 */
export async function discoverSocketSessions(socketDir: string): Promise<SocketSessionInfo[]> {
	if (!existsSync(socketDir)) {
		return [];
	}

	const sessions: SocketSessionInfo[] = [];
	const uid = currentUid();
	const now = Date.now();
	const bootMs = bootEpochMs();

	try {
		const entries = await readdir(socketDir);
		const sessionIdsWithSocket = new Set<string>();

		for (const entry of entries) {
			// Only process .sock files
			if (!entry.endsWith(".sock")) continue;

			const sessionId = entry.slice(0, -".sock".length);
			if (sessionId.length === 0) continue;
			const socketPath = path.join(socketDir, entry);
			const lockPath = path.join(socketDir, `${sessionId}.lock`);

			// lstat, not stat: a symlink named `<id>.sock` is not a socket we published,
			// and following it would let something outside the directory decide what this
			// scan sees.
			let socketInfo: Stats;
			try {
				socketInfo = await lstat(socketPath);
			} catch {
				continue;
			}

			if (!socketInfo.isSocket()) {
				// Debris class (ii): a regular file (or symlink) wearing a .sock name.
				// Neither reader could ever remove one before. Directories are left alone —
				// removing a tree is not this function's business.
				if (!socketInfo.isDirectory() && ownedByUs(socketInfo, uid) && olderThanGrace(socketInfo, now)) {
					await reapStaleSession(socketPath);
				}
				// Deliberately NOT added to sessionIdsWithSocket: this id has no socket, so
				// its lock belongs to the orphan sweep below. Shielding it here (the old
				// behaviour, and the drift from geist-core) is what made class (ii) immortal.
				continue;
			}

			// O1: another user's socket is not ours to list, dial, or delete.
			if (!ownedByUs(socketInfo, uid)) continue;

			sessionIdsWithSocket.add(sessionId);

			let lockInfo: Stats | null;
			try {
				lockInfo = await lstat(lockPath);
			} catch {
				lockInfo = null;
			}

			if (lockInfo === null) {
				// Debris class (i): a socket with no lock. Never a normal transient — the
				// lock is claimed before the bind, and teardown removes the socket first.
				if (olderThanGrace(socketInfo, now)) await reapStaleSession(socketPath);
				continue;
			}
			// A lock that is not a plain file, or is not ours, is not evidence about a
			// session of ours. Left strictly alone.
			if (!lockInfo.isFile() || !ownedByUs(lockInfo, uid)) continue;

			const lock = await readLock(lockPath);
			// Unreadable or half-written: ownership unknown, never guess.
			if (!lock) continue;

			const ownership = pidOwnership(lock.pid);
			if (ownership === "dead" || lockIsPreBootDebris(lock, bootMs)) {
				await reapStaleSession(socketPath, lockPath);
				continue;
			}
			// Alive, but another user's process: never listed (O1), never reaped (O2).
			if (ownership === "foreign") continue;

			sessions.push({
				sessionId,
				socketPath,
				pid: lock.pid,
				cwd: lock.cwd,
				createdAt: lock.createdAt,
			});
		}

		await reapOrphanedLocks(socketDir, entries, sessionIdsWithSocket, uid, bootMs);
	} catch {
		// Directory not readable - return empty
		return [];
	}

	return sessions;
}

/**
 * Remove the files of a session that can never accept a connection again.
 *
 * Best effort: a concurrent reaper or a permission problem must never turn a
 * discovery call into a failure.
 */
async function reapStaleSession(...paths: string[]): Promise<void> {
	for (const target of paths) {
		try {
			await rm(target, { force: true });
		} catch {}
	}
}

/**
 * Remove `.lock` files whose `.sock` is already gone and whose owner is provably
 * gone with it.
 *
 * Such locks are invisible to the `.sock` scan above, so without this they accumulate
 * forever. A lock with no socket is also the normal state for a moment during startup -
 * the lock is claimed before the socket is bound - so a lock whose PID is alive, or
 * whose PID cannot be read at all, is always left alone. A lock belonging to another
 * uid, or naming another user's live process, is left alone too (O1, O2).
 */
async function reapOrphanedLocks(
	socketDir: string,
	entries: string[],
	sessionIdsWithSocket: Set<string>,
	uid: number | null,
	bootMs: number,
): Promise<void> {
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		if (sessionIdsWithSocket.has(entry.slice(0, -".lock".length))) continue;

		const lockPath = path.join(socketDir, entry);
		try {
			const info = await lstat(lockPath);
			if (!info.isFile() || !ownedByUs(info, uid)) continue;
			const lock = await readLock(lockPath);
			// Unreadable ownership: never guess, leave it alone.
			if (!lock) continue;
			const ownership = pidOwnership(lock.pid);
			if (ownership === "dead" || lockIsPreBootDebris(lock, bootMs)) {
				await rm(lockPath, { force: true });
			}
		} catch {}
	}
}
