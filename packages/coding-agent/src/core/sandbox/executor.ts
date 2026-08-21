/**
 * The `SandboxExecutor` seam (R44-SBX.1).
 *
 * One interface, one status question, one execute path. Platform backends
 * (macOS Seatbelt, Linux Landlock/namespaces) implement it; unsupported
 * platforms get `createUnavailableSandboxExecutor`.
 *
 * ## The status contract
 *
 * `status()` answers `available` **only** with evidence -- for a real backend
 * that means a passing startup self-test (R44-SBX.4). It never throws: a status
 * call that blew up would be indistinguishable at the call site from "we do not
 * know", and "we do not know" must read as `unavailable`.
 *
 * A sandbox that reports `available` while not confining is worse than no
 * sandbox: it converts a known risk into a false guarantee, and every downstream
 * permission decision inherits the lie. So `unavailable` is the only degraded
 * state there is. There is no "available but partially confining", and no path
 * anywhere in this module that runs a command unconfined.
 *
 * ## Why `exec` rejects instead of falling back
 *
 * `exec` on an unavailable executor rejects with `SandboxUnavailableError`. It
 * cannot run the command -- running it would run it unconfined, which is the one
 * thing this module must never do. Callers check `status()` first and, when it
 * is `unavailable`, take the *documented* fallback (Phase 45: the permission
 * gate exactly as it works today, with a one-time notice). That fallback is a
 * decision made in the open by the caller, not a silent slide inside the
 * sandbox.
 */

import { createLinuxSandboxExecutor } from "./linux.ts";
import type { SandboxPolicy } from "./policy.ts";
import { createSeatbeltSandboxExecutor } from "./seatbelt.ts";

export type SandboxStatus = { readonly available: true } | { readonly available: false; readonly reason: string };

export interface SandboxExecOptions {
	/** Streamed stdout+stderr, matching `BashOperations.exec` (R44-SBX.6). */
	readonly onData: (data: Buffer) => void;
	readonly signal?: AbortSignal;
	/** Seconds, matching the bash tool's units. */
	readonly timeout?: number;
	/**
	 * Environment for the sandboxed child. Backends apply env hygiene
	 * (R44-SBX.5) on top: the child never receives the full parent environment.
	 */
	readonly env?: NodeJS.ProcessEnv;
}

export interface SandboxExecResult {
	/** `null` when the process was killed. */
	readonly exitCode: number | null;
}

export interface SandboxExecutor {
	/** Backend identity for diagnostics, e.g. `"seatbelt"`, `"landlock"`, `"unavailable"`. */
	readonly name: string;
	/** Never throws. Backends cache their self-test result behind this. */
	status(): Promise<SandboxStatus>;
	/**
	 * Runs `command` confined by `policy`. Rejects with `SandboxUnavailableError`
	 * when the backend cannot confine -- never runs the command unconfined.
	 */
	exec(command: string, cwd: string, policy: SandboxPolicy, options: SandboxExecOptions): Promise<SandboxExecResult>;
}

/** Thrown by `exec` when confinement cannot be established. Carries the same reason `status()` reports. */
export class SandboxUnavailableError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`sandbox unavailable: ${reason}`);
		this.name = "SandboxUnavailableError";
		this.reason = reason;
	}
}

/** Platforms a backend can exist for. Everything else is `unavailable` by construction. */
export const SUPPORTED_SANDBOX_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

export interface SandboxBackendFactory {
	readonly platform: NodeJS.Platform;
	create(): SandboxExecutor;
}

/**
 * Backends registered for the current build.
 *
 * Registration says a backend *exists* for the platform, nothing more. Both
 * entries construct an executor whose `status()` still has to pass the
 * R44-SBX.4 self-test before it will run anything, so appearing in this list is
 * never itself a claim of confinement -- which is what makes it safe to register
 * the Linux backend from a machine that cannot run it.
 *
 * `create()` is a thunk, so the platform module is only instantiated for the
 * platform actually in use and a factory that throws is caught below.
 */
export const BUILTIN_SANDBOX_BACKENDS: readonly SandboxBackendFactory[] = [
	{ platform: "darwin", create: () => createSeatbeltSandboxExecutor() },
	{ platform: "linux", create: () => createLinuxSandboxExecutor() },
];

/** An executor that is permanently unavailable for a stated reason. */
export function createUnavailableSandboxExecutor(reason: string, name = "unavailable"): SandboxExecutor {
	return {
		name,
		status: async () => ({ available: false, reason }),
		exec: async () => {
			throw new SandboxUnavailableError(reason);
		},
	};
}

export interface CreateSandboxExecutorOptions {
	/** Defaults to `process.platform`. */
	platform?: NodeJS.Platform;
	/** Defaults to `BUILTIN_SANDBOX_BACKENDS`. */
	backends?: readonly SandboxBackendFactory[];
}

/**
 * Picks the backend for `platform`, or an unavailable executor with a reason.
 *
 * Never throws -- a backend factory that throws while constructing is itself a
 * reason to report `unavailable`.
 */
export function createSandboxExecutor(options: CreateSandboxExecutorOptions = {}): SandboxExecutor {
	const platform = options.platform ?? process.platform;
	const backends = options.backends ?? BUILTIN_SANDBOX_BACKENDS;

	if (!SUPPORTED_SANDBOX_PLATFORMS.includes(platform)) {
		return createUnavailableSandboxExecutor(
			`no sandbox backend exists for platform ${JSON.stringify(platform)} (supported: ${SUPPORTED_SANDBOX_PLATFORMS.join(", ")})`,
		);
	}

	const factory = backends.find((backend) => backend.platform === platform);
	if (!factory) {
		return createUnavailableSandboxExecutor(
			`no sandbox backend is registered for platform ${JSON.stringify(platform)} in this build`,
		);
	}

	try {
		return factory.create();
	} catch (err) {
		return createUnavailableSandboxExecutor(
			`sandbox backend for platform ${JSON.stringify(platform)} failed to initialize: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}
