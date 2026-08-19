/**
 * `SandboxPolicy` v1 (R44-SBX.2) and its resolution (R44-SBX.3).
 *
 * The policy is a **plain declarative value**: a resolved write allowlist, a
 * read mode, a network toggle, and a privilege-escalation invariant. Backends
 * translate it into an SBPL profile / a Landlock ruleset; they do not extend it.
 * Keeping it plain is what makes it reviewable, serialisable, diffable and
 * testable independently of any platform.
 *
 * v1 shape, deliberately small (see
 * `.planning/specs/2026-07-12-bash-sandbox-confinement.md`):
 *
 * - **Write allowlist** -- project cwd, session scratch dir, OS temp,
 *   `extraWritePaths` from settings, plus a curated set of cache roots that dev
 *   toolchains write to outside the project. Everything else is read-only.
 * - **Read** -- allow-all. Dev workflows read toolchains, caches and dotfiles
 *   constantly; a read-deny list is a v2 concern and must not block v1.
 * - **Network** -- one on/off toggle, default **on** (`npm install`, `git fetch`).
 * - **Privilege escalation** -- not representable. `allowPrivilegeEscalation` is
 *   the literal `false`, not a boolean, so no caller can widen it and every
 *   backend must render a profile in which `sudo` cannot work by construction.
 *
 * ## Resolution rules
 *
 * Every path is real-path resolved *before* it lands in the policy (see
 * `real-path.ts` for why). The two classes of input are treated differently on
 * failure, and the difference is deliberate:
 *
 * - **Agent-supplied paths** (`cwd`, `sessionScratchDir`, `tmpDir`) that cannot
 *   be resolved throw `SandboxPolicyError`. A session whose own working
 *   directory does not resolve is broken; backends catch this and report
 *   `unavailable`, which is the fail-closed outcome.
 * - **User-configured paths** (`extraWritePaths`) that cannot be resolved are
 *   dropped and reported in `rejected`. Dropping narrows the writable set, so it
 *   is safe; it is never silent, so it is debuggable.
 *
 * ## Excluded roots: the exclusions apply to *every* entry, cwd included
 *
 * The curated cache roots below deliberately exclude `~` itself. That exclusion
 * used to be trivially defeated: `cwd` was pushed into the allowlist with no
 * check at all, so running the agent from `$HOME` (or `/Users`, or macOS's
 * `/System/Volumes/Data`) produced a policy whose allowlist *was* the home
 * directory -- silently, with no `rejected` entry, and reported `available`. A
 * sandbox whose allowlist is `$HOME` confines nothing, and the user had no way
 * to know.
 *
 * So `excludedWriteRootReason` is applied uniformly, and the two input classes
 * keep their documented failure modes: an excluded **agent-supplied** path
 * throws, an excluded **configured** path lands in `rejected` and is surfaced.
 * The check is not purely lexical -- `/System/Volumes/Data/Users/alice` is
 * `realpath`-stable on macOS yet is the same directory as `/Users/alice`, so
 * candidates are also compared to the home directory and its ancestors by
 * device+inode identity.
 */

import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isContainedIn, type RealPathResolution, resolveRealPath } from "./real-path.ts";

export const SANDBOX_POLICY_VERSION = 1;

export type SandboxNetworkMode = "on" | "off";

/** Resolved, declarative sandbox policy. Frozen: backends read it, never edit it. */
export interface SandboxPolicy {
	readonly version: typeof SANDBOX_POLICY_VERSION;
	/**
	 * Absolute, real-path resolved, deduplicated, minimal (no entry nested under
	 * another) and sorted. The sort makes generated profiles byte-stable, which
	 * matters for profile caching and for diffing what a session was allowed to do.
	 */
	readonly writePaths: readonly string[];
	/** v1 is read allow-all. A union so v2 can add modes without changing the field. */
	readonly read: "allow-all";
	readonly network: SandboxNetworkMode;
	/**
	 * Always `false`, and typed as the literal so it cannot be set otherwise.
	 * Backends must render a profile where privilege escalation is impossible,
	 * and the R44-SBX.4 self-test probes it before any backend reports
	 * `available` (see `self-test.ts`).
	 */
	readonly allowPrivilegeEscalation: false;
}

export interface SandboxPolicyInput {
	/** Project working directory. Must exist, resolve, and not be an excluded root. */
	cwd: string;
	/** The session's scratch directory, when it has one. */
	sessionScratchDir?: string;
	/** OS temp dir. Defaults to `os.tmpdir()`; overridable for tests. */
	tmpDir?: string;
	/** Additional writable roots from settings / `permissions.yml`. */
	extraWritePaths?: readonly string[];
	/** Include the curated cache roots below. Defaults to `true`. */
	includeDefaultCacheRoots?: boolean;
	/** Home directory used to expand cache roots and to compute exclusions. Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Defaults to `"on"`. */
	network?: SandboxNetworkMode;
	/** Platform the exclusion list is curated for. Defaults to `process.platform`. */
	platform?: NodeJS.Platform;
}

export interface RejectedWritePath {
	/** The entry exactly as configured, so the user can find it in their settings. */
	readonly input: string;
	readonly reason: string;
}

export interface SandboxPolicyResolution {
	readonly policy: SandboxPolicy;
	/**
	 * Configured write paths that were dropped. Never empty-but-ignored: surfacing
	 * these is what keeps "we narrowed your policy" from being a silent behaviour.
	 */
	readonly rejected: readonly RejectedWritePath[];
}

/** Thrown when an agent-supplied policy path cannot be resolved or is an excluded root (see module doc). */
export class SandboxPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SandboxPolicyError";
	}
}

/**
 * Cache roots dev toolchains write to outside the project.
 *
 * The bar an entry has to clear is **not** "regenerable". Every package cache is
 * regenerable, and every package cache also holds code that a later,
 * *unsandboxed* `npm install` / `cargo build` / `npx` links into a tree and
 * runs. Granting one of those is a persistence route straight out of the
 * sandbox, so the bar is:
 *
 * > tampering with an entry must be **detected**, or the entry must be
 * > unreachable by a later lookup, by a mechanism that is on **by default**.
 *
 * What that leaves, and why:
 *
 * | root                     | why it stays                                                                       |
 * |--------------------------|------------------------------------------------------------------------------------|
 * | `~/.npm/_cacache`        | content-addressed; npm verifies the SRI hash from the lockfile on read, and a mismatch is a cache miss, so a planted blob is unreachable |
 * | `~/.npm/_logs`           | plain-text run logs, no code, and npm writes them on every command                   |
 * | `~/.pnpm-store`          | content-addressable store keyed by file hash; `verify-store-integrity` is on by default |
 * | `~/.yarn/berry/cache`    | zips checksummed against `yarn.lock`; `checksumBehavior` defaults to `throw`          |
 * | `~/.cargo/registry`      | `.cargo-checksum.json` is verified on use; a modified crate source is a hard error    |
 *
 * Removed in the Phase 44 review, and why each one is a persistence route rather
 * than a cache:
 *
 * - `~/.cache` and `$XDG_CACHE_HOME` -- an unowned catch-all. Playwright browser
 *   binaries, pre-commit hook virtualenvs and toolchains installed by `uv` /
 *   bazelisk live under it and are executed directly by the next unsandboxed run.
 * - `~/Library/Caches` (macOS) -- same, and worse: Sparkle-style auto-updaters
 *   stage the installer they will later launch under `~/Library/Caches/<bundle-id>/`,
 *   and Homebrew caches downloaded bottles and `.pkg` installers there.
 * - `~/.npm` as a whole -- narrowed to the two subtrees above because
 *   `~/.npm/_npx` holds fully installed package trees that `npx` executes
 *   verbatim, with no integrity check at run time.
 * - `~/.bun/install/cache` -- keyed by name@version and hard-linked into
 *   `node_modules`; there is no default re-verification step to point at.
 * - `~/.yarn/cache` -- yarn classic's cache does not live here anyway (it is
 *   under the XDG / `~/Library/Caches` roots that are now excluded).
 * - `~/.cargo/git` -- git checkouts of dependencies carry no checksum file, and a
 *   planted `build.rs` runs at the next unsandboxed `cargo build`.
 * - `~/go/pkg/mod` -- `go.sum` is verified when the module zip is *downloaded*,
 *   not when the already-extracted tree is compiled.
 * - `~/.gradle/caches` and `~/.m2/repository` -- jars and compiled build scripts
 *   executed by the next unsandboxed `gradle` / `mvn`; dependency verification is
 *   opt-in in Gradle and warn-only by default in Maven.
 *
 * Nothing here is a parent of user documents, credentials or shell config, and
 * `~` itself, `~/.config`, `~/.local` and `~/.ssh` remain absent -- see
 * `excludedWriteRootReason`, which now enforces that rather than trusting this
 * list to be the only way in. The long tail is handled by `extraWritePaths` and
 * (Phase 45) the rerun-unsandboxed escalation prompt, not by growing this list.
 */
function defaultCacheRoots(home: string): string[] {
	return [
		join(home, ".npm", "_cacache"),
		join(home, ".npm", "_logs"),
		join(home, ".pnpm-store"),
		join(home, ".yarn", "berry", "cache"),
		join(home, ".cargo", "registry"),
	];
}

/**
 * Directories that alias the whole filesystem under another spelling, so that
 * granting one is granting `/`. macOS mounts the data volume at
 * `/System/Volumes/Data` and firmlinks it into `/`, and `realpath` keeps both
 * spellings, so a string comparison against `/` does not see it.
 */
const SYSTEM_VOLUME_ROOTS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
	darwin: ["/System/Volumes/Data"],
};

/** Device+inode identity, so firmlinks and bind mounts cannot spell their way past a string check. */
function isSameDirectory(a: string, b: string): boolean {
	try {
		const left = statSync(a);
		const right = statSync(b);
		return left.dev === right.dev && left.ino === right.ino;
	} catch {
		// A path that cannot be stat'ed is not the home directory under another name.
		return false;
	}
}

/** `path` and every directory above it, ending at the filesystem root. */
function selfAndAncestors(path: string): string[] {
	const out: string[] = [];
	let cursor = path;
	for (;;) {
		out.push(cursor);
		const parent = dirname(cursor);
		if (parent === cursor) return out;
		cursor = parent;
	}
}

/**
 * Why `path` must not enter the write allowlist, or `null` when it may.
 *
 * `path` must already be real-path resolved. The reason is a sentence fragment
 * that reads after "refusing ...: <reason>".
 */
export function excludedWriteRootReason(
	path: string,
	home: string | undefined,
	platform: NodeJS.Platform,
): string | null {
	if (path === "/") return "it is the filesystem root, so the allowlist would not be an allowlist";
	for (const root of SYSTEM_VOLUME_ROOTS[platform] ?? []) {
		if (isContainedIn(root, path)) {
			return `it is ${JSON.stringify(root)} or an ancestor of it, which aliases the entire filesystem`;
		}
	}
	if (home === undefined || home === "") return null;
	if (path === home) return "it is the home directory, which would make every dotfile, key and credential writable";
	if (isContainedIn(home, path)) {
		return `it contains the home directory ${JSON.stringify(home)}, which would make every dotfile, key and credential writable`;
	}
	for (const ancestor of selfAndAncestors(home)) {
		if (isSameDirectory(path, ancestor)) {
			return ancestor === home
				? `it is the home directory ${JSON.stringify(home)} reached by another spelling`
				: `it is ${JSON.stringify(ancestor)} reached by another spelling, and that contains the home directory`;
		}
	}
	return null;
}

function rejectionFor(result: Extract<RealPathResolution, { ok: false }>): RejectedWritePath {
	return { input: result.input, reason: result.reason };
}

/**
 * Deduplicates, drops entries already covered by another entry, and sorts.
 *
 * Sorting ascending puts every ancestor before its descendants (an ancestor is a
 * proper string prefix), so a single forward pass is enough to collapse nesting.
 */
function normalizeWriteSet(paths: readonly string[]): string[] {
	const unique = [...new Set(paths)].sort();
	const minimal: string[] = [];
	for (const path of unique) {
		if (minimal.some((existing) => isContainedIn(path, existing))) continue;
		minimal.push(path);
	}
	return minimal;
}

/**
 * Builds a v1 policy from `input`, real-path resolving every path first.
 *
 * Throws `SandboxPolicyError` when an agent-supplied path cannot be resolved or
 * is an excluded root; drops unresolvable or excluded `extraWritePaths` into
 * `rejected`.
 */
export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicyResolution {
	const platform = input.platform ?? process.platform;
	// Resolved so the comparison happens between real paths; an unresolvable home
	// still participates as a plain string rather than disabling the exclusion.
	const configuredHome = input.homeDir ?? homedir();
	const resolvedHome = configuredHome ? resolveRealPath(configuredHome, { base: "/" }) : undefined;
	const home = resolvedHome?.ok ? resolvedHome.path : configuredHome || undefined;

	/** Agent-supplied path: unresolvable or excluded is fatal, never silent. */
	const requireAllowedRoot = (label: string, entry: string, base: string): string => {
		const result = resolveRealPath(entry, { base });
		if (!result.ok) {
			throw new SandboxPolicyError(`cannot build a sandbox policy: ${label} ${result.reason}`);
		}
		const excluded = excludedWriteRootReason(result.path, home, platform);
		if (excluded) {
			throw new SandboxPolicyError(
				`cannot build a sandbox policy: refusing to put ${label} ${JSON.stringify(result.path)} in the write allowlist because ${excluded}. Run from a project directory, or grant the specific subtrees you need with extraWritePaths.`,
			);
		}
		return result.path;
	};

	const cwd = requireAllowedRoot("the project cwd", input.cwd, process.cwd());
	const rejected: RejectedWritePath[] = [];
	const writePaths: string[] = [cwd];

	writePaths.push(requireAllowedRoot("the OS temp dir", input.tmpDir ?? tmpdir(), cwd));
	if (input.sessionScratchDir !== undefined) {
		writePaths.push(requireAllowedRoot("the session scratch dir", input.sessionScratchDir, cwd));
	}

	const configured = [...(input.extraWritePaths ?? [])];
	if (input.includeDefaultCacheRoots ?? true) {
		// No home dir means no cache roots -- there is nothing to expand them against,
		// and the fail-closed answer is a narrower policy, not a guessed one.
		if (home) configured.push(...defaultCacheRoots(home));
	}

	for (const entry of configured) {
		const result = resolveRealPath(entry, { base: cwd });
		if (!result.ok) {
			rejected.push(rejectionFor(result));
			continue;
		}
		const excluded = excludedWriteRootReason(result.path, home, platform);
		if (excluded) {
			// Configured input: narrow the policy and say so. Silently accepting this
			// is what made the exclusions above decorative.
			rejected.push({
				input: entry,
				reason: `refusing to add ${JSON.stringify(result.path)} to the write allowlist because ${excluded}`,
			});
			continue;
		}
		writePaths.push(result.path);
	}

	const policy: SandboxPolicy = Object.freeze({
		version: SANDBOX_POLICY_VERSION,
		writePaths: Object.freeze(normalizeWriteSet(writePaths)),
		read: "allow-all",
		network: input.network ?? "on",
		allowPrivilegeEscalation: false,
	});
	return { policy, rejected };
}

/**
 * Whether `policy` permits writing to `candidate`.
 *
 * Resolves `candidate` to a real path first -- a lexical `startsWith` against
 * `writePaths` is exactly the bug this exists to prevent, since a symlink or a
 * `..` hop makes an in-project-looking string name a file outside the project.
 * Use this anywhere an in-process pre-check is needed; the kernel backend
 * remains the enforcement boundary, this mirrors it.
 *
 * `candidate` must be absolute unless a `base` is given. Anything unresolvable
 * answers `false` -- an undecidable path is not a writable one.
 */
export function isPathWritable(policy: SandboxPolicy, candidate: string, options?: { base?: string }): boolean {
	if (options?.base === undefined && !isAbsolute(candidate)) return false;
	const result = resolveRealPath(candidate, { base: options?.base ?? candidate });
	if (!result.ok) return false;
	return policy.writePaths.some((root) => isContainedIn(result.path, root));
}
