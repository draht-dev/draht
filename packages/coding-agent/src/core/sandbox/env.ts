/**
 * Environment hygiene for the sandboxed child (R44-SBX.5).
 *
 * The child gets a **constructed** environment, never `{ ...process.env }` and
 * never the caller's env object passed straight through. The caller's env is
 * treated as a *source of values*; the allowlist below is the *gate*.
 *
 * ## Why an allowlist and not a denylist
 *
 * A denylist has to enumerate every secret-bearing variable that exists, which
 * is unbounded and grows with every tool a user installs -- `ANTHROPIC_API_KEY`,
 * `AWS_SECRET_ACCESS_KEY`, `GH_TOKEN`, `NPM_TOKEN`, `OP_SERVICE_ACCOUNT_TOKEN`,
 * whatever tomorrow ships. Getting a denylist wrong leaks a credential; getting
 * an allowlist wrong breaks a build, loudly, and the user tells us. Only one of
 * those two failure modes is recoverable.
 *
 * This matters *more* here than it did in Phase 28, not less. Phase 28's RLM
 * sandbox denies network outright, so a leaked key could at worst be written
 * into the session workdir. The bash sandbox's network is **on by default**
 * (R44-SBX.2 -- dev workflows need `npm install` and `git fetch`), so a variable
 * that reaches the child is a variable that can leave the machine. The write
 * allowlist bounds what a command can *destroy*; only this list bounds what it
 * can *disclose*.
 *
 * ## What is on the list, and why
 *
 * Everything here is either (a) needed to make a shell and a toolchain behave
 * like the user's own shell -- `PATH`, `HOME`, `SHELL`, `TMPDIR`, locale, `TERM`
 * -- or (b) a `DRAHT_*` session variable the bash tool sets deliberately for
 * user scripts to read (see `resolveSpawnContext` in `../tools/bash.ts`), none
 * of which carry credentials.
 *
 * Deliberately **absent**, and worth stating because each is a thing somebody
 * will eventually ask for:
 *
 * - `SSH_AUTH_SOCK` / `GPG_AGENT_INFO` -- handles to an agent holding live
 *   private keys. Forwarding one lets anything in the sandbox sign and
 *   authenticate as the user; the filesystem allowlist does not bound that at
 *   all. `git push` over SSH therefore does not work inside the sandbox, which
 *   is the correct default (the spec keeps outward-facing operations prompting
 *   in Phase 45 anyway).
 * - `*_TOKEN`, `*_API_KEY`, `AWS_*`, `NPM_TOKEN`, ... -- the whole point.
 * - `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES` --
 *   these inject code into the child before its first line runs. They are not
 *   secrets, they are execution vectors, and inheriting them silently would let
 *   the *parent's* configuration decide what the sandboxed shell actually does.
 *
 * A project that genuinely needs one of these passes it through
 * `extraAllowedNames` (Phase 45 wires that to settings) -- an explicit, visible,
 * per-project decision rather than an accident of inheritance.
 */

/** Set in every sandboxed child, so scripts and prompts can detect confinement. */
export const SANDBOX_ENV_MARKER = "DRAHT_SANDBOX";

/**
 * The only variable names that may reach a sandboxed child by default.
 * See the module doc for the reasoning and for what is deliberately missing.
 */
export const SANDBOX_ENV_ALLOWLIST: readonly string[] = Object.freeze([
	// Shell and toolchain basics.
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	// Kept deliberately: the unsandboxed backend inherits it too, and bash
	// overrides a stale value against the real cwd (verified). Dropping it would
	// make `$PWD` report the physical path where the unsandboxed shell reports
	// the logical one -- a gratuitous behaviour difference, not a safety gain.
	"PWD",
	"TMPDIR",
	"TMP",
	"TEMP",
	// Terminal presentation. Without these, tools that colourise or wrap output
	// behave differently inside the sandbox than outside it, which reads as the
	// sandbox "breaking" things it did not break.
	"TERM",
	"COLORTERM",
	"COLUMNS",
	"LINES",
	// Locale. Absent these, some toolchains fall back to ASCII and mangle output.
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_COLLATE",
	"LC_CTYPE",
	"LC_MESSAGES",
	"LC_MONETARY",
	"LC_NUMERIC",
	"LC_TIME",
	"TZ",
	// Session metadata the bash tool sets on purpose for user scripts.
	"DRAHT_SESSION_ID",
	"DRAHT_SESSION_FILE",
	"DRAHT_PROVIDER",
	"DRAHT_MODEL",
	"DRAHT_REASONING_LEVEL",
]);

export interface BuildSandboxEnvOptions {
	/**
	 * Where values are read from. Defaults to `process.env`. The bash tool passes
	 * its own prepared env here; passing it does **not** widen what is exported,
	 * it only changes the values the allowlist picks up.
	 */
	source?: NodeJS.ProcessEnv;
	/** Additional names to admit, from project settings. Explicit by construction. */
	extraAllowedNames?: readonly string[];
	/**
	 * Values forced after filtering, regardless of the source. Used for variables
	 * the sandbox itself decides (a `TMPDIR` that is inside the write allowlist,
	 * for instance).
	 */
	overrides?: NodeJS.ProcessEnv;
}

/**
 * Builds the child environment from the allowlist.
 *
 * A name absent from the source stays absent from the result -- the function
 * never invents a default, because a fabricated `HOME` or `PATH` is a behaviour
 * difference that would be blamed on the sandbox rather than on the caller.
 */
export function buildSandboxEnv(options: BuildSandboxEnvOptions = {}): NodeJS.ProcessEnv {
	const source = options.source ?? process.env;
	const allowed = new Set<string>(SANDBOX_ENV_ALLOWLIST);
	for (const name of options.extraAllowedNames ?? []) allowed.add(name);

	const env: NodeJS.ProcessEnv = {};
	for (const name of allowed) {
		const value = source[name];
		if (value !== undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(options.overrides ?? {})) {
		if (value !== undefined) env[name] = value;
	}
	env[SANDBOX_ENV_MARKER] = "1";
	return env;
}
