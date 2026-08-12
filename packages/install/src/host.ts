import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface HostRunResult {
	/** Process exit code, or `null` when the process was killed by a signal or never started. */
	status: number | null;
	stdout: string;
	stderr: string;
	/** Set when the process could not be spawned at all (missing binary, permission denied). */
	spawnError?: Error;
}

export interface HostRunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

/**
 * Runs one external program. Every adapter host call goes through this seam,
 * so a test can substitute a recorder and assert the exact argv, cwd and env a
 * host was invoked with.
 */
export type HostRunner = (file: string, args: string[], options?: HostRunOptions) => HostRunResult;

/** Default timeout for a host CLI call. Host CLIs are interactive-scale tools, not long jobs. */
export const DEFAULT_HOST_TIMEOUT_MS = 120_000;

/**
 * The production `HostRunner`. `shell: false` is the load-bearing detail: every
 * argument reaches the host program as one argv element, so a component id or
 * path containing shell metacharacters can never become a second command.
 */
export function createHostRunner(): HostRunner {
	return (file, args, options = {}) => {
		const result = spawnSync(file, args, {
			cwd: options.cwd,
			env: options.env,
			encoding: "utf8",
			shell: false,
			timeout: options.timeoutMs ?? DEFAULT_HOST_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
		});
		return {
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			spawnError: result.error ?? undefined,
		};
	};
}

function isExecutableFile(path: string): boolean {
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return false;
	} catch {
		return false;
	}
	// On Windows the executable bit does not exist; presence on PATH with a
	// PATHEXT-matching suffix is the only signal, and callers pass those in.
	if (process.platform === "win32") return true;
	try {
		// eslint-disable-next-line no-bitwise -- POSIX mode bits are a bitfield by definition.
		return (statSync(path).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * Resolves an executable against an explicitly-passed PATH. Deliberately does
 * NOT shell out to `which`/`where`: detection must be a pure function of the
 * environment the caller hands in, so a test can control it exactly and no
 * external process runs just to answer "is this installed".
 */
export function whichOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
	if (name.includes("/") || name.includes("\\")) {
		return isExecutableFile(name) ? name : null;
	}
	const rawPath = env.PATH ?? env.Path ?? "";
	if (rawPath === "") return null;
	const suffixes = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];

	for (const dir of rawPath.split(delimiter)) {
		if (dir === "" || !isAbsolute(dir)) continue;
		for (const suffix of suffixes) {
			const candidate = join(dir, `${name}${suffix}`);
			if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
		}
	}
	return null;
}
