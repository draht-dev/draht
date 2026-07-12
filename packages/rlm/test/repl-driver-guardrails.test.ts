// Tests for packages/rlm/python/repl_driver.py's Python-level guardrails
// (builtins allowlist, import allowlist, AST pre-screen) added in
// .planning/phases/28-repl-sandbox-safety/28-01-PLAN.md, Architecture
// section 2 / task 2.
//
// IMPORTANT (see the plan's "IMPORTANT" section and this file's own docs
// below): these guardrails are defense-in-depth for a confused/
// prompt-injected root LLM, NOT the real security boundary -- that's the
// OS-level sandbox in `../src/sandbox.ts` (covered by `test/sandbox.test.ts`,
// which spawns the driver wrapped in `sandbox-exec`/`unshare`). This file
// deliberately spawns `repl_driver.py` UNWRAPPED (plain `spawn("python3",
// [DRIVER_PATH])`, exactly like Phase 26's `test/repl-driver.test.ts` does,
// with no `spawnSandboxed` involved) so that a passing rejection here proves
// the Python-level guardrail layer is real and independent, not merely
// redundant with the OS sandbox.
//
// This is a NEW file, separate from `test/repl-driver.test.ts` (Phase 26) --
// it does not modify or exercise anything that would regress that file's 7
// existing wire-protocol cases.

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = join(__dirname, "..", "python", "repl_driver.py");

interface DriverMessage {
	type: string;
	[key: string]: unknown;
}

/**
 * Thin newline-delimited-JSON harness around the real, UNSANDBOXED driver
 * subprocess -- intentionally not going through `spawnSandboxed` (see the
 * file-level comment above for why).
 */
class DriverHarness {
	readonly child: ChildProcess;
	private buffer = "";
	private queue: DriverMessage[] = [];
	private waiters: Array<(message: DriverMessage) => void> = [];

	constructor() {
		this.child = spawn("python3", [DRIVER_PATH], {
			stdio: ["pipe", "pipe", "pipe"],
		});
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
			// Surface driver-side tracebacks (a crash in the driver itself, as
			// opposed to an in-REPL exception/guardrail rejection reported via
			// exec_result.error) to make test failures debuggable instead of
			// silently timing out.
			console.error(`[repl_driver stderr] ${chunk}`);
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
	}
}

describe("repl_driver.py Python-level guardrails", () => {
	let harness: DriverHarness;

	afterEach(() => {
		harness?.dispose();
	});

	describe("1. allowed stdlib imports still work", () => {
		test("re", async () => {
			harness = new DriverHarness();
			const result = await harness.exec("import re\nprint(re.findall(r'\\d+', 'a1 b22'))");
			expect(result.error).toBeNull();
			expect(result.stdout).toBe("['1', '22']\n");
		});

		test("json", async () => {
			harness = new DriverHarness();
			const result = await harness.exec("import json\nprint(json.dumps({'a': 1, 'b': [1, 2]}))");
			expect(result.error).toBeNull();
			expect(result.stdout).toBe('{"a": 1, "b": [1, 2]}\n');
		});

		test("math", async () => {
			harness = new DriverHarness();
			const result = await harness.exec("import math\nprint(math.sqrt(16))");
			expect(result.error).toBeNull();
			expect(result.stdout).toBe("4.0\n");
		});

		test("itertools", async () => {
			harness = new DriverHarness();
			const result = await harness.exec("import itertools\nprint(list(itertools.chain([1, 2], [3, 4])))");
			expect(result.error).toBeNull();
			expect(result.stdout).toBe("[1, 2, 3, 4]\n");
		});

		test("collections (including a `from` import)", async () => {
			harness = new DriverHarness();
			const result = await harness.exec("from collections import Counter\nprint(Counter('aabbbc').most_common(1))");
			expect(result.error).toBeNull();
			expect(result.stdout).toBe("[('b', 3)]\n");
		});

		test("statistics", async () => {
			harness = new DriverHarness();
			const result = await harness.exec("import statistics\nprint(statistics.mean([1, 2, 3, 4]))");
			expect(result.error).toBeNull();
			expect(result.stdout).toBe("2.5\n");
		});
	});

	test("2. a disallowed import (`import os`) is rejected with a clear ImportError, not a raw crash -- proving the guardrail is real defense in depth independent of the OS sandbox (this harness spawns the driver unwrapped, no sandbox-exec/unshare involved)", async () => {
		harness = new DriverHarness();
		const result = await harness.exec("import os");

		expect(result.final).toBeNull();
		expect(typeof result.error).toBe("string");
		const error = result.error as string;
		expect(error).toContain("ImportError");
		expect(error).toContain("'os'");
		expect(error).not.toContain("Segmentation");

		// The driver itself must still be alive and responsive -- a "raw
		// crash" would mean the process died rather than reporting a clean
		// exec_result.error.
		const followUp = await harness.exec("print('still alive')");
		expect(followUp.stdout).toBe("still alive\n");
		expect(followUp.error).toBeNull();
	});

	test("2b. a disallowed submodule of an allowed-looking path is also rejected (e.g. urllib.request)", async () => {
		harness = new DriverHarness();
		const result = await harness.exec("import urllib.request");
		expect(typeof result.error).toBe("string");
		expect(result.error as string).toContain("ImportError");
	});

	describe("3. the AST pre-screen rejects known escape-technique shapes before exec()", () => {
		const cases: Array<[string, string]> = [
			["__class__", "x = (1).__class__"],
			[
				"__subclasses__ (full litmus case A)",
				"[c for c in ().__class__.__base__.__subclasses__() if c.__name__ == 'catch_warnings'][0].__init__.__globals__['__builtins__']['__import__']('os').system('id')",
			],
			["__globals__", "def f():\n    pass\nf.__globals__"],
			["gi_frame", "(x for x in []).gi_frame"],
			["f_builtins (full litmus case B)", "(_ for _ in ()).gi_frame.f_builtins['__import__']('os')"],
			["bare eval(", "eval('1 + 1')"],
			["bare exec(", "exec('x = 1')"],
			["bare getattr(", "getattr(1, 'real')"],
		];

		for (const [label, code] of cases) {
			test(label, async () => {
				harness = new DriverHarness();

				// A sentinel assignment BEFORE the offending construct proves
				// there are no side effects from partial execution: if the AST
				// screen runs before exec() (as it must), `sentinel` is never
				// created at all, since the whole step is rejected pre-exec.
				const guarded = `sentinel = "should never be created"\n${code}`;
				const result = await harness.exec(guarded);

				expect(result.final).toBeNull();
				expect(typeof result.error).toBe("string");
				expect(result.stdout).toBe("");

				// Prove `sentinel` was never bound (i.e. the guarded step had zero
				// side effects, not partial execution up to the offending
				// construct) by asserting a later reference to it raises
				// NameError.
				const probe = await harness.exec("print(sentinel)");
				expect(probe.error).toContain("NameError");
			});
		}
	});

	test("4. ordinary legitimate multi-line code with loops/comprehensions/string methods/regex continues to work unaffected", async () => {
		harness = new DriverHarness();
		const code = [
			"import re",
			"words = ['Hello', 'world', 'FOO', 'bar123']",
			"lowered = [w.lower() for w in words]",
			"digits_only = [w for w in words if re.fullmatch(r'[A-Za-z]+\\d+', w)]",
			"total = 0",
			"for i in range(10):",
			"    total += i * i",
			"summary = {",
			"    'lowered': lowered,",
			"    'digits_only': digits_only,",
			"    'total': total,",
			"    'joined': ', '.join(lowered),",
			"}",
			"print(summary)",
		].join("\n");

		const result = await harness.exec(code);
		expect(result.error).toBeNull();
		expect(result.stdout).toBe(
			"{'lowered': ['hello', 'world', 'foo', 'bar123'], 'digits_only': ['bar123'], 'total': 285, 'joined': 'hello, world, foo, bar123'}\n",
		);
	});

	test("4b. exception handling with allowlisted exception names works normally", async () => {
		harness = new DriverHarness();
		const result = await harness.exec(
			[
				"results = []",
				"for value in ['1', 'two', '3']:",
				"    try:",
				"        results.append(int(value))",
				"    except ValueError as exc:",
				"        results.append(str(exc))",
				"print(results)",
			].join("\n"),
		);
		expect(result.error).toBeNull();
		expect(result.stdout).toContain("invalid literal for int()");
	});
});
