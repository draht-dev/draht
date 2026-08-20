/**
 * The bind assertion has to hold for the whole run, not for one instant.
 *
 * Phase 32 shipped a single-listener proof that sampled `lsof` once, at a moment
 * of the parent's choosing, and read its own failure as an answer: `lsof` exits
 * 1 with no output when a process has no listeners, and it also produces no
 * output when it is not installed. Both were flattened to `[]`, so on a host
 * without `lsof` the proof passed while proving nothing — the recorded residual.
 *
 * This suite covers the shared helper that replaces it:
 *
 *   • a loopback-bound child is observed as exactly one loopback listener for
 *     the whole sample window, not just at one sampled instant;
 *   • a child that deliberately binds every interface is caught by the same
 *     window — the watcher is able to fail;
 *   • enumeration that cannot run at all raises a named error rather than
 *     reporting an empty, and vacuously clean, socket list.
 *
 * The third case is the one that matters: it is what makes the other two
 * evidence rather than a `lsof`-shaped no-op.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLoopbackListener, type Listener, listeningSockets, watchListeners } from "./helpers/listening-sockets";

const cleanupDirs: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill("SIGKILL");
		await child.exited;
	}
	for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

/** Read the child's stdout until a line parses as JSON, or it dies trying. */
async function firstJsonLine<T>(proc: Bun.Subprocess<"ignore", "pipe", "pipe">, timeoutMs = 20_000): Promise<T> {
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + timeoutMs;
	let buffered = "";
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			for (const line of buffered.split("\n")) {
				if (!line.trim().startsWith("{")) continue;
				try {
					return JSON.parse(line) as T;
				} catch {
					// Partial line — wait for the rest.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	throw new Error(`child never printed a JSON line.\nstdout so far:\n${buffered}`);
}

/**
 * Spawn a child that binds exactly one TCP listener on `hostname` and then stays
 * alive, so the parent can watch the kernel's view of it for a whole window.
 */
async function spawnListener(hostname: string): Promise<{ proc: Bun.Subprocess; pid: number; port: number }> {
	const dir = tempDir("draht-bind-watch-");
	const file = join(dir, "listener.ts");
	await Bun.write(
		file,
		`const server = Bun.serve({ port: 0, hostname: ${JSON.stringify(hostname)}, fetch: () => new Response("ok") });\n` +
			`console.log(JSON.stringify({ ready: true, port: server.port }));\n` +
			`await new Promise(() => {});\n`,
	);
	const proc = Bun.spawn([process.execPath, file], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	}) as Bun.Subprocess<"ignore", "pipe", "pipe">;
	children.push(proc);
	const { port } = await firstJsonLine<{ ready: boolean; port: number }>(proc);
	return { proc, pid: proc.pid as number, port };
}

/** Run `body` while the watcher samples `pid`, and return everything it saw. */
async function watchDuring(
	pid: number,
	body: () => Promise<void>,
	options: { intervalMs?: number; env?: Record<string, string> } = {},
): Promise<Listener[]> {
	const controller = new AbortController();
	// Settle the watcher into a value immediately: it can reject while `body` is
	// still running, and an unattached rejection would fail the test with the
	// watcher's own stack instead of the assertion the caller wrote.
	const watching = watchListeners(pid, {
		intervalMs: options.intervalMs ?? 20,
		signal: controller.signal,
		env: options.env,
	}).then(
		(listeners) => ({ listeners, error: undefined as unknown }),
		(error: unknown) => ({ listeners: undefined, error }),
	);
	try {
		await body();
	} finally {
		controller.abort();
	}
	const settled = await watching;
	if (settled.listeners === undefined) throw settled.error;
	return settled.listeners;
}

describe("watching a process's listeners for a whole run", () => {
	test("a loopback-bound server is exactly one loopback listener across the whole window", async () => {
		const { pid, port } = await spawnListener("127.0.0.1");

		const observed = await watchDuring(pid, async () => {
			// A run, not an instant: several requests, several sample intervals.
			for (let i = 0; i < 5; i++) {
				expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
				await Bun.sleep(40);
			}
		});

		expect(observed.map((listener) => ({ address: listener.address, port: listener.port }))).toEqual([
			{ address: "127.0.0.1", port },
		]);
		expect(observed.every(isLoopbackListener)).toBe(true);
	}, 30_000);

	test("a deliberately wide bind is caught — the watcher is able to fail", async () => {
		const { pid, port } = await spawnListener("0.0.0.0");

		const observed = await watchDuring(pid, async () => {
			await Bun.sleep(200);
		});

		expect(observed.length).toBeGreaterThan(0);
		expect(observed.map((listener) => listener.port)).toEqual([port]);
		// lsof -nP renders a wildcard bind as `*:<port>`; either spelling is wide.
		expect(observed.every((listener) => listener.address === "*" || listener.address === "0.0.0.0")).toBe(true);
		expect(observed.some(isLoopbackListener)).toBe(false);
	}, 30_000);

	test("the watcher throws a named error when lsof is unavailable instead of reporting that a process has no listeners", async () => {
		const { pid, port } = await spawnListener("127.0.0.1");

		// With `lsof` reachable this pid demonstrably has a listener, so an empty
		// result under the stripped PATH below could only be the missing binary.
		expect(listeningSockets(pid).map((listener) => listener.port)).toEqual([port]);

		const emptyPath = tempDir("draht-no-lsof-");
		let thrown: unknown;
		try {
			await watchDuring(pid, async () => await Bun.sleep(100), { env: { PATH: emptyPath } });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).name).toBe("ListenerEnumerationError");
		expect((thrown as Error).message).toContain("lsof");

		// And the single-sample entry point refuses in the same way, so no caller
		// can read "cannot enumerate" as "nothing is listening".
		let direct: unknown;
		try {
			listeningSockets(pid, { env: { PATH: emptyPath } });
		} catch (error) {
			direct = error;
		}
		expect((direct as Error | undefined)?.name).toBe("ListenerEnumerationError");
	}, 30_000);
});
