// Tests for packages/rlm/src/sandbox.ts and packages/rlm/sandbox/macos.sb --
// the OS-level sandbox spawn wrapper that is the REAL security boundary for
// the RLM Python REPL driver (see
// .planning/phases/28-repl-sandbox-safety/28-01-PLAN.md, "IMPORTANT"
// section and Architecture section 1).
//
// Every test here spawns the REAL sandboxed subprocess (`sandbox-exec` on
// macOS / `unshare`|`bwrap` on Linux, whichever this platform provides) --
// nothing is mocked. The whole point of this suite is to prove the OS
// process boundary actually holds, including against the two escape
// techniques (test 5) that defeat any purely in-process/Python-level
// restriction -- not to exercise `repl_driver.py`'s Python-level guardrails
// (that's test/repl-driver-guardrails.test.ts, a different phase-28 task).

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { resolveSandboxedCommand, SandboxUnavailableError, spawnSandboxed } from "../src/sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = join(__dirname, "..", "python", "repl_driver.py");

interface DriverMessage {
	type: string;
	[key: string]: unknown;
}

/**
 * Thin newline-delimited-JSON harness around a REAL sandboxed
 * `repl_driver.py` subprocess -- mirrors test/repl-driver.test.ts's harness,
 * but spawns through `spawnSandboxed` instead of a bare `spawn("python3", ...)`.
 */
class SandboxedDriverHarness {
	readonly child: ChildProcess;
	readonly workdir: string;
	private buffer = "";
	private queue: DriverMessage[] = [];
	private waiters: Array<(message: DriverMessage) => void> = [];

	constructor() {
		this.workdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-"));
		this.child = spawnSandboxed({ driverPath: DRIVER_PATH, workdir: this.workdir });

		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => {
			this.buffer += chunk;
			let newlineIndex = this.buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = this.buffer.slice(0, newlineIndex);
				this.buffer = this.buffer.slice(newlineIndex + 1);
				newlineIndex = this.buffer.indexOf("\n");
				if (!line.trim()) continue;
				const message = JSON.parse(line) as DriverMessage;
				const waiter = this.waiters.shift();
				if (waiter) {
					waiter(message);
				} else {
					this.queue.push(message);
				}
			}
		});
		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (chunk: string) => {
			// Surface driver/sandbox-side crashes to make test failures
			// debuggable instead of silently timing out.
			console.error(`[sandboxed repl_driver stderr] ${chunk}`);
		});
	}

	send(message: DriverMessage): void {
		this.child.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	/** Resolves with the next message the driver emits, in arrival order. */
	next(): Promise<DriverMessage> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}

	/** Sends one `exec` message and waits for its `exec_result`. */
	exec(code: string): Promise<DriverMessage> {
		this.send({ type: "exec", code });
		return this.next();
	}

	dispose(): void {
		this.child.stdin?.end();
		this.child.kill();
		try {
			rmSync(this.workdir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup only.
		}
	}
}

describe("OS-level sandbox (sandbox.ts + sandbox/macos.sb) -- the real security boundary", () => {
	let harness: SandboxedDriverHarness | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
	});

	test("1. startup self-test: a network connect attempt and an out-of-workdir file read both fail, surfaced cleanly (not a crash)", async () => {
		harness = new SandboxedDriverHarness();
		const result = await harness.exec(
			[
				"import socket",
				"net_failed = False",
				"try:",
				"    socket.create_connection(('1.1.1.1', 80), timeout=2)",
				"except Exception:",
				"    net_failed = True",
				"file_failed = False",
				"try:",
				"    open('/etc/passwd').read()",
				"except Exception:",
				"    file_failed = True",
				"print(f'net_failed={net_failed} file_failed={file_failed}')",
			].join("\n"),
		);

		// A crash (sandbox setup failure, dyld abort, etc.) would show up as
		// the harness never receiving a well-formed exec_result at all (the
		// `next()` promise would hang until the test timeout, or the process
		// would exit) -- reaching this assertion at all is part of the proof.
		expect(result.type).toBe("exec_result");
		expect(result.error).toBeNull();
		expect(result.stdout).toBe("net_failed=True file_failed=True\n");
	});

	test("2. `import os; os.system(...)` cannot actually run anything (process-exec denied)", async () => {
		harness = new SandboxedDriverHarness();
		const marker = join(harness.workdir, "pwned-os-system.txt");
		const result = await harness.exec(
			["import os", `rc = os.system(${JSON.stringify(`echo pwned > ${marker}`)})`, "print('rc=', rc)"].join("\n"),
		);

		expect(result.error).toBeNull();
		// The real proof isn't the numeric exit code (its exact encoding is
		// platform-dependent) -- it's that the command's side effect never
		// happened, because /bin/sh itself could never be exec'd.
		expect(existsSync(marker)).toBe(false);
	});

	test('3. `open("/etc/passwd")` fails (read denied outside the workdir)', async () => {
		harness = new SandboxedDriverHarness();
		const result = await harness.exec('open("/etc/passwd").read()');

		expect(result.final).toBeNull();
		expect(typeof result.error).toBe("string");
		expect(result.error as string).toContain("PermissionError");
	});

	test("4. `urllib.request.urlopen(...)` does not succeed", async () => {
		harness = new SandboxedDriverHarness();
		const result = await harness.exec(
			[
				"import urllib.request",
				"outcome = None",
				"try:",
				"    urllib.request.urlopen('http://93.184.216.34', timeout=2)",
				"    outcome = 'succeeded'",
				"except Exception as e:",
				"    outcome = 'failed: ' + repr(e)",
				"print(outcome)",
			].join("\n"),
		);

		expect(result.error).toBeNull();
		expect(result.stdout as string).not.toContain("succeeded");
		expect(result.stdout as string).toContain("failed:");
	});

	test("5. escape-technique litmus tests both fail to actually run anything, even though neither touches `import os`/`open`", async () => {
		harness = new SandboxedDriverHarness();

		// Litmus A (subclass-based): reaches the real, unrestricted
		// __builtins__/__import__ via the type graph
		// (().__class__.__base__.__subclasses__()), with zero use of `import`
		// or `open`. If the OS sandbox is the only thing standing between
		// this and a real shell command, this proves it holds.
		const markerA = join(harness.workdir, "pwned-litmus-subclass.txt");
		const resultA = await harness.exec(
			[
				"cw = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'catch_warnings'][0]",
				`rc = cw.__init__.__globals__['__builtins__']['__import__']('os').system(${JSON.stringify(`echo pwned > ${markerA}`)})`,
				"print('rc=', rc)",
			].join("\n"),
		);
		expect(resultA.error).toBeNull();
		expect(existsSync(markerA)).toBe(false);

		// Litmus B (gi_frame-based): reaches the real builtins via a
		// generator's frame -- zero dunders on this route at all.
		const markerB = join(harness.workdir, "pwned-litmus-giframe.txt");
		const resultB = await harness.exec(
			[
				"osmod = (_ for _ in ()).gi_frame.f_builtins['__import__']('os')",
				`rc = osmod.system(${JSON.stringify(`echo pwned > ${markerB}`)})`,
				"print('rc=', rc)",
			].join("\n"),
		);
		expect(resultB.error).toBeNull();
		expect(existsSync(markerB)).toBe(false);
	});

	test("6. writing inside the session workdir succeeds (the sandbox isn't blocking legitimate work too)", async () => {
		harness = new SandboxedDriverHarness();
		const target = join(harness.workdir, "legit.txt");
		const result = await harness.exec(
			[
				`with open(${JSON.stringify(target)}, "w") as f:`,
				'    f.write("hello from inside the sandbox")',
				"print('wrote ok')",
			].join("\n"),
		);

		expect(result.error).toBeNull();
		expect(result.stdout).toBe("wrote ok\n");
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("hello from inside the sandbox");
	});

	test("7. a broken sandbox wrapper (nonexistent binary) refuses to run rather than falling back to an unwrapped spawn", () => {
		const workdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-failclosed-"));
		try {
			const brokenOverrides =
				process.platform === "darwin"
					? { sandboxExecBin: "/nonexistent/sandbox-exec-binary-for-test" }
					: { unshareBin: "/nonexistent/unshare-for-test", bwrapBin: "/nonexistent/bwrap-for-test" };

			// resolveSandboxedCommand must throw synchronously -- fail closed,
			// no unwrapped fallback command is ever produced.
			expect(() => resolveSandboxedCommand({ driverPath: DRIVER_PATH, workdir, ...brokenOverrides })).toThrow(
				SandboxUnavailableError,
			);

			// spawnSandboxed (what session.ts actually calls) must likewise
			// refuse synchronously instead of returning a live child process
			// running the driver unsandboxed.
			expect(() => spawnSandboxed({ driverPath: DRIVER_PATH, workdir, ...brokenOverrides })).toThrow(
				SandboxUnavailableError,
			);
		} finally {
			rmSync(workdir, { recursive: true, force: true });
		}
	});
});
