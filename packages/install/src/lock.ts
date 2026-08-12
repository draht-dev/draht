import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { z } from "zod";
import { CliError } from "./errors.ts";
import { lockPath } from "./paths.ts";

export const LockRecordSchema = z.object({
	pid: z.number().int().positive(),
	hostname: z.string().min(1),
	startedAt: z.string().min(1),
	command: z.string().min(1),
});
export type LockRecord = z.infer<typeof LockRecordSchema>;

/** Raised when another invocation owns the lock, or when ownership cannot be established safely. */
export class LockHeldError extends CliError {
	constructor(message: string, detail?: Record<string, unknown>) {
		super("lock-held", message, { exitCode: 3, detail });
		this.name = "LockHeldError";
	}
}

export interface LockHandle {
	path: string;
	record: LockRecord;
	/** Removes the lock. Safe to call more than once. */
	release: () => void;
}

export interface AcquireLockOptions {
	/** Which command is taking the lock — recorded so a held-lock message can say what is running. */
	command?: string;
	/** Liveness probe for the recorded owner pid. Injected so stale-owner handling is testable. */
	pidAlive?: (pid: number) => boolean;
}

/** Signal-0 liveness probe. `EPERM` means the process exists but belongs to another user — still alive. */
function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Reads the lock record, or `null` when there is no lock. Returns `null` for an unreadable file too — callers treat that as "present but unknown". */
export function readLockFile(root: string): LockRecord | null {
	const path = lockPath(root);
	if (!existsSync(path)) return null;
	try {
		const parsed = LockRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Whether a lock file exists at all, regardless of whether it parses. */
export function lockFileExists(root: string): boolean {
	return existsSync(lockPath(root));
}

function writeLock(path: string, record: LockRecord): void {
	// `wx` fails with EEXIST rather than truncating, which is what makes this an
	// atomic create-or-fail on every filesystem the engine targets.
	const fd = openSync(path, "wx", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(record)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Takes the engine's single mutual-exclusion lock for the duration of a
 * mutating command.
 *
 * Contention handling is deliberately conservative. A live owner is refused. A
 * lock written by a *different machine* is refused, because this process
 * cannot ask whether a pid on another host is alive — a shared home directory
 * over a network filesystem is exactly where a wrong guess corrupts an
 * install. A lock that does not parse is refused rather than assumed stale:
 * doctor reports it, and removing it is an explicit human decision. Only a
 * same-host lock whose owner pid is provably gone is reported as stale but is
 * not removed automatically: portable Node filesystem APIs offer no atomic
 * compare-and-delete, so reclaiming it could delete a new owner's lock.
 */
export function acquireLock(root: string, options: AcquireLockOptions = {}): LockHandle {
	const { command = "install", pidAlive = defaultPidAlive } = options;
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const path = lockPath(root);
	const record: LockRecord = {
		pid: process.pid,
		hostname: hostname(),
		startedAt: new Date().toISOString(),
		command,
	};

	try {
		writeLock(path, record);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

		const existing = readLockFile(root);
		if (!existing) {
			throw new LockHeldError(
				`another draht-install invocation may be running: the lock at ${path} is unreadable. Inspect it, and remove it only if no draht-install process is running.`,
				{ lock: path },
			);
		}
		if (existing.hostname !== record.hostname) {
			throw new LockHeldError(
				`the lock at ${path} is held by pid ${existing.pid} on host "${existing.hostname}"; this host cannot verify whether that process is still running`,
				{ lock: path, owner: existing },
			);
		}
		if (pidAlive(existing.pid)) {
			throw new LockHeldError(
				`another draht-install invocation (pid ${existing.pid}, command "${existing.command}", started ${existing.startedAt}) is already applying changes`,
				{ lock: path, owner: existing },
			);
		}

		throw new LockHeldError(
			`the lock at ${path} belongs to same-host pid ${existing.pid}, which is no longer running. Automatic removal is refused because another invocation may have replaced it; inspect the record and remove it only while no draht-install process is running`,
			{ lock: path, owner: existing, stale: true },
		);
	}

	let released = false;
	return {
		path,
		record,
		release: () => {
			if (released) return;
			released = true;
			// Only remove a lock this handle still owns: if a stale-takeover
			// replaced it, deleting it would release someone else's lock.
			const current = readLockFile(root);
			if (current && current.pid === record.pid && current.startedAt === record.startedAt) {
				rmSync(path, { force: true });
			}
		},
	};
}
