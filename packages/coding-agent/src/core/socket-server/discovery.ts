/**
 * Socket Session Discovery
 *
 * Scans the sockets directory to find all running attachable sessions.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { SocketSessionInfo } from "./types.js";

/**
 * Discover all running socket-based sessions.
 *
 * Scans the socket directory for .sock files and reads their corresponding
 * .lock files to extract metadata (PID, cwd, createdAt).
 *
 * Sessions whose lock file names a dead PID are stale: nothing can ever accept a
 * connection on that socket again. Discovery reaps those `.sock`/`.lock` pairs instead
 * of leaving them to accumulate forever, and also reaps `.lock` files whose `.sock` is
 * already gone and whose owner is dead. Files belonging to a live PID, and files whose
 * lock is missing or unreadable (ownership unknown), are never touched.
 *
 * @param socketDir - Directory containing socket files
 * @returns Array of discovered session info
 */
export async function discoverSocketSessions(socketDir: string): Promise<SocketSessionInfo[]> {
	if (!existsSync(socketDir)) {
		return [];
	}

	const sessions: SocketSessionInfo[] = [];

	try {
		const entries = await readdir(socketDir);
		const sessionIdsWithSocket = new Set<string>();

		for (const entry of entries) {
			// Only process .sock files
			if (!entry.endsWith(".sock")) continue;

			const sessionId = entry.replace(/\.sock$/, "");
			sessionIdsWithSocket.add(sessionId);
			const socketPath = path.join(socketDir, entry);
			const lockPath = path.join(socketDir, `${sessionId}.lock`);

			// Check if socket file exists and is a socket
			try {
				const stats = await stat(socketPath);
				if (!stats.isSocket()) continue;
			} catch {
				continue;
			}

			// Read lock file for metadata
			if (!existsSync(lockPath)) continue;

			try {
				const lockContent = await readFile(lockPath, "utf-8");
				const lines = lockContent.trim().split("\n");

				if (lines.length < 3) continue;

				const pid = Number.parseInt(lines[0], 10);
				const cwd = lines[1];
				const createdAt = new Date(lines[2]);

				// Verify PID is still running
				if (!isProcessRunning(pid)) {
					await reapStaleSession(socketPath, lockPath);
					continue;
				}

				sessions.push({
					sessionId,
					socketPath,
					pid,
					cwd,
					createdAt,
				});
			} catch {}
		}

		await reapOrphanedLocks(socketDir, entries, sessionIdsWithSocket);
	} catch {
		// Directory not readable - return empty
		return [];
	}

	return sessions;
}

/**
 * Remove the socket and lock file of a session whose owning process is gone.
 *
 * Best effort: a concurrent reaper or a permission problem must never turn a
 * discovery call into a failure.
 */
async function reapStaleSession(socketPath: string, lockPath: string): Promise<void> {
	try {
		await rm(socketPath, { force: true });
		await rm(lockPath, { force: true });
	} catch {}
}

/**
 * Remove `.lock` files whose `.sock` is already gone and whose owner is provably dead.
 *
 * Such locks are invisible to the `.sock` scan above, so without this they accumulate
 * forever. A lock with no socket is also the normal state for a moment during startup -
 * the lock is claimed before the socket is bound - so a lock whose PID is alive, or
 * whose PID cannot be read at all, is always left alone.
 */
async function reapOrphanedLocks(
	socketDir: string,
	entries: string[],
	sessionIdsWithSocket: Set<string>,
): Promise<void> {
	for (const entry of entries) {
		if (!entry.endsWith(".lock")) continue;
		if (sessionIdsWithSocket.has(entry.replace(/\.lock$/, ""))) continue;

		const lockPath = path.join(socketDir, entry);
		try {
			const lockContent = await readFile(lockPath, "utf-8");
			const pid = Number.parseInt(lockContent.trim().split("\n")[0], 10);
			// Unreadable ownership: never guess, leave it alone.
			if (!Number.isInteger(pid)) continue;
			if (isProcessRunning(pid)) continue;
			await rm(lockPath, { force: true });
		} catch {}
	}
}

/**
 * Check if a process with the given PID is running.
 *
 * Uses `process.kill(pid, 0)` which doesn't actually send a signal,
 * but throws if the process doesn't exist.
 */
export function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}
