/**
 * R32-FLEET.2 — the fleet projection reads the `<id>.sock` + `.lock` contract
 * directly.
 *
 * `discoverSocketSessions()` in `@draht/coding-agent` cannot be imported here:
 * `check-geist-boundary.mjs` forbids it, and that is the point (R32-FLEET.1).
 * So the contract is re-read against its documented shape, and
 * `check:geist-protocol`'s mirror clause is what keeps the two honest.
 *
 * Every case below builds a REAL Unix socket with `node:net` and a real lock
 * file — `stat().isSocket()` and `process.kill(pid, 0)` are the two predicates
 * under test, and neither can be exercised against a plain file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { listAttachableSessions, resolveSocketDir } from "../../src/attach/socket-sessions.js";

let socketDir: string;
const servers: Server[] = [];

/** A pid that is certainly not running: the kernel refuses to allocate it. */
const DEAD_PID = 0x7ffffffe;

beforeEach(() => {
	// Short prefix on purpose: a Unix socket path over ~104 bytes fails to bind
	// with EINVAL on macOS, and `os.tmpdir()` there is already 50 characters.
	socketDir = mkdtempSync("/tmp/geist-fleet-");
});

afterEach(() => {
	for (const server of servers) server.close();
	servers.length = 0;
	rmSync(socketDir, { recursive: true, force: true });
});

/** Bind a real Unix socket at `<id>.sock` and write the `<id>.lock` beside it. */
async function makeSession(
	id: string,
	lock: { pid?: number | string; cwd?: string; startedAt?: string; raw?: string } = {},
): Promise<void> {
	const server = createServer();
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(join(socketDir, `${id}.sock`), resolve);
	});
	writeLock(id, lock);
}

function writeLock(
	id: string,
	lock: { pid?: number | string; cwd?: string; startedAt?: string; raw?: string } = {},
): void {
	const contents =
		lock.raw ??
		`${lock.pid ?? process.pid}\n${lock.cwd ?? "/work/repo"}\n${lock.startedAt ?? "2026-08-18T10:00:00.000Z"}`;
	writeFileSync(join(socketDir, `${id}.lock`), contents, { mode: 0o600 });
}

describe("resolveSocketDir", () => {
	test("honours DRAHT_CODING_AGENT_DIR, the same variable the draht binary reads", () => {
		expect(resolveSocketDir({ DRAHT_CODING_AGENT_DIR: "/tmp/agent-dir" })).toBe("/tmp/agent-dir/sockets");
	});

	test("falls back to ~/.draht/agent/sockets", () => {
		const resolved = resolveSocketDir({ HOME: "/home/someone" });
		expect(resolved.endsWith("/.draht/agent/sockets")).toBe(true);
	});
});

describe("listAttachableSessions", () => {
	test("a directory that does not exist is an empty fleet, not a failure", () => {
		expect(listAttachableSessions(join(socketDir, "missing"))).toEqual([]);
	});

	test("lists a live session with the four fields the lock contract knows", async () => {
		await makeSession("alpha", { cwd: "/work/alpha", startedAt: "2026-08-18T09:00:00.000Z" });

		expect(listAttachableSessions(socketDir)).toEqual([
			{ id: "alpha", cwd: "/work/alpha", pid: process.pid, startedAt: "2026-08-18T09:00:00.000Z" },
		]);
	});

	test("is ordered by id, so two reads of one fleet never disagree", async () => {
		await makeSession("charlie");
		await makeSession("alpha");
		await makeSession("bravo");

		expect(listAttachableSessions(socketDir).map((session) => session.id)).toEqual(["alpha", "bravo", "charlie"]);
	});

	test("a dead pid never appears, and its .sock and .lock are reaped", async () => {
		await makeSession("ghost", { pid: DEAD_PID });

		expect(listAttachableSessions(socketDir)).toEqual([]);
		expect(existsSync(join(socketDir, "ghost.sock"))).toBe(false);
		expect(existsSync(join(socketDir, "ghost.lock"))).toBe(false);
	});

	test("a live session beside a dead one still lists", async () => {
		await makeSession("ghost", { pid: DEAD_PID });
		await makeSession("live", { cwd: "/work/live" });

		expect(listAttachableSessions(socketDir).map((session) => session.id)).toEqual(["live"]);
	});

	test("an orphan .lock with a dead pid is reaped; one with a live pid is left alone", () => {
		writeLock("orphan-dead", { pid: DEAD_PID });
		writeLock("orphan-live");

		expect(listAttachableSessions(socketDir)).toEqual([]);
		expect(existsSync(join(socketDir, "orphan-dead.lock"))).toBe(false);
		// A lock with no socket is also the normal state for the instant between
		// claiming the lock and binding the socket — reaping a live claim would
		// hand one session id to two processes.
		expect(existsSync(join(socketDir, "orphan-live.lock"))).toBe(true);
	});

	test("a lock whose ownership cannot be read is skipped, never reaped", async () => {
		await makeSession("garbled", { raw: "not-a-pid\n/work\n2026-08-18T09:00:00.000Z" });

		expect(listAttachableSessions(socketDir)).toEqual([]);
		expect(existsSync(join(socketDir, "garbled.lock"))).toBe(true);
		expect(existsSync(join(socketDir, "garbled.sock"))).toBe(true);
	});

	test("a truncated lock is skipped", async () => {
		await makeSession("short", { raw: `${process.pid}\n/work` });

		expect(listAttachableSessions(socketDir)).toEqual([]);
	});

	test("a .sock that is a plain file is not a session", () => {
		writeFileSync(join(socketDir, "fake.sock"), "");
		writeLock("fake");

		expect(listAttachableSessions(socketDir)).toEqual([]);
	});

	test("a socket with no lock beside it is not a session", async () => {
		const server = createServer();
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(join(socketDir, "unlocked.sock"), resolve));

		expect(listAttachableSessions(socketDir)).toEqual([]);
	});

	test("a nested directory ending in .sock cannot masquerade as a session", () => {
		mkdirSync(join(socketDir, "dir.sock"));
		writeLock("dir");

		expect(listAttachableSessions(socketDir)).toEqual([]);
	});
});
