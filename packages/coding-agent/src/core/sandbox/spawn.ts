/**
 * Spawning a wrapped, confined child.
 *
 * Both platform backends produce the same shape -- a wrapper binary
 * (`sandbox-exec`, `bwrap`, `unshare`) whose trailing arguments are the ordinary
 * shell invocation -- so the process plumbing lives here once: streaming,
 * timeout, abort, process-tree teardown.
 *
 * It deliberately mirrors `createLocalBashOperations` in `../tools/bash.ts`
 * (detached process group, `killProcessTree` on abort/timeout, `waitForChildProcess`
 * so a chatty descendant's output is not truncated) rather than reimplementing
 * the semantics, because R44-SBX.6 requires the sandboxed backend to be a drop-in
 * for the local one: a command that times out or is cancelled must behave the
 * same whether or not it ran confined.
 *
 * Killing the *tree* matters more here than it does unsandboxed. The wrapper is
 * the direct child; the shell and everything it spawns are grandchildren.
 * Signalling only the wrapper would leave the real work running -- still
 * confined, but no longer attached to anything that will reap it.
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";

export interface SandboxedSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	/** Seconds, matching the bash tool's units. */
	timeout?: number;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0)
		throw new Error("Invalid timeout: must be a finite number of seconds");
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	return timeoutMs;
}

/** Spawns `command args...` and streams its combined output. Resolves with the exit code (`null` if killed). */
export async function spawnSandboxedProcess(
	command: string,
	args: readonly string[],
	options: SandboxedSpawnOptions,
): Promise<{ exitCode: number | null }> {
	const timeoutMs = resolveTimeoutMs(options.timeout);
	if (options.signal?.aborted) throw new Error("aborted");

	const child = spawn(command, [...args], {
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (child.pid) trackDetachedChildPid(child.pid);

	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const onAbort = () => {
		if (child.pid) killProcessTree(child.pid);
	};

	try {
		if (timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				if (child.pid) killProcessTree(child.pid);
			}, timeoutMs);
		}
		child.stdout?.on("data", options.onData);
		child.stderr?.on("data", options.onData);
		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}
		const exitCode = await waitForChildProcess(child);
		if (options.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${options.timeout}`);
		return { exitCode };
	} finally {
		if (child.pid) untrackDetachedChildPid(child.pid);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
	}
}
