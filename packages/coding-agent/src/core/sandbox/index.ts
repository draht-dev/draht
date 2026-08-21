/**
 * OS-level sandbox for the bash tool (Phase 44, R44-SBX.1 .. R44-SBX.3).
 *
 * - `policy.ts` -- `SandboxPolicy` v1: the declarative write allowlist, read
 *   mode, network toggle and privilege-escalation invariant.
 * - `real-path.ts` -- real-path resolution applied to every policy path before
 *   any profile is generated, so no symlink or `..` hop can widen the allowlist.
 * - `executor.ts` -- the `SandboxExecutor` seam, backend registry and the
 *   `unavailable` posture.
 * - `seatbelt-profile.ts` / `seatbelt.ts` -- the macOS backend. The profile is
 *   an allow-list (`(deny default)` plus enumerated capabilities) handed to
 *   `sandbox-exec` inline, so it never exists as a file the sandbox could edit.
 *   Exercised for real against `/usr/bin/sandbox-exec` by
 *   `test/sandbox-backend.test.ts`, including the escape vectors it closes.
 * - `linux.ts` -- the Linux backend (Landlock helper / bwrap / unshare).
 *   **Source-only evidence: never executed.** See its module doc.
 * - `self-test.ts` -- R44-SBX.4. The only thing that may report `available`.
 * - `env.ts` -- R44-SBX.5. The child's environment is constructed, not inherited.
 * - `spawn.ts` -- the shared wrapped-child process plumbing.
 *
 * The `BashOperations` wrapper (R44-SBX.6) lives in `bash-operations.ts` and is
 * deliberately **not** re-exported here: it is the one file in this directory
 * that imports from `../tools/`, and keeping it out of the barrel lets anything
 * that only wants the policy model import this without dragging the tool layer
 * along -- and keeps a future `tools/bash.ts` -> sandbox import cycle-free.
 * Import it directly: `from "../sandbox/bash-operations.ts"`.
 */

export {
	type BuildSandboxEnvOptions,
	buildSandboxEnv,
	SANDBOX_ENV_ALLOWLIST,
	SANDBOX_ENV_MARKER,
} from "./env.ts";
export {
	BUILTIN_SANDBOX_BACKENDS,
	type CreateSandboxExecutorOptions,
	createSandboxExecutor,
	createUnavailableSandboxExecutor,
	type SandboxBackendFactory,
	type SandboxExecOptions,
	type SandboxExecResult,
	type SandboxExecutor,
	type SandboxStatus,
	SandboxUnavailableError,
	SUPPORTED_SANDBOX_PLATFORMS,
} from "./executor.ts";
export {
	buildLinuxSandboxCommand,
	createLinuxSandboxExecutor,
	detectLinuxSandboxMechanism,
	type LinuxSandboxMechanism,
	type LinuxSandboxOptions,
	MIN_LANDLOCK_KERNEL,
	supportsLandlock,
} from "./linux.ts";
export {
	excludedWriteRootReason,
	isPathWritable,
	type RejectedWritePath,
	resolveSandboxPolicy,
	SANDBOX_POLICY_VERSION,
	type SandboxNetworkMode,
	type SandboxPolicy,
	SandboxPolicyError,
	type SandboxPolicyInput,
	type SandboxPolicyResolution,
} from "./policy.ts";
export { isContainedIn, type RealPathResolution, type ResolveRealPathOptions, resolveRealPath } from "./real-path.ts";
export {
	buildSandboxExecArgs,
	createSeatbeltSandboxExecutor,
	DEFAULT_SANDBOX_EXEC_BIN,
	MAX_INLINE_PROFILE_BYTES,
	type SeatbeltSandboxOptions,
} from "./seatbelt.ts";
export { buildSeatbeltProfile, quoteSbplString, SandboxProfileError } from "./seatbelt-profile.ts";
export { runSandboxSelfTest, type SandboxSelfTestOptions, type SandboxSelfTestRunner } from "./self-test.ts";
