/**
 * THE ONE PLACE THIS DAEMON CREATES A PROCESS (R35-ALWAYS.9, and Phase 36's
 * exec-surface requirements arriving one phase early).
 *
 * `session_resume` is a frame from a phone that causes a program to run. That
 * is the exact shape R36-SPAWN exists to close, so the whole of it is built
 * here, once, and every other spawn in this package is either routed through it
 * or deleted — see `gateway/routes/sessions.ts`, whose lazy
 * `["draht", "start"]` PATH lookup this change removes.
 *
 * ## What is free by construction, and must stay free
 *
 * The wire frame carries A SESSION ID AND NOTHING ELSE (`SessionResumeFrame`).
 * No path, no command, no argv, no cwd, no environment. The daemon resolves the
 * id against ITS OWN history index and builds the argv itself, so the worst a
 * caller can name is a session that exists or one that does not (R36-SPAWN.1,
 * R36-SPAWN.8). Nothing in this file may ever accept a caller-supplied string
 * that reaches `spawn`.
 *
 * ## What had to be built, because nothing here defaulted to it
 *
 *  - **R36-SPAWN.2 — a canonical absolute executable, never PATH.** Every spawn
 *    in this repo before this file was a bare command string resolved through
 *    the daemon's inherited `PATH`. The target is `realpath`'d and then every
 *    component of the result is checked to be owned by this uid (or root) and
 *    not writable by anyone else, so no directory on the way to it can be
 *    swapped by another user between the check and the exec.
 *  - **argv-ARRAY spawn, never a shell.** No `sh -c`, no interpolation.
 *  - **R36-SPAWN.4 — an allowlist-built child environment.** A daemon-spawned
 *    session inherits the DAEMON's environment, which is not Oskar's shell.
 *    R36-SPAWN.4's inheritance exemption covers sessions geist DISCOVERS, not
 *    ones it spawns. So the child gets: an absolute trusted `PATH`, the runtime
 *    and locale minimum, the agent directory it must publish its socket in, and
 *    the declared credentials — and nothing else. Names that change how a
 *    program loads code (`LD_*`, `DYLD_*`, `NODE_OPTIONS`, …) are refused even
 *    when an operator declares them.
 *  - **R36-SPAWN.5 — project trust is honoured.** A resumed session re-enters a
 *    cwd chosen by a remote frame; a project the operator has explicitly marked
 *    untrusted is refused rather than entered.
 *  - **R36-SPAWN.7 — numeric deadlines, and TERM→KILL of the PROCESS TREE.** The
 *    child is spawned into its own process group precisely so a teardown can
 *    reach what it started, and a signal-trapping child is killed anyway.
 *  - **stdout stays `"ignore"`, so "first output" is stderr alone.** MEASURED: an rpc
 *    session writes 444 B to stdout before it binds and 9 132 after one turn, 0 to stderr.
 *
 * ## Two things this file deliberately does NOT do
 *
 * It does not scan the socket directory. `FleetObserver` is the daemon's single
 * scanner and single reaper (R35-ALWAYS.10); a second walker of a directory
 * whose reader DELETES files would race it into fabricating `disappeared` for a
 * live session. What this file does is `stat` ONE path it already knows the name
 * of — `<socketDir>/<id>.sock` — which reaps nothing and lists nothing.
 *
 * And it does not use `AgentSessionRuntime.switchSession` / `rebind`. `rebind`
 * broadcasts `SESSION_REPLACED` and stops the old socket, forcing exactly the
 * client reconnect R35-ALWAYS.9 forbids. A resume is a FRESH SPAWN of a fresh
 * process that reopens the same session file — and because the session id is
 * preserved when a session file is reopened, that process binds the SAME
 * `<id>.sock` and the fleet trace for one key is `disappeared(X)`,
 * `appeared(X)` with a new pid.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve as resolvePath, sep } from "node:path";
import type { HistorySession } from "@draht/geist-core";
import { buildSpawnArgv } from "./spawn-argv.js";

/**
 * Where an operator points this daemon at the draht it should resume with.
 *
 * An ABSOLUTE path to the emitted CLI (or to a native draht binary). It is a
 * declaration, not a hint: if it is set and unusable, resolution fails loudly
 * rather than falling back to something else that happens to be reachable.
 */
export const DRAHT_BIN_ENV = "DRAHT_BIN";

/**
 * Extra environment names an operator declares may cross into a resumed session,
 * comma-separated.
 *
 * The built-in {@link DECLARED_CREDENTIAL_ENV} covers the credentials draht
 * itself reads. This exists because a real deployment has one or two more —
 * a proxy variable, a self-hosted gateway's token — and the alternative to
 * declaring them is inheriting everything, which is what R36-SPAWN.4 forbids.
 * Names here are still refused if they are in {@link NEVER_FORWARDED} or are not
 * a plausible variable name.
 */
export const RESUME_ENV_ALLOW_ENV = "DRAHT_RESUME_ENV_ALLOW";

/** Overrides the child's `PATH`. Must be absolute components only. */
export const RESUME_PATH_ENV = "DRAHT_RESUME_PATH";

/**
 * The `PATH` a resumed session gets when the operator declares none.
 *
 * Absolute, ordinary system directories. It is deliberately NOT the daemon's
 * own `PATH`: a daemon started from a login shell carries whatever that shell
 * had — an nvm shim directory, a `~/.local/bin` — and a session that only works
 * because the daemon happened to be started from a terminal is a session that
 * breaks the first time the daemon is started by launchd.
 *
 * An operator whose sessions need more sets {@link RESUME_PATH_ENV}, which is a
 * declaration this daemon records rather than an accident it inherits.
 */
export const DEFAULT_RESUME_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** `spawn()` to a live pid — a bound on a call that normally returns one synchronously. Fatal: `spawn_failed`. */
export const DEFAULT_SPAWN_DEADLINE_MS = 2_000;

/**
 * How long a resumed session has to publish its socket before it is torn down.
 *
 * Measured on this machine, a cold `draht --session … --attachable --mode rpc`
 * publishes in roughly 3–6 s: model discovery and extension loading happen
 * before the bind. 30 s clears that with room for a loaded machine and is still
 * a bound rather than a hope — the point of R36-SPAWN.7 is that the number
 * exists and that something happens when it elapses.
 */
export const DEFAULT_HANDSHAKE_DEADLINE_MS = 30_000;

/** Pid to the first byte of stderr. Fatal: `timeout`. */
// KEEP IT EQUAL to the handshake deadline: a healthy session is silent for the 3–6 s it takes to bind.
export const DEFAULT_FIRST_OUTPUT_DEADLINE_MS = DEFAULT_HANDSHAKE_DEADLINE_MS;

export const DEFAULT_STOP_DEADLINE_MS = 2_000;

/** How often a pending resume checks whether the socket has appeared. */
const READY_POLL_MS = 100;

/**
 * The credentials a resumed session is allowed to be given (R36-SPAWN.4's
 * "only the declared auth").
 *
 * These are the provider credential names `packages/coding-agent` reads today.
 * The list is a HAND MIRROR of that table and will drift from it; drift here is
 * a session that starts and cannot answer, which is loud, whereas the
 * alternative — a suffix rule like "anything ending in `_API_KEY`" — silently
 * forwards every unrelated service's key that happens to be in the daemon's
 * environment. Loud and narrow beats quiet and wide for a set that decides what
 * a remotely-triggered process can authenticate as.
 */
export const DECLARED_CREDENTIAL_ENV: readonly string[] = [
	"AI_GATEWAY_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_OAUTH_TOKEN",
	"AZURE_OPENAI_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"NVIDIA_API_KEY",
	"OPENAI_API_KEY",
	"OPENAI_API_VERSION",
	"OPENAI_BASE_URL",
	"OPENROUTER_API_KEY",
	"TOGETHER_API_KEY",
	"XAI_API_KEY",
	"ZAI_API_KEY",
];

/**
 * Non-credential names the child needs to behave like a program at all.
 *
 * `PATH` is NOT here — it is constructed, never copied. Neither is `TERM`: a
 * resumed session has no terminal, and handing it one is how a headless process
 * starts emitting escape sequences into a JSONL.
 */
const BASE_ENV_NAMES: readonly string[] = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "TMPDIR", "TZ", "USER"];

/**
 * Names that are refused even when an operator declares them.
 *
 * Every one of these changes what code a program loads before its own first
 * line runs, which makes "the executable is canonical and owned by us" say
 * nothing at all. Matched as exact names or as a prefix ending in `_`.
 */
const NEVER_FORWARDED: readonly string[] = [
	"PATH",
	"LD_",
	"DYLD_",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_REPL_EXTERNAL_MODULE",
	"BUN_INSPECT",
	"BUN_INSPECT_CONNECT_TO",
	"BUN_INSPECT_NOTIFY",
	"BUN_BE_BUN",
	"PYTHONPATH",
	"PERL5LIB",
	"RUBYOPT",
	"GEM_PATH",
	"IFS",
	"ENV",
	"BASH_ENV",
	"SHELLOPTS",
];

/** A name that could plausibly be an environment variable at all. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `name` may never be forwarded, however it was declared. */
export function isForbiddenEnvName(name: string): boolean {
	return NEVER_FORWARDED.some((entry) => (entry.endsWith("_") ? name.startsWith(entry) : name === entry));
}

/**
 * Why a spawn did not happen, in the vocabulary `session_resumed.code` uses.
 *
 * Every refusal this file raises is one of these, so the frame path never has to
 * classify prose. `not_found` is not here: that is decided before a spawn is
 * contemplated, by {@link SessionResumer}.
 *
 * `already_live` IS here, and used to not be. It is the outcome of the one
 * question this file can answer and the pre-spawn check cannot: DID SOMEBODY
 * ELSE TAKE THIS ID WHILE OUR CHILD WAS STARTING. A resume takes 3–6 s to reach
 * its bind, and for the whole of that window the id is in neither `liveIds()`
 * nor the socket directory — so "not live" at t=0 says nothing about t=4 s.
 * When the answer turns out to be yes, the caller wanted this session reachable
 * and it is; reporting the loser's dead child as `spawn_failed` would be true
 * about our process and useless about the session.
 */
export type SpawnRefusalCode = "refused" | "already_live" | "cwd_missing" | "spawn_failed" | "timeout";

/** A refusal carrying the code the wire will report. */
export class SpawnRefusedError extends Error {
	readonly code: SpawnRefusalCode;

	constructor(code: SpawnRefusalCode, message: string) {
		super(message);
		this.name = "SpawnRefusedError";
		this.code = code;
	}
}

/**
 * A canonical, absolute, ownership-checked program plus the leading argv it must
 * be given.
 *
 * Two members because the emitted draht is a `.js` file, so "the executable" is
 * really an interpreter and a script — and BOTH of them are attack surface, so
 * both are resolved and checked the same way.
 */
export interface ResolvedExecutable {
	/** The program that is `exec`ed. Canonical and absolute. */
	executable: string;
	/** Argv that precedes the daemon's own arguments (the script path, if any). */
	leadingArgs: string[];
	/** The draht target as resolved, for logging. Equal to `executable` for a native binary. */
	target: string;
}

/**
 * Assert that nothing on the way to `canonical` can be replaced by another user.
 *
 * `canonical` must already be a `realpath`, so it contains no symlink and
 * `lstat` and `stat` agree at every component. What is checked, from the root
 * down:
 *
 *  - the component exists and is owned by this uid or by root — a directory
 *    owned by a third user is one that user can rename out from under the exec;
 *  - it is not group- or world-writable, UNLESS it carries the sticky bit. The
 *    sticky exemption is what makes `/tmp` (mode 1777, root-owned) usable: with
 *    it set, a non-owner cannot rename or unlink our entry, which is precisely
 *    the property the writability check is asking about. Without the exemption
 *    this refuses every macOS machine's `/private/tmp` and therefore every
 *    throwaway install.
 *
 * Raises {@link SpawnRefusedError} rather than returning a boolean: a caller
 * that could ignore the answer is a caller that will.
 */
export function assertSafeExecutablePath(canonical: string, uid: number): void {
	if (!isAbsolute(canonical)) {
		throw new SpawnRefusedError("refused", `not an absolute path: ${canonical}`);
	}
	const parts = canonical.split(sep).filter((part) => part.length > 0);
	let current: string = sep;
	for (let index = 0; index <= parts.length; index++) {
		if (index > 0) current = index === 1 ? sep + parts[0] : `${current}${sep}${parts[index - 1]}`;
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(current);
		} catch {
			throw new SpawnRefusedError("refused", `unreadable on the path to the draht binary: ${current}`);
		}
		if (stats.isSymbolicLink()) {
			// Unreachable for a realpath, and asserted anyway: this whole check is
			// worthless the moment one component is a link somebody else can move.
			// It is NOT the link refusal a declared path gets — that one has to run
			// BEFORE `realpath` to see anything, and lives in
			// {@link assertNoSymlinkComponents}. This branch stays as a floor for a
			// future caller that reaches here without canonicalising first.
			throw new SpawnRefusedError("refused", `symlink on the path to the draht binary: ${current}`);
		}
		const ownedByUs = stats.uid === uid || stats.uid === 0;
		if (!ownedByUs) {
			throw new SpawnRefusedError("refused", `not owned by this user or root: ${current}`);
		}
		// The sticky exemption is a statement about DIRECTORIES and nothing else.
		// `chmod 1777` on a regular file means "save text image", a no-op on every
		// system this runs on — it does not stop another user from opening that
		// file for writing and replacing the program we are about to exec. Before
		// this predicate was gated, a leaf at mode 1777 was ALLOWED while the same
		// leaf at 0777 was refused, which is the wrong way round.
		const sticky = (stats.mode & 0o1000) !== 0 && stats.isDirectory();
		if ((stats.mode & 0o022) !== 0 && !sticky) {
			throw new SpawnRefusedError("refused", `writable by others: ${current}`);
		}
	}
	const leaf = statSync(canonical);
	if (!leaf.isFile()) {
		throw new SpawnRefusedError("refused", `not a regular file: ${canonical}`);
	}
	// setuid/setgid on the thing we exec means the child does not run as this
	// user, so every ownership conclusion the walk just reached stops describing
	// the process that actually results. Refuse rather than reason about it.
	if ((leaf.mode & 0o6000) !== 0) {
		throw new SpawnRefusedError("refused", `setuid or setgid: ${canonical}`);
	}
}

/** Constraints on WHERE a resolved path may live and whether links may be followed to it. */
export interface PathConstraints {
	/**
	 * Whether a symbolic link ON THE SUPPLIED PATH may be followed (default `true`).
	 *
	 * `false` lstat-walks the supplied path BEFORE `realpath` and refuses a link at
	 * any component it is not root that owns (see {@link assertNoSymlinkComponents}
	 * for why root is exempt). Before `realpath` is the only order that can notice
	 * one: `realpath` erases every link, so the walk's own symlink branch can never
	 * fire.
	 *
	 * This must stay OPT-IN. `process.execPath` under a version manager is a
	 * user-owned symlink on many machines — a daemon that refused those would
	 * resolve no interpreter at all.
	 */
	followSymlinks?: boolean;
	/** If non-empty, the canonical result must live under one of these. */
	approvedRoots?: readonly string[];
	/** The canonical result must not live under any of these. */
	forbiddenRoots?: readonly string[];
}

/** Where an executable may and may not live. {@link PathConstraints} minus the link policy. */
export type ExecutableRoots = Omit<PathConstraints, "followSymlinks">;

/**
 * Refuse a symbolic link at ANY component of the path as supplied, with ONE
 * exemption: a link owned by root.
 *
 * Called before `realpath`, because after it there is nothing left to see. The
 * point is that a declaration names a FILE, and a link is an indirection that
 * decides — at exec time, not at check time — which file that is.
 *
 * THE ROOT EXEMPTION IS NOT A CONVENIENCE, IT IS THE PLATFORM. `/tmp`, `/var`
 * and `/etc` are root-owned symbolic links on every macOS machine, so a rule
 * without it refuses `/tmp/…` and `/var/folders/…` — i.e. every throwaway
 * install and the whole of `os.tmpdir()`. Only root can re-point a root-owned
 * link, and root can replace the target outright, which is the same reason the
 * ownership walk already accepts a root-owned component. A link owned by anyone
 * else — including US, because an operator's declaration should be exact — is
 * refused.
 *
 * A symlink's own permission bits are deliberately NOT consulted: they are
 * unenforced on macOS and meaningless on Linux (0777 by construction). What
 * bounds who can re-point a link is write access to its PARENT directory, and
 * every parent is checked by {@link assertSafeExecutablePath} on the resolved
 * path.
 */
function assertNoSymlinkComponents(supplied: string, what: string): void {
	// Lexical normalisation is safe HERE and only here: it is wrong in general
	// (`a/b/../c` differs from realpath when `b` is a link) and this walk refuses
	// exactly that case, so by the time it returns the two agree.
	const lexical = resolvePath(supplied);
	const parts = lexical.split(sep).filter((part) => part.length > 0);
	let current: string = sep;
	for (let index = 0; index < parts.length; index++) {
		current = index === 0 ? sep + parts[0] : `${current}${sep}${parts[index]}`;
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(current);
		} catch {
			throw new SpawnRefusedError("refused", `${what} does not exist: ${supplied}`);
		}
		if (stats.isSymbolicLink() && stats.uid !== 0) {
			throw new SpawnRefusedError("refused", `symlink on the path to ${what}: ${current}`);
		}
	}
}

/** A root as a canonical absolute prefix. Unresolvable roots normalise lexically rather than vanish. */
function canonicalRoot(root: string): string {
	if (!isAbsolute(root)) {
		throw new SpawnRefusedError("refused", `a containment root must be an absolute path, got ${root}`);
	}
	try {
		return realpathSync(root);
	} catch {
		return resolvePath(root);
	}
}

/**
 * Canonical-path containment WITH a separator boundary.
 *
 * `startsWith(root)` alone says `/x/projects-evil` is inside `/x/projects`,
 * which is the live defect in this daemon's `isPathAllowed`
 * (`gateway/src/config/config.ts`). Do not copy that here.
 */
function isInsideRoot(canonical: string, root: string): boolean {
	if (canonical === root) return true;
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return canonical.startsWith(prefix);
}

/**
 * `realpath` + the ownership walk, as one step, because neither is safe alone.
 *
 * Exported because harness executables named by the user registry resolve
 * through this and nothing else: one gate, one set of refusals.
 *
 * Constraints are all opt-in and every default is today's behaviour — links are
 * followed, both root lists are empty and empty means "no constraint" — so a
 * caller that passes none gets exactly what it got before they existed.
 */
export function canonicalize(candidate: string, uid: number, what: string, constraints: PathConstraints = {}): string {
	if (!isAbsolute(candidate)) {
		throw new SpawnRefusedError("refused", `${what} must be an absolute path, got ${candidate}`);
	}
	if (constraints.followSymlinks === false) assertNoSymlinkComponents(candidate, what);
	let canonical: string;
	try {
		canonical = realpathSync(candidate);
	} catch {
		throw new SpawnRefusedError("refused", `${what} does not exist: ${candidate}`);
	}
	assertSafeExecutablePath(canonical, uid);
	// Containment is asserted on the CANONICAL result, never on what was supplied:
	// a root check against an uncanonicalised string is one `..` away from useless.
	for (const root of constraints.forbiddenRoots ?? []) {
		if (isInsideRoot(canonical, canonicalRoot(root))) {
			throw new SpawnRefusedError("refused", `${what} is inside a forbidden root: ${canonical}`);
		}
	}
	const approved = constraints.approvedRoots ?? [];
	if (approved.length > 0 && !approved.some((root) => isInsideRoot(canonical, canonicalRoot(root)))) {
		throw new SpawnRefusedError("refused", `${what} is not inside an approved root: ${canonical}`);
	}
	return canonical;
}

/** Whether a resolved target needs a JS runtime to run it. */
function isScript(path: string): boolean {
	return path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs");
}

/**
 * Where this daemon's draht lives, resolved WITHOUT ever consulting `PATH`.
 *
 * Order, and every candidate goes through {@link canonicalize}:
 *
 *  1. `DRAHT_BIN`, if an operator declared one. A declaration that does not
 *     resolve is an error, never a reason to look elsewhere. It is resolved
 *     NO-FOLLOW: a symbolic link at any component of the declared path is a
 *     refusal, not something to `realpath` away.
 *  2. The sibling package in a monorepo checkout —
 *     `packages/coding-agent/dist/cli.js` relative to this file.
 *  3. `@draht/coding-agent/dist/cli.js` under a `node_modules` above this file,
 *     which is where an installed gateway finds it.
 *
 * When the resolved target is a script, the interpreter is `process.execPath` —
 * canonical and absolute by construction, and the only runtime this daemon can
 * be certain exists, because it is the one currently executing. It is
 * `realpath`'d and ownership-checked too: `process.execPath` on a machine with a
 * version manager is frequently a symlink into a directory the manager rewrites.
 */
export function resolveDrahtExecutable(
	env: NodeJS.ProcessEnv = process.env,
	uid: number = process.getuid?.() ?? 0,
	roots: ExecutableRoots = {},
): ResolvedExecutable {
	const declared = env[DRAHT_BIN_ENV];
	const here = dirname(new URL(import.meta.url).pathname);
	const candidates = declared
		? [declared]
		: [
				// packages/gateway/src/session → packages/coding-agent/dist/cli.js
				resolvePath(here, "..", "..", "..", "coding-agent", "dist", "cli.js"),
				resolvePath(here, "..", "..", "node_modules", "@draht", "coding-agent", "dist", "cli.js"),
				resolvePath(here, "..", "..", "..", "..", "node_modules", "@draht", "coding-agent", "dist", "cli.js"),
			];

	let lastError: SpawnRefusedError | null = null;
	for (const candidate of candidates) {
		try {
			// The DECLARED path is the one an operator (or, later, a registry entry)
			// names, so it is the one that must not be reachable through a directory
			// somebody else can re-point. The built-in monorepo candidates keep
			// following links: they are derived from this module's own location, and
			// a checkout under a symlinked prefix — `/tmp` on every macOS box — is an
			// ordinary dev tree, not an attack.
			const target = canonicalize(candidate, uid, "the draht binary", {
				...roots,
				followSymlinks: declared ? false : undefined,
			});
			if (!isScript(target)) return { executable: target, leadingArgs: [], target };
			// Deliberately UNCONSTRAINED: no roots and links followed. The interpreter
			// is `process.execPath`, which under a version manager is a symlink and
			// lives nowhere near an approved root for project code. Constrain it and
			// this daemon resolves no runtime at all.
			const interpreter = canonicalize(realpathSync(process.execPath), uid, "the javascript runtime");
			return { executable: interpreter, leadingArgs: [target], target };
		} catch (error) {
			lastError = error instanceof SpawnRefusedError ? error : new SpawnRefusedError("refused", String(error));
			if (declared) throw lastError;
		}
	}
	throw lastError ?? new SpawnRefusedError("refused", "no draht binary could be resolved");
}

/** What a child environment is built from. Every field is the daemon's, never a caller's. */
export interface ChildEnvironmentOptions {
	/** The daemon's environment, read for the declared names only. */
	env?: NodeJS.ProcessEnv;
	/** The agent directory the resumed session must publish its socket in. */
	agentDir: string;
	/** The session's own working directory, used as the fallback `HOME`/`TMPDIR` are not. */
	cwd: string;
	/** Per-harness scoping. `undefined` = every declared credential (resume, unchanged). `[]` = NONE. */
	credentialEnv?: readonly string[];
}

/**
 * The complete environment a resumed session runs with (R36-SPAWN.4).
 *
 * Built up from nothing. There is no `...process.env` anywhere in this function
 * and there must never be one: the property under test is that a name nobody
 * declared does not reach the child, and a spread makes that property false in
 * one character.
 */
export function buildChildEnvironment(options: ChildEnvironmentOptions): Record<string, string> {
	const env = options.env ?? process.env;
	const child: Record<string, string> = {};

	const declaredPath = env[RESUME_PATH_ENV];
	const path = declaredPath?.split(":").every((part) => part.length > 0 && isAbsolute(part))
		? declaredPath
		: DEFAULT_RESUME_PATH;
	child.PATH = path;

	for (const name of BASE_ENV_NAMES) {
		const value = env[name];
		if (typeof value === "string" && value.length > 0) child[name] = value;
	}

	// Set, never copied: the daemon's own agent directory is what makes the
	// resumed session's socket land in the directory this daemon watches. A
	// resume whose child published somewhere else would spawn successfully and
	// never join the fleet.
	child.DRAHT_CODING_AGENT_DIR = options.agentDir;

	const extra = (env[RESUME_ENV_ALLOW_ENV] ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0 && ENV_NAME.test(name));

	for (const name of [...(options.credentialEnv ?? DECLARED_CREDENTIAL_ENV), ...extra]) {
		if (isForbiddenEnvName(name)) continue;
		const value = env[name];
		if (typeof value === "string" && value.length > 0) child[name] = value;
	}

	return child;
}

/**
 * Read the operator's trust decisions for `cwd` (R36-SPAWN.5).
 *
 * A bounded re-read of `packages/coding-agent`'s `ProjectTrustStore` rather than
 * an import: the gateway does not depend on `@draht/coding-agent` and adding a
 * dependency on the kernel package to read one JSON file would be a far larger
 * change than duplicating the lookup. `geist-core`'s history reader duplicates
 * `readSessionHeader` for the same kind of reason.
 *
 * ONLY AN EXPLICIT `false` REFUSES. "No decision recorded" is not a denial — it
 * is the ordinary state of every project the operator has never been asked
 * about, and the child resolves it for itself the way any other non-interactive
 * draht does. What this stops is the one thing a remote frame must never do:
 * re-enter a directory the operator has already said no to.
 *
 * A store that cannot be read is treated as "no decision". Failing closed here
 * would mean a corrupt or absent `trust.json` silently disables resume for every
 * project, which is a far more likely outcome than the store being tampered
 * with — and a tampered store is a machine already lost.
 */
/**
 * `cwd` as `trust.json` keys it: `realpathSync`, or the resolved path when that
 * fails. A HAND MIRROR of `coding-agent`'s `canonicalizePath(resolvePath(...))`,
 * for the same reason the whole lookup is a mirror — see
 * {@link projectExplicitlyUntrusted}.
 */
function canonicalCwd(cwd: string): string {
	const resolved = resolvePath(cwd);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

export function projectExplicitlyUntrusted(agentDir: string, cwd: string): boolean {
	const trustPath = join(agentDir, "trust.json");
	let data: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(trustPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
		data = parsed as Record<string, unknown>;
	} catch {
		return false;
	}
	// CANONICAL, because the store this mirrors is keyed canonically.
	// `ProjectTrustStore.setMany` writes `canonicalizePath(resolvePath(path))`,
	// and `canonicalizePath` IS `realpathSync`. A lookup that only `normalize`d
	// therefore missed the operator's explicit `false` for every recorded cwd
	// that was not already its own realpath — a session whose header names a
	// path through a symlink, which is the ordinary case for anything under a
	// symlinked home or under macOS's `/tmp` — and the resume then proceeded
	// into a project the operator had already said no to.
	//
	// The `catch` keeps "no decision" as the failure mode rather than "trusted
	// by accident": a cwd that cannot be realpath'd does not exist, and
	// `SessionSpawner.resume` has already refused `cwd_missing` before this is
	// reached. Falling back to the un-canonical form means a store keyed by that
	// exact string still matches.
	let current = normalize(canonicalCwd(cwd));
	while (true) {
		const value = data[current];
		if (value === true) return false;
		if (value === false) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * The pid recorded in `<socketDir>/<id>.lock`, or null when there is not a
 * readable one.
 *
 * THE LOCK, NOT THE SOCKET, IS THE PROOF OF OWNERSHIP. `SocketServer.start`
 * claims `<id>.lock` with an exclusive `wx` create whose first line is the
 * owner's pid, and only then binds `<id>.sock`; it removes the lock again if the
 * bind fails, and on stop. So the lock is the only artifact on disk that names
 * WHO a session id currently belongs to — the socket names nothing at all, which
 * is exactly why "a socket appeared" was never evidence that OUR child put it
 * there.
 *
 * Unreadable, absent, or truncated all read as null: the exclusive create and
 * the pid write are two steps, and a lock caught between them means somebody is
 * claiming right now, which is "not yet decided" rather than "not held".
 */
function lockOwnerPid(socketDir: string, sessionId: string): number | null {
	try {
		const first = readFileSync(join(socketDir, `${sessionId}.lock`), "utf8").split("\n")[0];
		const pid = Number.parseInt(first.trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/**
 * Whether `pid` names a process that exists.
 *
 * `EPERM` counts as alive — it means the pid exists and belongs to somebody we
 * may not signal. Only `ESRCH` is death. Without this, a lock left by a crashed
 * process would be read as a live owner and every resume of that id would be
 * answered `already_live` forever; the child's own `claimLock` reaps such debris
 * on exactly the same test, so this agrees with the process it is watching.
 */
function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Fragments of `SocketSessionBusyError`'s message, as the child prints it.
 *
 * A HAND MIRROR of `coding-agent`'s `socket-server.ts`, and a FALLBACK rather
 * than the mechanism: {@link lockOwnerPid} answers the same question
 * structurally and is what normally fires. This exists for the one window it
 * cannot cover — our child loses the lock race and exits with `process.exit(1)`
 * (an explicit `--attachable` keeps a bind failure fatal) BEFORE the winner has
 * finished writing its own pid into the lock. Structurally that instant is
 * indistinguishable from "nobody claimed anything"; the child's own stderr is
 * the only thing that knows the difference, so it is read. Drift here degrades a
 * correct `already_live` to a `spawn_failed` that quotes the busy message
 * verbatim — loud, and never a double spawn.
 */
const BUSY_STDERR_MARKERS: readonly string[] = [
	"is already attachable from a running process",
	"has an attachable lock that names no readable PID",
];

/** How {@link SessionSpawner} is configured. All of it is the daemon's own state. */
export interface SessionSpawnerOptions {
	/** `<agent dir>/sockets` — where a resumed session publishes `<id>.sock`. */
	socketDir: string;
	/** The agent directory itself, handed to the child and read for `trust.json`. */
	agentDir: string;
	/** The daemon's environment. Read for the declared names only. */
	env?: NodeJS.ProcessEnv;
	spawnDeadlineMs?: number;
	handshakeDeadlineMs?: number;
	firstOutputDeadlineMs?: number;
	stopDeadlineMs?: number;
	/** Aliases for the handshake and stop deadlines, kept working for callers that pass them. */
	deadlineMs?: number;
	teardownGraceMs?: number;
	detached?: boolean;
	/** Resolution seam. Tests inject one; nothing else should. */
	resolveExecutable?: () => ResolvedExecutable;
}

/** What one spawn produced. */
export interface SpawnOutcome {
	pid: number;
}

/** Structural, not `harness-resolver.ts`'s `ResolvedHarnessLaunch`: that file already imports from this one. */
export interface SessionLaunchRequest {
	/** Minted by the daemon. Never supplied by a client. */
	sessionId: string;
	/** Canonical absolute, already ownership-walked and root-contained by the resolver. */
	executable: string;
	leadingArgs: readonly string[];
	/** Canonical absolute. The spawn's cwd AND its `--context-root`. */
	projectRoot: string;
	/** Required, so forgetting it is a compile error rather than every key the daemon holds. */
	credentialEnv: readonly string[];
}

interface StartRequest {
	sessionId: string;
	executable: string;
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	/** A fixed daemon-side literal naming the origin. Never free text, never a client's. */
	what: "the resumed session" | "the spawned session";
}

interface SpawnedProcess {
	/** The `detached` option AS PASSED. Without it the child sits in the DAEMON'S group. */
	groupSignallable: boolean;
	stopping?: Promise<void>;
}

/**
 * The hardened spawn itself.
 *
 * One method, one argv shape, no string that came from a client.
 */
export class SessionSpawner {
	readonly #socketDir: string;
	readonly #agentDir: string;
	readonly #env: NodeJS.ProcessEnv;
	readonly #spawnDeadlineMs: number;
	readonly #handshakeDeadlineMs: number;
	readonly #firstOutputDeadlineMs: number;
	readonly #stopDeadlineMs: number;
	readonly #detached: boolean;
	readonly #resolveExecutable: () => ResolvedExecutable;
	readonly #spawned = new Map<number, SpawnedProcess>();

	constructor(options: SessionSpawnerOptions) {
		this.#socketDir = options.socketDir;
		this.#agentDir = options.agentDir;
		this.#env = options.env ?? process.env;
		this.#spawnDeadlineMs = options.spawnDeadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS;
		this.#handshakeDeadlineMs = options.handshakeDeadlineMs ?? options.deadlineMs ?? DEFAULT_HANDSHAKE_DEADLINE_MS;
		this.#firstOutputDeadlineMs = options.firstOutputDeadlineMs ?? DEFAULT_FIRST_OUTPUT_DEADLINE_MS;
		this.#stopDeadlineMs = options.stopDeadlineMs ?? options.teardownGraceMs ?? DEFAULT_STOP_DEADLINE_MS;
		this.#detached = options.detached ?? true;
		this.#resolveExecutable = options.resolveExecutable ?? (() => resolveDrahtExecutable(this.#env));
	}

	/**
	 * Start a process for one recorded session and wait for it to join the fleet.
	 *
	 * THE ARGV, AND WHY IT IS NOT `--resume`. R35-ALWAYS.9 names "the existing
	 * `--resume` path"; that path takes no value (`args.ts`: `--resume` sets a
	 * boolean) and opens a full-screen TUI picker which, run headless, paints
	 * ANSI and exits on stdin EOF. A bare session id is no better: a id found in
	 * ANOTHER project reaches an interactive "Fork this session into current
	 * directory?" prompt whose EOF answer is "no" — and the process then prints
	 * "Aborted." and EXITS 0, which is indistinguishable from success to any
	 * caller. (`main.ts` now refuses that prompt outright on a non-TTY stdin, so
	 * the failure is at least loud; this argv avoids it entirely.)
	 *
	 * What is used instead, verified by running it:
	 *
	 *   --session <ABSOLUTE .jsonl path>   the path branch of `resolveSessionPath`,
	 *                                      which skips the fork prompt and runs in
	 *                                      the SESSION's cwd whatever ours is
	 *   --attachable                       explicit, so a bind failure is FATAL to
	 *                                      the child rather than a silent degrade —
	 *                                      a resumed session that is not on the
	 *                                      fleet is a resume that did not happen
	 *   --mode rpc                         required: with no TTY, `resolveAppMode`
	 *                                      falls through to print mode, the process
	 *                                      answers once and exits, and the socket
	 *                                      appears and vanishes
	 *
	 * `stdin` is a pipe that is opened and never written. `"ignore"` gives rpc
	 * mode an immediate EOF on the channel it reads its requests from.
	 *
	 * @throws {SpawnRefusedError} with the code the wire will report.
	 */
	async resume(session: { id: string; path: string; cwd: string }): Promise<SpawnOutcome> {
		// Checked BEFORE the spawn, not translated from a dead child afterwards.
		// Non-interactively the child would exit 1 with "Stored session working
		// directory does not exist"; catching it here means there is never an
		// orphan to reason about, and the caller gets a typed refusal instead of
		// a process that started and died.
		if (!existsSync(session.cwd)) {
			throw new SpawnRefusedError(
				"cwd_missing",
				`the directory this session ran in no longer exists: ${session.cwd}`,
			);
		}
		if (projectExplicitlyUntrusted(this.#agentDir, session.cwd)) {
			throw new SpawnRefusedError("refused", `this project is marked untrusted: ${session.cwd}`);
		}

		const resolved = this.#resolveExecutable();
		const argv = [...resolved.leadingArgs, "--session", session.path, "--attachable", "--mode", "rpc"];
		const env = buildChildEnvironment({ env: this.#env, agentDir: this.#agentDir, cwd: session.cwd });

		return this.#startAndAwaitSocket({
			sessionId: session.id,
			executable: resolved.executable,
			argv,
			cwd: session.cwd,
			env,
			what: "the resumed session",
		});
	}

	/**
	 * Start a session nobody has run before, from a registry harness (R36-SPAWN.1).
	 *
	 * No `#resolveExecutable`: that seam finds the DAEMON'S OWN draht and is
	 * resume's. A launch's executable comes from the registry, in the request.
	 */
	async launch(request: SessionLaunchRequest): Promise<SpawnOutcome> {
		if (!existsSync(request.projectRoot)) {
			throw new SpawnRefusedError("cwd_missing", `this project root no longer exists: ${request.projectRoot}`);
		}
		// `--no-approve` only makes the child untrusted; re-entering a directory the operator said no to
		// is a different refusal, and it belongs before any process exists.
		if (projectExplicitlyUntrusted(this.#agentDir, request.projectRoot)) {
			throw new SpawnRefusedError("refused", `this project is marked untrusted: ${request.projectRoot}`);
		}

		return this.#startAndAwaitSocket({
			sessionId: request.sessionId,
			executable: request.executable,
			argv: buildSpawnArgv(request),
			cwd: request.projectRoot,
			env: buildChildEnvironment({
				env: this.#env,
				agentDir: this.#agentDir,
				cwd: request.projectRoot,
				credentialEnv: request.credentialEnv,
			}),
			what: "the spawned session",
		});
	}

	/**
	 * Everything after the argv: spawn, wait for this child's own lock and socket, or refuse.
	 *
	 * Shared by both origins, never copied — a second copy is how a resumed
	 * process and a launched one stop being indistinguishable to the fleet.
	 */
	async #startAndAwaitSocket({ sessionId, executable, argv, cwd, env, what }: StartRequest): Promise<SpawnOutcome> {
		let child: ChildProcess;
		try {
			child = spawn(executable, argv, {
				cwd,
				env,
				// Its own process group, so teardown can reach the whole tree rather
				// than the one pid we happen to hold — a draht session spawns tools.
				// It also means the child outlives a daemon restart, which is the
				// posture recorded as still-open in the plan: a resumed session is a
				// session, not a daemon worker.
				detached: this.#detached,
				stdio: ["pipe", "ignore", "pipe"],
				shell: false,
			});
		} catch (error) {
			throw new SpawnRefusedError("spawn_failed", error instanceof Error ? error.message : String(error));
		}

		// ── LISTENERS FIRST, BEFORE ANY EARLY RETURN ─────────────────────────────
		// `spawn` reports a failure it could not detect synchronously — a cwd that
		// vanished between the check and the call, an unreadable binary, EMFILE — as
		// an ASYNCHRONOUS `error` EVENT, and an `error` event with no listener is an
		// uncaught exception that takes the whole daemon down. Measured: with the
		// pre-spawn cwd check removed, a `session_resume` for a moved project killed
		// the gateway, and every subsequent request was refused at the socket. So
		// every handler is attached on the line after the spawn, and nothing between
		// here and the wait may return or throw first. The same goes for the stdio
		// pipes: a child that dies with our write end open surfaces as EPIPE on
		// `stdin`, which is also an unhandled `error` event.
		let stderr = "";
		let saidAnything = false;
		// Drained forever, retaining only a bounded prefix. Closing the read end
		// instead would give the child EPIPE on stderr, and the default disposition
		// of SIGPIPE is to terminate — a "cleanup" that kills the session we just
		// started.
		child.stderr?.on("data", (chunk: Buffer) => {
			saidAnything = true;
			if (stderr.length < 2048) stderr += chunk.toString("utf8");
		});
		child.stderr?.on("error", () => {});
		child.stdin?.on("error", () => {});

		let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
		child.once("exit", (code, signal) => {
			exited = { code, signal };
		});
		child.once("error", (error) => {
			exited = { code: null, signal: null };
			stderr += String(error);
		});

		const spawnDeadline = Date.now() + this.#spawnDeadlineMs;
		while (child.pid === undefined && exited === null && Date.now() < spawnDeadline) {
			await sleep(READY_POLL_MS);
		}
		const pid = child.pid;
		if (pid === undefined) {
			throw new SpawnRefusedError(
				"spawn_failed",
				`the child process was created with no pid within ${this.#spawnDeadlineMs} ms${describeChildOutput(stderr)}`,
			);
		}
		// Held locally too: the teardown below must reach the group of a child that has already been forgotten.
		const record: SpawnedProcess = { groupSignallable: this.#detached };
		this.#spawned.set(pid, record);
		if (exited === null) child.once("exit", () => this.#spawned.delete(pid));
		else this.#spawned.delete(pid);

		const socketPath = join(this.#socketDir, `${sessionId}.sock`);
		const startedAt = Date.now();
		const deadline = startedAt + this.#handshakeDeadlineMs;
		const firstOutputDeadline = startedAt + this.#firstOutputDeadlineMs;
		try {
			while (Date.now() < deadline) {
				// ── WHOSE SOCKET IS IT ───────────────────────────────────────────────
				// A socket that exists is NOT this spawn's success. Two connections can
				// ask to resume one id inside the 3–6 s a bind takes, and the loser's
				// poll would otherwise see the WINNER's socket, return the loser's own
				// pid, and report `resumed` for a child that started nothing and then
				// died — the caller holds a pid that was never the session and has no
				// way to find that out. So the lock is read too, and only OUR OWN
				// child's pid in it counts.
				//
				// ONE stat and ONE small read of TWO known names. Not a readdir, and
				// therefore still not a second reaper racing the fleet observer
				// (R35-ALWAYS.10).
				const owner = lockOwnerPid(this.#socketDir, sessionId);
				if (owner === pid && existsSync(socketPath)) {
					this.#release(child);
					return { pid };
				}
				if (owner !== null && owner !== pid && pidIsAlive(owner)) {
					// Somebody else holds this id. Our child either has already been
					// refused the lock or is about to be, so it is torn down (the `catch`
					// below) rather than left to degrade into a second writer on one
					// session JSONL — which is what would happen the day an explicit
					// `--attachable` stops being fatal.
					throw new SpawnRefusedError(
						"already_live",
						`this session was taken live by another process (PID ${owner}) while it was starting; attach to it instead`,
					);
				}
				if (exited !== null) {
					if (BUSY_STDERR_MARKERS.some((marker) => stderr.includes(marker))) {
						throw new SpawnRefusedError(
							"already_live",
							`this session is already attachable from another process: ${stderr.trim()}`,
						);
					}
					throw new SpawnRefusedError(
						"spawn_failed",
						`${what} exited before publishing its socket: ${describeExit(exited)} ${stderr.trim()}`.trim(),
					);
				}
				if (!saidAnything && Date.now() >= firstOutputDeadline) {
					throw new SpawnRefusedError(
						"timeout",
						`${what} published no socket and never said a word within ${this.#firstOutputDeadlineMs} ms`,
					);
				}
				await sleep(READY_POLL_MS);
			}
		} catch (error) {
			await this.#stopRecorded(pid, record);
			throw error;
		}

		await this.#stopRecorded(pid, record);
		throw new SpawnRefusedError(
			"timeout",
			`${what} did not publish its socket within ${this.#handshakeDeadlineMs} ms${describeChildOutput(stderr)}`,
		);
	}

	/**
	 * Let a successfully started session go.
	 *
	 * `unref` on the process handle and on the stderr pipe, both: a pipe is its
	 * own libuv handle and an unref'd child with a ref'd pipe still holds the
	 * event loop open, which would make the daemon un-exitable after one resume.
	 */
	#release(child: ChildProcess): void {
		// `unref` lives on the socket, which is what these pipes are at runtime;
		// the `Readable`/`Writable` types the node typings give them do not declare
		// it, hence the narrowing rather than a cast to `any`.
		(child.stderr as { unref?: () => void } | null)?.unref?.();
		(child.stdin as { unref?: () => void } | null)?.unref?.();
		child.unref();
	}

	/**
	 * TERM, then KILL, to the PROCESS GROUP when this spawner made one (R36-SPAWN.7).
	 *
	 * The negative pid is the whole point: a draht session spawns tools, and
	 * signalling only the pid we hold leaves them running with the socket
	 * directory still theirs. The KILL is unconditional after the grace window
	 * rather than conditional on the process still existing, because a child that
	 * traps TERM is exactly the case a deadline exists for — a measured
	 * `trap '' TERM; sleep 3600` survives TERM for as long as you care to wait.
	 * @throws {RangeError} for a pid no process can have: `kill(0)` signals the CALLER'S own group and `kill(-1)` every process this uid owns.
	 */
	async stop(pid: number): Promise<void> {
		if (!Number.isInteger(pid) || pid <= 1) {
			throw new RangeError(`stop() takes the pid of a spawned process; ${pid} names no process`);
		}
		const known = this.#spawned.get(pid);
		return known === undefined ? this.#signalDown(pid, false) : this.#stopRecorded(pid, known);
	}

	#stopRecorded(pid: number, record: SpawnedProcess): Promise<void> {
		record.stopping ??= this.#signalDown(pid, record.groupSignallable);
		return record.stopping;
	}

	async #signalDown(pid: number, groupSignallable: boolean): Promise<void> {
		const target = groupSignallable ? -pid : pid;
		try {
			process.kill(target, "SIGTERM");
		} catch (error) {
			// Nothing there to escalate against. `EPERM` still gets the KILL: the target exists.
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		}
		await sleep(this.#stopDeadlineMs);
		try {
			process.kill(target, "SIGKILL");
		} catch {
			// Gone, which is the outcome this wanted.
		}
	}
}

function describeChildOutput(stderr: string): string {
	const said = stderr.trim();
	return said.length === 0 ? " and never said a word" : ` after printing: ${said}`;
}

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
	if (exit.signal !== null) return `killed by ${exit.signal}`;
	return `exit code ${exit.code ?? "unknown"}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => {
		const timer = setTimeout(done, ms);
		timer.unref?.();
	});
}

/** What a `session_resume` frame is answered with. Mirrors `session_resumed`. */
export interface ResumeOutcome {
	code: "resumed" | "already_live" | "not_found" | "cwd_missing" | "refused" | "spawn_failed" | "timeout";
	message: string;
}

/** How {@link SessionResumer} finds out what it is being asked about. */
export interface SessionResumerOptions extends SessionSpawnerOptions {
	/** Every session this machine has recorded. The ONLY id space a resume resolves in. */
	history: () => readonly HistorySession[];
	/** The ids the fleet currently holds a live socket for. */
	liveIds: () => Iterable<string>;
	/** Spawn seam. Tests inject one; nothing else should. */
	spawner?: SessionSpawner;
}

/**
 * The port the attach bridge is given: session id in, typed outcome out.
 *
 * THE RESOLUTION RULE, which is the security property (R36-SPAWN.1): the id is
 * looked up in the daemon's OWN enumerated history index and anything not in
 * that set is refused `not_found` having spawned nothing. There is no branch in
 * which a string from the wire becomes a path.
 */
export class SessionResumer {
	readonly #history: () => readonly HistorySession[];
	readonly #liveIds: () => Iterable<string>;
	readonly #spawner: SessionSpawner;
	readonly #socketDir: string;
	readonly #uid: number;
	/**
	 * The ids this DAEMON is currently starting a process for.
	 *
	 * DAEMON-WIDE, and that is the whole point. The bridge's own guard is per
	 * CONNECTION, so it bounds one WebSocket and nothing else: two phones, two
	 * tabs, or one phone on two radios sharing a token were three connections
	 * with three independent guards, and all three could be answered
	 * `{ok: true, code: "resumed"}` for one id. Measured on the shipped daemon,
	 * two connections 200 ms apart produced TWO live draht processes on one
	 * session JSONL and one socket path.
	 *
	 * It has to live here rather than in the bridge because this is the only
	 * object in the resume path there is exactly one of per daemon — see the
	 * comment on its construction in `gateway/routes/fleet.ts`, which hoists it
	 * out of the per-frame closure precisely so this set survives between frames.
	 *
	 * A `Set` and not a `Map` of promises: the second caller is answered NOW with
	 * something true, not joined to the first one's outcome. Joining would report
	 * `resumed` to a caller that did not cause the spawn, which is indeed what it
	 * asked for — but it also reports the FIRST caller's `timeout` or
	 * `spawn_failed` to a caller whose own request was never attempted, and the
	 * honest answer to "is a resume in flight" is "yes, wait".
	 */
	readonly #inFlight = new Set<string>();

	constructor(options: SessionResumerOptions) {
		this.#history = options.history;
		this.#liveIds = options.liveIds;
		this.#spawner = options.spawner ?? new SessionSpawner(options);
		this.#socketDir = options.socketDir;
		this.#uid = process.getuid?.() ?? 0;
	}

	/**
	 * One resume per id, across every connection this daemon holds.
	 *
	 * The claim is taken SYNCHRONOUSLY, before the first `await` anywhere below,
	 * so two frames that arrive in one turn of the event loop cannot both pass
	 * it. Released in a `finally`, so a throw from any depth cannot leave an id
	 * permanently unresumable.
	 *
	 * The loser is told `refused` — not `resumed`, and not `already_live`. It is
	 * `ok: false` on purpose: the session is NOT reachable yet, the caller's
	 * request was not performed, and the recovery is to wait a few seconds and
	 * ask again. `already_live` would be a lie the renderer acts on by trying to
	 * attach to a socket that does not exist, and `resumed` would be the exact
	 * defect this replaces.
	 */
	async resume(sessionId: string): Promise<ResumeOutcome> {
		if (this.#inFlight.has(sessionId)) {
			return {
				code: "refused",
				message: "a resume of this session is already in flight; wait for it to finish before asking again",
			};
		}
		this.#inFlight.add(sessionId);
		try {
			return await this.#resume(sessionId);
		} finally {
			this.#inFlight.delete(sessionId);
		}
	}

	async #resume(sessionId: string): Promise<ResumeOutcome> {
		for (const live of this.#liveIds()) {
			if (live !== sessionId) continue;
			// A SUCCESS, and it has to be: a second writer on one session JSONL is
			// the hazard the busy lock exists for, and the caller's intent — "make
			// this session reachable" — is already satisfied. The renderer attaches.
			return { code: "already_live", message: "this session is already live; attach to it instead" };
		}

		// A socket that exists but is NOT in the fleet is either debris the
		// observer has not reaped yet or — the case that matters — another uid's
		// live session, which `listAttachableSessions` filters out of the fleet
		// precisely so it cannot be attached to. Spawning into it would race a
		// foreign process for one lock, so it is refused rather than attempted.
		const foreign = this.#foreignSocketOwner(sessionId);
		if (foreign !== null) {
			return { code: "refused", message: `a session with this id is held by another user (uid ${foreign})` };
		}

		const row = this.#history().find((entry) => entry.id === sessionId);
		if (row === undefined) {
			return { code: "not_found", message: "no session with this id has been recorded on this machine" };
		}

		try {
			await this.#spawner.resume({ id: row.id, path: row.path, cwd: row.cwd });
			return { code: "resumed", message: "the session is live again" };
		} catch (error) {
			if (error instanceof SpawnRefusedError) return { code: error.code, message: error.message };
			return { code: "spawn_failed", message: error instanceof Error ? error.message : String(error) };
		}
	}

	/** The uid of a `<id>.sock` owned by somebody else, or null. */
	#foreignSocketOwner(sessionId: string): number | null {
		try {
			const stats = lstatSync(join(this.#socketDir, `${sessionId}.sock`));
			return stats.uid === this.#uid ? null : stats.uid;
		} catch {
			return null;
		}
	}
}
