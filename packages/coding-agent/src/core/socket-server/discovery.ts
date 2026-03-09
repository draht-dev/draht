/**
 * Socket Session Discovery
 *
 * Scans the sockets directory to find all running attachable sessions.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SocketSessionInfo } from "./types.js";

/**
 * Discover all running socket-based sessions.
 *
 * Scans the socket directory for .sock files and reads their corresponding
 * .lock files to extract metadata (PID, cwd, createdAt).
 *
 * Filters out stale sessions (PID no longer running).
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

		for (const entry of entries) {
			// Only process .sock files
			if (!entry.endsWith(".sock")) continue;

			const sessionId = entry.replace(/\.sock$/, "");
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
					// Stale socket - skip it (cleanup could be done here)
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
	} catch {
		// Directory not readable - return empty
		return [];
	}

	return sessions;
}

/**
 * Check if a process with the given PID is running.
 *
 * Uses `process.kill(pid, 0)` which doesn't actually send a signal,
 * but throws if the process doesn't exist.
 */
function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
