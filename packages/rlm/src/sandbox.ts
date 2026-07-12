/**
 * OS-level sandbox spawn wrapper for the RLM Python REPL driver.
 *
 * This is the REAL security boundary described in
 * .planning/phases/28-repl-sandbox-safety/28-01-PLAN.md ("IMPORTANT" section
 * and Architecture section 1) -- NOT `repl_driver.py`'s Python-level
 * builtins/import allowlist (that's defense-in-depth for a
 * confused/prompt-injected LLM, not something that stops a deliberately
 * adversarial payload; the Python object graph makes in-process
 * confinement of arbitrary Python fundamentally unachievable -- see the
 * plan for the `__subclasses__`/`gi_frame.f_builtins` escapes that defeat
 * any purely in-process approach).
 *
 * **macOS**: wraps the interpreter with `sandbox-exec -f macos.sb ...`. The
 * SBPL profile (`../sandbox/macos.sb`) denies network and process-exec
 * entirely (which alone defeats `os.system`/`subprocess` -- they fork+exec
 * a shell -- independent of any Python-level import block) and scopes file
 * access to exactly the Python installation needed to boot plus the
 * session's workdir. Machine-specific paths (where python3 actually lives)
 * are discovered here at spawn time via a real subprocess call, never
 * hardcoded/guessed -- see `resolvePythonInstallation`.
 *
 * **Linux**: wraps with `unshare --user --map-root-user --net --mount --`
 * (empty net namespace = network unreachable at the kernel; mount
 * namespace for FS confinement), falling back to `bwrap` with equivalent
 * flags if `unshare` isn't available. Availability is detected at spawn
 * time, never assumed.
 *
 * **Fail closed everywhere**: if the sandboxing mechanism for the current
 * platform can't be established (wrapper binary missing, profile missing,
 * Python installation can't be discovered, unsupported platform), every
 * function here throws `SandboxUnavailableError` synchronously rather than
 * returning a command that would run the driver unwrapped. There is no
 * fallback path to an unsandboxed spawn anywhere in this module.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, delimiter as pathDelimiter } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MACOS_PROFILE_PATH = join(__dirname, "..", "sandbox", "macos.sb");
const DEFAULT_SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

/**
 * Thrown whenever the OS-level sandbox can't be established for the current
 * platform/environment. Callers (see `session.ts`) must let this propagate
 * and refuse to run rather than catching it and falling back to an
 * unwrapped spawn -- that fallback is exactly the failure mode Architecture
 * section 1's "fail closed" requirement exists to prevent.
 */
export class SandboxUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxUnavailableError";
	}
}

export interface SandboxSpawnOptions {
	/** Absolute path to `repl_driver.py`. */
	driverPath: string;
	/**
	 * Absolute path to the session's scratch workdir. The only place the
	 * sandboxed process may read *and* write freely (besides the read-only
	 * Python installation itself).
	 */
	workdir: string;
	/**
	 * Which `python3` to sandbox. Defaults to whatever `python3` resolves to
	 * on `PATH`. Overridable mainly so tests can point at a specific
	 * interpreter without mutating `PATH`.
	 */
	pythonBin?: string;
	/**
	 * Override for the macOS `sandbox-exec` binary path. Mainly a test
	 * injection point for proving fail-closed behavior (point it at a
	 * nonexistent path and assert setup refuses rather than falling back to
	 * an unwrapped spawn) -- see Architecture section 1's fail-closed
	 * requirement and this plan's task 1 test 7.
	 */
	sandboxExecBin?: string;
	/** Override for the Linux `unshare` binary path. Mainly for tests. */
	unshareBin?: string;
	/** Override for the Linux `bwrap` binary path (used if `unshare` is unavailable). Mainly for tests. */
	bwrapBin?: string;
}

/** The concrete command + args a `child_process.spawn` call should use. */
export interface SandboxedCommand {
	command: string;
	args: string[];
}

interface PythonInstallation {
	/** `realpath()`'d absolute path to the interpreter binary that will actually run. */
	realBin: string;
	/**
	 * Some macOS "framework" Python builds (the python.org installer,
	 * Homebrew's `--with-framework`) internally `posix_spawn()` themselves
	 * into a second binary at startup
	 * (`Resources/Python.app/Contents/MacOS/Python`) before any user code
	 * runs, to get a normal `.app` bundle identity (Tk/Cocoa access, Dock
	 * icon, etc.). Confirmed empirically while scoping this profile: without
	 * allowing this second exec, dyld aborts before `main()` ever runs. Equal
	 * to `realBin` when no such companion binary exists.
	 */
	reexecBin: string;
	/** `realpath()`'d `sys.prefix` -- the install root the interpreter needs read access to in order to boot. */
	prefix: string;
}

const pythonInstallationCache = new Map<string, PythonInstallation>();

/**
 * Asks the given `python3` binary (via a real subprocess call -- there is no
 * static/config-file way to learn a Python install's true executable path
 * and stdlib root; every install lays these out differently) where it and
 * its stdlib actually live, then checks for the macOS framework-build
 * re-exec companion described above. Memoized per `pythonBin` string since
 * the answer can't change during this process's lifetime and this runs on
 * every sandboxed spawn.
 */
function resolvePythonInstallation(pythonBin: string): PythonInstallation {
	const cached = pythonInstallationCache.get(pythonBin);
	if (cached) return cached;

	let stdout: string;
	try {
		stdout = execFileSync(pythonBin, ["-c", "import sys; print(sys.executable); print(sys.prefix)"], {
			encoding: "utf8",
		});
	} catch (err) {
		throw new SandboxUnavailableError(
			`sandbox_violation: could not run ${JSON.stringify(pythonBin)} to discover its installation -- refusing to run the REPL driver unsandboxed. (${
				err instanceof Error ? err.message : String(err)
			})`,
		);
	}

	const lines = stdout.trim().split("\n");
	const executableLine = lines[0];
	const prefixLine = lines[1];
	if (!executableLine || !prefixLine) {
		throw new SandboxUnavailableError(
			`sandbox_violation: unexpected output discovering the Python installation for ${JSON.stringify(pythonBin)}: ${JSON.stringify(stdout)}`,
		);
	}

	let realBin: string;
	let prefix: string;
	try {
		realBin = realpathSync(executableLine.trim());
		prefix = realpathSync(prefixLine.trim());
	} catch (err) {
		throw new SandboxUnavailableError(
			`sandbox_violation: could not resolve real filesystem paths for the Python installation -- refusing to run the REPL driver unsandboxed. (${
				err instanceof Error ? err.message : String(err)
			})`,
		);
	}

	const reexecCandidate = join(prefix, "Resources", "Python.app", "Contents", "MacOS", "Python");
	const reexecBin = existsSync(reexecCandidate) ? realpathSync(reexecCandidate) : realBin;

	const installation: PythonInstallation = { realBin, reexecBin, prefix };
	pythonInstallationCache.set(pythonBin, installation);
	return installation;
}

/** Resolves a bare command name against `PATH`, returning `null` if not found. Used for the Linux wrappers. */
function resolveOnPath(name: string): string | null {
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(pathDelimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function buildMacosCommand(opts: SandboxSpawnOptions): SandboxedCommand {
	const sandboxExecBin = opts.sandboxExecBin ?? DEFAULT_SANDBOX_EXEC_BIN;
	if (!existsSync(sandboxExecBin)) {
		throw new SandboxUnavailableError(
			`sandbox_violation: macOS sandbox-exec binary not found at ${JSON.stringify(sandboxExecBin)} -- refusing to run the REPL driver unsandboxed.`,
		);
	}
	if (!existsSync(MACOS_PROFILE_PATH)) {
		throw new SandboxUnavailableError(
			`sandbox_violation: sandbox profile missing at ${JSON.stringify(MACOS_PROFILE_PATH)} -- refusing to run the REPL driver unsandboxed.`,
		);
	}

	const { realBin, reexecBin, prefix } = resolvePythonInstallation(opts.pythonBin ?? "python3");

	let workdir: string;
	let driverPath: string;
	try {
		workdir = realpathSync(opts.workdir);
		driverPath = realpathSync(opts.driverPath);
	} catch (err) {
		throw new SandboxUnavailableError(
			`sandbox_violation: could not resolve workdir/driver paths -- refusing to run the REPL driver unsandboxed. (${
				err instanceof Error ? err.message : String(err)
			})`,
		);
	}

	return {
		command: sandboxExecBin,
		args: [
			"-D",
			`PYTHON_REAL_BIN=${realBin}`,
			"-D",
			`PYTHON_REEXEC_BIN=${reexecBin}`,
			"-D",
			`PYTHON_PREFIX=${prefix}`,
			"-D",
			`DRIVER_PATH=${driverPath}`,
			"-D",
			`WORKDIR=${workdir}`,
			"-f",
			MACOS_PROFILE_PATH,
			realBin,
			driverPath,
		],
	};
}

function buildLinuxCommand(opts: SandboxSpawnOptions): SandboxedCommand {
	const pythonBin = opts.pythonBin ?? "python3";

	let workdir: string;
	let driverPath: string;
	try {
		workdir = realpathSync(opts.workdir);
		driverPath = realpathSync(opts.driverPath);
	} catch (err) {
		throw new SandboxUnavailableError(
			`sandbox_violation: could not resolve workdir/driver paths -- refusing to run the REPL driver unsandboxed. (${
				err instanceof Error ? err.message : String(err)
			})`,
		);
	}

	const unshareBin = opts.unshareBin ?? resolveOnPath("unshare");
	if (unshareBin && existsSync(unshareBin)) {
		// Empty user+net namespace: no interfaces besides loopback exist, so
		// network is unreachable at the kernel regardless of anything Python
		// itself tries. Mount namespace confines the filesystem view; the
		// workdir bind-mount (rw) plus the rest of the root (ro, implicit --
		// `unshare --mount` alone doesn't remount anything) is a coarser
		// boundary than the macOS profile's explicit allowlist, which is why
		// `--map-root-user` + a private mount namespace is paired with the
		// driver only ever being told about `workdir` for file I/O at the
		// Python-guardrail layer (Phase 28 task 2) -- the kernel-level net
		// denial is what task 1 owns and is unconditional here.
		return {
			command: unshareBin,
			args: ["--user", "--map-root-user", "--net", "--mount", "--", pythonBin, driverPath],
		};
	}

	const bwrapBin = opts.bwrapBin ?? resolveOnPath("bwrap");
	if (bwrapBin && existsSync(bwrapBin)) {
		const binds = ["/usr", "/lib", "/bin", "/sbin"]
			.filter((path) => existsSync(path))
			.flatMap((path) => ["--ro-bind", path, path]);
		if (existsSync("/lib64")) binds.push("--ro-bind", "/lib64", "/lib64");
		return {
			command: bwrapBin,
			args: [
				"--unshare-user",
				"--unshare-net",
				"--unshare-pid",
				"--die-with-parent",
				...binds,
				"--bind",
				workdir,
				workdir,
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--chdir",
				workdir,
				pythonBin,
				driverPath,
			],
		};
	}

	throw new SandboxUnavailableError(
		"sandbox_violation: neither `unshare` nor `bwrap` is available on this Linux host -- refusing to run the REPL driver unsandboxed.",
	);
}

/**
 * Computes the sandboxed command/args for the current platform without
 * spawning anything. Exposed separately from `spawnSandboxed` so tests can
 * assert on the resolved invocation and so fail-closed behavior (throwing
 * `SandboxUnavailableError`) is observable synchronously, before any
 * process exists.
 */
export function resolveSandboxedCommand(opts: SandboxSpawnOptions): SandboxedCommand {
	if (process.platform === "darwin") return buildMacosCommand(opts);
	if (process.platform === "linux") return buildLinuxCommand(opts);
	throw new SandboxUnavailableError(
		`sandbox_violation: no OS-level sandbox implementation for platform ${JSON.stringify(process.platform)} -- refusing to run the REPL driver unsandboxed.`,
	);
}

/**
 * Environment variables the sandboxed interpreter is allowed to see, by
 * allowlist rather than denylist. The OS sandbox itself denies network
 * access outright, so this isn't the primary defense against exfiltrating
 * anything read from here -- but the same object-graph escapes that defeat
 * in-process Python restriction (see this module's doc comment) can still
 * reach `os.environ` and write it into the session workdir even with
 * network denied, so the child process should never see more of the parent
 * Node process's environment (API keys, tokens, credentials, ...) than it
 * actually needs to boot a working interpreter.
 */
const SAFE_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"TZ",
	"PYTHONHASHSEED",
	"PYTHONIOENCODING",
	"PYTHONUTF8",
] as const;

/**
 * Builds a scrubbed environment for the sandboxed child process from
 * `SAFE_ENV_ALLOWLIST` -- deliberately NOT `{ ...process.env }` (see
 * `SAFE_ENV_ALLOWLIST`'s doc comment for why the full parent environment,
 * secrets included, must not be handed to a process running LLM-authored
 * code).
 */
function buildScrubbedEnv(): NodeJS.ProcessEnv {
	const scrubbed: NodeJS.ProcessEnv = {};
	for (const key of SAFE_ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) scrubbed[key] = value;
	}
	return scrubbed;
}

/**
 * Spawns `repl_driver.py` wrapped in the platform's OS-level sandbox.
 * Throws `SandboxUnavailableError` synchronously (before any process is
 * created) if the sandbox can't be established -- there is no unwrapped
 * fallback path.
 */
export function spawnSandboxed(opts: SandboxSpawnOptions): ChildProcess {
	const { command, args } = resolveSandboxedCommand(opts);
	return spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: buildScrubbedEnv() });
}
