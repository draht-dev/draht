/**
 * The `BashOperations` wrapper (R44-SBX.6).
 *
 * This is the only place the sandbox meets the agent's bash tool. It implements
 * the existing `BashOperations` seam in `../tools/bash.ts` -- the same interface
 * an SSH or container backend would implement -- so the bash tool itself needs
 * no change: `createBashTool(cwd, { operations })` is the whole integration.
 *
 * ## Three states, and the rule that separates them
 *
 * | sandboxing | backend    | what runs                                   |
 * |------------|------------|---------------------------------------------|
 * | off        | (not asked)| the wrapped local backend, untouched        |
 * | on         | available  | the command, confined by the policy          |
 * | on         | unavailable| the wrapped local backend, announced once    |
 *
 * **Off must be invisible.** Sandboxing off is the default and is what every
 * existing session is: the wrapper forwards `command`, `cwd` and the *same
 * options object* to the wrapped backend and returns its result. It does not
 * resolve a policy, does not construct an env, does not so much as ask the
 * executor whether it exists -- because asking runs a self-test, which spawns
 * processes. The bash tool is the agent's primary limb; a wrapper that subtly
 * changed its timing, its environment or its error text while claiming to be
 * disabled would be a regression paid for by every user who never turned the
 * sandbox on.
 *
 * ## Why `unavailable` falls back, when the rest of this module never does
 *
 * Everywhere else in `src/core/sandbox/`, "cannot confine" means "do not run".
 * Here it means "run the way this product ran yesterday". That inversion is
 * deliberate and is the spec's one explicit departure from Phase 28
 * (`.planning/specs/2026-07-12-bash-sandbox-confinement.md`): the RLM sandbox
 * exists to contain untrusted generated code, so refusing to start is the safe
 * answer; the bash tool *is* the agent, so hard-failing every command on a host
 * without a working backend bricks the product rather than protecting it. The
 * documented posture is to fall back to the permission gate exactly as it works
 * today (R45-SBM.5), which is a strictly-unchanged security posture, not a
 * weakened one.
 *
 * What makes that safe rather than merely convenient is that the fallback is
 * **loud and whole-session**:
 *
 * - It is announced through `onNotice` **once**, not once per command. A
 *   per-command warning is noise, and noise is how a security notice gets
 *   trained away.
 * - The decision is taken from `SandboxExecutor.status()`, which is asked once
 *   and memoised, so a session is either sandboxed or it is not. There is no
 *   command-by-command drift where some commands were confined and nobody can
 *   say which.
 * - The fallback child is the *ordinary* child: it carries no `DRAHT_SANDBOX`
 *   marker and gets no filtered env, so nothing downstream -- a prompt, a
 *   script, a future permission decision -- can mistake it for a confined one.
 *   The test suite asserts this by checking that an escape write actually
 *   *succeeds* in fallback: a fallback that happened to block it would be
 *   indistinguishable from confinement the session never had.
 *
 * ## What does *not* fall back
 *
 * Once the backend has reported `available`, a single invocation that cannot be
 * confined -- an unrenderable policy, a cwd that no longer resolves -- is an
 * error, not a fallback. It rejects with `SandboxUnavailableError`. Silently
 * running that one command unconfined in an otherwise-sandboxed session is the
 * exact hole this phase exists to close: the caller believes confinement holds,
 * and the one command that escaped it is the one nobody was told about. Phase 45
 * turns that rejection into the "rerun unsandboxed?" approval prompt, which is
 * the same decision made *in the open*.
 *
 * ## Layering note
 *
 * This is the only file in `src/core/sandbox/` that imports from `../tools/`,
 * which is why it is deliberately absent from `./index.ts`: the barrel stays
 * usable by anything that just wants the policy model, without dragging the tool
 * and render layers in behind it -- and a future `bash.ts` that wants to import
 * the sandbox barrel cannot create a cycle.
 */

import { type BashOperations, createLocalBashOperations } from "../tools/bash.ts";
import {
	createSandboxExecutor,
	type SandboxExecutor,
	type SandboxStatus,
	SandboxUnavailableError,
} from "./executor.ts";
import { resolveSandboxPolicy, type SandboxPolicy, type SandboxPolicyInput } from "./policy.ts";

/** Static, or read per invocation so a `/sandbox` toggle takes effect on the next command. */
export type SandboxEnabledSource = boolean | (() => boolean);

/**
 * Everything about the policy except `cwd`.
 *
 * `cwd` is not configurable here on purpose: the policy's project root is always
 * the directory the command actually runs in, taken from the `exec` call itself.
 * A separately-configured root could drift from the real working directory, and
 * a write allowlist that does not contain the cwd is the kind of mismatch that
 * gets "fixed" by widening the allowlist. Anything else that must be writable is
 * `extraWritePaths`, which is explicit and visible.
 */
export type SandboxPolicyOverrides = Omit<SandboxPolicyInput, "cwd">;

/** Static, or read per invocation so settings changes take effect without a restart. */
export type SandboxPolicySource = SandboxPolicyOverrides | (() => SandboxPolicyOverrides);

/**
 * Something the caller must be able to show the user. Both kinds are emitted at
 * most once per distinct fact per wrapper, never once per command.
 */
export type SandboxNotice =
	| {
			readonly kind: "unavailable";
			/** Backend that could not confine, for diagnostics (`"seatbelt"`, `"unavailable"`, ...). */
			readonly backend: string;
			readonly reason: string;
	  }
	| {
			/** A configured write path was dropped from the policy. Narrowing, but never silent. */
			readonly kind: "write-path-rejected";
			/** The entry exactly as configured, so the user can find it in their settings. */
			readonly input: string;
			readonly reason: string;
	  };

export interface SandboxedBashOperationsOptions {
	/**
	 * The unsandboxed backend, used when sandboxing is off or unavailable.
	 * Defaults to `createLocalBashOperations({ shellPath })` -- the same call the
	 * bash tool makes for itself, so the fallback path is not a reimplementation
	 * of local execution but literally the existing one.
	 */
	operations?: BashOperations;
	/** Explicit shell path from settings, forwarded to the default local backend. */
	shellPath?: string;
	/** Defaults to `createSandboxExecutor()` (platform backend, or an unavailable one with a reason). */
	executor?: SandboxExecutor;
	/** Session sandbox state. Defaults to `false`: nothing becomes sandboxed by accident. */
	enabled?: SandboxEnabledSource;
	/** Policy inputs other than `cwd`. */
	policy?: SandboxPolicySource;
	/** Where user-visible sandbox facts go. Phase 45 wires this to the UI. */
	onNotice?: (notice: SandboxNotice) => void;
}

export interface SandboxedBashOperations extends BashOperations {
	/** Backend identity for diagnostics. */
	readonly backendName: string;
	/**
	 * The backend's status, asked once and memoised.
	 *
	 * Answers "*can* this session sandbox?", which is a different question from
	 * "is sandboxing on?" -- Phase 45 needs the former to decide whether to offer
	 * `/sandbox on` at all. Calling it runs the R44-SBX.4 self-test, so it is not
	 * called implicitly while sandboxing is off.
	 */
	sandboxStatus(): Promise<SandboxStatus>;
}

/**
 * Wraps a local `BashOperations` with OS-level confinement.
 *
 * The returned object is a drop-in for `createLocalBashOperations()`; with
 * `enabled` false (the default) it *is* that backend, one function call deeper.
 */
export function createSandboxedBashOperations(options: SandboxedBashOperationsOptions = {}): SandboxedBashOperations {
	const fallback = options.operations ?? createLocalBashOperations({ shellPath: options.shellPath });
	const executor = options.executor ?? createSandboxExecutor();
	const enabledSource = options.enabled ?? false;
	const policySource = options.policy ?? {};
	const onNotice = options.onNotice;

	const isEnabled = (): boolean => (typeof enabledSource === "function" ? enabledSource() : enabledSource);

	let unavailableAnnounced = false;
	const announcedRejections = new Set<string>();

	const announceUnavailable = (reason: string): void => {
		if (unavailableAnnounced) return;
		unavailableAnnounced = true;
		onNotice?.({ kind: "unavailable", backend: executor.name, reason });
	};

	const announceRejection = (input: string, reason: string): void => {
		const key = JSON.stringify([input, reason]);
		if (announcedRejections.has(key)) return;
		announcedRejections.add(key);
		onNotice?.({ kind: "write-path-rejected", input, reason });
	};

	let statusPromise: Promise<SandboxStatus> | undefined;
	const sandboxStatus = (): Promise<SandboxStatus> => {
		// `Promise.resolve().then(...)` rather than a bare call: `status()` is
		// documented never to throw, but a caller-supplied executor is not bound by
		// our documentation, and a synchronous throw here would escape as an
		// exception from the *bash tool* rather than as "we could not confine".
		statusPromise ??= Promise.resolve()
			.then(() => executor.status())
			.catch((err) => ({
				available: false as const,
				reason: `sandbox backend ${JSON.stringify(executor.name)} could not report its status: ${
					err instanceof Error ? err.message : String(err)
				}`,
			}));
		return statusPromise;
	};

	/**
	 * Resolved fresh for every invocation, not cached by cwd.
	 *
	 * Real-path resolution is a claim about the filesystem *now*: a directory in
	 * the allowlist can be replaced by a symlink between two commands in the same
	 * session, and a policy cached from before that swap would authorise a path
	 * that no longer means what it meant. It matches the backends, which
	 * regenerate their profile per invocation for the same reason. Phase 46 owns
	 * the spawn-overhead budget and can revisit this with numbers.
	 */
	const policyFor = (cwd: string): SandboxPolicy => {
		const overrides = typeof policySource === "function" ? policySource() : policySource;
		let resolution: ReturnType<typeof resolveSandboxPolicy>;
		try {
			resolution = resolveSandboxPolicy({ ...overrides, cwd });
		} catch (err) {
			// The policy is what confinement *is*. Not being able to build one is not
			// a reason to run without one.
			throw new SandboxUnavailableError(
				`cannot resolve a sandbox policy for ${JSON.stringify(cwd)}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		for (const rejection of resolution.rejected) announceRejection(rejection.input, rejection.reason);
		return resolution.policy;
	};

	return {
		backendName: executor.name,
		sandboxStatus,
		exec: async (command, cwd, execOptions) => {
			// Sandboxing off: hand the call straight through. Same arguments, same
			// options object, same promise -- nothing to diverge from.
			if (!isEnabled()) return fallback.exec(command, cwd, execOptions);

			const status = await sandboxStatus();
			if (!status.available) {
				announceUnavailable(status.reason);
				return fallback.exec(command, cwd, execOptions);
			}

			return executor.exec(command, cwd, policyFor(cwd), execOptions);
		},
	};
}
