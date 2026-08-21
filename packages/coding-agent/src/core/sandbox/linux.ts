/**
 * Linux backend (R44-SBX.1) -- Landlock helper, bubblewrap, or `unshare`.
 *
 * ## Evidence class: SOURCE-ONLY. Nothing here has been executed.
 *
 * This module was written and reviewed on macOS (darwin). No line of it has ever
 * run on Linux, and the tests that accompany it assert on *constructed argument
 * vectors*, never on confinement -- constructing the right argv is not evidence
 * that the argv confines anything. Treat every claim below as a design intent
 * awaiting the Linux CI matrix that R46-SBH.2 owns, which exists precisely
 * because Phase 28 shipped an unverified Linux path from this same machine.
 *
 * The reason that posture is *safe* rather than merely honest: this backend is
 * gated by the same R44-SBX.4 self-test as the macOS one, and the self-test
 * confirms confinement from outside the sandbox. If any mechanism below fails to
 * confine on a real kernel, `status()` answers `unavailable` and no command runs
 * through it. Unverified code cannot promote itself to `available`; only a
 * passing probe on the actual host can.
 *
 * ## Landlock, and why it is a seam rather than an implementation
 *
 * R44-SBX.1 names Landlock (kernel >= 5.13) as the preferred mechanism, and it
 * is the right one: per-process filesystem restriction, no root, no setuid
 * helper, no namespaces. But applying it means calling `landlock_create_ruleset(2)`,
 * `landlock_add_rule(2)` and `prctl(PR_SET_NO_NEW_PRIVS)` *between* fork and exec,
 * and Node exposes none of those. Codex solves this with a native Rust helper it
 * ships; Phase 44 builds no native artefact, and adding one is not something
 * that can be validated from here.
 *
 * So Landlock is wired as an explicit, opt-in helper contract rather than
 * guessed at against a third-party CLI whose flags cannot be checked from this
 * machine:
 *
 *     <helper> --ro <path> --rw <path> [--rw <path> ...] [--no-network] -- <argv...>
 *
 * configured via `landlockHelperBin` or `DRAHT_SANDBOX_LANDLOCK_HELPER`. If no
 * helper is configured the mechanism is simply not selected. If one is
 * configured but does not honour the contract, the self-test fails and the
 * backend reports `unavailable` -- which is why shipping an unproven contract
 * here is not a security risk.
 *
 * ## Namespace mechanisms (the fallback R44-SBX.1 asks for)
 *
 * - **bubblewrap** (`bwrap`), preferred: `--ro-bind / /` gives read allow-all,
 *   then one `--bind` per policy write path makes exactly those subtrees
 *   writable. That is the R44-SBX.2 policy shape expressed directly. bwrap sets
 *   `PR_SET_NO_NEW_PRIVS` by default, which is what makes `sudo` and every other
 *   setuid binary inert -- the privilege-escalation invariant. `--unshare-net`
 *   when the policy says network off.
 * - **`unshare`**, fallback: `--user --map-root-user --mount` and then a mount
 *   preamble that makes `/` read-only and re-binds the write paths read-write.
 *   Coarser and more fragile than bwrap (it is a shell preamble, not a
 *   supervisor), and the one piece here most likely to need revision once it has
 *   actually run. `--net` for network off, as in Phase 28.
 *
 *   Note the consequence of the R44-SBX.4 privilege-escalation probe: `unshare`
 *   sets neither `PR_SET_NO_NEW_PRIVS` nor anything that refuses `exec` of a
 *   setuid binary, so it can demonstrate neither half of the
 *   `allowPrivilegeEscalation: false` invariant and the self-test will report
 *   `unavailable` for it. That is the fail-closed reading and it is the intended
 *   one: this backend's entire safety argument is the self-test, so a mechanism
 *   that cannot show the invariant holds does not get to claim it.
 *
 * Ordering is Landlock helper, then bwrap, then unshare: most precise mechanism
 * first, and the kernel-version check keeps the Landlock path from being chosen
 * on a kernel that cannot support it even when a helper is configured.
 */

import { existsSync } from "node:fs";
import { release as osRelease } from "node:os";
import { delimiter, join } from "node:path";
import { getShellConfig, type ShellConfig } from "../../utils/shell.ts";
import { buildSandboxEnv } from "./env.ts";
import {
	type SandboxExecOptions,
	type SandboxExecResult,
	type SandboxExecutor,
	type SandboxStatus,
	SandboxUnavailableError,
} from "./executor.ts";
import type { SandboxPolicy } from "./policy.ts";
import { SandboxProfileError } from "./seatbelt-profile.ts";
import { runSandboxSelfTest } from "./self-test.ts";
import { spawnSandboxedProcess } from "./spawn.ts";

/** Landlock filesystem restriction landed in Linux 5.13. Below that the helper cannot work. */
export const MIN_LANDLOCK_KERNEL = { major: 5, minor: 13 } as const;

export type LinuxSandboxMechanism =
	| { kind: "landlock"; bin: string }
	| { kind: "bwrap"; bin: string }
	| { kind: "unshare"; bin: string };

export interface LinuxSandboxOptions {
	/** Path to a Landlock helper implementing the contract in the module doc. */
	landlockHelperBin?: string;
	/** Resolves a bare binary name; defaults to a `PATH` scan. Injection point for tests. */
	lookupBin?: (name: string) => string | null;
	/**
	 * Defaults to `os.release()`. Injection point for tests.
	 *
	 * The default is applied inside `detectLinuxSandboxMechanism` rather than only
	 * at the one call site in `createLinuxSandboxExecutor`, because it used to
	 * default to `""` there: every *exported* call therefore failed
	 * `supportsLandlock("")` and silently fell through to bwrap, even on a kernel
	 * that supports Landlock and with a helper configured.
	 */
	kernelRelease?: string;
	shellPath?: string;
	extraAllowedEnvVars?: readonly string[];
	selfTestTimeoutSeconds?: number;
}

function lookupOnPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** True when `release` (an `os.release()` string) is at least 5.13. Unparseable releases answer `false`. */
export function supportsLandlock(release: string): boolean {
	const match = /^(\d+)\.(\d+)/.exec(release);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major > MIN_LANDLOCK_KERNEL.major) return true;
	return major === MIN_LANDLOCK_KERNEL.major && minor >= MIN_LANDLOCK_KERNEL.minor;
}

/** Picks the mechanism to use, most precise first. `null` means this host has none. */
export function detectLinuxSandboxMechanism(options: LinuxSandboxOptions = {}): LinuxSandboxMechanism | null {
	const lookup = options.lookupBin ?? lookupOnPath;
	const release = options.kernelRelease ?? osRelease();

	const helper = options.landlockHelperBin ?? process.env.DRAHT_SANDBOX_LANDLOCK_HELPER;
	if (helper && existsSync(helper) && supportsLandlock(release)) return { kind: "landlock", bin: helper };

	const bwrap = lookup("bwrap");
	if (bwrap) return { kind: "bwrap", bin: bwrap };

	const unshare = lookup("unshare");
	if (unshare) return { kind: "unshare", bin: unshare };

	return null;
}

/** Single-quoted shell word for the `unshare` preamble. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `unshare` mount preamble: make propagation private, remount `/` read-only,
 * then bind each write path back read-write.
 *
 * `/dev` and `/proc` are remounted read-write best-effort (`|| true`): they carry
 * no user data, and a shell that cannot write `/dev/null` is unusable. Failures
 * are tolerated because the self-test, not this preamble, decides whether the
 * result is good enough to call a sandbox.
 */
function buildUnsharePreamble(policy: SandboxPolicy): string {
	const steps = [
		"mount --make-rprivate /",
		"mount --bind / /",
		"mount -o remount,bind,ro /",
		"mount -o remount,bind,rw /dev 2>/dev/null || true",
		"mount -o remount,bind,rw /proc 2>/dev/null || true",
	];
	for (const path of policy.writePaths) {
		const quoted = shellQuote(path);
		steps.push(`mount --bind ${quoted} ${quoted}`, `mount -o remount,bind,rw ${quoted}`);
	}
	return steps.join(" && ");
}

/**
 * Builds the wrapper invocation for `mechanism`.
 *
 * Exported so the argument vectors are reviewable and testable without a Linux
 * host -- with the standing caveat that a correct-looking argv is not evidence
 * of confinement.
 */
export function buildLinuxSandboxCommand(
	mechanism: LinuxSandboxMechanism,
	policy: SandboxPolicy,
	command: string,
	shell: ShellConfig,
	cwd: string,
): { command: string; args: string[] } {
	if (policy.writePaths.length === 0) {
		throw new SandboxProfileError("cannot build a linux sandbox command: the write allowlist is empty");
	}
	if (policy.writePaths.includes("/")) {
		throw new SandboxProfileError(
			"cannot build a linux sandbox command: the write allowlist contains the filesystem root, which would confine nothing",
		);
	}
	const shellInvocation = [shell.shell, ...shell.args, command];

	if (mechanism.kind === "landlock") {
		const args = ["--ro", "/"];
		for (const path of policy.writePaths) args.push("--rw", path);
		if (policy.network === "off") args.push("--no-network");
		return { command: mechanism.bin, args: [...args, "--", ...shellInvocation] };
	}

	if (mechanism.kind === "bwrap") {
		const args = [
			"--die-with-parent",
			// Read allow-all: the whole filesystem, read-only ...
			"--ro-bind",
			"/",
			"/",
			// ... with the kernel/device filesystems a shell needs ...
			"--dev-bind",
			"/dev",
			"/dev",
			"--proc",
			"/proc",
		];
		// ... and exactly the policy's paths writable again. Later binds win, so
		// these must follow the read-only root bind.
		for (const path of policy.writePaths) args.push("--bind", path, path);
		if (policy.network === "off") args.push("--unshare-net");
		args.push("--chdir", cwd, "--");
		return { command: mechanism.bin, args: [...args, ...shellInvocation] };
	}

	// unshare: the namespace flags Phase 28 used, plus a preamble that turns a
	// mount namespace into an actual write allowlist.
	const args = ["--user", "--map-root-user", "--mount"];
	if (policy.network === "off") args.push("--net");
	const preamble = buildUnsharePreamble(policy);
	return {
		command: mechanism.bin,
		args: [...args, "--", shell.shell, ...shell.args, `${preamble} && cd ${shellQuote(cwd)} && ${command}`],
	};
}

export function createLinuxSandboxExecutor(options: LinuxSandboxOptions = {}): SandboxExecutor {
	const mechanism = detectLinuxSandboxMechanism(options);

	const runConfined = async (
		command: string,
		cwd: string,
		policy: SandboxPolicy,
		execOptions: SandboxExecOptions,
	): Promise<SandboxExecResult> => {
		if (!mechanism) {
			throw new SandboxUnavailableError(
				"no linux sandbox mechanism is available on this host (looked for a Landlock helper, bwrap, then unshare) -- refusing to run the command unconfined",
			);
		}
		const shell = getShellConfig(options.shellPath);
		let built: { command: string; args: string[] };
		try {
			built = buildLinuxSandboxCommand(mechanism, policy, command, shell, cwd);
		} catch (err) {
			// Same reasoning as the Seatbelt backend: a policy that cannot be
			// expressed is one that cannot be enforced, and nothing has spawned yet.
			throw new SandboxUnavailableError(
				`cannot build a linux sandbox invocation for this policy: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return spawnSandboxedProcess(built.command, built.args, {
			cwd,
			env: buildSandboxEnv({ source: execOptions.env, extraAllowedNames: options.extraAllowedEnvVars }),
			onData: execOptions.onData,
			signal: execOptions.signal,
			timeout: execOptions.timeout,
		});
	};

	let statusPromise: Promise<SandboxStatus> | undefined;
	const status = (): Promise<SandboxStatus> => {
		statusPromise ??= (
			mechanism
				? runSandboxSelfTest({
						backendName: `linux-${mechanism.kind}`,
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
					})
				: Promise.resolve<SandboxStatus>({
						available: false,
						reason:
							"no linux sandbox mechanism is available on this host: no Landlock helper is configured (DRAHT_SANDBOX_LANDLOCK_HELPER), and neither bwrap nor unshare was found on PATH",
					})
		).catch((err) => ({
			available: false as const,
			reason: `linux sandbox self-test failed: ${err instanceof Error ? err.message : String(err)}`,
		}));
		return statusPromise;
	};

	return {
		name: mechanism ? `linux-${mechanism.kind}` : "linux-unavailable",
		status,
		exec: async (command, cwd, policy, execOptions) => {
			const current = await status();
			if (!current.available) throw new SandboxUnavailableError(current.reason);
			return runConfined(command, cwd, policy, execOptions);
		},
	};
}
