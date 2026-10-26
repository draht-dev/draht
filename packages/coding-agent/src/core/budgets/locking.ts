import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_WAIT_MS = 15_000;
/** Recovery takes moments, so a recovery marker this old was left by a process that died while recovering. */
const STALE_RECOVERY_MS = 30_000;

interface LockOwner {
	pid: number;
	boot: string;
	namespace: string;
	id: string;
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

let host: Pick<LockOwner, "boot" | "namespace"> | undefined;

/** Boot and PID-namespace identity; both are empty where the platform has no /proc. */
function hostIdentity(): Pick<LockOwner, "boot" | "namespace"> {
	const read = (value: () => string) => {
		try {
			return value().trim();
		} catch {
			return "";
		}
	};
	host ??= {
		boot: read(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8")),
		namespace: read(() => readlinkSync("/proc/self/ns/pid")),
	};
	return host;
}

function readOwner(lock: string): string | undefined {
	try {
		return readFileSync(join(lock, "owner"), "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
}

function parseOwner(owner: string): LockOwner | undefined {
	try {
		const value: unknown = JSON.parse(owner);
		if (
			typeof value !== "object" ||
			value === null ||
			!("pid" in value) ||
			!("boot" in value) ||
			!("namespace" in value) ||
			!("id" in value) ||
			typeof value.pid !== "number" ||
			!Number.isSafeInteger(value.pid) ||
			value.pid < 1 ||
			typeof value.boot !== "string" ||
			typeof value.namespace !== "string" ||
			typeof value.id !== "string"
		) {
			return undefined;
		}
		return { pid: value.pid, boot: value.boot, namespace: value.namespace, id: value.id };
	} catch {
		return undefined;
	}
}

/** An owner counts as dead only when this process can tell: the machine rebooted, or its PID left our namespace. */
function ownerIsDead(owner: string): boolean {
	const parsed = parseOwner(owner);
	if (!parsed) return false;
	const current = hostIdentity();
	if (parsed.boot && current.boot && parsed.boot !== current.boot) return true;
	if (parsed.namespace !== current.namespace) return false;
	try {
		process.kill(parsed.pid, 0);
		return false;
	} catch (error) {
		if (hasCode(error, "ESRCH")) return true;
		if (hasCode(error, "EPERM")) return false;
		throw error;
	}
}

function removeStaleRecovery(recovery: string): void {
	try {
		if (Date.now() - statSync(recovery).mtimeMs > STALE_RECOVERY_MS)
			rmSync(recovery, { recursive: true, force: true });
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function recoverDeadLock(lock: string): void {
	const recovery = `${lock}.recovery`;
	try {
		mkdirSync(recovery);
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
		removeStaleRecovery(recovery);
		return;
	}
	try {
		const owner = readOwner(lock);
		if (!owner || !ownerIsDead(owner) || readOwner(lock) !== owner) return;
		const removed = `${lock}.removed-${randomUUID()}`;
		renameSync(lock, removed);
		rmSync(removed, { recursive: true });
	} finally {
		rmSync(recovery, { recursive: true, force: true });
	}
}

export function withBudgetLock<T>(lock: string, action: () => T): T {
	const owner = JSON.stringify({ pid: process.pid, ...hostIdentity(), id: randomUUID() } satisfies LockOwner);
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			mkdirSync(lock);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			recoverDeadLock(lock);
			if (Date.now() >= deadline) throw new Error(`Budget task is locked: ${lock}`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
			continue;
		}
		try {
			writeFileSync(join(lock, "owner"), owner, { flag: "wx", mode: 0o600 });
		} catch (error) {
			rmSync(lock, { recursive: true });
			throw error;
		}
		break;
	}
	try {
		const result = action();
		if (readOwner(lock) !== owner) throw new Error("Budget task lock ownership changed");
		return result;
	} finally {
		if (readOwner(lock) === owner) rmSync(lock, { recursive: true });
	}
}
