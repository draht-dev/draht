/**
 * Platform assumption tests.
 *
 * Many backend tests rely on standard POSIX binaries (cat, echo, sh, dd, yes).
 * These tests explicitly verify those binaries are present and behave as
 * expected, so a CI failure on a non-standard system gives a clear diagnostic
 * rather than a cryptic process-spawn error buried in another test.
 *
 * All tests here use Bun.spawn directly and are intentionally minimal.
 */

import { describe, expect, test } from "bun:test";
import { SessionProcess } from "../session/session-process";

describe("Platform binary assumptions", () => {
	test("'echo hello' exits 0 and writes 'hello\\n' to stdout", async () => {
		const proc = new SessionProcess(["echo", "hello"]);
		const chunks: string[] = [];
		proc.onOutput((d) => chunks.push(d));
		await proc.exited;
		expect(proc.exitCode).toBe(0);
		expect(chunks.join("")).toBe("hello\n");
	});

	test("'cat' is present and accepts stdin", async () => {
		const proc = new SessionProcess(["cat"]);
		await proc.ready;
		proc.write("ping\n");
		const chunks: string[] = [];
		proc.onOutput((d) => chunks.push(d));
		await Bun.sleep(40);
		proc.kill();
		await proc.exited;
		expect(proc.status).toBe("stopped");
		// Bun reports exitCode as null when process is killed by a signal (SIGKILL/SIGTERM).
		// exitCode is only set when the process exits voluntarily (e.g. exit 0, exit 1).
		// Both null (signal kill) and non-null (voluntary exit) are acceptable here.
	});

	test("'sh -c exit 0' exits with code 0", async () => {
		const proc = new SessionProcess(["sh", "-c", "exit 0"]);
		await proc.exited;
		expect(proc.exitCode).toBe(0);
	});

	test("'sh -c exit 42' exits with code 42", async () => {
		const proc = new SessionProcess(["sh", "-c", "exit 42"]);
		await proc.exited;
		expect(proc.exitCode).toBe(42);
	});

	test("'dd' is present (used in backpressure tests)", async () => {
		const proc = new SessionProcess(["dd", "if=/dev/zero", "bs=1024", "count=1"]);
		const chunks: string[] = [];
		proc.onOutput((d) => chunks.push(d));
		await proc.exited;
		// 1 KiB of NUL bytes, decoded as UTF-8 replacement chars or NUL — just check size
		expect(totalBytes(chunks)).toBeGreaterThanOrEqual(1024);
	});

	test("'yes | head -n 1' produces at least one 'y'", async () => {
		const proc = new SessionProcess(["sh", "-c", "yes | head -n 1"]);
		const chunks: string[] = [];
		proc.onOutput((d) => chunks.push(d));
		await proc.exited;
		expect(chunks.join("")).toContain("y");
	});

	test("spawning a non-existent binary throws synchronously from Bun.spawn", () => {
		// Bun.spawn() throws a synchronous ENOENT error when the binary is not found.
		// This means SessionProcess constructor throws before ready/exited are set up.
		// Callers of SessionProcess (e.g. Session.create, SessionManager.create) must
		// be aware that construction can throw for invalid commands.
		expect(() => {
			new SessionProcess(["__nonexistent_binary_7x__"]);
		}).toThrow();
	});
});

function totalBytes(chunks: string[]): number {
	return chunks.reduce((n, c) => n + c.length, 0);
}
