/**
 * macOS Seatbelt backend (R44-SBX.1) -- `sandbox-exec -p <generated profile>`.
 *
 * This is the platform this machine can and does exercise for real: every claim
 * in `seatbelt-profile.ts`'s doc comment was measured here, and the tests in
 * `test/sandbox-backend.test.ts` run against the actual `/usr/bin/sandbox-exec`,
 * not a stub.
 *
 * ## Flow
 *
 * 1. Render the policy to SBPL (`buildSeatbeltProfile`).
 * 2. `sandbox-exec -p <profile> <shell> -c <command>` with a constructed env.
 *
 * There is no step where the profile touches the filesystem, and that is the
 * point. This backend used to stage the SBPL at
 * `mkdtemp(os.tmpdir())/policy.sb` and pass `-f <path>` -- but `os.tmpdir()` is
 * in the write allowlist of *every* production policy (R44-SBX.2), so the file
 * describing the sandbox sat inside the sandbox's own writable area. A confined
 * command could therefore watch that directory and overwrite the profile of a
 * later command with `(allow default)`; a reviewer demonstrated the write
 * succeeding. Passing the profile inline through `-p` removes the artifact
 * rather than trying to protect it: there is no path to race, no directory to
 * watch, and no window between write and read.
 *
 * The profile is visible in the wrapper's argv, which is a disclosure of the
 * policy (which directories are writable), never of a secret -- and a sandboxed
 * process cannot read another process's argv anyway, since the profile denies
 * `process-info*` against other processes.
 *
 * Regenerating per invocation rather than caching by policy hash is deliberate
 * for v1: the policy is resolved per invocation anyway (R44-SBX.2). Profile
 * generation is string building; Phase 46 owns the spawn-overhead budget and can
 * revisit with numbers.
 *
 * ## `status()` and `exec()`
 *
 * `status()` runs the R44-SBX.4 self-test once and memoises the *promise*, so
 * concurrent callers share one probe. `exec()` awaits that same status first and
 * throws `SandboxUnavailableError` when it is not `available` -- **before**
 * spawning anything. That ordering is the whole failure posture: a backend that
 * cannot prove confinement does not run the command in a weaker sandbox and does
 * not run it bare, it does not run it.
 *
 * ## `sandbox-exec` is deprecated
 *
 * It has carried a deprecation warning for years and still ships on every macOS;
 * Chrome, Claude Code and Codex all depend on it. The risk is handled by
 * structure rather than by hope: if Apple removes it, `existsSync` fails or the
 * self-test fails, and this backend reports `unavailable`. Deprecation therefore
 * degrades us to today's permission-gate behaviour (Phase 45), never to silently
 * unconfined execution.
 */

import { existsSync } from "node:fs";
import { getShellConfig } from "../../utils/shell.ts";
import { buildSandboxEnv } from "./env.ts";
import {
	type SandboxExecOptions,
	type SandboxExecResult,
	type SandboxExecutor,
	type SandboxStatus,
	SandboxUnavailableError,
} from "./executor.ts";
import type { SandboxPolicy } from "./policy.ts";
import { buildSeatbeltProfile } from "./seatbelt-profile.ts";
import { runSandboxSelfTest } from "./self-test.ts";
import { spawnSandboxedProcess } from "./spawn.ts";

export const DEFAULT_SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

/**
 * Ceiling on the inline profile, well under the 1 MiB `ARG_MAX` this machine
 * reports. A policy that renders larger than this is not one we hand to `execve`
 * and hope: an `E2BIG` from the wrapper would surface as an opaque spawn failure,
 * whereas refusing here surfaces as `unavailable`, which is the outcome every
 * other "cannot confine" case in this module already produces.
 */
export const MAX_INLINE_PROFILE_BYTES = 256 * 1024;

/**
 * Builds the wrapper argv.
 *
 * Exported so a test can assert the shape directly: the profile travels as the
 * `-p` operand and **no element is a path to a profile file**, which is the
 * invariant that keeps a sandboxed command from tampering with the profile of a
 * later one.
 */
export function buildSandboxExecArgs(
	profile: string,
	shell: string,
	shellArgs: readonly string[],
	command: string,
): string[] {
	return ["-p", profile, shell, ...shellArgs, command];
}

export interface SeatbeltSandboxOptions {
	/**
	 * Path to `sandbox-exec`. Overridable chiefly as a test injection point for
	 * proving fail-closed behaviour -- point it at a nonexistent path and the
	 * backend must report `unavailable`, not fall back to a bare spawn. Same role
	 * the equivalent option plays in `packages/rlm/src/sandbox.ts`.
	 */
	sandboxExecBin?: string;
	/** Explicit shell path from settings; defaults to `getShellConfig()`'s resolution. */
	shellPath?: string;
	/**
	 * Profile generator override. Exists so tests can hand the backend a
	 * deliberately broken or deliberately permissive profile and assert the
	 * self-test catches both. Production never sets it.
	 */
	buildProfile?: (policy: SandboxPolicy) => string;
	/** Extra environment variable names to admit (Phase 45 wires this to settings). */
	extraAllowedEnvVars?: readonly string[];
	/** Seconds allowed for the self-test probe. Defaults to the self-test's own default. */
	selfTestTimeoutSeconds?: number;
}

export function createSeatbeltSandboxExecutor(options: SeatbeltSandboxOptions = {}): SandboxExecutor {
	const sandboxExecBin = options.sandboxExecBin ?? DEFAULT_SANDBOX_EXEC_BIN;
	const buildProfile = options.buildProfile ?? buildSeatbeltProfile;

	/**
	 * Runs one command confined by `policy`. Used by both `exec` and the
	 * self-test, so the probe cannot pass through a path production does not use.
	 */
	const runConfined = async (
		command: string,
		cwd: string,
		policy: SandboxPolicy,
		execOptions: SandboxExecOptions,
	): Promise<SandboxExecResult> => {
		if (!existsSync(sandboxExecBin)) {
			throw new SandboxUnavailableError(
				`macOS sandbox-exec not found at ${JSON.stringify(sandboxExecBin)} -- refusing to run the command unconfined`,
			);
		}
		let profile: string;
		try {
			profile = buildProfile(policy);
		} catch (err) {
			// A policy this backend cannot render exactly is a policy it cannot
			// enforce. Surfacing it as `SandboxUnavailableError` (rather than letting
			// a `SandboxProfileError` escape) keeps every "could not confine" outcome
			// one type at the call site -- and, as everywhere else here, the command
			// has not been spawned at this point and will not be.
			throw new SandboxUnavailableError(
				`cannot generate a sandbox profile for this policy: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const profileBytes = Buffer.byteLength(profile, "utf8");
		if (profileBytes > MAX_INLINE_PROFILE_BYTES) {
			throw new SandboxUnavailableError(
				`the sandbox profile for this policy is ${profileBytes} bytes, over the ${MAX_INLINE_PROFILE_BYTES}-byte limit for passing it inline -- refusing to run the command unconfined`,
			);
		}
		const shell = getShellConfig(options.shellPath);
		return await spawnSandboxedProcess(
			sandboxExecBin,
			buildSandboxExecArgs(profile, shell.shell, shell.args, command),
			{
				cwd,
				env: buildSandboxEnv({
					source: execOptions.env,
					extraAllowedNames: options.extraAllowedEnvVars,
				}),
				onData: execOptions.onData,
				signal: execOptions.signal,
				timeout: execOptions.timeout,
			},
		);
	};

	let statusPromise: Promise<SandboxStatus> | undefined;
	const status = (): Promise<SandboxStatus> => {
		statusPromise ??= runSandboxSelfTest({
			backendName: "seatbelt",
			timeoutSeconds: options.selfTestTimeoutSeconds,
			run: async (command, cwd, policy, timeoutSeconds) => {
				let output = "";
				const result = await runConfined(command, cwd, policy, {
					onData: (data) => {
						output += data.toString();
					},
					timeout: timeoutSeconds,
				});
				return { exitCode: result.exitCode, output };
			},
			// A throwing `runConfined` (missing binary, unrenderable policy) is a
			// failed self-test like any other; `runSandboxSelfTest` catches it and
			// turns it into a reason.
		}).catch((err) => ({
			available: false as const,
			reason: `seatbelt sandbox self-test failed: ${err instanceof Error ? err.message : String(err)}`,
		}));
		return statusPromise;
	};

	return {
		name: "seatbelt",
		status,
		exec: async (command, cwd, policy, execOptions) => {
			const current = await status();
			if (!current.available) throw new SandboxUnavailableError(current.reason);
			return runConfined(command, cwd, policy, execOptions);
		},
	};
}
