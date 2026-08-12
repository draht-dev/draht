import { mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendJournal } from "../src/journal.ts";
import { acquireLock, LockHeldError, readLockFile } from "../src/lock.ts";
import { lockPath } from "../src/paths.ts";
import {
	assertNoSymlinkPivot,
	assertSafeComponentId,
	assertSafeRelativePath,
	assertSafeTarget,
	SafetyError,
} from "../src/safety.ts";
import { createDefaultState, saveState } from "../src/state.ts";
import { tempRoot } from "./helpers/cli.ts";

const onPosix = process.platform !== "win32";

describe("component id validation", () => {
	it("accepts the shipped ids", () => {
		for (const id of ["claude-plugin", "codex-plugin", "coding-agent", "installer"]) {
			expect(() => assertSafeComponentId(id)).not.toThrow();
		}
	});

	it.each(["../escape", "/abs", "a/b", "..", ".", "", "UPPER", "trailing-", "with space", "nul\0byte"])(
		"rejects %j",
		(id) => {
			expect(() => assertSafeComponentId(id)).toThrow(SafetyError);
		},
	);
});

describe("payload path validation", () => {
	it("accepts ordinary nested relative paths", () => {
		for (const path of ["a.txt", "dir/file.md", "a/b/c/d.json"]) {
			expect(() => assertSafeRelativePath(path)).not.toThrow();
		}
	});

	it.each([
		"/etc/passwd",
		"../outside",
		"dir/../../outside",
		"C:\\Windows\\system32",
		"dir\\file",
		"",
		"./",
		"a//b",
		"nul\0byte",
		"a/../..",
	])("rejects %j", (path) => {
		expect(() => assertSafeRelativePath(path)).toThrow(SafetyError);
	});
});

describe("target directory validation", () => {
	const home = "/home/tester";
	const installRoot = "/home/tester/.draht/install";
	const bounds = { home, installRoot };

	it("accepts a payload target nested under the home directory", () => {
		expect(() => assertSafeTarget("/home/tester/.draht/claude-marketplace/plugins/draht", bounds)).not.toThrow();
	});

	it("rejects a relative target", () => {
		expect(() => assertSafeTarget(".draht/x", bounds)).toThrow(SafetyError);
	});

	it("rejects the home directory itself and the filesystem root", () => {
		expect(() => assertSafeTarget(home, bounds)).toThrow(SafetyError);
		expect(() => assertSafeTarget("/", bounds)).toThrow(SafetyError);
	});

	it("rejects a target outside the resolved home", () => {
		expect(() => assertSafeTarget("/etc/cron.d/draht", bounds)).toThrow(SafetyError);
		expect(() => assertSafeTarget("/home/someone-else/.draht/x", bounds)).toThrow(SafetyError);
	});

	it("rejects targeting the install root, anything inside it, and any parent of it", () => {
		expect(() => assertSafeTarget(installRoot, bounds)).toThrow(SafetyError);
		expect(() => assertSafeTarget(join(installRoot, "cache"), bounds)).toThrow(SafetyError);
		expect(() => assertSafeTarget("/home/tester/.draht", bounds)).toThrow(SafetyError);
	});

	it("rejects a traversal that normalizes back out of home", () => {
		expect(() => assertSafeTarget("/home/tester/../../etc", bounds)).toThrow(SafetyError);
	});
});

describe("symlink pivot detection", () => {
	it.runIf(onPosix)("rejects a target whose own path is a symlink", () => {
		const tmp = tempRoot("pivot");
		try {
			const home = join(tmp.path, "home");
			const real = join(tmp.path, "elsewhere");
			mkdirSync(home, { recursive: true });
			mkdirSync(real, { recursive: true });
			const target = join(home, "payload");
			symlinkSync(real, target);

			expect(() => assertNoSymlinkPivot(target, home)).toThrow(SafetyError);
		} finally {
			tmp.dispose();
		}
	});

	it.runIf(onPosix)("rejects a target reached through a symlinked parent directory", () => {
		const tmp = tempRoot("pivot");
		try {
			const home = join(tmp.path, "home");
			const real = join(tmp.path, "elsewhere");
			mkdirSync(join(home, "a"), { recursive: true });
			mkdirSync(join(real, "c"), { recursive: true });
			symlinkSync(real, join(home, "a", "b"));

			expect(() => assertNoSymlinkPivot(join(home, "a", "b", "c"), home)).toThrow(SafetyError);
		} finally {
			tmp.dispose();
		}
	});

	it("accepts a plain nested directory and a not-yet-existing leaf", () => {
		const tmp = tempRoot("pivot");
		try {
			const home = join(tmp.path, "home");
			mkdirSync(join(home, "a", "b"), { recursive: true });

			expect(() => assertNoSymlinkPivot(join(home, "a", "b"), home)).not.toThrow();
			expect(() => assertNoSymlinkPivot(join(home, "a", "b", "not-yet"), home)).not.toThrow();
		} finally {
			tmp.dispose();
		}
	});
});

describe("mutual exclusion lock", () => {
	it("creates a lock recording the owning process and releases it", () => {
		const tmp = tempRoot("lock");
		try {
			const lock = acquireLock(tmp.path);
			const record = readLockFile(tmp.path);

			expect(record?.pid).toBe(process.pid);
			expect(record?.hostname).toBe(hostname());

			lock.release();
			expect(readLockFile(tmp.path)).toBeNull();
		} finally {
			tmp.dispose();
		}
	});

	it("refuses a second concurrent acquisition", () => {
		const tmp = tempRoot("lock");
		try {
			const first = acquireLock(tmp.path);
			try {
				expect(() => acquireLock(tmp.path)).toThrow(LockHeldError);
			} finally {
				first.release();
			}
		} finally {
			tmp.dispose();
		}
	});

	it("refuses to auto-reclaim a lock whose owner process is gone", () => {
		const tmp = tempRoot("lock");
		try {
			writeFileSync(
				lockPath(tmp.path),
				`${JSON.stringify({ pid: 999_999, hostname: hostname(), startedAt: new Date().toISOString(), command: "install" })}\n`,
			);

			expect(() => acquireLock(tmp.path, { pidAlive: () => false })).toThrow(LockHeldError);
			expect(readLockFile(tmp.path)?.pid).toBe(999_999);
		} finally {
			tmp.dispose();
		}
	});

	it("refuses to take over a live owner even if the record looks old", () => {
		const tmp = tempRoot("lock");
		try {
			writeFileSync(
				lockPath(tmp.path),
				`${JSON.stringify({ pid: 999_999, hostname: hostname(), startedAt: "2000-01-01T00:00:00.000Z", command: "install" })}\n`,
			);

			expect(() => acquireLock(tmp.path, { pidAlive: () => true })).toThrow(LockHeldError);
		} finally {
			tmp.dispose();
		}
	});

	it("refuses a lock held by another machine, whose liveness it cannot verify", () => {
		const tmp = tempRoot("lock");
		try {
			writeFileSync(
				lockPath(tmp.path),
				`${JSON.stringify({ pid: process.pid, hostname: "some-other-host", startedAt: new Date().toISOString(), command: "install" })}\n`,
			);

			expect(() => acquireLock(tmp.path, { pidAlive: () => false })).toThrow(LockHeldError);
		} finally {
			tmp.dispose();
		}
	});

	it("refuses a corrupt lock instead of assuming it is stale", () => {
		const tmp = tempRoot("lock");
		try {
			writeFileSync(lockPath(tmp.path), "{not json");

			expect(() => acquireLock(tmp.path, { pidAlive: () => false })).toThrow(LockHeldError);
		} finally {
			tmp.dispose();
		}
	});

	it("is re-acquirable after release", () => {
		const tmp = tempRoot("lock");
		try {
			acquireLock(tmp.path).release();
			const second = acquireLock(tmp.path);
			expect(readLockFile(tmp.path)?.pid).toBe(process.pid);
			second.release();
		} finally {
			tmp.dispose();
		}
	});

	it("does not delete a replacement lock owned by a different token", () => {
		const tmp = tempRoot("lock");
		try {
			const first = acquireLock(tmp.path);
			const directory = lockPath(tmp.path);
			const originalOwner = join(directory, readdirSync(directory)[0]);
			rmSync(originalOwner);
			const replacement = { ...first.record, token: "replacement-owner-token", command: "update" };
			writeFileSync(join(directory, `owner-${replacement.token}.json`), `${JSON.stringify(replacement)}\n`);

			first.release();

			expect(readLockFile(tmp.path)).toEqual(replacement);
		} finally {
			tmp.dispose();
		}
	});
});

describe("state directory privacy", () => {
	it.runIf(onPosix)("keeps the install root, state, journal and lock user-private", () => {
		const tmp = tempRoot("perms");
		try {
			const root = join(tmp.path, "install");
			saveState(root, createDefaultState());
			appendJournal(root, { tx: "tx-1", seq: 1, at: new Date().toISOString(), event: "planned" });
			const lock = acquireLock(root);

			// eslint-disable-next-line no-bitwise -- POSIX mode bits are a bitfield.
			const mode = (path: string) => statSync(path).mode & 0o777;

			expect(mode(root)).toBe(0o700);
			expect(mode(join(root, "state.json"))).toBe(0o600);
			expect(mode(join(root, "journal.jsonl"))).toBe(0o600);
			expect(mode(lockPath(root))).toBe(0o700);
			const owner = join(lockPath(root), readdirSync(lockPath(root))[0]);
			expect(mode(owner)).toBe(0o600);

			lock.release();
		} finally {
			tmp.dispose();
		}
	});
});
