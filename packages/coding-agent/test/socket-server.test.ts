import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	discoverSocketSessions,
	makeSessionAttachable,
	SocketClient,
	SocketServer,
	SocketSessionBusyError,
} from "../src/core/socket-server/index.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "dsock-"));
	tempDirs.push(dir);
	return dir;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for: ${message}`);
}

/** Reject instead of hanging forever, so a wedged promise fails fast and visibly. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const guard = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, guard]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A PID that is guaranteed to be dead: spawn a process and let it exit. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""]);
	if (typeof result.pid !== "number") throw new Error("Failed to spawn a throwaway process");
	return result.pid;
}

function createFakeSession(sessionId: string, onPrompt?: (text: string) => void): AgentSession {
	return {
		sessionManager: {
			getHeader: () => ({ id: sessionId }),
		},
		subscribe: () => () => {},
		prompt: async (text: string) => {
			onPrompt?.(text);
		},
	} as unknown as AgentSession;
}

async function withAgentDir<T>(agentDir: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previous;
		}
	}
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("SocketServer + discovery + SocketClient", () => {
	test("round-trips output and input, then disappears from discovery after stop", async () => {
		const socketDir = await createTempDir();
		const sessionCwd = path.join(socketDir, "project");
		const server = new SocketServer({ sessionId: "s1", socketDir, cwd: sessionCwd });
		await server.start();

		// Discovery finds the live session with its metadata.
		const discovered = await discoverSocketSessions(socketDir);
		expect(discovered.map((s) => s.sessionId)).toEqual(["s1"]);
		expect(discovered[0].pid).toBe(process.pid);
		expect(discovered[0].cwd).toBe(sessionCwd);

		const metadata: Array<{ sessionId: string; cwd: string }> = [];
		const output: string[] = [];
		const client = new SocketClient({ socketPath: discovered[0].socketPath, clientId: "c1" });
		client.onMetadata((sessionId, cwd) => metadata.push({ sessionId, cwd }));
		client.onOutput((data) => output.push(data));
		await client.connect();

		// Server -> client: metadata on attach.
		await waitFor(() => metadata.length === 1, "session metadata on attach");
		expect(metadata[0]).toEqual({ sessionId: "s1", cwd: sessionCwd });

		// Server -> client: streamed output.
		server.broadcastOutput("hello from server\n");
		await waitFor(() => output.join("") === "hello from server\n", "broadcast output");

		// Client -> server: input.
		const inputs: Array<{ data: string; clientId: string }> = [];
		server.onInput((data, clientId) => inputs.push({ data, clientId }));
		client.sendInput("hello from client\n");
		await waitFor(() => inputs.length === 1, "input forwarded to server");
		expect(inputs[0]).toEqual({ data: "hello from client\n", clientId: "c1" });

		client.disconnect();
		await server.stop();

		expect(await discoverSocketSessions(socketDir)).toEqual([]);
		expect(existsSync(path.join(socketDir, "s1.sock"))).toBe(false);
		expect(existsSync(path.join(socketDir, "s1.lock"))).toBe(false);
	});

	test("echoes input from one client to the other clients", async () => {
		const socketDir = await createTempDir();
		const server = new SocketServer({ sessionId: "s2", socketDir, cwd: socketDir });
		await server.start();
		const socketPath = path.join(socketDir, "s2.sock");

		const echoes: Array<{ data: string; clientId: string }> = [];
		const writer = new SocketClient({ socketPath, clientId: "writer" });
		const watcher = new SocketClient({ socketPath, clientId: "watcher" });
		watcher.onInputEcho((data, clientId) => echoes.push({ data, clientId }));

		await watcher.connect();
		await writer.connect();
		await waitFor(() => server.clientCount === 2, "both clients attached");

		writer.sendInput("shared input\n");
		await waitFor(() => echoes.length === 1, "input echoed to the other client");
		expect(echoes[0]).toEqual({ data: "shared input\n", clientId: "writer" });

		writer.disconnect();
		watcher.disconnect();
		await server.stop();
	});

	test("discovery filters out a socket whose lock names a dead PID", async () => {
		const socketDir = await createTempDir();
		const live = new SocketServer({ sessionId: "live", socketDir, cwd: socketDir });
		const stale = new SocketServer({ sessionId: "stale", socketDir, cwd: socketDir });
		await live.start();
		await stale.start();

		expect((await discoverSocketSessions(socketDir)).map((s) => s.sessionId).sort()).toEqual(["live", "stale"]);

		// Rewrite the stale session's lock file so it names a process that no longer exists.
		await writeFile(path.join(socketDir, "stale.lock"), `${deadPid()}\n${socketDir}\n${new Date().toISOString()}`);

		const discovered = await discoverSocketSessions(socketDir);
		expect(discovered.map((s) => s.sessionId)).toEqual(["live"]);

		await live.stop();
		await stale.stop();
	});

	test("refuses to take over a socket whose lock names a different live process", async () => {
		const socketDir = await createTempDir();
		const owner = new SocketServer({ sessionId: "busy", socketDir, cwd: socketDir });
		await owner.start();

		// Simulate a second draht process resolving to the same session id: the lock on disk
		// names a live PID that is not ours.
		const lockPath = path.join(socketDir, "busy.lock");
		await writeFile(lockPath, `${process.ppid}\n${socketDir}\n${new Date().toISOString()}`);

		const intruder = new SocketServer({ sessionId: "busy", socketDir, cwd: socketDir });
		await expect(intruder.start()).rejects.toThrow(/already attachable/i);

		// The live owner keeps its socket and its lock file.
		expect(existsSync(path.join(socketDir, "busy.sock"))).toBe(true);
		const lock = await readFile(lockPath, "utf-8");
		expect(lock.trim().split("\n")[0]).toBe(String(process.ppid));

		await owner.stop();
	});

	test("reaps a lock whose PID is dead and takes the socket over", async () => {
		const socketDir = await createTempDir();
		await mkdir(socketDir, { recursive: true });
		const socketPath = path.join(socketDir, "crashed.sock");
		const lockPath = path.join(socketDir, "crashed.lock");
		// Leftovers of a crashed session: a socket file plus a lock naming a dead PID.
		await writeFile(socketPath, "");
		await writeFile(lockPath, `${deadPid()}\n${socketDir}\n${new Date().toISOString()}`);

		const server = new SocketServer({ sessionId: "crashed", socketDir, cwd: socketDir });
		await server.start();

		const lock = await readFile(lockPath, "utf-8");
		expect(lock.trim().split("\n")[0]).toBe(String(process.pid));

		// The reclaimed socket actually serves clients.
		const metadata: string[] = [];
		const client = new SocketClient({ socketPath, clientId: "c1" });
		client.onMetadata((sessionId) => metadata.push(sessionId));
		await client.connect();
		await waitFor(() => metadata.length === 1, "metadata from the reclaimed socket");
		expect(metadata[0]).toBe("crashed");

		client.disconnect();
		await server.stop();
	});

	test("discovery reaps the socket and lock of a dead owner but leaves live ones alone", async () => {
		const socketDir = await createTempDir();
		const live = new SocketServer({ sessionId: "alive", socketDir, cwd: socketDir });
		const orphan = new SocketServer({ sessionId: "orphan", socketDir, cwd: socketDir });
		await live.start();
		await orphan.start();

		await writeFile(path.join(socketDir, "orphan.lock"), `${deadPid()}\n${socketDir}\n${new Date().toISOString()}`);

		expect((await discoverSocketSessions(socketDir)).map((s) => s.sessionId)).toEqual(["alive"]);

		expect(existsSync(path.join(socketDir, "orphan.sock"))).toBe(false);
		expect(existsSync(path.join(socketDir, "orphan.lock"))).toBe(false);
		expect(existsSync(path.join(socketDir, "alive.sock"))).toBe(true);
		expect(existsSync(path.join(socketDir, "alive.lock"))).toBe(true);

		await orphan.stop();
		await live.stop();
	});
});

describe("makeSessionAttachable", () => {
	test("records the session cwd in the lock file, not process.cwd()", async () => {
		const agentDir = await createTempDir();
		const sessionCwd = path.join(agentDir, "other-project");
		expect(sessionCwd).not.toBe(process.cwd());

		const handle = await withAgentDir(agentDir, () =>
			makeSessionAttachable({ session: createFakeSession("cwdfix"), enabled: true, cwd: sessionCwd }),
		);

		try {
			const lock = await readFile(path.join(agentDir, "sockets", "cwdfix.lock"), "utf-8");
			const [, recordedCwd] = lock.trim().split("\n");
			expect(recordedCwd).toBe(sessionCwd);
			expect(recordedCwd).not.toBe(process.cwd());

			const discovered = await discoverSocketSessions(path.join(agentDir, "sockets"));
			expect(discovered.map((s) => s.cwd)).toEqual([sessionCwd]);
		} finally {
			await handle.stop();
		}
	});

	test("cleanup removes both the .sock and the .lock file", async () => {
		const agentDir = await createTempDir();
		const socketDir = path.join(agentDir, "sockets");

		const handle = await withAgentDir(agentDir, () =>
			makeSessionAttachable({ session: createFakeSession("clean"), enabled: true, cwd: agentDir }),
		);

		expect(existsSync(path.join(socketDir, "clean.sock"))).toBe(true);
		expect(existsSync(path.join(socketDir, "clean.lock"))).toBe(true);

		await handle.stop();

		expect(existsSync(path.join(socketDir, "clean.sock"))).toBe(false);
		expect(existsSync(path.join(socketDir, "clean.lock"))).toBe(false);
		expect(await discoverSocketSessions(socketDir)).toEqual([]);
	});

	test("is a no-op when not enabled", async () => {
		const agentDir = await createTempDir();
		const handle = await withAgentDir(agentDir, () =>
			makeSessionAttachable({ session: createFakeSession("off"), enabled: false, cwd: agentDir }),
		);
		await handle.stop();
		expect(existsSync(path.join(agentDir, "sockets"))).toBe(false);
	});
});

describe("SocketServer.stop() is bounded", () => {
	test("resolves and removes both files when a peer never attaches and never closes", async () => {
		const socketDir = await createTempDir();
		const server = new SocketServer({ sessionId: "wedge", socketDir, cwd: socketDir });
		await server.start();
		const socketPath = path.join(socketDir, "wedge.sock");
		const lockPath = path.join(socketDir, "wedge.lock");

		// A non-Node peer (the gateway/WebSocket bridge): it connects, never sends an
		// `attach` frame - so it is never registered as a client - and keeps its half of
		// the connection open when the server half-closes.
		const peer = netConnect({ path: socketPath, allowHalfOpen: true });
		peer.on("error", () => {});
		await new Promise<void>((resolve, reject) => {
			peer.once("connect", () => resolve());
			peer.once("error", reject);
		});

		try {
			await withTimeout(server.stop(), 10_000, "server.stop() with a wedged peer");
			expect(existsSync(socketPath)).toBe(false);
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			peer.destroy();
		}
	});
});

describe("SocketServer lock claiming", () => {
	test("treats a fresh empty lock as held, so a concurrent starter cannot reap a live owner", async () => {
		const socketDir = await createTempDir();
		const owner = new SocketServer({ sessionId: "racy", socketDir, cwd: socketDir });
		await owner.start();

		// Exactly what a concurrent starter sees when it reads the lock between the
		// exclusive create and the pid write: the file exists but is still empty.
		const lockPath = path.join(socketDir, "racy.lock");
		await writeFile(lockPath, "");

		const intruder = new SocketServer({ sessionId: "racy", socketDir, cwd: socketDir });
		await expect(intruder.start()).rejects.toThrow(SocketSessionBusyError);

		// The in-flight claim was not stolen and the owner's socket still exists.
		expect(await readFile(lockPath, "utf-8")).toBe("");
		expect(existsSync(path.join(socketDir, "racy.sock"))).toBe(true);

		await owner.stop();
	});

	test("reclaims an unparseable lock once it is provably stale", async () => {
		const socketDir = await createTempDir();
		const lockPath = path.join(socketDir, "abandoned.lock");
		await writeFile(lockPath, "");
		const longAgo = new Date(Date.now() - 60 * 60 * 1000);
		await utimes(lockPath, longAgo, longAgo);

		const server = new SocketServer({ sessionId: "abandoned", socketDir, cwd: socketDir });
		await server.start();

		const lock = await readFile(lockPath, "utf-8");
		expect(lock.trim().split("\n")[0]).toBe(String(process.pid));

		await server.stop();
	});
});

describe("SocketServer session id validation", () => {
	test("refuses ids that are not safe path components", async () => {
		const socketDir = await createTempDir();
		for (const evil of ["../escape", "a/b", "..", ".hidden", "", "escape/"]) {
			expect(() => new SocketServer({ sessionId: evil, socketDir, cwd: socketDir })).toThrow(/Session id/);
		}
	});
});

describe("discovery reaps orphaned locks", () => {
	test("removes a lock with no socket whose PID is dead and keeps one whose PID is alive", async () => {
		const socketDir = await createTempDir();
		const deadLock = path.join(socketDir, "gone.lock");
		const liveLock = path.join(socketDir, "starting.lock");
		const stamp = new Date().toISOString();
		await writeFile(deadLock, `${deadPid()}\n${socketDir}\n${stamp}`);
		await writeFile(liveLock, `${process.pid}\n${socketDir}\n${stamp}`);

		expect(await discoverSocketSessions(socketDir)).toEqual([]);

		expect(existsSync(deadLock)).toBe(false);
		// A live owner may simply not have bound its socket yet - never reap it.
		expect(existsSync(liveLock)).toBe(true);
	});
});

describe("lock ownership on refused starts", () => {
	test("a refused SocketServer leaves the live owner's lock untouched", async () => {
		const socketDir = await createTempDir();
		const sessionId = "foreign-owned";
		const lockPath = path.join(socketDir, `${sessionId}.lock`);
		// process.ppid is alive and is not this process, so #claimLock must treat it
		// as a live foreign owner and refuse. (A lock naming process.pid would be
		// reaped as our own leftover, which is correct but not what this tests.)
		const contents = `${process.ppid}\n${socketDir}\n${new Date().toISOString()}`;
		await writeFile(lockPath, contents, { mode: 0o600 });

		const intruder = new SocketServer({ sessionId, socketDir, cwd: socketDir });
		await expect(intruder.start()).rejects.toThrow();

		// The obvious `try { start() } catch { stop() }` idiom must not destroy the
		// live owner's claim - stop() may only remove files this instance claimed.
		await intruder.stop();
		expect(existsSync(lockPath)).toBe(true);
		expect(await readFile(lockPath, "utf8")).toBe(contents);

		const intruder2 = new SocketServer({ sessionId, socketDir, cwd: socketDir });
		await expect(intruder2.start()).rejects.toThrow();
		intruder2.stopSync();
		expect(existsSync(lockPath)).toBe(true);
		expect(await readFile(lockPath, "utf8")).toBe(contents);
	});
});
