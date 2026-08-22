/**
 * Fleet projection off the draht attach contract (R32-FLEET.1, R32-FLEET.2).
 *
 * A running `draht --attachable` publishes exactly two files per session under
 * `<agent dir>/sockets/`:
 *
 *   `<id>.sock`  a Unix domain socket, mode 0600, inside a 0700 directory
 *   `<id>.lock`  three newline-separated lines: pid, cwd, ISO creation time
 *
 * That pair IS the contract. This module reads it and nothing else — no
 * `@draht/coding-agent` import, no kernel import — because the boundary gate
 * forbids them from `packages/geist-core` and Phase 38 has to be able to move
 * the host out from under this code without moving the code
 * (`scripts/check-geist-boundary.mjs`, R31-FOUND.4).
 *
 * Deliberately duplicated rather than shared: `discoverSocketSessions()` in
 * `coding-agent/src/core/socket-server/discovery.ts` reads the same two files.
 * The duplication is the price of the boundary, and `check:geist-protocol`'s
 * mirror clause is what keeps the two readings from drifting.
 *
 * Everything here is synchronous. A fleet read happens on an HTTP request and
 * on every `hello`; it touches a handful of small files in one directory, and a
 * synchronous read cannot interleave with a concurrent reaper mid-scan.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, type Stats } from "node:fs";
import { homedir, uptime } from "node:os";
import { join } from "node:path";
import type { AttachableSession, FleetFrame } from "@draht/geist-protocol";

/**
 * The environment variable the draht binary itself reads to relocate its agent
 * directory (`coding-agent/src/config.ts`'s `ENV_AGENT_DIR`). Named here as a
 * string because importing it would cross the boundary; a test that points a
 * spawned draht and a daemon at one temp directory is what proves the two
 * spellings agree.
 */
export const AGENT_DIR_ENV = "DRAHT_CODING_AGENT_DIR";

/** Directory name the agent directory holds its session sockets in. */
export const SOCKETS_DIR_NAME = "sockets";

/**
 * Where this machine's attachable sessions publish themselves.
 *
 * @param env - Environment to read. Defaults to this process's.
 */
export function resolveSocketDir(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = env[AGENT_DIR_ENV];
	if (agentDir) return join(agentDir, SOCKETS_DIR_NAME);
	const home = env.HOME ?? homedir();
	return join(home, ".draht", "agent", SOCKETS_DIR_NAME);
}

/**
 * How long a file has to sit untouched before it counts as debris rather than as
 * a transient another starter is in the middle of creating. Mirrors
 * `UNWRITTEN_LOCK_STALE_MS` / `DEBRIS_GRACE_MS` on the coding-agent side.
 */
const DEBRIS_GRACE_MS = 10_000;

/** Slack on the boot comparison. See the coding-agent mirror for the reasoning. */
const PRE_BOOT_SLACK_MS = 300_000;

/** What this process may do about the process a lock names. */
type PidOwnership = "ours" | "foreign" | "dead";

/**
 * Who owns the process a lock names.
 *
 * `kill(pid, 0)` sends no signal; it only asks whether the pid could be
 * signalled. `EPERM` means the process exists but belongs to another user —
 * alive, and deliberately still reported as alive: reaping another user's session
 * would be both wrong and impossible. What EPERM also means, and what nothing
 * used to act on, is that the session is NOT OURS: a process this uid could have
 * started is always signallable by this uid. Without that distinction a lock
 * naming root's pid 1 is listed as a live attachable session of ours and the
 * bridge dials it.
 */
function pidOwnership(pid: number): PidOwnership {
	if (!Number.isInteger(pid) || pid <= 0) return "dead";
	try {
		process.kill(pid, 0);
		return "ours";
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM" ? "foreign" : "dead";
	}
}

/** This process's uid, or null off POSIX where the concept does not exist. */
function currentUid(): number | null {
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

/**
 * A lock recording a process that started before this machine last booted.
 *
 * Nothing running now started before the last boot, so such a lock is provably
 * debris however alive its pid looks. This is the bound on readable-pid locks: a
 * blanket age bound is rejected because a draht session legitimately runs for
 * days and reaping a live session's lock is worse than the leak it cures. The
 * time comes from the lock's 4th line (the owner's process start time) when the
 * writing build recorded one, and from line 3 otherwise, so locks already on disk
 * are covered too.
 */
function isPreBootDebris(startedAtMs: number | null, bootMs: number): boolean {
	return startedAtMs !== null && startedAtMs < bootMs - PRE_BOOT_SLACK_MS;
}

/** Best-effort removal: a concurrent reaper must never fail a fleet read. */
function reap(...paths: string[]): void {
	for (const path of paths) {
		try {
			rmSync(path, { force: true });
		} catch {
			// Another reaper got there first, or the directory is read-only.
		}
	}
}

/**
 * One `<id>.lock`, parsed, or `null` when its ownership cannot be established.
 *
 * "Cannot be established" is not the same as "dead": a lock that is truncated,
 * unreadable, or whose first line is not a pid is left strictly alone, because
 * a lock is written in two steps and a lock being claimed right now looks
 * exactly like debris.
 */
function readLock(
	lockPath: string,
): { pid: number; cwd: string; startedAt: string; startedAtMs: number | null } | null {
	let contents: string;
	try {
		contents = readFileSync(lockPath, "utf-8");
	} catch {
		return null;
	}
	const lines = contents.trim().split("\n");
	// Three lines is still the whole contract; the 4th is additive and optional, so
	// a lock written by a build that predates it reads exactly as it always did.
	if (lines.length < 3) return null;
	const pid = Number.parseInt(lines[0] ?? "", 10);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const cwd = lines[1] ?? "";
	const startedAt = lines[2] ?? "";
	if (cwd.length === 0 || startedAt.length === 0) return null;
	const fromLine4 = lines.length >= 4 ? Number.parseInt(lines[3] ?? "", 10) : Number.NaN;
	const parsedStartedAt = Date.parse(startedAt);
	const startedAtMs = Number.isFinite(fromLine4)
		? fromLine4
		: Number.isFinite(parsedStartedAt)
			? parsedStartedAt
			: null;
	return { pid, cwd, startedAt, startedAtMs };
}

/**
 * Every live attachable draht session **of this user** on this machine.
 *
 * A session appears only when all of these hold: `<id>.sock` really is a socket
 * owned by this uid, `<id>.lock` is a plain file owned by this uid and parses,
 * and its pid is alive AND signallable by us. Ordering is by id so two reads of
 * one fleet never disagree.
 *
 * ── WHAT IS REAPED ON THE WAY PAST, AND WHAT IS NOT (R35-ALWAYS.3/.4) ─────────
 *
 * Reaped: a pair whose owner is dead; a pair whose lock records a process that
 * started before the last boot; a `<id>.sock` with no `<id>.lock`; a `<id>.sock`
 * that is not a socket at all; a `.lock` with no `.sock` whose owner is gone. The
 * middle two used to be immortal — both readers `continue`d past them without
 * reaping, and two such orphans had been sitting in the real
 * `~/.draht/agent/sockets` since 2026-08-21 — so any count of leftover files was
 * measuring a directory that was already leaking.
 *
 * NOT reaped, ever, from here: anything belonging to another uid, and any lock
 * naming another user's live process. A read that runs on an HTTP request must
 * not destroy what it cannot interpret; `SocketServer.start()` is the one place
 * allowed to remove those, and only after it has asserted the directory is ours.
 *
 * This must stay identical to `discoverSocketSessions()` in
 * `coding-agent/src/core/socket-server/discovery.ts`. The protocol mirror gate
 * covers relayed frames only — not one line of this — and the two had already
 * drifted: that reader used to add an id to its "has a socket" set before it had
 * established the entry was a socket, which shielded the lock of a non-socket
 * `<id>.sock` from the orphan sweep and is precisely why that class never died.
 *
 * @param socketDir - Directory to scan. See {@link resolveSocketDir}.
 */
export function listAttachableSessions(socketDir: string): AttachableSession[] {
	if (!existsSync(socketDir)) return [];

	let entries: string[];
	try {
		entries = readdirSync(socketDir);
	} catch {
		// Unreadable directory: report an empty fleet rather than failing the
		// request that asked for it.
		return [];
	}

	const sessions: AttachableSession[] = [];
	const withSocket = new Set<string>();
	const uid = currentUid();
	const now = Date.now();
	const bootMs = now - uptime() * 1000;

	for (const entry of entries) {
		if (!entry.endsWith(".sock")) continue;
		const id = entry.slice(0, -".sock".length);
		if (id.length === 0) continue;
		const socketPath = join(socketDir, entry);
		const lockPath = join(socketDir, `${id}.lock`);

		// `lstatSync`, not `statSync`: a symlink named `<id>.sock` is not something a
		// draht published, and following it lets whatever it points at decide what
		// this scan sees.
		let socketInfo: Stats;
		try {
			socketInfo = lstatSync(socketPath);
		} catch {
			continue;
		}

		if (!socketInfo.isSocket()) {
			// A regular file (or symlink) wearing a `.sock` name. Directories are left
			// alone: removing a tree is not a fleet read's business.
			if (!socketInfo.isDirectory() && ownedByUs(socketInfo, uid) && olderThanGrace(socketInfo, now)) {
				reap(socketPath);
			}
			// Deliberately NOT added to `withSocket`: this id has no socket, so its lock
			// belongs to the orphan sweep below.
			continue;
		}

		// Another user's socket is not ours to list, dial, or delete.
		if (!ownedByUs(socketInfo, uid)) continue;

		withSocket.add(id);

		let lockInfo: Stats | null;
		try {
			lockInfo = lstatSync(lockPath);
		} catch {
			lockInfo = null;
		}

		if (lockInfo === null) {
			// A socket with no lock. Never a normal transient: the lock is claimed before
			// the bind, and teardown removes the socket before the lock.
			if (olderThanGrace(socketInfo, now)) reap(socketPath);
			continue;
		}
		// A lock that is not a plain file, or is not ours, is not evidence about a
		// session of ours. Left strictly alone.
		if (!lockInfo.isFile() || !ownedByUs(lockInfo, uid)) continue;

		const lock = readLock(lockPath);
		if (!lock) continue;

		const ownership = pidOwnership(lock.pid);
		if (ownership === "dead" || isPreBootDebris(lock.startedAtMs, bootMs)) {
			reap(socketPath, lockPath);
			continue;
		}
		// Alive, but not a process this user could have started: never listed, and
		// never reaped from here.
		if (ownership === "foreign") continue;

		sessions.push({
			id,
			cwd: lock.cwd,
			pid: lock.pid,
			startedAt: lock.startedAt,
			// ── STOP-GAP, OWNED BY THE STATUS TASK ────────────────────────────────
			// `geist/0.4` made these five fields REQUIRED on every session row, and a
			// frame without them fails validation at the bridge — the daemon closes
			// every connection at `hello`. They are filled here with what is literally
			// true of a row this scan produced, and nothing more:
			//   origin     'socket' — by construction; this function only reads sockets.
			//   attachable  true    — it was just proved live and same-owner.
			//   resumable   false   — you ATTACH to a live session. Resuming one would
			//                         start a second process appending to one session
			//                         JSONL, which is the hazard the busy lock exists
			//                         for. A history row is the resumable kind.
			//                         NOT a stop-gap, unlike its neighbours: this is the
			//                         ruling. `attachable` and `resumable` are the two
			//                         VERBS a renderer offers, and a renderer showing
			//                         "Resume" on a live row offers the wrong one. The
			//                         conformance corpus once froze `resumable: true`
			//                         here and has been regenerated to agree; the daemon
			//                         still answers `session_resume` on a live id with
			//                         `already_live`, but that refusal is defence in
			//                         depth, not the invitation's excuse.
			//   status/statusAt — no probe has run in this process, and `unknown` with
			//                         no timestamp is the honest way to say so. The
			//                         deadline-bounded quad-state probe replaces both.
			origin: "socket",
			attachable: true,
			resumable: false,
			status: "unknown",
			statusAt: null,
		});
	}

	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		const id = entry.slice(0, -".lock".length);
		if (withSocket.has(id)) continue;
		const lockPath = join(socketDir, entry);
		let lockInfo: Stats;
		try {
			lockInfo = lstatSync(lockPath);
		} catch {
			continue;
		}
		if (!lockInfo.isFile() || !ownedByUs(lockInfo, uid)) continue;
		const lock = readLock(lockPath);
		// Unreadable ownership: never guess, leave it alone.
		if (!lock) continue;
		// A live claimer of ours, or another user's live process: leave it alone.
		if (pidOwnership(lock.pid) !== "dead" && !isPreBootDebris(lock.startedAtMs, bootMs)) continue;
		reap(lockPath);
	}

	sessions.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	return sessions;
}

/**
 * Whether the two files behind a session id are both ours, right now.
 *
 * Split out so the bridge can restate the confinement at the moment it dials,
 * rather than trusting a list built earlier in the same request.
 */
export function sessionFilesAreOurs(socketDir: string, sessionId: string): boolean {
	const uid = currentUid();
	try {
		const socketInfo = lstatSync(join(socketDir, `${sessionId}.sock`));
		if (!socketInfo.isSocket() || !ownedByUs(socketInfo, uid)) return false;
		const lockInfo = lstatSync(join(socketDir, `${sessionId}.lock`));
		if (!lockInfo.isFile() || !ownedByUs(lockInfo, uid)) return false;
	} catch {
		return false;
	}
	return true;
}

/**
 * Identity of this observer run.
 *
 * `epoch` is deliberately not a clock: it says WHICH RUN a snapshot came from, so
 * a renderer that sees an epoch it has not seen knows to throw away what it holds
 * rather than trying to order two worlds against each other. One value per
 * process is the whole of the guarantee this module can make on its own — a
 * scanner with no continuity across restarts has exactly one epoch per run.
 */
const FLEET_EPOCH = randomUUID();

/** Monotonic within {@link FLEET_EPOCH}. */
let fleetSeq = 0;

/**
 * The fleet as a wire frame — the same body `GET /fleet` returns and the same
 * frame pushed after `hello`, so a renderer parses one shape either way.
 *
 * STOP-GAP, same owner as the fields above: `epoch`/`seq` became required in
 * `geist/0.4` for ordering snapshots against `fleet_delta`. Until the single
 * fleet observer exists there is no delta stream to order against, so `seq` is
 * simply the count of snapshots this process has emitted — monotonic, which is
 * all the schema claims, and honest about there being one scanner per read.
 */
export function buildFleetFrame(socketDir: string): FleetFrame {
	return { type: "fleet", sessions: listAttachableSessions(socketDir), epoch: FLEET_EPOCH, seq: fleetSeq++ };
}
