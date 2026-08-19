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

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
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
 * Whether a process is alive.
 *
 * `kill(pid, 0)` sends no signal; it only asks whether the pid could be
 * signalled. `EPERM` means the process exists but belongs to another user —
 * alive, and deliberately reported as such: reaping another user's session
 * would be both wrong and impossible.
 */
function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
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
function readLock(lockPath: string): { pid: number; cwd: string; startedAt: string } | null {
	let contents: string;
	try {
		contents = readFileSync(lockPath, "utf-8");
	} catch {
		return null;
	}
	const lines = contents.trim().split("\n");
	if (lines.length < 3) return null;
	const pid = Number.parseInt(lines[0] ?? "", 10);
	if (!Number.isInteger(pid) || pid <= 0) return null;
	const cwd = lines[1] ?? "";
	const startedAt = lines[2] ?? "";
	if (cwd.length === 0 || startedAt.length === 0) return null;
	return { pid, cwd, startedAt };
}

/**
 * Every live attachable draht session on this machine.
 *
 * A session appears only when all three of these hold: `<id>.sock` really is a
 * socket, `<id>.lock` parses, and its pid is alive. A `.sock`/`.lock` pair whose
 * pid is dead is reaped on the way past — nothing can ever accept a connection
 * on that socket again — as is a `.lock` whose `.sock` is gone and whose owner
 * is provably dead. Ordering is by id so two reads of one fleet never disagree.
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

	for (const entry of entries) {
		if (!entry.endsWith(".sock")) continue;
		const id = entry.slice(0, -".sock".length);
		if (id.length === 0) continue;
		const socketPath = join(socketDir, entry);
		const lockPath = join(socketDir, `${id}.lock`);

		try {
			if (!statSync(socketPath).isSocket()) continue;
		} catch {
			continue;
		}
		withSocket.add(id);

		const lock = readLock(lockPath);
		if (!lock) continue;

		if (!isProcessAlive(lock.pid)) {
			reap(socketPath, lockPath);
			continue;
		}

		sessions.push({ id, cwd: lock.cwd, pid: lock.pid, startedAt: lock.startedAt });
	}

	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		const id = entry.slice(0, -".lock".length);
		if (withSocket.has(id)) continue;
		const lockPath = join(socketDir, entry);
		const lock = readLock(lockPath);
		// Unreadable ownership, or a live claimer: never guess, leave it alone.
		if (!lock || isProcessAlive(lock.pid)) continue;
		reap(lockPath);
	}

	sessions.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	return sessions;
}

/**
 * The fleet as a wire frame — the same body `GET /fleet` returns and the same
 * frame pushed after `hello`, so a renderer parses one shape either way.
 */
export function buildFleetFrame(socketDir: string): FleetFrame {
	return { type: "fleet", sessions: listAttachableSessions(socketDir) };
}
