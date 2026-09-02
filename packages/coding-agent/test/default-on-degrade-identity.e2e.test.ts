/**
 * R35-ALWAYS.1 + R35-ALWAYS.2 — default-on socket registration, and the promise that turning it
 * on changes nothing an operator can see and never prevents a session starting.
 *
 * EVIDENCE CLASS 3. Every assertion below drives `packages/coding-agent/dist/cli.js` — the emitted
 * binary, rebuilt in `beforeAll` — as a real child process. Interactive assertions drive it through
 * a REAL pty, because `resolveAppMode` returns "interactive" only when both stdin and stdout are
 * ttys, and default-on is gated on exactly that. An in-process test of the resolver would pass
 * while the shipped binary bound nothing, or bound everything.
 *
 * ── WHY THERE IS A PTY DRIVER IN THIS FILE ──────────────────────────────────────────────────────
 * There is no pty binding in this repo's dependency tree, and `script -q /dev/null …` cannot be
 * used from a test runner: macOS `script` calls `tcgetattr` on ITS OWN stdin and dies with
 * "Operation not supported on socket" when the parent is not a terminal (measured). So the driver
 * below forks a pty directly with Python's `pty` module, fixes the window size so geometry is not a
 * source of run-to-run drift, optionally waits for a substring and then types or signals, and
 * reports how the child died. It is deliberately dumb: it never interprets the stream, it only
 * records it.
 *
 * ── WHAT "BYTE-IDENTICALLY" MEANS HERE, AND WHY IT IS NOT BYTES ─────────────────────────────────
 * R35-ALWAYS.2 asks for byte identity between a default-on run and a feature-off run. Taken
 * literally that is unsatisfiable and therefore untestable: a pty stream carries terminal
 * capability queries and replies whose timing splits writes differently between runs, and rpc
 * stdout carries a fresh UUID per run. A test written against literal bytes could only ever be
 * made to pass by quietly weakening the comparison until it proved nothing.
 *
 * So the claim is restated as OBSERVABLY IDENTICAL MODULO DECLARED NORMALIZATIONS, and every
 * normalization is named here:
 *
 *   • OSC sequences (`\x1b]…BEL` / `\x1b]…ST`) and CSI sequences (`\x1b[…letter`) are stripped.
 *     These carry cursor moves, colour, window-title sets and terminal capability queries. They
 *     describe HOW the terminal was painted, not WHAT was said. Stripping them cannot hide the
 *     thing under test: the banner default-on used to print is plain text, and so is the degrade
 *     notice.
 *   • CR and CRLF collapse to LF, so "one more line" is a countable claim on a pty stream that
 *     doubles its line endings.
 *   • UUIDs, the run's own temp directories (home, agent dir, work dir, and their /private
 *     realpaths), `PID <n>` and `<n>ms` are replaced with fixed tokens. Each of these differs
 *     between ANY two runs, feature or no feature.
 *
 * And the harness is made falsifiable by asserting a CONTROL PAIR FIRST: two `--no-attachable`
 * runs, in different directories, must normalize to exactly the same text. If a future edit
 * weakens the normalizer into something that accepts everything, that test is what fails. The
 * sensitivity floor is demonstrated by the poisoned-directory case, which detects a difference of
 * exactly ONE line.
 *
 * Two scopes are deliberately NOT covered by the stream comparison, and both are recorded rulings
 * rather than gaps:
 *   • THE SESSION TRANSCRIPT changes, and that is accepted. Installing the permission relay makes
 *     the session write a `permission_resolution` row for every terminal tool-permission decision.
 *     An audit row for a decision that really happened is an improvement, not a regression. The
 *     test PINS the delta: `permission_resolution` rows are the ONLY difference — no other entry
 *     type, no reordering.
 *   • THE SOAK LOG (R35-ALWAYS.11) is exempt: it lives under `<agentDir>/soak/`, outside the
 *     session store, and records unconditionally. Without that exemption .2 and .11 contradict
 *     each other.
 *
 * ── HARNESS HYGIENE, each item paid for by a probe that proved nothing ──────────────────────────
 *  • `DRAHT_PERMISSION_MODE` is never inherited: the environment is BUILT, not filtered. This
 *    repo's interactive shell exports `auto`, under which the scripted `bash` call is auto-allowed
 *    and no permission ask — and therefore no `permission_resolution` row — is ever raised.
 *  • Every temp dir sits directly under `/tmp` with a short name. A Unix socket path over ~104
 *    bytes fails to bind with EINVAL, and macOS `os.tmpdir()` spends ~50 characters before a uuid.
 *  • `DRAHT_CODING_AGENT_DIR` is set for every child, which also disables first-time setup — a
 *    fresh HOME would otherwise open an interactive theme picker and hang the run.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const PKG_ROOT = path.resolve(__dirname, "..");
const EMITTED_CLI = path.join(PKG_ROOT, "dist", "cli.js");

/** A port nothing listens on: any outbound HTTP a child attempts must fail loudly. */
const DEAD_PROXY = "http://127.0.0.1:1";

/** Fixed pty geometry. Terminal width decides where the TUI wraps; drift here is not signal. */
const PTY_COLS = 120;
const PTY_ROWS = 40;

const tempDirs: string[] = [];
let driverPath = "";

/**
 * Fork a pty, run a command in it, optionally drive it, and report how it died.
 *
 * argv: <outfile> <stepsJson> <cols> <rows> <timeoutSeconds> -- <cmd...>
 * Each step is `{wait?: string, send?: string, signal?: string, delay?: number}`; `wait` is matched
 * against the stream with escape sequences REMOVED, because the TUI interleaves colour codes with
 * the very words a step waits for.
 */
const PTY_DRIVER = String.raw`
import os, sys, pty, select, fcntl, termios, struct, signal, json, time, re

ANSI = re.compile(rb'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>]*[a-zA-Z]')

out_path = sys.argv[1]
steps = json.loads(sys.argv[2])
cols, rows, timeout = int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5])
cmd = sys.argv[sys.argv.index("--") + 1:]

pid, master = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
    os._exit(127)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

buf = b""
deadline = time.time() + timeout
si = 0
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
    if si < len(steps):
        st = steps[si]
        want = st.get("wait")
        if want is None or want.encode() in ANSI.sub(b"", buf):
            time.sleep(st.get("delay", 0.4))
            if st.get("signal"):
                os.kill(pid, getattr(signal, st["signal"]))
            else:
                os.write(master, st.get("send", "").encode())
            si += 1
killed = False
if not eof:
    killed = True
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
_, status = os.waitpid(pid, 0)
open(out_path, "wb").write(buf)
result = {"steps": si, "wanted": len(steps), "eof": eof, "killed": killed}
if os.WIFSIGNALED(status):
    result["signal"] = os.WTERMSIG(status)
else:
    result["exit"] = os.WEXITSTATUS(status)
sys.stderr.write("RESULT " + json.dumps(result) + "\n")
`;

interface PtyStep {
	wait?: string;
	send?: string;
	signal?: string;
	delay?: number;
}

interface PtyResult {
	steps: number;
	wanted: number;
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
}

async function createSandbox(name: string): Promise<Sandbox> {
	const root = await mkdtemp(path.join("/tmp", `d35-${name}-`));
	tempDirs.push(root);
	const home = path.join(root, "h");
	const agentDir = path.join(root, "a");
	const workDir = path.join(root, "w");
	for (const dir of [home, agentDir, workDir]) await mkdir(dir, { recursive: true });
	return { root, home, agentDir, workDir, socketDir: path.join(agentDir, "sockets") };
}

/**
 * The child's entire environment, built from nothing rather than filtered from `process.env`.
 *
 * A filter can miss a provider key spelling or the ambient `DRAHT_PERMISSION_MODE`; a
 * from-scratch env cannot.
 */
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
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const watchdog = options.timeoutMs
			? setTimeout(() => {
					child.kill("SIGKILL");
				}, options.timeoutMs)
			: undefined;
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
		child.on("close", (code, signal) => {
			if (watchdog) clearTimeout(watchdog);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

/** Run the emitted binary inside a pty, driven by `steps`. */
async function runInPty(
	sandbox: Sandbox,
	cliArgs: string[],
	options: {
		steps?: PtyStep[];
		env?: Record<string, string>;
		timeoutSeconds?: number;
		/**
		 * Send fd 2 to this file instead of the pty, so the two streams can be told apart.
		 *
		 * A pty MERGES stdout and stderr by construction — one device on both descriptors — so
		 * the raw capture above can never answer "which stream said that?". Interactive mode is
		 * still required to reach the default-on path at all (it is gated on stdin AND stdout
		 * being ttys), and `resolveAppMode` never looks at fd 2, so redirecting only stderr
		 * leaves the run under test exactly as interactive as it was.
		 */
		stderrFile?: string;
	} = {},
): Promise<PtyResult> {
	const outFile = path.join(sandbox.root, `pty-${Math.random().toString(36).slice(2)}.raw`);
	const cliCommand = [process.execPath, EMITTED_CLI, "--provider", "draht-stub", "--model", "stub-1", ...cliArgs];
	// `sh -c <script> <name> <args...>` binds $0 to the interpreter path and $@ to the rest, so
	// the redirection is applied and then `exec` hands the pty straight to node — no shell left
	// in the process tree to change how the child dies.
	const command = options.stderrFile
		? ["/bin/sh", "-c", `exec "$0" "$@" 2>'${options.stderrFile}'`, ...cliCommand]
		: cliCommand;
	const result = await runProcess(
		"python3",
		[
			driverPath,
			outFile,
			JSON.stringify(options.steps ?? []),
			String(PTY_COLS),
			String(PTY_ROWS),
			String(options.timeoutSeconds ?? 60),
			"--",
			...command,
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
/** Charset-select and keypad-mode escapes; two bytes, no terminator, not covered by CSI. */
const SHORT_ESCAPE = /\x1b[()][0-9A-Za-z]|\x1b[=><]/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Escape sequences removed, nothing else touched. For streams that are not pty captures. */
function stripEscapes(text: string): string {
	return text.replace(OSC, "").replace(CSI, "").replace(SHORT_ESCAPE, "");
}

/**
 * Reduce a pty stream to the text a human would have read, with everything that differs between
 * any two runs replaced by a token. See this file's header for why each rule is here.
 */
function normalizeStream(raw: string, sandbox: Sandbox): string {
	let text = raw.replace(OSC, "").replace(CSI, "").replace(SHORT_ESCAPE, "");
	text = text.replace(/\r\n?/g, "\n");
	for (const [token, dir] of [
		["<work>", sandbox.workDir],
		["<agent>", sandbox.agentDir],
		["<home>", sandbox.home],
		["<root>", sandbox.root],
	] as const) {
		for (const variant of [dir, realpathSync(dir)]) {
			text = text.split(variant).join(token);
		}
	}
	text = text.replace(UUID, "<uuid>");
	text = text.replace(/\bPID \d+\b/g, "PID <pid>");
	text = text.replace(/\b\d+(?:\.\d+)?ms\b/g, "<ms>");
	return text;
}

function normalizedLines(raw: string, sandbox: Sandbox): string[] {
	return normalizeStream(raw, sandbox).split("\n");
}

function socketFiles(sandbox: Sandbox): string[] {
	if (!existsSync(sandbox.socketDir)) return [];
	return readdirSync(sandbox.socketDir).sort();
}

/**
 * Whether this run ever tried to publish itself.
 *
 * `<agentDir>/sockets` is created by `SocketServer.start()` and by nothing else on a session
 * start path, and it OUTLIVES the run — while the .sock and .lock inside it do not, because a
 * clean exit removes them. So "did the default bind?" is asked of the directory, and "was the
 * socket live, and did it die with the process?" is asked separately, by polling a session that
 * is still running (see the SIGINT test).
 */
function attemptedToPublish(sandbox: Sandbox): boolean {
	return existsSync(sandbox.socketDir);
}

function sessionEntries(sandbox: Sandbox): Record<string, unknown>[] {
	const sessionsRoot = path.join(sandbox.agentDir, "sessions");
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl") && !entry.name.endsWith(".checkpoints.jsonl")) files.push(full);
		}
	};
	if (existsSync(sessionsRoot)) walk(sessionsRoot);
	if (files.length !== 1) throw new Error(`expected exactly one session file, found ${files.length}: ${files.join()}`);
	return readFileSync(files[0], "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function buildEmittedBinary(): Promise<void> {
	const result = await runProcess("bun", ["run", "build"], { cwd: PKG_ROOT, env: process.env });
	if (result.code !== 0) throw new Error(`build failed:\n${result.stdout}\n${result.stderr}`);
}

/**
 * A startup-benchmark run: the real interactive path — TUI init, theme detection, the whole
 * startup banner — that then stops itself and exits 0 instead of waiting for input. It is the
 * only way to get a complete, terminating interactive run to compare.
 */
const BENCHMARK_ENV = { DRAHT_STARTUP_BENCHMARK: "1" };

beforeAll(async () => {
	await buildEmittedBinary();
	const driverDir = await mkdtemp(path.join("/tmp", "d35-drv-"));
	tempDirs.push(driverDir);
	driverPath = path.join(driverDir, "ptydrive.py");
	writeFileSync(driverPath, PTY_DRIVER);
}, 300_000);

afterAll(async () => {
	for (const dir of tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

describe("default-on socket registration is invisible and never fatal (R35-ALWAYS.1, R35-ALWAYS.2)", () => {
	test("CONTROL: two feature-off interactive runs normalize to exactly the same text", async () => {
		// FIRST, and deliberately so. Everything below compares normalized streams, so the
		// normalizer itself has to be shown to still distinguish runs rather than flatten them.
		// If somebody later widens a rule until it accepts anything, this is not the test that
		// fails — but it is the test that proves the baseline was ever meaningful.
		const one = await createSandbox("ctl1");
		const two = await createSandbox("ctl2");
		const first = await runInPty(one, ["--no-attachable"], { env: BENCHMARK_ENV });
		const second = await runInPty(two, ["--no-attachable"], { env: BENCHMARK_ENV });

		expect(first.exit, `first run: ${JSON.stringify(first)}`).toBe(0);
		expect(second.exit, `second run: ${JSON.stringify(second)}`).toBe(0);
		expect(normalizeStream(second.raw, two)).toBe(normalizeStream(first.raw, one));
		// And the normalizer did not simply erase the run.
		expect(normalizeStream(first.raw, one)).toContain("draht");
		expect(normalizeStream(first.raw, one).length).toBeGreaterThan(2000);
		expect(socketFiles(one)).toEqual([]);
	}, 180_000);

	test("default-on with a healthy socket directory is indistinguishable from --no-attachable", async () => {
		const off = await createSandbox("off");
		const on = await createSandbox("on");
		const control = await runInPty(off, ["--no-attachable"], { env: BENCHMARK_ENV });
		const defaulted = await runInPty(on, [], { env: BENCHMARK_ENV });

		expect(control.exit).toBe(0);
		expect(defaulted.exit).toBe(0);
		// It really did register — otherwise "identical" would be trivially true. The socket
		// itself is gone by now: a clean exit removes the .sock and .lock, which is the point.
		expect(attemptedToPublish(off)).toBe(false);
		expect(attemptedToPublish(on)).toBe(true);
		expect(socketFiles(on)).toEqual([]);
		expect(normalizeStream(defaulted.raw, on)).toBe(normalizeStream(control.raw, off));
	}, 180_000);

	test("a poisoned socket directory costs exactly one line and the session still starts", async () => {
		const off = await createSandbox("pois-off");
		const broken = await createSandbox("pois-on");
		// `sockets` is a FILE, so `mkdir` throws EEXIST. Before this task that killed the session:
		// main.ts caught everything from makeSessionAttachable and called process.exit(1).
		writeFileSync(path.join(broken.agentDir, "sockets"), "x");

		const control = await runInPty(off, ["--no-attachable"], { env: BENCHMARK_ENV });
		const degraded = await runInPty(broken, [], { env: BENCHMARK_ENV });

		// THE REQUIREMENT: a registration failure never prevents a session starting.
		expect(degraded.exit, `degraded run: ${JSON.stringify(degraded)}`).toBe(0);

		const controlLines = normalizedLines(control.raw, off);
		const degradedLines = normalizedLines(degraded.raw, broken);
		expect(degradedLines.length).toBe(controlLines.length + 1);

		const extra = degradedLines.filter((line, index) => line !== controlLines[index - 1] && index === 0);
		// The one extra line is the FIRST line, printed before the TUI paints anything.
		expect(extra.length).toBe(1);
		expect(degradedLines[0]).toContain("Not registering this session for remote attach");
		expect(degradedLines[0]).toContain("not a directory is in the way");
		// A human sentence, not an errno.
		expect(degradedLines[0]).not.toContain("EEXIST");
		// Everything after that first line is the control run, unchanged.
		expect(degradedLines.slice(1).join("\n")).toBe(controlLines.join("\n"));
	}, 180_000);

	test("FATAL: an explicit --attachable that cannot bind exits 1, on stderr, with a silent stdout", async () => {
		// THE OTHER HALF OF THE SPLIT CATCH, and until now the untested half. Every other
		// explicit-flag assertion in this file drives a bind that SUCCEEDS, so nothing watched the
		// fatal branch: neutering `if (attachableRequestedExplicitly)` — silently degrading a run
		// where the operator ASKED for a reachable session — left the suite green, 10/10.
		//
		// THE REQUIREMENT this pins is the asymmetry itself. An implicit default that fails must
		// never stop a session (proved three tests above). An explicit `--attachable` that fails
		// must stop it, because the alternative is an operator who typed the flag, saw a session
		// start, and is quietly not on the fleet.
		//
		// `--mode rpc` rather than a pty, deliberately: an explicit flag binds in EVERY mode, so
		// no terminal is needed to reach the bind, and a plain child process hands back SEPARATED
		// streams — the only way to say WHICH stream a message went to.
		const sandbox = await createSandbox("fatal");
		// The same poison as the degrade test: `sockets` is a FILE, so `mkdir` throws EEXIST.
		writeFileSync(path.join(sandbox.agentDir, "sockets"), "x");

		const result = await runProcess(
			process.execPath,
			[EMITTED_CLI, "--provider", "draht-stub", "--model", "stub-1", "--attachable", "--mode", "rpc"],
			{ cwd: sandbox.workDir, env: childEnv(sandbox), timeoutMs: 60_000 },
		);
		const detail = `code=${result.code} signal=${result.signal}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
		// A `null` code here is the watchdog reaping a process that degraded and carried on
		// serving rpc — which is exactly the regression this test exists to catch.
		expect(result.code, detail).toBe(1);
		const stderrText = stripEscapes(result.stderr);
		// The operator gets the real reason, not a euphemism: they asked for this and can fix it.
		expect(stderrText, detail).toContain("Error:");
		expect(stderrText, detail).toContain("EEXIST");
		expect(stderrText, detail).toContain(path.join(sandbox.agentDir, "sockets"));
		// And it is NOT the degrade notice. The two halves of the catch must not converge.
		expect(stderrText, detail).not.toContain("Not registering this session for remote attach");
		// rpc stdout is a protocol stream that a caller parses line by line. Nothing was said on
		// it at all — not the error, not a banner, not one frame of a session that never started.
		expect(result.stdout, detail).toBe("");
		// Nothing bound, and the thing in the way is still exactly what the test put there.
		expect(readFileSync(path.join(sandbox.agentDir, "sockets"), "utf8")).toBe("x");
	}, 120_000);

	test("STREAMS: the degrade notice goes to stderr, and stdout carries none of it", async () => {
		// The catch above claims the one notice goes out "on stderr (never stdout, in any mode)",
		// and nothing in this file could see that. A pty MERGES the two streams by construction —
		// one device on fd 1 and fd 2 — so every existing assertion about the notice reads the
		// same text whether it was written with `console.error` or `console.log`. Measured:
		// switching the notice to `console.log` left the suite at 10/10.
		//
		// The IMPLICIT path cannot be reached without a terminal (default-on is gated on stdin and
		// stdout both being ttys), so the pty stays and only fd 2 is redirected before exec. What
		// is under test is unchanged: the same interactive run, with its streams finally separable.
		const sandbox = await createSandbox("split");
		writeFileSync(path.join(sandbox.agentDir, "sockets"), "x");
		const stderrFile = path.join(sandbox.root, "stderr.log");

		const run = await runInPty(sandbox, [], { env: BENCHMARK_ENV, stderrFile });
		// Still not fatal: this is the implicit path, and it degrades.
		expect(run.exit, `degraded run: ${JSON.stringify(run)}`).toBe(0);

		const errText = stripEscapes(readFileSync(stderrFile, "utf8"));
		const outText = normalizeStream(run.raw, sandbox);
		expect(errText).toContain("Not registering this session for remote attach");
		expect(errText).toContain("not a directory is in the way");
		// ONE line, not a paragraph, and the whole sentence is on the stream that carries it.
		expect(errText.trim().split("\n").length).toBe(1);
		expect(errText).toContain("This session runs normally but is not reachable from your other devices.");
		// THE POINT: stdout saw none of it. Both halves of the sentence are checked, so moving the
		// notice to `console.log` cannot hide behind a wrapped line.
		expect(outText).not.toContain("Not registering this session for remote attach");
		expect(outText).not.toContain("not reachable from your other devices");
		// And stdout is not merely empty — the session really ran on it, so "clean" is a claim
		// about a stream that had plenty to say.
		expect(outText).toContain("draht");
		expect(outText.length).toBeGreaterThan(2000);
	}, 180_000);

	test("a busy twin degrades with a notice naming the owner, and starts anyway", async () => {
		// THE COMMONEST DEFAULT-ON FAILURE, and it is not environmental. `continueRecent` reopens
		// the most recent session FILE, so a second `draht -c` in one project reuses the header id
		// and therefore the socket name. `--session-id` reproduces exactly that collision without
		// depending on which session happens to be most recent.
		const sandbox = await createSandbox("busy");
		const sessionId = "01a02700-0000-7000-8000-00000000beef";
		const owner = spawn(
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
			{ cwd: sandbox.workDir, env: childEnv(sandbox), stdio: ["pipe", "pipe", "pipe"] },
		);
		try {
			const socketPath = path.join(sandbox.socketDir, `${sessionId}.sock`);
			const deadline = Date.now() + 45_000;
			while (!existsSync(socketPath) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(existsSync(socketPath), "the owning rpc session never bound its socket").toBe(true);

			const twin = await runInPty(sandbox, ["--session-id", sessionId], { env: BENCHMARK_ENV });
			expect(twin.exit, `twin run: ${JSON.stringify(twin)}`).toBe(0);

			const notice = normalizedLines(twin.raw, sandbox).find((line) =>
				line.includes("Not registering this session for remote attach"),
			);
			expect(notice, `no degrade notice in:\n${normalizeStream(twin.raw, sandbox)}`).toBeDefined();
			expect(notice).toContain("already published by PID <pid>");
			expect(notice).toContain("--attach <uuid>");
		} finally {
			owner.kill("SIGKILL");
		}
	}, 180_000);

	test("TRANSCRIPT: the only durable difference is permission_resolution rows", async () => {
		// A real permission ask, answered at the TUI, through the emitted binary. The relay is
		// what writes the audit row, and it is installed only when a socket is bound — so the
		// default-on transcript is the one that gains rows.
		const runOne = async (name: string, cliArgs: string[]): Promise<Record<string, unknown>[]> => {
			const sandbox = await createSandbox(name);
			const marker = path.join(sandbox.workDir, "marker.txt");
			const script = JSON.stringify([
				{ toolCalls: [{ id: "call-1", name: "bash", arguments: { command: `echo scripted > ${marker}` } }] },
			]);
			const result = await runInPty(sandbox, [...cliArgs, "run the tool"], {
				env: { DRAHT_STUB_TOOL_CALLS: script },
				steps: [
					// "→ Yes" is preselected; Enter approves.
					{ wait: "Approve tool call?", send: "\r" },
					// The stub's closing text means the turn finished and the row is written.
					{ wait: "stub:", send: "", delay: 1.5 },
				],
				timeoutSeconds: 90,
			});
			expect(result.steps, `${name} never reached both drive steps: ${JSON.stringify(result)}`).toBe(2);
			// The FILE SYSTEM answers "was it approved?", not a frame this test decoded.
			expect(existsSync(marker), `${name}: the approved tool never ran`).toBe(true);
			return sessionEntries(sandbox);
		};

		const withoutSocket = await runOne("tx-off", ["--no-attachable"]);
		const withSocket = await runOne("tx-on", []);

		expect(withoutSocket.map((entry) => entry.type)).not.toContain("permission_resolution");
		expect(withSocket.map((entry) => entry.type)).toContain("permission_resolution");
		// THE PIN: strip the accepted rows and the two transcripts agree entry-for-entry, in order.
		const stripped = withSocket.filter((entry) => entry.type !== "permission_resolution");
		expect(stripped.map((entry) => entry.type)).toEqual(withoutSocket.map((entry) => entry.type));
		expect(stripped.length).toBe(withoutSocket.length);
	}, 300_000);

	test("SIGNALS: SIGINT still kills a default-on session, and takes the socket with it", async () => {
		// A stream diff cannot see this. `registerAttachableSessionCleanup` becomes a SIGINT
		// listener for the life of every interactive session under default-on, and Node applies a
		// signal's default disposition only when NOTHING listens — so a handler that politely
		// defers turns Ctrl+C into a no-op. Measured before the fix: the control run died with
		// signal 2 and the default-on run was still alive at the 60 s deadline with its socket and
		// lock on disk.
		const off = await createSandbox("sig-off");
		const on = await createSandbox("sig-on");
		// Both runs get the SAME dwell before the signal, so the tails compared below are taken at
		// the same point in each session's life.
		const steps: PtyStep[] = [{ wait: "ctrl+o more", signal: "SIGINT", delay: 6 }];

		const control = await runInPty(off, ["--no-attachable"], { steps, timeoutSeconds: 45 });

		// This is also where "the default really binds" is proved, because it is the only place a
		// session is still ALIVE while the test can look: poll the socket directory during the six
		// seconds before the signal.
		const defaultedRun = runInPty(on, [], { steps, timeoutSeconds: 45 });
		let liveSockets: string[] = [];
		const pollDeadline = Date.now() + 30_000;
		while (liveSockets.length < 2 && Date.now() < pollDeadline) {
			liveSockets = socketFiles(on);
			if (liveSockets.length < 2) await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const defaulted = await defaultedRun;
		expect(liveSockets.map((name) => path.extname(name)).sort()).toEqual([".lock", ".sock"]);

		expect(control.steps, `control never reached the TUI: ${JSON.stringify(control)}`).toBe(1);
		expect(defaulted.steps, `default-on never reached the TUI: ${JSON.stringify(defaulted)}`).toBe(1);
		// Same termination: killed by SIGINT, not exited, not still running at the deadline.
		expect(control.signal).toBe(2);
		expect(defaulted.signal).toBe(2);
		expect(defaulted.killed).toBe(false);
		// And the socket did not outlive the process.
		expect(socketFiles(on)).toEqual([]);
		// The tail a human would have seen is the same on both.
		const tail = (result: PtyResult, sandbox: Sandbox): string =>
			normalizedLines(result.raw, sandbox).slice(-5).join("\n");
		expect(tail(defaulted, on)).toBe(tail(control, off));
	}, 180_000);

	test("--no-attachable keeps the prompt that follows it", async () => {
		// It used to swallow it. `--no-attachable` fell into the unknown-flag path, which consumes
		// the next token as the flag's value, and the run then died with "Unknown option".
		const sandbox = await createSandbox("flag");
		const result = await runProcess(
			process.execPath,
			[
				EMITTED_CLI,
				"--provider",
				"draht-stub",
				"--model",
				"stub-1",
				"--no-session",
				"--no-attachable",
				"fix the bug",
			],
			{ cwd: sandbox.workDir, env: childEnv(sandbox), timeoutMs: 90_000 },
		);
		const detail = `code=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
		expect(result.code, detail).toBe(0);
		expect(result.stdout, detail).toContain("stub: fix the bug");
		expect(result.stderr, detail).not.toContain("Unknown option");
		expect(attemptedToPublish(sandbox)).toBe(false);
	}, 120_000);

	test("explicit --attachable still binds in rpc mode, banner and all", async () => {
		// Guards the existing cross-package acceptance, which spawns exactly this.
		const sandbox = await createSandbox("rpc");
		const child = spawn(
			process.execPath,
			[EMITTED_CLI, "--provider", "draht-stub", "--model", "stub-1", "--attachable", "--mode", "rpc"],
			{ cwd: sandbox.workDir, env: childEnv(sandbox), stdio: ["pipe", "pipe", "pipe"] },
		);
		try {
			const deadline = Date.now() + 45_000;
			while (socketFiles(sandbox).length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(
				socketFiles(sandbox)
					.map((name) => path.extname(name))
					.sort(),
			).toEqual([".lock", ".sock"]);
		} finally {
			child.kill("SIGKILL");
		}
	}, 120_000);

	test("the default never reaches print mode, which is what keeps subagents unbound", async () => {
		// Subagents spawn with ["--mode","json","-p","--no-session"]. If the default were resolved
		// in the argument parser instead of at the bind site, a parallel wave of them would be the
		// first thing to hit the socket cap.
		const sandbox = await createSandbox("print");
		const result = await runProcess(
			process.execPath,
			[
				EMITTED_CLI,
				"--provider",
				"draht-stub",
				"--model",
				"stub-1",
				"--mode",
				"json",
				"-p",
				"--no-session",
				"hello",
			],
			{ cwd: sandbox.workDir, env: childEnv(sandbox), timeoutMs: 90_000 },
		);
		expect(result.code, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
		expect(attemptedToPublish(sandbox)).toBe(false);
	}, 120_000);

	test("the env opt-out and the global settings key each turn the default off", async () => {
		const viaEnv = await createSandbox("env-off");
		const envRun = await runInPty(viaEnv, [], { env: { ...BENCHMARK_ENV, DRAHT_NO_ATTACHABLE: "1" } });
		expect(envRun.exit).toBe(0);
		expect(attemptedToPublish(viaEnv)).toBe(false);

		const viaSettings = await createSandbox("set-off");
		writeFileSync(path.join(viaSettings.agentDir, "settings.json"), JSON.stringify({ attachableSessions: false }));
		const settingsRun = await runInPty(viaSettings, [], { env: BENCHMARK_ENV });
		expect(settingsRun.exit).toBe(0);
		expect(attemptedToPublish(viaSettings)).toBe(false);

		// And an explicit --attachable overrides both, because the operator asked.
		const forced = await createSandbox("forced");
		writeFileSync(path.join(forced.agentDir, "settings.json"), JSON.stringify({ attachableSessions: false }));
		const forcedRun = await runInPty(forced, ["--attachable"], {
			env: { ...BENCHMARK_ENV, DRAHT_NO_ATTACHABLE: "1" },
		});
		expect(forcedRun.exit).toBe(0);
		expect(attemptedToPublish(forced)).toBe(true);
		// The explicit path keeps its banner; the implicit path is what got silenced.
		expect(normalizeStream(forcedRun.raw, forced)).toContain("Attachable session started");
	}, 300_000);
});
