/**
 * R35-ALWAYS.3 (same-owner attach) and R35-ALWAYS.4 (hygiene and the cap),
 * proved end to end against emitted artefacts only.
 *
 * Everything below drives the real `packages/coding-agent/dist/cli.js` — the file
 * `bin.draht` points at — and the daemon its own bin starts, over HTTP and a real
 * WebSocket. Nothing here imports `SocketServer`, `listAttachableSessions` or an
 * `AttachBridge`: a package-level test that did could pass while the shipped
 * binary published a socket anybody could dial, which is this repo's recorded
 * failure mode.
 *
 * THREE THINGS THIS FILE EXISTS TO CATCH, each measured on this machine before it
 * was written:
 *
 *   1. 25 start/SIGKILL cycles of the emitted binary left exactly 50 files, 25
 *      `.sock` and 25 `.lock`, strictly linear, zero reaped — because reaping
 *      happened only inside a fleet read. A machine where no phone and no daemon
 *      ever asks for the fleet grew without bound. The load-bearing assertion is
 *      therefore made DURING the cycles, before anything calls `GET /fleet`:
 *      asserting only the end state would be satisfied by the daemon's own reaper
 *      and would pass with reap-on-start deleted.
 *   2. There was not one `getuid()` call in coding-agent, geist-core or the
 *      gateway. A socket plus a lock naming a process this user cannot signal was
 *      listed as a live attachable session by both readers and dialled by the
 *      bridge.
 *   3. There was no cap: 500 sockets bound in one process with zero refusals, and
 *      `ulimit -n` here is 1048576, so nothing bounded a crash-restart loop.
 *
 * WHY THE FRAMES ARE PARSED LOOSELY. This suite deliberately does not validate
 * the daemon's frames against `ServerFrameSchema`: what it asserts is who may
 * reach a Unix socket, not what the wire looks like, and pinning the wire here
 * would make an ownership regression indistinguishable from a protocol edit.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import * as os from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const DRAHT_CLI = join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
const GATEWAY_CLI = join(REPO_ROOT, "packages", "gateway", "src", "cli.ts");
const TOKEN = "socket-ownership-e2e-token";

/** The cap the implementation defaults to, restated here rather than imported. */
const EXPECTED_CAP = 64;

/**
 * A Unix socket path over ~104 bytes fails to bind with EINVAL, and macOS's
 * `os.tmpdir()` is already 50 characters before a session uuid is appended. Every
 * directory here therefore lives directly under /tmp with a short name — this
 * suite binds more sockets than any other in the repo.
 */
const cleanupDirs: string[] = [];
const children: Bun.Subprocess[] = [];
const plantedServers: Server[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(`/tmp/${prefix}`);
	cleanupDirs.push(dir);
	return dir;
}

async function until<T>(
	probe: () => T | undefined | false | null | Promise<T | undefined | false | null>,
	what: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value) return value as T;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Drain a pipe into a string so a failing child's diagnostics survive. */
function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
	})().catch(() => {});
}

function socketDirOf(agentDir: string): string {
	return join(agentDir, "sockets");
}

function entriesOf(socketDir: string): string[] {
	try {
		return readdirSync(socketDir).sort();
	} catch {
		return [];
	}
}

function socketsOf(socketDir: string): string[] {
	return entriesOf(socketDir).filter((entry) => entry.endsWith(".sock"));
}

interface Draht {
	proc: Bun.Subprocess;
	stderr: { text: string };
}

/**
 * Start the emitted draht binary as an attachable session.
 *
 * `--mode rpc` is REQUIRED: with no TTY, `resolveAppMode` falls through to print
 * mode and the process answers once and exits before anything can attach.
 *
 * `env -u DRAHT_PERMISSION_MODE` in spirit — the environment is built explicitly
 * rather than inherited, so an exported permission mode in the developer's shell
 * cannot silently change what the child does.
 */
function spawnDraht(agentDir: string, home: string, cwd: string): Draht {
	const stderr = { text: "" };
	const proc = Bun.spawn(
		["node", DRAHT_CLI, "--attachable", "--mode", "rpc", "--provider", "draht-stub", "--model", "stub-1"],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				TMPDIR: home,
				DRAHT_CODING_AGENT_DIR: agentDir,
				DRAHT_STUB_PROVIDER: "1",
			},
			stdin: "pipe",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	return { proc, stderr };
}

/** Wait until a draht has published a `.sock` that was not there before. */
async function publishedSocket(draht: Draht, socketDir: string, before: Set<string>): Promise<string> {
	const entry = await until(() => {
		if (draht.proc.exitCode !== null) {
			throw new Error(
				`draht exited with code ${draht.proc.exitCode} before publishing a socket:\n${draht.stderr.text}`,
			);
		}
		return socketsOf(socketDir).find((name) => !before.has(name));
	}, `draht to publish its socket (stderr: ${draht.stderr.text})`);
	return entry.slice(0, -".sock".length);
}

async function kill(proc: Bun.Subprocess): Promise<void> {
	proc.kill("SIGKILL");
	await proc.exited;
}

/** Claim a free loopback port: the CLI validates 1..65535 and refuses 0. */
function freeLoopbackPort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
	const claimed = probe.port;
	probe.stop(true);
	if (claimed === undefined) throw new Error("the port probe bound no TCP port");
	return claimed;
}

interface Daemon {
	http: string;
	ws: string;
	stderr: { text: string };
}

async function startDaemon(agentDir: string, home: string): Promise<Daemon> {
	const port = freeLoopbackPort();
	const stderr = { text: "" };
	const proc = Bun.spawn(["bun", GATEWAY_CLI, "--port", String(port), "--auth", TOKEN], {
		env: { ...process.env, HOME: home, DRAHT_CODING_AGENT_DIR: agentDir, DRAHT_PERMISSION_MODE: undefined },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(proc);
	collect(proc.stderr as ReadableStream<Uint8Array>, stderr);
	await until(() => stderr.text.includes("draht-gateway listening"), `the daemon on ${port} to bind (${stderr.text})`);
	return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}`, stderr };
}

/** The ids `GET /fleet` reports. Parsed loosely on purpose — see the header. */
async function fleetIds(daemon: Daemon): Promise<string[]> {
	const response = await fetch(`${daemon.http}/fleet`, { headers: { Authorization: `Bearer ${TOKEN}` } });
	expect(response.status).toBe(200);
	const body = (await response.json()) as { sessions?: { id: string }[] };
	return (body.sessions ?? []).map((session) => session.id).sort();
}

/** One renderer, driven exactly as a phone would drive it. */
class Renderer {
	readonly frames: Record<string, unknown>[] = [];
	closed: { code: number; reason: string } | null = null;
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.addEventListener("message", (event: MessageEvent) => {
			this.frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
		});
		ws.addEventListener("close", (event: CloseEvent) => {
			this.closed = { code: event.code, reason: event.reason };
		});
	}

	static async open(daemon: Daemon): Promise<Renderer> {
		const ws = new (
			WebSocket as unknown as new (
				url: string,
				opts: { headers: Record<string, string> },
			) => WebSocket
		)(`${daemon.ws}/attach`, { headers: { Authorization: `Bearer ${TOKEN}` } });
		const renderer = new Renderer(ws);
		await new Promise<void>((res, rej) => {
			ws.addEventListener("open", () => res());
			ws.addEventListener("error", () => rej(new Error("websocket refused")));
		});
		return renderer;
	}

	send(frame: unknown): void {
		this.#ws.send(JSON.stringify(frame));
	}

	async handshake(): Promise<void> {
		this.send({
			type: "hello",
			protocol: "geist/0.x",
			// Hardcoded rather than imported so this handshake is what a RENDERER
			// sends; it moves with every 0.x bump.
			version: "0.5",
			client: { name: "ownership-e2e", version: "0.0.0" },
		});
		await this.waitFor((frame) => frame.type === "fleet", "the fleet frame");
	}

	async waitFor(
		predicate: (frame: Record<string, unknown>) => boolean,
		what: string,
		timeoutMs = 20_000,
	): Promise<Record<string, unknown>> {
		return until(
			() => this.frames.find(predicate),
			`${what} (saw: ${this.frames.map((frame) => frame.type).join(", ")})`,
			timeoutMs,
		);
	}

	close(): void {
		try {
			this.#ws.close();
		} catch {
			// Already gone.
		}
	}
}

/** Backdate a path so the debris grace window (10s) has provably passed. */
function backdate(path: string): void {
	const longAgo = new Date(Date.now() - 600_000);
	utimesSync(path, longAgo, longAgo);
}

/**
 * Bind a real Unix socket at `path` and keep it listening for the whole suite.
 *
 * A real socket, not a placeholder file: `isSocket()` is the first thing both
 * readers check, and a plain file would be filtered before the rule under test
 * was ever reached.
 */
async function plantSocket(path: string): Promise<Server> {
	const server = createServer();
	await new Promise<void>((res, rej) => {
		server.once("error", rej);
		server.listen(path, () => res());
	});
	server.unref();
	plantedServers.push(server);
	return server;
}

/** Write a lock file in the published three-line format, plus the 4th line. */
function plantLock(path: string, pid: number, cwd: string): void {
	const startedAtMs = Math.round(Date.now() - process.uptime() * 1000);
	writeFileSync(path, `${pid}\n${cwd}\n${new Date().toISOString()}\n${startedAtMs}`, { mode: 0o600 });
}

/**
 * ── HOW AN UNPRIVILEGED TEST PLANTS A FILE OWNED BY ANOTHER UID ────────────────
 *
 * The file-uid half of O1 used to be written off as untestable: no unprivileged
 * process can CREATE a file owned by somebody else, so the uid comparison was
 * left "covered by reading only" — and a review then measured what that was
 * worth. With `ownedByUs()` forced to `true` in BOTH readers and the directory's
 * uid check deleted, this suite stayed 9 green. Nothing here discriminated on a
 * uid at all; the only thing that did was `kill(pid, 0) == EPERM`.
 *
 * It cannot be created — but it can be NAMED. `link(2)` makes a second name for
 * an existing inode, and a name carries no ownership of its own: the uid stays
 * the inode's. Every macOS host already runs system services whose Unix sockets
 * are owned by root and world-writable (`srw-rw-rw- root /var/run/syslog`), and
 * both those names live on the same volume as /tmp. Hardlinking one into a test
 * socket directory yields exactly what the rule is about: an entry that `lstat`s
 * as a real socket whose `st_uid` is not ours.
 *
 * Unlinking that second name later removes the NAME only — the inode keeps its
 * original one — so nothing outside the temp directory is touched.
 *
 * Linux refuses this: `fs.protected_hardlinks` (on by default) allows hardlinks
 * only to regular files you own or can read AND write, and a socket is not a
 * regular file. The probe therefore ends in a real link attempt rather than in a
 * guess about the platform, and the tests that need one are skipped — visibly,
 * by name — where it fails. Skipped is not the same as covered; see the note on
 * the directory-uid check in the ownership describe below.
 */
const FOREIGN_SOCKET_CANDIDATES = [
	"/var/run/syslog",
	"/var/run/mDNSResponder",
	"/var/run/cups/cups.sock",
	"/run/systemd/journal/dev-log",
	"/dev/log",
];

function statOrNull(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

/**
 * A socket on this machine owned by another uid that this process may hardlink,
 * proved by actually hardlinking it, or null when there is none.
 *
 * The mtime bound matters: a planted foreign socket inherits the source inode's
 * mtime, and the "never reaped" assertions below are only meaningful once the
 * debris grace window has provably passed for it. A socket bound seconds ago
 * would make those tests pass for the wrong reason, so it is not accepted.
 */
function probeForeignSocket(): string | null {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	if (uid === null) return null;
	const probeDir = mkdtempSync("/tmp/p35x");
	try {
		for (const candidate of FOREIGN_SOCKET_CANDIDATES) {
			const info = statOrNull(candidate);
			if (info === null || !info.isSocket() || info.uid === uid) continue;
			if (Date.now() - info.mtimeMs <= 60_000) continue;
			const probe = join(probeDir, "probe.sock");
			try {
				linkSync(candidate, probe);
			} catch {
				continue;
			}
			const linked = statOrNull(probe);
			rmSync(probe, { force: true });
			if (linked?.isSocket() && linked.uid !== uid) return candidate;
		}
		return null;
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}

/** The source inode for {@link plantForeignUidSocket}, probed once. */
const FOREIGN_SOCKET_SOURCE = probeForeignSocket();

/** Declare a test that needs a foreign-uid socket, skipping it where none exists. */
const foreignUidTest = FOREIGN_SOCKET_SOURCE === null ? test.skip : test;

/** Give an existing foreign-uid socket a second name inside `path`. */
function plantForeignUidSocket(path: string): void {
	if (FOREIGN_SOCKET_SOURCE === null) throw new Error("no hardlinkable foreign-uid socket on this host");
	linkSync(FOREIGN_SOCKET_SOURCE, path);
}

let home: string;

beforeAll(async () => {
	// Built unconditionally: the artefact under test is emitted, not committed, so
	// "it already exists" says nothing about whether it matches this source tree.
	const build = Bun.spawnSync(["npm", "run", "build"], { cwd: join(REPO_ROOT, "packages", "coding-agent") });
	if (build.exitCode !== 0) throw new Error(`draht build failed:\n${build.stderr.toString()}`);
	if (!existsSync(DRAHT_CLI)) throw new Error(`draht build produced no ${DRAHT_CLI}`);
	home = tempDir("p35h");
}, 300_000);

afterAll(async () => {
	for (const server of plantedServers) {
		try {
			server.close();
		} catch {
			// Already gone.
		}
	}
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe("crash cycles leave nothing behind (R35-ALWAYS.4)", () => {
	test("50 sequential start/SIGKILL cycles never accumulate, and end with an empty fleet", async () => {
		const agentDir = tempDir("p35c");
		const socketDir = socketDirOf(agentDir);
		const cwd = tempDir("p35w");
		const daemon = await startDaemon(agentDir, home);

		let last: Draht | null = null;
		let highWater = 0;
		for (let cycle = 0; cycle < 50; cycle++) {
			const before = new Set(socketsOf(socketDir));
			const draht = spawnDraht(agentDir, home, cwd);
			await publishedSocket(draht, socketDir, before);

			// THE LOAD-BEARING ASSERTION, and the reason it is here rather than after
			// the loop: nothing has called `GET /fleet` yet, so the daemon's reaper has
			// not run and cannot be what keeps this number down. Two files is one live
			// session's pair. Before reap-on-start this reached 2 x (cycle + 1).
			const files = entriesOf(socketDir);
			highWater = Math.max(highWater, files.length);
			// Paired with the cycle number so a failure says WHEN it started growing.
			expect([cycle, files.length]).toEqual([cycle, 2]);

			await kill(draht.proc);
			last = draht;
		}
		expect(highWater).toBe(2);
		expect(last).not.toBeNull();

		// The 50th cycle's own pair is still on disk — its owner was killed and no
		// draht started after it. Reaping that one is the daemon's job, and it is the
		// half the acceptance can only see through the wire.
		expect(entriesOf(socketDir)).toHaveLength(2);
		await until(async () => (await fleetIds(daemon)).length === 0, "the fleet to empty");
		expect(entriesOf(socketDir)).toEqual([]);
	}, 300_000);
});

describe("a session this user does not own (R35-ALWAYS.3)", () => {
	let daemon: Daemon;
	let agentDir: string;
	let socketDir: string;
	const foreignId = "aaaaaaaa-0000-4000-8000-000000000001";
	/** A socket owned by another uid, with a lock of ours naming a live process of ours. */
	const foreignUidId = "eeeeeeee-0000-4000-8000-000000000001";
	/** A socket owned by another uid with no lock at all: debris class (i), but not ours. */
	const foreignUidOrphan = "eeeeeeee-0000-4000-8000-000000000002";
	let connections = 0;

	beforeAll(async () => {
		agentDir = tempDir("p35f");
		socketDir = socketDirOf(agentDir);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });

		// A REAL socket, listening, plus a lock naming pid 1.
		//
		// pid 1 is the discriminator this test can construct without being root:
		// `kill(1, 0)` returns EPERM, which the code deliberately reads as ALIVE, and
		// a process this uid cannot signal is by definition not a process this uid
		// started. That is exactly the shape the demonstrated attack had — a lock
		// naming root's pid 1 next to a socket in a directory the attacker could
		// write.
		const server = await plantSocket(join(socketDir, `${foreignId}.sock`));
		server.on("connection", (socket) => {
			connections += 1;
			socket.destroy();
		});
		plantLock(join(socketDir, `${foreignId}.lock`), 1, "/tmp");

		// THE FILE-UID HALF, which this file used to claim was asserted elsewhere and
		// was not. Both entries are real sockets whose st_uid is not ours (see
		// `plantForeignUidSocket`), and they attack the rule from its two sides:
		//
		//   `foreignUidId`     everything except the socket's uid says "a live session
		//                      of this user" — the lock beside it is ours, is a plain
		//                      file, parses, and names a process that is alive and
		//                      signallable by us (this test runner). Only the uid of
		//                      the socket keeps it out of the fleet, so a reader that
		//                      stops comparing uids lists it.
		//   `foreignUidOrphan` a foreign socket with no lock. To a reader that stops
		//                      comparing uids this is debris class (i) — a lockless
		//                      socket of ours, long past the grace window — and it
		//                      gets unlinked. O2 says a read never deletes what it
		//                      cannot interpret, so it must survive every scan.
		if (FOREIGN_SOCKET_SOURCE !== null) {
			plantForeignUidSocket(join(socketDir, `${foreignUidId}.sock`));
			plantLock(join(socketDir, `${foreignUidId}.lock`), process.pid, "/tmp");
			plantForeignUidSocket(join(socketDir, `${foreignUidOrphan}.sock`));
		}

		daemon = await startDaemon(agentDir, home);
	}, 120_000);

	test("GET /fleet does not list it, and does not delete it either", async () => {
		expect(await fleetIds(daemon)).toEqual([]);
		// Not reaped: a read that runs on an HTTP request must not destroy what it
		// cannot interpret. Deleting another user's live socket would be the same
		// class of bug in the other direction.
		expect(existsSync(join(socketDir, `${foreignId}.sock`))).toBe(true);
		expect(existsSync(join(socketDir, `${foreignId}.lock`))).toBe(true);
	});

	test("an attach frame naming it is refused, and the socket is never dialled", async () => {
		const renderer = await Renderer.open(daemon);
		await renderer.handshake();

		renderer.send({ type: "attach", sessionId: foreignId, clientId: "intruder", mode: "read-write" });
		const refusal = await renderer.waitFor((frame) => frame.type === "protocol_error", "the refusal");
		expect(refusal).toMatchObject({ type: "protocol_error", code: "unknown_session" });
		expect(renderer.frames.some((frame) => frame.type === "session_metadata")).toBe(false);

		// The load-bearing half, asserted on the far side of the socket by the thing
		// that would have accepted the connection. Before the ownership rule the
		// bridge dialled this socket and this counter reached 1.
		await Bun.sleep(500);
		expect(connections).toBe(0);
		renderer.close();
	}, 60_000);

	test("the daemon's own read reaps both debris classes, and leaves what is not ours", async () => {
		// The SAME rules, in the mirrored reader. `GET /fleet` runs geist-core's
		// synchronous scan, which never touches a draht process — so this is the half
		// of R35-ALWAYS.4 that the session-side sweep cannot prove, and the two
		// implementations really are two.
		const lockless = join(socketDir, "dddddddd-0000-4000-8000-000000000001.sock");
		await plantSocket(lockless);
		backdate(lockless);
		const notASocket = join(socketDir, "dddddddd-0000-4000-8000-000000000002.sock");
		writeFileSync(notASocket, "not a socket");
		backdate(notASocket);

		// A lock whose LINE 4 is the only thing that condemns it: line 3 is right now,
		// and its pid is this test runner — alive, ours, signallable. Everything a
		// reader that ignores the 4th line can see says "a session being claimed this
		// instant, leave it alone"; only the recorded start time says it belongs to a
		// process that cannot exist, because nothing running now started before the
		// last boot. See the sibling assertion on the draht side for why the other
		// pre-boot fixture in this file cannot carry this.
		const recycledPid = join(socketDir, "dddddddd-0000-4000-8000-000000000003.lock");
		writeFileSync(recycledPid, `${process.pid}\n/tmp\n${new Date().toISOString()}\n0`, { mode: 0o600 });

		expect(await fleetIds(daemon)).toEqual([]);

		expect(existsSync(lockless)).toBe(false);
		expect(existsSync(notASocket)).toBe(false);
		expect(existsSync(recycledPid)).toBe(false);
		// And the pair that is not ours is still exactly where it was.
		expect(existsSync(join(socketDir, `${foreignId}.sock`))).toBe(true);
		expect(existsSync(join(socketDir, `${foreignId}.lock`))).toBe(true);
	});

	foreignUidTest("a socket owned by another uid is not listed, however live its lock looks", async () => {
		// Reached through `GET /fleet`, i.e. geist-core's synchronous mirror of the
		// same rules — the reader that runs in the daemon and never touches a draht
		// process. The planted lock is deliberately perfect: ours, plain, parseable,
		// naming a pid that is alive and signallable by us. `st_uid` on the socket is
		// the single bit that says no.
		expect(await fleetIds(daemon)).not.toContain(foreignUidId);
		expect(await fleetIds(daemon)).toEqual([]);
		// And listing is not the only thing forbidden: O2 keeps a fleet read from
		// deleting what it refused to interpret.
		expect(existsSync(join(socketDir, `${foreignUidId}.sock`))).toBe(true);
		expect(existsSync(join(socketDir, `${foreignUidId}.lock`))).toBe(true);
	});

	foreignUidTest("a lockless socket owned by another uid is not reaped as debris of ours", async () => {
		// The mirror image: the entry LOOKS exactly like debris class (i), which this
		// same read deletes on sight two tests above. It survives only because the uid
		// check happens before the lockless-socket branch is reachable.
		const planted = join(socketDir, `${foreignUidOrphan}.sock`);
		expect(lstatSync(planted).uid).not.toBe(process.getuid?.());
		expect(await fleetIds(daemon)).toEqual([]);
		expect(existsSync(planted)).toBe(true);
	});

	test("a live session of ours in the same directory is still listed and attachable", async () => {
		// The other half of every filter: it must not simply refuse everything. A
		// real draht in the SAME directory as the planted pair is listed, and only
		// it is.
		const cwd = tempDir("p35w");
		const before = new Set(socketsOf(socketDir));
		const draht = spawnDraht(agentDir, home, cwd);
		const id = await publishedSocket(draht, socketDir, before);

		expect(await fleetIds(daemon)).toEqual([id]);

		const renderer = await Renderer.open(daemon);
		await renderer.handshake();
		renderer.send({ type: "attach", sessionId: id, clientId: "owner", mode: "read-write" });
		await renderer.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
		renderer.close();
		await kill(draht.proc);
	}, 120_000);

	test("the emitted binary WRITES the 4th line, not just reads it", async () => {
		// The readers are witnessed twice over; the writer was not. Reverting
		// socket-server.ts to a three-line lock left this suite green and
		// coding-agent's own socket suites green — 26/26 — because every fixture here
		// PLANTS its locks. A format whose readers are pinned and whose only writer is
		// not is a format that can quietly stop being written, and the recycled-pid
		// refusal it exists to bound would come back with no test saying so.
		const cwd = tempDir("p35l");
		const before = new Set(socketsOf(socketDir));
		const draht = spawnDraht(agentDir, home, cwd);
		const id = await publishedSocket(draht, socketDir, before);

		const lines = readFileSync(join(socketDir, `${id}.lock`), "utf8").split("\n");
		expect(lines).toHaveLength(4);

		// Line 4 is the owner's process start time in ms. Assert it is REAL rather
		// than merely present: it must name an instant after the machine booted and
		// at or before now, which a hardcoded 0 (the pre-boot debris value) and a
		// hardcoded Date.now() at read time both fail.
		const startedAtMs = Number(lines[3]);
		expect(Number.isFinite(startedAtMs)).toBe(true);
		const bootedAtMs = Date.now() - os.uptime() * 1000;
		expect(startedAtMs).toBeGreaterThan(bootedAtMs);
		expect(startedAtMs).toBeLessThanOrEqual(Date.now());

		// And it is the CHILD's start time, not this test process's: draht started
		// seconds ago, the runner minutes-to-hours ago.
		const ourStartMs = Math.round(Date.now() - process.uptime() * 1000);
		expect(startedAtMs).toBeGreaterThan(ourStartMs);

		await kill(draht.proc);
	}, 120_000);
});

describe("the sockets directory itself (R35-ALWAYS.3)", () => {
	/*
	 * ── ONE RULE HERE IS STILL COVERED BY READING ONLY ────────────────────────────
	 *
	 * `#assertSocketDirIsOurs` refuses a sockets DIRECTORY whose uid is not ours,
	 * and nothing below exercises that branch. The hardlink that plants a
	 * foreign-uid socket does not help: `link(2)` refuses directories outright, and
	 * pointing `DRAHT_CODING_AGENT_DIR` at somebody else's tree only produces an
	 * EACCES from `mkdir` — a different refusal, on a different line, that would
	 * pass with the uid comparison deleted. The other two directory rules ARE
	 * witnessed: the symlink refusal and the mode tightening are the two tests
	 * below. Stated here rather than implied, because a reviewer measured what the
	 * previous implication was worth: with the uid comparison deleted from all
	 * three places, this suite stayed entirely green.
	 */
	test("a symlinked sockets directory is refused by name, and nothing is published", async () => {
		// `lstat`, not `stat`: a symlink pointing at a directory somebody else
		// controls passes every check that follows if the link is followed. There was
		// no check at all before — the 0700 mode was asserted by `chmod` and by
		// nothing else.
		const agentDir = tempDir("p35l");
		const elsewhere = tempDir("p35e");
		mkdirSync(agentDir, { recursive: true });
		Bun.spawnSync(["ln", "-s", elsewhere, socketDirOf(agentDir)]);

		const draht = spawnDraht(agentDir, home, tempDir("p35w"));
		await until(
			() => draht.stderr.text.includes("Refusing to publish an attachable session"),
			`the typed refusal (stderr: ${draht.stderr.text})`,
		);
		expect(draht.stderr.text).toContain("not a directory");
		expect(socketsOf(elsewhere)).toEqual([]);
		await kill(draht.proc);
	}, 120_000);

	test("a world-writable sockets directory that IS ours is tightened, not left open", async () => {
		const agentDir = tempDir("p35m");
		const socketDir = socketDirOf(agentDir);
		mkdirSync(socketDir, { recursive: true });
		chmodSync(socketDir, 0o777);

		const draht = spawnDraht(agentDir, home, tempDir("p35w"));
		await publishedSocket(draht, socketDir, new Set());
		expect(statSync(socketDir).mode & 0o777).toBe(0o700);
		await kill(draht.proc);
	}, 120_000);
});

describe("the live-socket cap and the immortal debris classes (R35-ALWAYS.4)", () => {
	test("binding past the cap is refused with an error naming the cap and the count", async () => {
		const agentDir = tempDir("p35p");
		const socketDir = socketDirOf(agentDir);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });

		// EXPECTED_CAP live pairs: a real socket each, and a lock naming THIS test
		// process, which is alive and signallable by us and therefore counts as one
		// of our live sessions in exactly the way a real draht would.
		for (let index = 0; index < EXPECTED_CAP; index++) {
			const id = `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`;
			await plantSocket(join(socketDir, `${id}.sock`));
			plantLock(join(socketDir, `${id}.lock`), process.pid, "/tmp");
		}
		expect(socketsOf(socketDir)).toHaveLength(EXPECTED_CAP);

		const draht = spawnDraht(agentDir, home, tempDir("p35w"));
		await until(() => draht.stderr.text.includes("cap is"), `the cap refusal (stderr: ${draht.stderr.text})`);
		// Both numbers, because an operator has to be able to tell a cap from a bug.
		expect(draht.stderr.text).toContain(`already holds ${EXPECTED_CAP} live attachable sessions`);
		expect(draht.stderr.text).toContain(`cap is ${EXPECTED_CAP}`);
		// And no 65th socket, however the caller chose to react to the refusal.
		expect(socketsOf(socketDir)).toHaveLength(EXPECTED_CAP);
		await kill(draht.proc);
	}, 120_000);

	test("a lockless .sock and a regular file named <id>.sock are both reaped by the next start", async () => {
		const agentDir = tempDir("p35d");
		const socketDir = socketDirOf(agentDir);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });

		// Class (i): a real socket whose lock is gone. Two of these had been sitting
		// in the real ~/.draht/agent/sockets since 2026-08-21, immortal because both
		// readers `continue`d past a missing lock without reaping.
		const lockless = join(socketDir, "cccccccc-0000-4000-8000-000000000001.sock");
		await plantSocket(lockless);
		backdate(lockless);

		// Class (ii): a regular file wearing a .sock name. Neither reader could ever
		// remove one.
		const notASocket = join(socketDir, "cccccccc-0000-4000-8000-000000000002.sock");
		writeFileSync(notASocket, "not a socket");
		backdate(notASocket);
		// Its lock, which the drifted reader used to shield from the orphan sweep by
		// recording the id as "has a socket" before checking that it was one.
		const shieldedLock = join(socketDir, "cccccccc-0000-4000-8000-000000000002.lock");
		plantLock(shieldedLock, 999_999, "/tmp");
		backdate(shieldedLock);

		// And the bound on readable-pid locks: a lock naming a pid that is alive AND
		// ours, but recording a process that started before this machine last booted.
		// Nothing running now started before the last boot, so it is debris however
		// alive its pid looks — which is how a lock naming a recycled pid used to
		// refuse a session id forever, at any age.
		const preBoot = join(socketDir, "cccccccc-0000-4000-8000-000000000003.lock");
		writeFileSync(preBoot, `${process.pid}\n/tmp\n${new Date(0).toISOString()}\n0`, { mode: 0o600 });

		// THE 4TH LINE, on its own. The fixture above does NOT witness it and this
		// file used to claim it did: its line 3 is the epoch too, so the line-3
		// fallback condemns it just as hard and it is still reaped by a parser that
		// never looks past three lines (measured: reverting the writer to three lines
		// and both parsers to `fromLine4 = NaN` left this suite 9 green). Line 4 is
		// the whole point of the format change — the ISO creation time says when the
		// LOCK was written, and a lock rewritten a moment ago by a process that has
		// been running since before the reboot is exactly the recycled-pid case. So:
		// line 3 recent, line 4 pre-boot, pid alive and ours. Only the 4th line can
		// reap this.
		const recycledPid = join(socketDir, "cccccccc-0000-4000-8000-000000000004.lock");
		writeFileSync(recycledPid, `${process.pid}\n/tmp\n${new Date().toISOString()}\n0`, { mode: 0o600 });

		const draht = spawnDraht(agentDir, home, tempDir("p35w"));
		const id = await publishedSocket(draht, socketDir, new Set(socketsOf(socketDir)));

		expect(existsSync(lockless)).toBe(false);
		expect(existsSync(notASocket)).toBe(false);
		expect(existsSync(shieldedLock)).toBe(false);
		expect(existsSync(preBoot)).toBe(false);
		expect(existsSync(recycledPid)).toBe(false);
		expect(entriesOf(socketDir)).toEqual([`${id}.lock`, `${id}.sock`]);
		await kill(draht.proc);
	}, 120_000);

	foreignUidTest(
		"a start-time sweep reaps our debris and leaves another uid's socket alone",
		async () => {
			// The same asymmetry as the fleet-read pair, but through the OTHER reader:
			// `SocketServer.start()`'s sweep is `discoverSocketSessions()` in coding-agent,
			// which the daemon never runs. It is the more dangerous of the two, because it
			// is the one place allowed to delete — so a uid check dropped here unlinks
			// another user's live socket instead of merely listing it.
			const agentDir = tempDir("p35u");
			const socketDir = socketDirOf(agentDir);
			mkdirSync(socketDir, { recursive: true, mode: 0o700 });

			const foreign = join(socketDir, "ffffffff-0000-4000-8000-000000000001.sock");
			plantForeignUidSocket(foreign);
			expect(lstatSync(foreign).uid).not.toBe(process.getuid?.());

			// Beside it, the same shape that IS ours, so the sweep is proved to have run
			// at all rather than to have skipped the directory.
			const ours = join(socketDir, "ffffffff-0000-4000-8000-000000000002.sock");
			await plantSocket(ours);
			backdate(ours);

			const draht = spawnDraht(agentDir, home, tempDir("p35w"));
			const id = await publishedSocket(draht, socketDir, new Set(socketsOf(socketDir)));

			expect(existsSync(ours)).toBe(false);
			expect(existsSync(foreign)).toBe(true);
			// Sorted on both sides: the published id is a fresh uuid and may fall either
			// side of the planted name.
			expect(entriesOf(socketDir)).toEqual(
				[`${id}.lock`, `${id}.sock`, "ffffffff-0000-4000-8000-000000000001.sock"].sort(),
			);
			await kill(draht.proc);
		},
		120_000,
	);
});
