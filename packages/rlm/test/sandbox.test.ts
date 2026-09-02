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
// restriction.
//
// IMPORTANT (post Fable-5-review correction): tests 2-6 deliberately do NOT
// go through repl_driver.py's own `exec` wire message. Routing them through
// the guarded driver protocol would exercise `repl_driver.py`'s Python-level
// guardrails (restricted `__builtins__`, import allowlist, AST pre-screen --
// see test/repl-driver-guardrails.test.ts for those) FIRST, before the code
// ever reached the OS sandbox at all -- e.g. `import os` would raise
// `ImportError` from `_restricted_import`, and the litmus escapes would be
// rejected by the AST screen (`_GuardrailViolation`), neither of which
// proves anything about whether the OS-level sandbox is actually enforcing.
// A disabled/no-op OS sandbox and a working one would look IDENTICAL through
// that route -- exactly the guardrail-vs-boundary conflation this plan's
// "IMPORTANT" section forbids. Instead, `runSandboxedScript` below spawns a
// plain, guardrail-free Python script -- full unrestricted builtins, no
// AST screen, no import allowlist -- wrapped in the exact same
// `spawnSandboxed`/`sandbox/macos.sb` wiring production uses. If a plain
// script still can't reach the network/filesystem/spawn a process, that is
// the OS sandbox doing the blocking, not repl_driver.py.
//
// Test 1 (the startup self-test) instead drives the real driver's new
// `self_test` wire message (Phase 28 Architecture section 1): `repl_driver.py`
// handles that message via `_run_self_test`, which itself bypasses the
// guardrail layer entirely (see its docstring) -- so asserting on its result
// is *also* a legitimate, guardrail-free probe of the OS boundary, and
// doubles as coverage that the startup self-test the plan requires actually
// exists and reports correctly.

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { resolveSandboxedCommand, SandboxUnavailableError, spawnSandboxed } from "../src/sandbox.js";
import { HAS_PYTHON3, HAS_USERNS } from "./sandbox-prereqs.js";

// Tests 1-6 spawn the REAL sandboxed python3 subprocess and need both
// prerequisites -- see sandbox-prereqs.ts. Test 7 only asserts the
// synchronous fail-closed throw against nonexistent wrapper binaries (no
// process is ever spawned), so it runs everywhere.
const SKIP_REAL_SPAWN = !HAS_PYTHON3 || !HAS_USERNS;

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
 * Only used by test 1 below (the `self_test` message), which is itself a
 * guardrail-free route -- see the file-level comment.
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

interface ScriptRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/**
 * Runs `pythonCode` as a standalone script wrapped in the exact same
 * OS-level sandbox `spawnSandboxed` puts `repl_driver.py` in for real
 * sessions -- but the script itself is plain, guardrail-free Python (full
 * unrestricted builtins, no AST pre-screen, no import allowlist). See the
 * file-level comment for why this -- not the guarded driver protocol -- is
 * what actually proves the OS boundary holds.
 *
 * `spawnSandboxed` takes a `driverPath` param, but nothing about it is
 * specific to `repl_driver.py`'s wire protocol -- it just resolves and runs
 * `<sandboxed python> <driverPath>`, so pointing it at an arbitrary script
 * reuses the identical command-construction/profile wiring production uses.
 */
function runSandboxedScript(pythonCode: string, workdir: string, scriptDir: string): Promise<ScriptRunResult> {
	const scriptPath = join(scriptDir, `probe-${Math.random().toString(36).slice(2)}.py`);
	writeFileSync(scriptPath, pythonCode);
	const child = spawnSandboxed({ driverPath: scriptPath, workdir });

	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ stdout, stderr, exitCode: code }));
	});
}

describe("OS-level sandbox (sandbox.ts + sandbox/macos.sb) -- the real security boundary", () => {
	let harness: SandboxedDriverHarness | undefined;
	let workdir: string | undefined;
	let scriptDir: string | undefined;

	afterEach(() => {
		harness?.dispose();
		harness = undefined;
		if (workdir) {
			rmSync(workdir, { recursive: true, force: true });
			workdir = undefined;
		}
		if (scriptDir) {
			rmSync(scriptDir, { recursive: true, force: true });
			scriptDir = undefined;
		}
	});

	test.skipIf(SKIP_REAL_SPAWN)(
		"1. startup self-test (`self_test` wire message): a network connect attempt and an out-of-workdir file read both fail, on a route that bypasses repl_driver.py's own guardrails",
		async () => {
			harness = new SandboxedDriverHarness();
			harness.send({ type: "self_test" });
			const result = await harness.next();

			// A crash (sandbox setup failure, dyld abort, etc.) would show up as
			// the harness never receiving a well-formed self_test_result at all
			// (the `next()` promise would hang until the test timeout, or the
			// process would exit) -- reaching this assertion at all is part of
			// the proof.
			expect(result.type).toBe("self_test_result");
			expect(result.networkBlocked).toBe(true);
			expect(result.fileReadBlocked).toBe(true);
		},
	);

	test.skipIf(SKIP_REAL_SPAWN)(
		"2. `import os; os.system(...)` cannot actually run anything (process-exec denied)",
		async () => {
			workdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-workdir-"));
			scriptDir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-script-"));
			const marker = join(workdir, "pwned-os-system.txt");

			const { exitCode } = await runSandboxedScript(
				["import os", `rc = os.system(${JSON.stringify(`echo pwned > ${marker}`)})`, "print('rc=', rc)"].join("\n"),
				workdir,
				scriptDir,
			);

			expect(exitCode).toBe(0);
			// The real proof isn't the numeric exit code (its exact encoding is
			// platform-dependent) -- it's that the command's side effect never
			// happened, because /bin/sh itself could never be exec'd.
			expect(existsSync(marker)).toBe(false);
		},
	);

	test.skipIf(SKIP_REAL_SPAWN)('3. `open("/etc/passwd")` fails (read denied outside the workdir)', async () => {
		workdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-workdir-"));
		scriptDir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-script-"));

		const { stdout, exitCode } = await runSandboxedScript(
			[
				"try:",
				"    open('/etc/passwd').read()",
				"    print('opened-unexpectedly')",
				"except Exception as e:",
				"    print('blocked:' + repr(e))",
			].join("\n"),
			workdir,
			scriptDir,
		);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("blocked:");
		expect(stdout).toContain("PermissionError");
	});

	test.skipIf(SKIP_REAL_SPAWN)("4. `urllib.request.urlopen(...)` does not succeed", async () => {
		workdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-workdir-"));
		scriptDir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-script-"));

		const { stdout, exitCode } = await runSandboxedScript(
			[
				"import urllib.request",
				"try:",
				"    urllib.request.urlopen('http://93.184.216.34', timeout=2)",
				"    print('succeeded')",
				"except Exception as e:",
				"    print('failed:' + repr(e))",
			].join("\n"),
			workdir,
			scriptDir,
		);

		expect(exitCode).toBe(0);
		expect(stdout).not.toContain("succeeded");
		expect(stdout).toContain("failed:");
	});

	test.skipIf(SKIP_REAL_SPAWN)(
		"5. escape-technique litmus tests both fail to actually run anything, even though neither touches `import os`/`open`, and neither is screened by any guardrail here",
		async () => {
			workdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-workdir-"));
			scriptDir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-script-"));

			// Litmus A (subclass-based): reaches the real, unrestricted
			// __builtins__/__import__ via the type graph
			// (().__class__.__base__.__subclasses__()), with zero use of `import
			// os`/`open`. `import warnings` here is NOT part of the escape itself
			// (it never touches os/subprocess/network/filesystem) -- it's only
			// there because `warnings.catch_warnings` must actually be loaded into
			// the process for it to appear in `object.__subclasses__()` at all
			// (confirmed empirically: a bare `python3 -c` script on current
			// CPython doesn't auto-import `warnings`, unlike some older
			// interpreter startup paths this public PoC was written against).
			// This script has full, unrestricted builtins (no
			// _build_restricted_builtins, no _screen_code) -- if the OS sandbox is
			// the only thing standing between this and a real shell command, this
			// proves it holds.
			const markerA = join(workdir, "pwned-litmus-subclass.txt");
			const resultA = await runSandboxedScript(
				[
					"import warnings",
					"cw = [c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'catch_warnings'][0]",
					`rc = cw.__init__.__globals__['__builtins__']['__import__']('os').system(${JSON.stringify(`echo pwned > ${markerA}`)})`,
					"print('rc=', rc)",
				].join("\n"),
				workdir,
				scriptDir,
			);
			expect(resultA.exitCode).toBe(0);
			expect(existsSync(markerA)).toBe(false);

			// Litmus B (gi_frame-based): reaches the real builtins via a
			// generator's frame -- zero dunders on this route at all.
			const markerB = join(workdir, "pwned-litmus-giframe.txt");
			const resultB = await runSandboxedScript(
				[
					"osmod = (_ for _ in ()).gi_frame.f_builtins['__import__']('os')",
					`rc = osmod.system(${JSON.stringify(`echo pwned > ${markerB}`)})`,
					"print('rc=', rc)",
				].join("\n"),
				workdir,
				scriptDir,
			);
			expect(resultB.exitCode).toBe(0);
			expect(existsSync(markerB)).toBe(false);
		},
	);

	test.skipIf(SKIP_REAL_SPAWN)(
		"6. writing inside the session workdir succeeds (the sandbox isn't blocking legitimate work too)",
		async () => {
			workdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-workdir-"));
			scriptDir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-script-"));
			const target = join(workdir, "legit.txt");

			const { stdout, exitCode } = await runSandboxedScript(
				[
					`with open(${JSON.stringify(target)}, "w") as f:`,
					'    f.write("hello from inside the sandbox")',
					"print('wrote ok')",
				].join("\n"),
				workdir,
				scriptDir,
			);

			expect(exitCode).toBe(0);
			expect(stdout).toBe("wrote ok\n");
			expect(existsSync(target)).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("hello from inside the sandbox");
		},
	);

	test("7. a broken sandbox wrapper (nonexistent binary) refuses to run rather than falling back to an unwrapped spawn", () => {
		const brokenWorkdir = mkdtempSync(join(tmpdir(), "rlm-sandbox-test-failclosed-"));
		try {
			const brokenOverrides =
				process.platform === "darwin"
					? { sandboxExecBin: "/nonexistent/sandbox-exec-binary-for-test" }
					: { unshareBin: "/nonexistent/unshare-for-test", bwrapBin: "/nonexistent/bwrap-for-test" };

			// resolveSandboxedCommand must throw synchronously -- fail closed,
			// no unwrapped fallback command is ever produced.
			expect(() =>
				resolveSandboxedCommand({ driverPath: DRIVER_PATH, workdir: brokenWorkdir, ...brokenOverrides }),
			).toThrow(SandboxUnavailableError);

			// spawnSandboxed (what session.ts actually calls) must likewise
			// refuse synchronously instead of returning a live child process
			// running the driver unsandboxed.
			expect(() => spawnSandboxed({ driverPath: DRIVER_PATH, workdir: brokenWorkdir, ...brokenOverrides })).toThrow(
				SandboxUnavailableError,
			);
		} finally {
			rmSync(brokenWorkdir, { recursive: true, force: true });
		}
	});
});
