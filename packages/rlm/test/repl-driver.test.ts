// Tests for packages/rlm/python/repl_driver.py's newline-delimited JSON wire
// protocol (see .planning/phases/26-rlm-core-primitives/26-01-PLAN.md,
// Architecture section 2-3). These spawn the real `python3` subprocess --
// nothing here is mocked -- to exercise the actual persistent exec() globals
// dict, the FINAL/FINAL_VAR exception mechanism, and the llm_query
// RPC-over-pipes round-trip.

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { HAS_PYTHON3 } from "./sandbox-prereqs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIVER_PATH = join(__dirname, "..", "python", "repl_driver.py");

interface DriverMessage {
	type: string;
	[key: string]: unknown;
}

/** Thin newline-delimited-JSON harness around the real driver subprocess. */
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
			// Surface driver-side tracebacks (e.g. a crash in the driver itself,
			// as opposed to an in-REPL exception reported via exec_result.error)
			// to make test failures debuggable instead of silently timing out.
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

// The harness spawns bare `python3` (no unshare/sandbox wrapper), so only
// python3 itself is a prerequisite -- without it the child never answers the
// wire protocol and every test hangs to its timeout instead of failing fast.
describe.skipIf(!HAS_PYTHON3)("repl_driver.py wire protocol", () => {
	let harness: DriverHarness;

	afterEach(() => {
		harness?.dispose();
	});

	test("1. variables persist across exec steps in one process", async () => {
		harness = new DriverHarness();
		const first = await harness.exec("x = 1");
		expect(first.error).toBeNull();

		const second = await harness.exec("x += 1\nprint(x)");
		expect(second.stdout).toBe("2\n");
		expect(second.error).toBeNull();
	});

	test("2. a seeded context variable is visible to subsequent exec calls", async () => {
		harness = new DriverHarness();
		await harness.exec('context = "hello"');

		const result = await harness.exec("print(context)");
		expect(result.stdout).toBe("hello\n");
	});

	test("3. FINAL(value) reports exec_result.final as kind value", async () => {
		harness = new DriverHarness();
		const result = await harness.exec('FINAL("done")');
		expect(result.final).toEqual({ kind: "value", value: "done" });
	});

	test("4. FINAL_VAR(name) reports exec_result.final as kind var with repr'd value", async () => {
		harness = new DriverHarness();
		await harness.exec("x = 42");

		const result = await harness.exec('FINAL_VAR("x")');
		expect(result.final).toEqual({ kind: "var", name: "x", value: "42" });
	});

	test("5. a Python exception is reported via exec_result.error, not a driver crash", async () => {
		harness = new DriverHarness();
		const result = await harness.exec("1 / 0");

		expect(result.final).toBeNull();
		expect(typeof result.error).toBe("string");
		expect(result.error as string).toContain("ZeroDivisionError");
	});

	test("6. llm_query blocks for and returns the matching llm_query_response", async () => {
		harness = new DriverHarness();
		harness.send({
			type: "exec",
			code: 'result = llm_query("what is 2+2")\nprint(result)',
		});

		const request = await harness.next();
		expect(request.type).toBe("llm_query_request");
		expect(request.prompt).toBe("what is 2+2");
		expect(typeof request.id).toBe("string");

		harness.send({
			type: "llm_query_response",
			id: request.id,
			text: "4",
		});

		const result = await harness.next();
		expect(result.type).toBe("exec_result");
		expect(result.stdout).toBe("4\n");
		expect(result.error).toBeNull();
	});

	test("7. FINAL(...) appearing inside a string/comment is not misdetected as a real FINAL", async () => {
		harness = new DriverHarness();
		const result = await harness.exec('print("not FINAL(x) really")  # FINAL(nope)');

		expect(result.final).toBeNull();
		expect(result.error).toBeNull();
		expect(result.stdout).toBe("not FINAL(x) really\n");
	});
});
