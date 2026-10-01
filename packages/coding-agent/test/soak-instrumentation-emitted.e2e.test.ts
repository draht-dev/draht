/**
 * R35-ALWAYS.11 (recording half) — the EMITTED BINARY writes a soak record at every seam a
 * seven-day verdict has to read, from the day default-on lands.
 *
 * EVIDENCE CLASS 3. Every assertion below drives `packages/coding-agent/dist/cli.js`, rebuilt in
 * `beforeAll`, as a real child process, and reads the log back off the filesystem afterwards. The
 * writer itself already has a Class-2 suite (`soak-log-rotation.test.ts`) proving its guarantees;
 * this file proves the PRODUCT calls it. A test that drove `SoakLog` directly, or that imported a
 * seam and invoked it in-process, would stay green for a binary that recorded nothing at all —
 * which was the exact state of the writer before this task: `SoakLog`, `getSoakLog`, `setSoakLog`
 * and `setSessionId` had zero call sites outside their own module.
 *
 * ── WHAT PHASE 39 NEEDS FROM THIS FILE ──────────────────────────────────────────────────────────
 * The soak verdict is read WEEKS LATER, by a tool, from a directory. So each test asks a question
 * of that directory rather than of a callback it installed:
 *   • is there a record for a bind, a teardown, an attach, a detach, a refused prompt?
 *   • does a heartbeat carry the fd and socket-directory gauges, and do those gauges agree with an
 *     INDEPENDENT `readdir` taken while the session is alive?
 *   • do records from a process that has exited survive into the next process's run?
 *   • when a SIGKILLed session leaves debris, is the sweep that removes it VISIBLE in the log —
 *     because a directory listing at verdict time cannot see what was tidied away days earlier?
 *
 * ── WHAT THIS FILE DOES NOT WITNESS, NAMED RATHER THAN IMPLIED ──────────────────────────────────
 * Every event in `SOAK_EVENTS` is asserted here except three, and each is left out for a reason:
 *   • `rotation` — reaching it from the emitted binary means writing a capped file's worth of
 *     records through the product. It is a WRITER guarantee, and `soak-log-rotation.test.ts`
 *     owns it at Class 2 with the size cap turned down.
 *   • `client_rejected` with reason `permission_unknown_request` — UNREACHABLE from a socket.
 *     `session-integration.ts` registers `onPermissionResponse` on every bind, so the "nothing
 *     in this process holds asks" branch only exists for a `SocketServer` built outside a
 *     session, which the emitted binary never does.
 *   • `socket_rebind` with `outcome: "failed"` — needs the rebind's `bind()` to throw, which
 *     from outside this process means racing the socket path away between two internal awaits.
 * Two reap classes are also unpinned: `preBootLock` and the `notASocket`/`locklessSocket`/orphan
 * classes, all of which sit behind the 10s debris grace and would each cost this suite a stall.
 * `deadPid` (the sweep working) and `foreignPid` (the EPERM hole it cannot close) are the two the
 * phase's claims rest on, and both are asserted below.
 *
 * ── THE TWO CONSTRAINTS THAT MAKE THIS INSTRUMENTATION SAFE ─────────────────────────────────────
 * 1. IT MAY NEVER SPEAK. The TUI owns the terminal and R35-ALWAYS.2 asserts a default-on session's
 *    streams are indistinguishable from a feature-off run, so the first test pairs a default-on run
 *    against a `--no-attachable` control and compares the whole stream after the declared
 *    normalizations. A pty MERGES fd 1 and fd 2 onto one device, which is exactly what is wanted
 *    here: one comparison covers stdout AND stderr, and any byte the recorder emitted on either
 *    would fail it.
 * 2. IT MAY NEVER THROW. Every seam swallows; the session is what matters. That is not directly
 *    observable from outside, so it is carried by the exit codes asserted throughout: a seam that
 *    threw would take the session with it.
 *
 * ── NORMALIZATIONS, DECLARED ────────────────────────────────────────────────────────────────────
 * Byte identity between two interactive runs is unsatisfiable (terminal capability queries split
 * writes differently between any two runs), so the comparison is over: OSC/CSI/short escapes
 * stripped, CR/CRLF collapsed to LF, and UUIDs, this run's own directories, `PID <n>` and `<n>ms`
 * replaced by fixed tokens. The full argument for each rule is in `default-on-degrade-identity.
 * e2e.test.ts`, which owns the R35-ALWAYS.2 regression; this file reuses the same normalizer for
 * the narrower claim that RECORDING added nothing to either stream.
 *
 * ── WHY THE READER IS HAND-ROLLED HERE ──────────────────────────────────────────────────────────
 * `soak/soak-reader.ts` exists and works, and it is deliberately NOT used: it shares a module with
 * the writer, so a bug in the field names they agree on would be invisible to a test built on it.
 * Twelve lines of `JSON.parse` per line answer the same question with no shared assumption beyond
 * "one JSON object per line", which is the file-format contract itself.
 *
 * ── HARNESS HYGIENE ─────────────────────────────────────────────────────────────────────────────
 *  • Sandboxes sit DIRECTLY under /tmp with short names: a Unix socket path over ~104 bytes fails
 *    to bind with EINVAL, and macOS `os.tmpdir()` spends ~50 characters before a uuid.
 *  • The child environment is BUILT, never filtered: this repo's shell exports
 *    `DRAHT_PERMISSION_MODE=auto`, which silently changes what a session asks.
 *  • Both proxy variables point at a closed port, and no credential of any kind is passed.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..");
const EMITTED_CLI = path.join(PKG_ROOT, "dist", "cli.js");

/** A port nothing listens on: any outbound HTTP a child attempts must fail loudly. */
const DEAD_PROXY = "http://127.0.0.1:1";

/** Fixed pty geometry. Terminal width decides where the TUI wraps; drift there is not signal. */
const PTY_COLS = 120;
const PTY_ROWS = 40;

/** The capability a client declares to be sent permission frames. Spelled out, not imported. */
const PERMISSION_RELAY_CAPABILITY = "permission-relay";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
let driverPath = "";

/**
 * Fork a pty, run a command in it until it exits or the deadline passes, and report how it died.
 *
 * Interactive mode is the ONLY mode default-on binds in (`resolveAppMode` returns "interactive"
 * only when stdin and stdout are both ttys), so a pty is not decoration: a plain pipe would test a
 * run that never reaches the seam. macOS `script -q` cannot stand in — it calls `tcgetattr` on its
 * own stdin and dies when the parent is not a terminal — so the pty is forked directly here.
 *
 * argv: <outfile> <cols> <rows> <timeoutSeconds> -- <cmd...>
 */
const PTY_DRIVER = String.raw`
import os, sys, pty, select, fcntl, termios, struct, signal, json, time

out_path = sys.argv[1]
cols, rows, timeout = int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
cmd = sys.argv[sys.argv.index("--") + 1:]

pid, master = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
    os._exit(127)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

buf = b""
deadline = time.time() + timeout
eof = False
while time.time() < deadline:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
        try:
            data = os.read(master, 65536)
        except OSError:
            eof = True
            break
        if not data:
            eof = True
            break
        buf += data
killed = False
if not eof:
    killed = True
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
_, status = os.waitpid(pid, 0)
open(out_path, "wb").write(buf)
result = {"eof": eof, "killed": killed}
if os.WIFSIGNALED(status):
    result["signal"] = os.WTERMSIG(status)
else:
    result["exit"] = os.WEXITSTATUS(status)
sys.stderr.write("RESULT " + json.dumps(result) + "\n")
`;

interface PtyResult {
	eof: boolean;
	killed: boolean;
	signal?: number;
	exit?: number;
	raw: string;
}

/** One run's private world: a fresh HOME, agent dir and working directory. */
interface Sandbox {
	root: string;
	home: string;
	agentDir: string;
	workDir: string;
	socketDir: string;
	soakDir: string;
}

async function createSandbox(name: string): Promise<Sandbox> {
	const root = await mkdtemp(path.join("/tmp", `t9-${name}-`));
	tempDirs.push(root);
	const home = path.join(root, "h");
	const agentDir = path.join(root, "a");
	const workDir = path.join(root, "w");
	for (const dir of [home, agentDir, workDir]) await mkdir(dir, { recursive: true });
	return {
		root,
		home,
		agentDir,
		workDir,
		socketDir: path.join(agentDir, "sockets"),
		soakDir: path.join(agentDir, "soak"),
	};
}

function childEnv(sandbox: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: sandbox.home,
		TMPDIR: sandbox.home,
		TERM: "xterm-256color",
		DRAHT_CODING_AGENT_DIR: sandbox.agentDir,
		DRAHT_STUB_PROVIDER: "1",
		HTTP_PROXY: DEAD_PROXY,
		HTTPS_PROXY: DEAD_PROXY,
		ALL_PROXY: DEAD_PROXY,
		...extra,
	};
}

function runProcess(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const watchdog = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (watchdog) clearTimeout(watchdog);
			reject(error);
		});
		child.on("close", (code) => {
			if (watchdog) clearTimeout(watchdog);
			resolve({ code, stdout, stderr });
		});
	});
}

/** Run the emitted binary inside a pty until it exits. */
async function runInPty(
	sandbox: Sandbox,
	cliArgs: string[],
	options: { env?: Record<string, string>; timeoutSeconds?: number } = {},
): Promise<PtyResult> {
	const outFile = path.join(sandbox.root, `pty-${Math.random().toString(36).slice(2)}.raw`);
	const result = await runProcess(
		"python3",
		[
			driverPath,
			outFile,
			String(PTY_COLS),
			String(PTY_ROWS),
			String(options.timeoutSeconds ?? 60),
			"--",
			process.execPath,
			EMITTED_CLI,
			"--provider",
			"draht-stub",
			"--model",
			"stub-1",
			...cliArgs,
		],
		{ cwd: sandbox.workDir, env: childEnv(sandbox, options.env), timeoutMs: 120_000 },
	);
	const line = result.stderr.split("\n").find((entry) => entry.startsWith("RESULT "));
	if (!line) throw new Error(`pty driver produced no result:\n${result.stderr}`);
	return {
		...(JSON.parse(line.slice("RESULT ".length)) as Omit<PtyResult, "raw">),
		raw: readFileSync(outFile, "utf8"),
	};
}

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[[0-9;?<>]*[a-zA-Z]/g;
const SHORT_ESCAPE = /\x1b[()][0-9A-Za-z]|\x1b[=><]/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** See this file's header: the declared normalizations, and nothing beyond them. */
function normalizeStream(raw: string, sandbox: Sandbox): string {
	let text = raw.replace(OSC, "").replace(CSI, "").replace(SHORT_ESCAPE, "");
	text = text.replace(/\r\n?/g, "\n");
	for (const [token, dir] of [
		["<work>", sandbox.workDir],
		["<agent>", sandbox.agentDir],
		["<home>", sandbox.home],
		["<root>", sandbox.root],
	] as const) {
		for (const variant of [dir, realpathSync(dir)]) text = text.split(variant).join(token);
	}
	text = text.replace(UUID, "<uuid>");
	text = text.replace(/\bPID \d+\b/g, "PID <pid>");
	text = text.replace(/\b\d+(?:\.\d+)?ms\b/g, "<ms>");
	return text;
}

/** A startup-benchmark run: the whole interactive path, which then exits 0 instead of waiting. */
const BENCHMARK_ENV = { DRAHT_STARTUP_BENCHMARK: "1" };

type Record_ = Record<string, unknown>;

/**
 * Every record the session half has written into this sandbox, in file order.
 *
 * Generations first (their names sort before the active file's, `-` < `.`), then the active file.
 * A line that will not parse is skipped rather than thrown on: the writer does not fsync, so the
 * final line of a file may legitimately be a torn tail.
 */
function soakRecords(sandbox: Sandbox): Record_[] {
	if (!existsSync(sandbox.soakDir)) return [];
	const files = readdirSync(sandbox.soakDir)
		.filter((name) => name.startsWith("session") && name.endsWith(".jsonl"))
		.sort();
	const records: Record_[] = [];
	for (const name of files) {
		for (const line of readFileSync(path.join(sandbox.soakDir, name), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			try {
				records.push(JSON.parse(line) as Record_);
			} catch {
				/* torn tail: the writer's declared, reader-tolerated failure mode */
			}
		}
	}
	return records;
}

function eventsOf(sandbox: Sandbox, event: string): Record_[] {
	return soakRecords(sandbox).filter((record) => record.event === event);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 45_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}

/** Wait for a record matching `match`, then return it. */
function waitForRecord(
	sandbox: Sandbox,
	match: (record: Record_) => boolean,
	what: string,
	timeoutMs?: number,
): Promise<Record_> {
	return until(() => soakRecords(sandbox).find(match), what, timeoutMs);
}

function socketFiles(sandbox: Sandbox): string[] {
	if (!existsSync(sandbox.socketDir)) return [];
	return readdirSync(sandbox.socketDir).sort();
}

/**
 * A `.sock`/`.lock` pair indistinguishable from a live session's, planted by the harness.
 *
 * A REAL listening socket, because the sweep `lstat`s it and a plain file wearing a `.sock`
 * name is a different debris class with a different disposal. The lock is the sweep's input
 * contract — pid, cwd, ISO creation time, owner start time — and `pid` is the whole point of
 * the fixture: `process.pid` makes a pair this uid reads as a live session of its own, while
 * pid 1 makes one it may look at and never touch.
 *
 * The start time is written as NOW, so the pair can never fall into the pre-boot debris class
 * and ownership is the only thing left that can decide its fate.
 */
async function plantSessionPair(sandbox: Sandbox, sessionId: string, pid: number): Promise<Server> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path.join(sandbox.socketDir, `${sessionId}.sock`), () => resolve());
	});
	writeFileSync(
		path.join(sandbox.socketDir, `${sessionId}.lock`),
		`${pid}\n${sandbox.workDir}\n${new Date().toISOString()}\n${Date.now()}\n`,
	);
	return server;
}

/**
 * A live `--attachable` session in rpc mode.
 *
 * rpc rather than a pty for every socket test: an EXPLICIT `--attachable` binds in every mode, so
 * no terminal is needed to reach the seams, and the child stays alive as long as its stdin is
 * open — which is what lets the log be read while the session is still running.
 */
async function startRpcSession(
	sandbox: Sandbox,
	sessionId: string,
	extraEnv: Record<string, string> = {},
): Promise<{ child: ChildProcess; socketPath: string }> {
	const child = spawn(
		process.execPath,
		[
			EMITTED_CLI,
			"--provider",
			"draht-stub",
			"--model",
			"stub-1",
			"--attachable",
			"--mode",
			"rpc",
			"--session-id",
			sessionId,
		],
		{ cwd: sandbox.workDir, env: childEnv(sandbox, extraEnv), stdio: ["pipe", "pipe", "pipe"] },
	);
	children.push(child);
	const socketPath = path.join(sandbox.socketDir, `${sessionId}.sock`);
	await until(() => (existsSync(socketPath) ? true : undefined), `session ${sessionId} to bind its socket`);
	return { child, socketPath };
}

/** A raw socket peer: the frames a real client sends, with nothing of the product's own code in it. */
class TestClient {
	readonly frames: Record_[] = [];
	#socket: Socket;
	#buffer = "";

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (chunk) => {
			this.#buffer += chunk.toString();
			const lines = this.#buffer.split("\n");
			this.#buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim() === "") continue;
				try {
					this.frames.push(JSON.parse(line) as Record_);
				} catch {
					/* not our problem here */
				}
			}
		});
		socket.on("error", () => {});
	}

	/**
	 * A connected peer that has sent NOTHING yet.
	 *
	 * Separate from {@link attach} because a refusal test cannot wait for
	 * `session_metadata`: a client the server turns away never gets one, and a
	 * harness that could only speak by attaching successfully could not reach the
	 * refusal seams at all.
	 */
	static async connect(socketPath: string): Promise<TestClient> {
		const socket = await new Promise<Socket>((resolve, reject) => {
			const candidate = connect(socketPath);
			candidate.once("connect", () => resolve(candidate));
			candidate.once("error", reject);
		});
		return new TestClient(socket);
	}

	static async attach(
		socketPath: string,
		clientId: string,
		options: { mode?: string; capabilities?: string[] } = {},
	): Promise<TestClient> {
		const client = await TestClient.connect(socketPath);
		client.send({
			type: "attach",
			clientId,
			mode: options.mode ?? "read-write",
			capabilities: options.capabilities ?? [PERMISSION_RELAY_CAPABILITY],
		});
		await client.waitFor((frame) => frame.type === "session_metadata", "session_metadata");
		return client;
	}

	send(message: Record_): void {
		this.#socket.write(`${JSON.stringify(message)}\n`);
	}

	waitFor(match: (frame: Record_) => boolean, what: string, timeoutMs = 45_000): Promise<Record_> {
		return until(() => this.frames.find(match), `frame: ${what}`, timeoutMs);
	}

	/** A graceful detach, exactly as `SocketClient.disconnect` sends it. */
	detach(clientId: string): void {
		this.send({ type: "detach", clientId });
		this.#socket.end();
	}

	close(): void {
		this.#socket.destroy();
	}
}

async function buildEmittedBinary(): Promise<void> {
	const result = await runProcess("bun", ["run", "build"], { cwd: PKG_ROOT, env: process.env });
	if (result.code !== 0) throw new Error(`build failed:\n${result.stdout}\n${result.stderr}`);
}

beforeAll(async () => {
	await buildEmittedBinary();
	const driverDir = await mkdtemp(path.join("/tmp", "t9-drv-"));
	tempDirs.push(driverDir);
	driverPath = path.join(driverDir, "ptydrive.py");
	writeFileSync(driverPath, PTY_DRIVER);
}, 300_000);

afterAll(async () => {
	for (const child of children.splice(0)) {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("the emitted binary records the socket seams (R35-ALWAYS.11)", () => {
	test("a default-on session records bind and teardown, and says nothing on either stream", async () => {
		const off = await createSandbox("off");
		const on = await createSandbox("on");
		const control = await runInPty(off, ["--no-attachable"], { env: BENCHMARK_ENV });
		const defaulted = await runInPty(on, [], { env: BENCHMARK_ENV });

		expect(control.exit, `control run: ${JSON.stringify(control)}`).toBe(0);
		// A seam that threw would take the session with it; this exit code is that claim.
		expect(defaulted.exit, `default-on run: ${JSON.stringify(defaulted)}`).toBe(0);

		// CONSTRAINT 1: the recorder is silent. The pty merges fd 1 and fd 2, so this single
		// comparison covers stdout AND stderr — a stray byte from either fails it.
		expect(normalizeStream(defaulted.raw, on)).toBe(normalizeStream(control.raw, off));
		// And the comparison is not vacuous: the run really did paint a session.
		expect(normalizeStream(defaulted.raw, on)).toContain("draht");
		expect(normalizeStream(defaulted.raw, on).length).toBeGreaterThan(2000);

		// The feature-off run has no socket, therefore no seam, therefore no log at all. That is
		// what makes the log below attributable to the bind rather than to merely starting draht.
		expect(existsSync(off.soakDir)).toBe(false);

		const binds = eventsOf(on, "socket_bind");
		expect(binds).toHaveLength(1);
		const bind = binds[0];
		expect(typeof bind.sessionId).toBe("string");
		expect((bind.sessionId as string).length).toBeGreaterThan(10);
		expect(typeof bind.rss).toBe("number");
		expect(bind.rss as number).toBeGreaterThan(0);
		expect(typeof bind.startupDeltaMs).toBe("number");
		expect(bind.startupDeltaMs as number).toBeGreaterThan(0);
		expect(typeof bind.pid).toBe("number");
		expect(bind.v).toBe(1);

		const teardowns = eventsOf(on, "socket_teardown");
		expect(teardowns).toHaveLength(1);
		expect(teardowns[0].sessionId).toBe(bind.sessionId);
		expect(teardowns[0].pid).toBe(bind.pid);
		// Whichever exit path ran, the record says which one — that is the field's whole job.
		expect(["stop", "stopSync"]).toContain(teardowns[0].exitPath);
		// The socket did not outlive the process, and the teardown record is the log's account of it.
		expect(socketFiles(on)).toEqual([]);
	}, 300_000);

	test("attaching and detaching a client is recorded on both edges, under the same session id", async () => {
		const sandbox = await createSandbox("attach");
		const sessionId = "01a02700-0000-7000-8000-00000000a11a";
		const { child, socketPath } = await startRpcSession(sandbox, sessionId);
		try {
			const client = await TestClient.attach(socketPath, "t9-peer");

			const attach = await waitForRecord(
				sandbox,
				(record) => record.event === "client_attach" && record.clientId === "t9-peer",
				"the client_attach record",
			);
			expect(attach.sessionId).toBe(sessionId);
			expect(attach.mode).toBe("read-write");
			expect(attach.clientCount).toBe(1);
			expect(attach.capabilities).toEqual([PERMISSION_RELAY_CAPABILITY]);

			client.detach("t9-peer");

			const detach = await waitForRecord(
				sandbox,
				(record) => record.event === "client_detach" && record.clientId === "t9-peer",
				"the client_detach record",
			);
			// The join Phase 39 makes: same session, same client, one edge each.
			expect(detach.sessionId).toBe(sessionId);
			expect(detach.clientCount).toBe(0);
			expect(typeof detach.connectedMs).toBe("number");
			expect(eventsOf(sandbox, "client_attach")).toHaveLength(1);
			expect(eventsOf(sandbox, "client_detach")).toHaveLength(1);
			client.close();
		} finally {
			child.kill("SIGKILL");
		}
	}, 180_000);

	test("a prompt sent mid-turn is recorded as prompt_rejected with its code", async () => {
		const sandbox = await createSandbox("queue");
		const sessionId = "01a02700-0000-7000-8000-00000000d0e5";
		// Paced output, so the second prompt lands while the first turn is still streaming. Without
		// the pacing knob the stub answers faster than a socket round trip and nothing is ever queued.
		// The stub echoes the prompt, so a long first prompt at 5 tokens/s streams for well over ten
		// seconds: enough that a loaded machine cannot finish the turn before the second prompt lands.
		const { child, socketPath } = await startRpcSession(sandbox, sessionId, {
			DRAHT_STUB_PROVIDER_TOKENS_PER_SECOND: "5",
		});
		try {
			const client = await TestClient.attach(socketPath, "t9-writer");
			const first = Array.from(
				{ length: 6 },
				(_, i) =>
					`clause ${i + 1}: the first prompt is deliberately long so that it is still streaming when the second lands`,
			).join("; ");
			client.send({ type: "input", data: first, clientId: "t9-writer" });
			await client.waitFor((frame) => frame.type === "output", "the first reply to start streaming");

			const second = "the second prompt arrives mid-turn";
			client.send({ type: "input", data: second, clientId: "t9-writer" });
			const notice = await client.waitFor(
				(frame) => frame.type === "error" && frame.code === "PROMPT_QUEUED",
				"the client-visible queue notice",
			);
			expect(notice.code).toBe("PROMPT_QUEUED");

			// The record exists for the same event the client was told about.
			const rejected = await waitForRecord(
				sandbox,
				(record) => record.event === "prompt_rejected" && record.code === "PROMPT_QUEUED",
				"the prompt_rejected record",
			);
			expect(rejected.sessionId).toBe(sessionId);
			expect(rejected.clientId).toBe("t9-writer");
			// LENGTH, never the text: this log is kept for weeks and read by a tool.
			expect(rejected.promptChars).toBe(second.length);
			expect(Object.keys(rejected)).not.toContain("prompt");
			expect(JSON.stringify(rejected)).not.toContain("arrives mid-turn");
			client.close();
		} finally {
			child.kill("SIGKILL");
		}
	}, 300_000);

	test("records survive process exit: two runs against one agent dir are both readable", async () => {
		// The whole point of a file. A soak verdict is read after the session that wrote it is
		// long gone, and the second run must APPEND rather than start the evidence over.
		const sandbox = await createSandbox("restart");
		const first = await runInPty(sandbox, [], { env: BENCHMARK_ENV });
		expect(first.exit, `first run: ${JSON.stringify(first)}`).toBe(0);
		const afterFirst = soakRecords(sandbox);
		expect(afterFirst.length).toBeGreaterThan(0);

		const second = await runInPty(sandbox, [], { env: BENCHMARK_ENV });
		expect(second.exit, `second run: ${JSON.stringify(second)}`).toBe(0);

		const binds = eventsOf(sandbox, "socket_bind");
		expect(binds).toHaveLength(2);
		// Two processes, two sessions — and the first run's line is still there byte for byte.
		expect(binds[0].pid).not.toBe(binds[1].pid);
		expect(binds[0].sessionId).not.toBe(binds[1].sessionId);
		expect(eventsOf(sandbox, "socket_teardown")).toHaveLength(2);
		expect(soakRecords(sandbox).slice(0, afterFirst.length)).toEqual(afterFirst);
	}, 300_000);

	test("heartbeats carry the fd and directory gauges, agree with an independent readdir, and repeat", async () => {
		const sandbox = await createSandbox("beat");
		const sessionId = "01a02700-0000-7000-8000-00000000bea7";
		const { child } = await startRpcSession(sandbox, sessionId);
		try {
			const beat = await waitForRecord(sandbox, (record) => record.event === "heartbeat", "a heartbeat record");
			// Taken while the session is ALIVE, so the directory still holds what the gauge counted.
			// After a clean exit both are zero and the comparison would prove nothing.
			const files = socketFiles(sandbox);
			const socks = files.filter((name) => name.endsWith(".sock")).length;
			const locks = files.filter((name) => name.endsWith(".lock")).length;
			expect(socks).toBe(1);
			expect(locks).toBe(1);

			expect(beat.sessionId).toBe(sessionId);
			expect(beat.sockCount).toBe(socks);
			expect(beat.lockCount).toBe(locks);
			expect(typeof beat.fdGauge).toBe("number");
			expect(beat.fdGauge as number).toBeGreaterThan(0);
			expect(typeof beat.rss).toBe("number");
			expect(beat.rss as number).toBeGreaterThan(0);
			expect(beat.clientCount).toBe(0);

			// ── AND IT KEEPS BEATING ────────────────────────────────────────────────────
			// The bind writes ONE heartbeat inline, before starting the interval. Everything
			// above is satisfied by that single record, so `startHeartbeat()` could be deleted
			// outright and nothing would notice — while a soak's whole use for the gauges is
			// the SERIES: "did fds grow over six days" and "was there a wall-clock gap where
			// the lid was shut" are questions only a second sample can answer.
			//
			// This costs a minute of wall clock, deliberately and knowingly: the interval is
			// 60s and takes no env override, so the only honest way to witness a periodic
			// timer is to wait for a period. The alternative — asserting the timer was armed
			// — is a claim about the writer, which its own Class-2 suite already owns.
			const later = await waitForRecord(
				sandbox,
				(record) => record.event === "heartbeat" && (record.wall as number) > (beat.wall as number),
				"a SECOND heartbeat, from the interval rather than the bind",
				150_000,
			);
			expect(later.sessionId).toBe(sessionId);
			expect(later.pid).toBe(beat.pid);
			// A whole period apart, which is what says this came from the interval and not
			// from some second seam that happens to write one more heartbeat at startup.
			expect((later.wall as number) - (beat.wall as number)).toBeGreaterThan(50_000);
			// The monotonic clock agrees with the wall clock: on an unsuspended host the two
			// gaps match, and this is the baseline a real lid-close would be read against.
			expect((later.mono as number) - (beat.mono as number)).toBeGreaterThan(50_000);
			// Still measuring the same live session, not replaying stale numbers.
			expect(later.sockCount).toBe(1);
			expect(later.lockCount).toBe(1);
			expect(later.fdGauge as number).toBeGreaterThan(0);
		} finally {
			child.kill("SIGKILL");
		}
	}, 300_000);

	test("a SIGKILLed session's debris is reaped by the next start, and the sweep is in the log", async () => {
		// THE RECORD PHASE 39 CANNOT DO WITHOUT. "Zero orphaned .sock/.lock pairs after seven days"
		// asked of the directory at verdict time is unfalsifiable — a sweep that ran on day two has
		// already removed its own evidence. Asked of the log, it is a countable claim.
		const sandbox = await createSandbox("reap");
		const doomed = "01a02700-0000-7000-8000-00000000dead";
		const survivor = "01a02700-0000-7000-8000-00000000a11e";

		const first = await startRpcSession(sandbox, doomed);
		const exited = new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
		first.child.kill("SIGKILL");
		await exited;

		// SIGKILL runs no handler, so the pair is still on disk: two files, one dead owner.
		expect(socketFiles(sandbox)).toEqual([`${doomed}.lock`, `${doomed}.sock`]);

		const second = await startRpcSession(sandbox, survivor);
		try {
			const reaped = await waitForRecord(
				sandbox,
				(record) => record.event === "sockets_reaped",
				"the sockets_reaped record",
			);
			// COUNTED IN FILES, which is what the directory listing above counts: the pair went.
			expect(reaped.count).toBe(2);
			expect(reaped.sessionId).toBe(survivor);
			// The reason code matters as much as the count: "reaped, dead pid" is a sweep working,
			// while a rising "skipped, foreign uid" would be the EPERM hole that no sweep can close.
			expect((reaped.reaped as Record_).deadPid).toBe(2);
			expect(reaped.skippedCount).toBe(0);
			expect((reaped.skipped as Record_).foreignPid).toBe(0);
			// And the directory agrees: the dead pair is gone, the live one is published.
			expect(socketFiles(sandbox)).toEqual([`${survivor}.lock`, `${survivor}.sock`]);
		} finally {
			second.child.kill("SIGKILL");
		}
	}, 240_000);

	test("a read-only, capability-less peer is recorded on both edges — the peer the obvious seam would have lost", async () => {
		// THE JUDGEMENT CALL THIS TASK MADE, ASKED OF THE BINARY. The plan named
		// `onAttachReplay` as the `client_attach` seam. That hook is gated on
		// `#mayReceivePermissionFrames`, so this client — read-only, declaring nothing —
		// would have reached the DETACH record and never the ATTACH one, and Phase 39
		// counts attaches against detaches. Every other test in this file attaches a
		// read-write peer carrying the permission capability, which is exactly the client
		// the gate lets through: put the gate back and they all still pass.
		const sandbox = await createSandbox("ro");
		const sessionId = "01a02700-0000-7000-8000-0000000000f0";
		const { child, socketPath } = await startRpcSession(sandbox, sessionId);
		try {
			const client = await TestClient.attach(socketPath, "t9-lurker", { mode: "read-only", capabilities: [] });

			const attach = await waitForRecord(
				sandbox,
				(record) => record.event === "client_attach" && record.clientId === "t9-lurker",
				"the client_attach record for a peer the replay hook never sees",
			);
			expect(attach.sessionId).toBe(sessionId);
			expect(attach.mode).toBe("read-only");
			// Recorded as declared, not as assumed: [] is what an older client sends, and it
			// is the value that decides whether this peer can be handed a permission frame.
			expect(attach.capabilities).toEqual([]);
			expect(attach.clientCount).toBe(1);

			// A refusal that carries `requestId` — the join key Phase 39 reads this log for.
			// A read-only peer may watch a dialog and may never answer one.
			const requestId = "t9-req-read-only";
			client.send({ type: "permission_response", clientId: "t9-lurker", requestId, optionId: "allow" });
			await client.waitFor(
				(frame) => frame.type === "error" && frame.code === "PERMISSION_READ_ONLY",
				"the client-visible read-only refusal",
			);
			const refused = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.code === "PERMISSION_READ_ONLY",
				"the client_rejected record for the refused answer",
			);
			expect(refused.reason).toBe("permission_read_only");
			expect(refused.sessionId).toBe(sessionId);
			expect(refused.clientId).toBe("t9-lurker");
			expect(refused.requestId).toBe(requestId);
			// The decision itself is the session store's business; this log holds the join
			// key and nothing that would let it be mistaken for a record of the outcome.
			expect(Object.keys(refused)).not.toContain("optionId");

			client.detach("t9-lurker");
			const detach = await waitForRecord(
				sandbox,
				(record) => record.event === "client_detach" && record.clientId === "t9-lurker",
				"the client_detach record",
			);
			expect(detach.mode).toBe("read-only");
			// SYMMETRY, which is the whole claim: one attach, one detach, for a client that
			// the gated seam would have given a detach and no attach.
			expect(eventsOf(sandbox, "client_attach")).toHaveLength(1);
			expect(eventsOf(sandbox, "client_detach")).toHaveLength(1);
			client.close();
		} finally {
			child.kill("SIGKILL");
		}
	}, 180_000);

	test("every refusal a connected peer can provoke is recorded with its reason", async () => {
		// `client_rejected` is the most deletable thing this task added: nothing about a
		// refusal survives into the directory, the streams or the exit code, so the ONLY
		// evidence a refusal ever happened is the record. All of these seams could be
		// early-returned together and the rest of this file would stay green.
		const sandbox = await createSandbox("refuse");
		const sessionId = "01a02700-0000-7000-8000-0000000000fe";
		const { child, socketPath } = await startRpcSession(sandbox, sessionId);
		try {
			const seated = await TestClient.attach(socketPath, "t9-seated");
			await waitForRecord(
				sandbox,
				(record) => record.event === "client_attach" && record.clientId === "t9-seated",
				"the seated client's attach",
			);

			// (1) A mode outside the closed set. `banana` is refused rather than treated as
			// read-write, and the log says which value was offered.
			const oddMode = await TestClient.connect(socketPath);
			oddMode.send({ type: "attach", clientId: "t9-odd-mode", mode: "banana", capabilities: [] });
			const modeRecord = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.reason === "unknown_client_mode",
				"the unknown_client_mode record",
			);
			expect(modeRecord.code).toBe("UNKNOWN_CLIENT_MODE");
			expect(modeRecord.clientId).toBe("t9-odd-mode");
			expect(modeRecord.mode).toBe("banana");
			expect(modeRecord.sessionId).toBe(sessionId);
			oddMode.close();

			// (2) A second peer claiming an id that is already seated. Counted because a
			// week of these is a client that reconnects without changing its id, which
			// looks like churn in the attach/detach series and is not.
			const twin = await TestClient.connect(socketPath);
			twin.send({ type: "attach", clientId: "t9-seated", mode: "read-write", capabilities: [] });
			const twinRecord = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.reason === "duplicate_client_id",
				"the duplicate_client_id record",
			);
			expect(twinRecord.clientId).toBe("t9-seated");
			expect(twinRecord.clientCount).toBe(1);
			twin.close();

			// (3) A frame this build has never heard of: version skew, in the direction a
			// renderer causes it.
			seated.send({ type: "t9-from-the-future", clientId: "t9-seated" });
			const skew = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.reason === "unknown_message_type",
				"the unknown_message_type record",
			);
			expect(skew.code).toBe("UNKNOWN_MESSAGE_TYPE");
			expect(skew.messageType).toBe("t9-from-the-future");

			// (4) An answer from a socket that never attached at all. No client entry, so
			// nothing but this record would ever show that an answer was thrown away.
			const stranger = await TestClient.connect(socketPath);
			stranger.send({
				type: "permission_response",
				clientId: "t9-stranger",
				requestId: "t9-req-stranger",
				optionId: "allow",
			});
			const strangerRecord = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.code === "PERMISSION_NOT_ATTACHED",
				"the permission_not_attached record",
			);
			expect(strangerRecord.reason).toBe("permission_not_attached");
			expect(strangerRecord.requestId).toBe("t9-req-stranger");
			stranger.close();

			// (5) An attached, writable peer that never declared the relay capability, so it
			// was never SENT the ask it is claiming to answer.
			const mute = await TestClient.attach(socketPath, "t9-mute", { capabilities: [] });
			mute.send({
				type: "permission_response",
				clientId: "t9-mute",
				requestId: "t9-req-mute",
				optionId: "allow",
			});
			const muteRecord = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.code === "PERMISSION_NOT_CAPABLE",
				"the permission_not_capable record",
			);
			expect(muteRecord.reason).toBe("permission_not_capable");
			expect(muteRecord.clientId).toBe("t9-mute");
			expect(muteRecord.requestId).toBe("t9-req-mute");

			// (6) The per-session client ceiling. Filled by attaching until one is turned
			// away rather than against a hardcoded 10: the number is the product's to
			// choose, the refusal is what has to be countable.
			const fillers: TestClient[] = [];
			let refusedAt = -1;
			for (let index = 0; index < 24 && refusedAt < 0; index++) {
				const filler = await TestClient.connect(socketPath);
				fillers.push(filler);
				filler.send({ type: "attach", clientId: `t9-fill-${index}`, mode: "read-only", capabilities: [] });
				const answer = await filler.waitFor(
					(frame) => frame.type === "session_metadata" || frame.type === "error",
					`filler ${index} to be seated or turned away`,
				);
				if (answer.type === "error") refusedAt = index;
			}
			expect(refusedAt, "no filler was ever refused: the client ceiling was never reached").toBeGreaterThan(0);
			const full = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.reason === "max_clients",
				"the max_clients record",
			);
			expect(full.clientId).toBe(`t9-fill-${refusedAt}`);
			// The ceiling and the count that hit it, so a verdict can tell "the product's
			// limit" from "a leak of client entries".
			expect(full.clientCount).toBe(full.maxClients);
			expect(full.maxClients as number).toBeGreaterThan(0);
			for (const filler of fillers) filler.close();

			// Every one of these is a refusal — a `warn`, never an `info`, because a soak
			// verdict reads levels before it reads reasons.
			const refusals = eventsOf(sandbox, "client_rejected");
			expect(new Set(refusals.map((record) => record.reason))).toEqual(
				new Set([
					"unknown_client_mode",
					"duplicate_client_id",
					"unknown_message_type",
					"permission_not_attached",
					"permission_not_capable",
					"max_clients",
				]),
			);
			expect(new Set(refusals.map((record) => record.level))).toEqual(new Set(["warn"]));
			seated.close();
			mute.close();
		} finally {
			child.kill("SIGKILL");
		}
	}, 300_000);

	test("a second draht refused the session id it wanted is recorded by the process that was refused", async () => {
		// The busy twin — `draht -c` in a second terminal — is the commonest default-on
		// refusal there is, and it is the one that leaves NOTHING behind: no socket, no
		// bind record, and a process that is gone seconds later. The refusal is written by
		// the LOSER, into the same agent dir the winner is writing to, which is what makes
		// it readable at verdict time at all.
		const sandbox = await createSandbox("busy");
		const sessionId = "01a02700-0000-7000-8000-0000000000b5";
		const { child } = await startRpcSession(sandbox, sessionId);
		try {
			const twin = await runProcess(
				process.execPath,
				[
					EMITTED_CLI,
					"--provider",
					"draht-stub",
					"--model",
					"stub-1",
					"--attachable",
					"--mode",
					"rpc",
					"--session-id",
					sessionId,
				],
				{ cwd: sandbox.workDir, env: childEnv(sandbox), timeoutMs: 90_000 },
			);
			// An EXPLICIT --attachable is fatal when it cannot be honoured, which is the
			// only reason this refusal is observable from outside at all.
			expect(twin.code, `twin: ${twin.stdout}\n${twin.stderr}`).toBe(1);

			const busy = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.reason === "session_busy",
				"the session_busy record",
			);
			expect(busy.sessionId).toBe(sessionId);
			// Whose process is holding it: the winner's pid, recorded by the loser. The
			// record is written by a DIFFERENT process from the one that owns the socket,
			// so its own `pid` field is the twin's and must not be the owner's.
			expect(busy.ownerPid).toBe(child.pid);
			expect(busy.pid).not.toBe(child.pid);
			expect(busy.level).toBe("warn");
			// The loser refused before binding, so it contributed no bind of its own.
			expect(eventsOf(sandbox, "socket_bind")).toHaveLength(1);
			expect(socketFiles(sandbox)).toEqual([`${sessionId}.lock`, `${sessionId}.sock`]);
		} finally {
			child.kill("SIGKILL");
		}
	}, 300_000);

	test("a session switch is recorded as a rebind, naming the session that was dropped", async () => {
		// /new, /resume, /fork and /import replace the session object, and the socket
		// follows. A rebind is NOT a bind: every attached client was just dropped, which is
		// indistinguishable from a crash-and-restart in a directory listing and is only
		// distinguishable in the log because this record names its predecessor.
		const sandbox = await createSandbox("rebind");
		const sessionId = "01a02700-0000-7000-8000-0000000000cb";
		const { child, socketPath } = await startRpcSession(sandbox, sessionId);
		try {
			const client = await TestClient.attach(socketPath, "t9-follower");
			await waitForRecord(
				sandbox,
				(record) => record.event === "client_attach" && record.clientId === "t9-follower",
				"the attach that is about to be dropped",
			);

			// The rpc surface's own `/new`: the same runtime seam the TUI's slash command
			// reaches, driven over the protocol the emitted binary actually speaks.
			child.stdin?.write(`${JSON.stringify({ id: "t9-new", type: "new_session" })}\n`);

			const rebind = await waitForRecord(
				sandbox,
				(record) => record.event === "socket_rebind",
				"the socket_rebind record",
			);
			expect(rebind.outcome).toBe("bound");
			expect(rebind.previousSessionId).toBe(sessionId);
			// Stamped with the id it rebound TO, so the two ids in one record are what lets
			// a verdict stitch the session's two halves together.
			expect(rebind.sessionId).not.toBe(sessionId);
			expect(typeof rebind.sessionId).toBe("string");
			expect(typeof rebind.socketPath).toBe("string");
			expect(rebind.startupDeltaMs as number).toBeGreaterThan(0);
			// And it is NOT counted as a bind: one process, one bind, however many sessions
			// it hosted. A rebind recorded as a bind would read as a restart that never
			// happened.
			expect(eventsOf(sandbox, "socket_bind")).toHaveLength(1);
			// The dropped client is told, and its detach is recorded like any other.
			await client.waitFor(
				(frame) => frame.type === "error" && frame.code === "SESSION_REPLACED",
				"the client-visible replacement notice",
			);
			client.close();
		} finally {
			child.kill("SIGKILL");
		}
	}, 300_000);

	test("debris this uid may not touch is recorded as SKIPPED, not as reaped", async () => {
		// The reap test above asserts `skippedCount: 0` — a field that is zero in every
		// other test in this file, and which a sweep that never counted a skip at all would
		// also report as zero. This is the other half: a rising `foreignPid` is the EPERM
		// hole no sweep can close, and R35-ALWAYS.3 rests on it being visible rather than
		// silently reaped or silently listed as live.
		const sandbox = await createSandbox("skip");
		let planted: Server | undefined;
		let session: { child: ChildProcess } | undefined;
		try {
			// pid 1 is launchd/init: alive, and not signallable by this uid. If that is not
			// true here (running as root), the plant proves nothing — so it is asserted
			// rather than assumed.
			let ownership = "ours";
			try {
				process.kill(1, 0);
			} catch (error) {
				ownership = (error as NodeJS.ErrnoException).code === "EPERM" ? "foreign" : "dead";
			}
			expect(ownership, "pid 1 must be alive and NOT signallable by this uid for this test to mean anything").toBe(
				"foreign",
			);

			await mkdir(sandbox.socketDir, { recursive: true, mode: 0o700 });
			const foreign = "01a02700-0000-7000-8000-0000000000f1";
			planted = await plantSessionPair(sandbox, foreign, 1);

			const survivor = "01a02700-0000-7000-8000-0000000000f2";
			session = await startRpcSession(sandbox, survivor);
			const swept = await waitForRecord(sandbox, (record) => record.event === "sockets_reaped", "the sweep's tally");
			// NOTHING was removed, and the record exists anyway: a tally that only published
			// itself when it had deleted something would make this hole invisible.
			expect(swept.count).toBe(0);
			expect(swept.skippedCount).toBe(1);
			expect((swept.skipped as Record_).foreignPid).toBe(1);
			expect(swept.level).toBe("info");
			expect(swept.sessionId).toBe(survivor);
			// And the directory agrees: the foreign pair is untouched (O2), and it was not
			// listed as a session of ours either (O1).
			expect(socketFiles(sandbox)).toEqual([
				`${foreign}.lock`,
				`${foreign}.sock`,
				`${survivor}.lock`,
				`${survivor}.sock`,
			]);
			expect(swept.live).toBe(0);
		} finally {
			session?.child.kill("SIGKILL");
			planted?.close();
		}
	}, 240_000);

	test("the live-socket ceiling refuses a bind, and the refusal is the ONLY trace that bind leaves", async () => {
		// The last of the seven refusal seams, and the one a soak exists to see: the cap is
		// what stops an unbounded socket directory, so a week in which it fired is a week
		// that hit the ceiling — and a refused bind leaves NO socket, NO bind record and a
		// process that is gone a second later. Nothing else in this file reaches it.
		//
		// Reached WITHOUT 64 draht processes: the cap counts live pairs on disk, and a pair
		// is live if its lock names a signallable pid of this uid. This test process is
		// exactly that, so the ceiling is filled with fixtures rather than with sessions.
		const sandbox = await createSandbox("cap");
		const planted: Server[] = [];
		try {
			await mkdir(sandbox.socketDir, { recursive: true, mode: 0o700 });
			// The product's number, not the test's: the record carries the cap it enforced,
			// and the assertion below compares it against how many pairs were planted, so a
			// changed ceiling fails here loudly instead of silently skipping the refusal.
			const CAP = 64;
			for (let index = 0; index < CAP; index++) {
				const id = `01a02700-0000-7000-8000-${String(index).padStart(12, "0")}`;
				planted.push(await plantSessionPair(sandbox, id, process.pid));
			}

			const refused = "01a02700-0000-7000-8000-0000000000ca";
			const twin = await runProcess(
				process.execPath,
				[
					EMITTED_CLI,
					"--provider",
					"draht-stub",
					"--model",
					"stub-1",
					"--attachable",
					"--mode",
					"rpc",
					"--session-id",
					refused,
				],
				{ cwd: sandbox.workDir, env: childEnv(sandbox), timeoutMs: 90_000 },
			);
			expect(twin.code, `refused session: ${twin.stdout}\n${twin.stderr}`).toBe(1);

			const capped = await waitForRecord(
				sandbox,
				(record) => record.event === "client_rejected" && record.reason === "socket_cap_reached",
				"the socket_cap_reached record",
			);
			expect(capped.sessionId).toBe(refused);
			// Both numbers, because "we are at the ceiling" and "the ceiling is 64" are
			// different facts and a verdict needs to tell a raised cap from a leak.
			expect(capped.cap).toBe(CAP);
			expect(capped.liveSockets).toBe(CAP);
			expect(capped.level).toBe("warn");
			// It never bound: no socket of its own, and no bind record to pair a teardown with.
			expect(eventsOf(sandbox, "socket_bind")).toHaveLength(0);
			expect(socketFiles(sandbox)).not.toContain(`${refused}.sock`);
		} finally {
			for (const server of planted) server.close();
		}
	}, 240_000);
});
