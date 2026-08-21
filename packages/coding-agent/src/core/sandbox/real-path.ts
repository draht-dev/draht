/**
 * Real-path resolution for sandbox policy paths (R44-SBX.3).
 *
 * Every path that reaches a sandbox profile must first become the path the
 * *kernel* sees, not the path a string spells. This is a security property, not
 * tidiness: the write allowlist is the whole policy, so anything that lets one
 * string name two different places lets the allowlist be widened silently.
 *
 * Two such mechanisms exist, and both are handled here:
 *
 * 1. **Symlinks.** A link inside the project pointing outside it (`<project>/link
 *    -> /somewhere/else`) makes `<project>/link/x` pass any `startsWith(project)`
 *    check while actually writing to `/somewhere/else/x`.
 * 2. **`..` traversal.** `..` is *not* a lexical operation once symlinks are in
 *    play: `<project>/link/../x` is `/somewhere/x`, not `<project>/x`. Node's
 *    `path.join`/`path.resolve` collapse `..` lexically and would therefore
 *    produce exactly the wrong answer, so this module deliberately never uses
 *    them to build the path it resolves.
 *
 * ## Why `..` is walked here instead of being handed to `realpath(3)`
 *
 * The obvious implementation -- hand the raw spelling to `realpathSync.native`
 * and let the OS walk it -- is **not portable, and the runtime it is wrong on is
 * the one that ships**. Measured, same machine, same fixture
 * (`<project>/link -> <outside>/sub`):
 *
 * | call                                          | node 26 | bun 1.4    |
 * |-----------------------------------------------|---------|------------|
 * | `realpathSync(<project>/link/..)`             | `<project>` (lexical, wrong) | `<project>` (lexical, wrong) |
 * | `realpathSync.native(<project>/link/..)`      | `<outside>` (POSIX, right)   | `<project>` (lexical, **wrong**) |
 *
 * Bun's `realpathSync.native` collapses `..` lexically before resolving, exactly
 * like the JS variant. The released `draht` binaries are built with `bun build
 * --compile` (see `packages/coding-agent` `build:binary`), so delegating `..` to
 * the OS would have meant `isPathWritable()` answering **true** for
 * `<project>/link/../evil.txt` in every shipped binary -- a path the kernel
 * writes to `<outside>/evil.txt`, outside the allowlist. That is R44-SBX.3
 * defeated by the very call that was supposed to enforce it.
 *
 * So the guarantee this module actually makes, and the one the walk below
 * implements, is:
 *
 * > `..` is never passed to the platform's `realpath`. The path is walked one
 * > segment at a time; each ordinary segment is resolved by `realpathSync.native`
 * > against an already fully-resolved prefix (a single name, no `..`, so both
 * > runtimes agree and symlink chasing, `ELOOP` and permission checks stay in the
 * > kernel); each `..` is applied to that resolved prefix, which is where POSIX
 * > says it applies.
 *
 * `test/sandbox-real-path-runtime.test.ts` executes the same assertions under
 * **both** node and bun and fails if the two disagree, so this claim is checked
 * against the runtime that ships rather than only the one the tests run in.
 *
 * ## Paths that do not exist yet
 *
 * A configured write path may legitimately not exist yet (a build output dir, a
 * cache root on a fresh machine). `realpath(3)` fails on those, and guessing is
 * how allowlists get widened by accident. The rule here:
 *
 * - Resolve every segment that *does* exist (so no symlink anywhere in the
 *   existing prefix can widen anything).
 * - Re-attach the remaining segments literally, since they name nothing yet.
 * - If any remaining segment is `..`, **refuse**: `..` below a non-existent
 *   directory has no determinable target (it depends on what that directory
 *   turns out to be when created), and inventing one is precisely the silent
 *   widening this requirement forbids.
 *
 * The resolved leaf is only an *ancestor* guarantee -- someone could later create
 * that leaf as a symlink pointing elsewhere. That is why `isPathWritable`
 * (see `policy.ts`) re-resolves the candidate at check time rather than trusting
 * the stored string, and why the kernel backends, not this module, are the
 * enforcement boundary.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";

/**
 * Resolves one already-`..`-free path. Correct on every runtime *for that
 * input*: the runtime divergence documented above is entirely about `..`, which
 * the walk below never hands to it.
 *
 * Were `.native` ever missing, calling it throws a `TypeError` that is caught in
 * `resolveRealPath` and reported as an unresolvable path, so the failure mode is
 * a narrower policy, never a lexically-collapsed one.
 */
const realpathNative = realpathSync.native;

export interface ResolveRealPathOptions {
	/** Absolute directory that relative inputs resolve against (normally the project cwd). */
	base: string;
}

export type RealPathResolution =
	| {
			readonly ok: true;
			/** The path as given. */
			readonly input: string;
			/** Absolute, fully symlink-resolved path. Contains no `.` or `..` segments. */
			readonly path: string;
			/** True when the whole path already existed; false when only its ancestor did. */
			readonly existed: boolean;
	  }
	| {
			readonly ok: false;
			readonly input: string;
			/** Human-readable explanation, safe to surface in diagnostics. */
			readonly reason: string;
	  };

/** Joins without `path.join`'s lexical `..` collapsing (see module doc). */
function joinRaw(base: string, input: string): string {
	const trimmedBase = base.length > 1 && base.endsWith(sep) ? base.slice(0, -1) : base;
	return `${trimmedBase}${sep}${input}`;
}

/**
 * Resolves `input` to a real, absolute path. Never throws -- failures come back
 * as `{ ok: false, reason }` so callers can drop the entry (narrowing the
 * writable set) instead of falling back to an unresolved spelling.
 */
export function resolveRealPath(input: string, options: ResolveRealPathOptions): RealPathResolution {
	if (input.trim() === "") {
		return { ok: false, input, reason: "path is empty" };
	}
	if (!isAbsolute(options.base)) {
		return { ok: false, input, reason: `base directory must be absolute, got ${JSON.stringify(options.base)}` };
	}

	const absolute = isAbsolute(input) ? input : joinRaw(options.base, input);

	// Split on the separator ourselves rather than letting `realpath` see the
	// whole spelling: this is the single line that makes the module's guarantee
	// independent of how the host runtime chose to implement `..`.
	const segments = absolute.split(sep);
	/** Always fully symlink-resolved, so `..` against it is plain `dirname`. */
	let resolved: string = sep;
	/** Segments below the deepest existing directory. They name nothing yet. */
	const pending: string[] = [];

	for (const segment of segments) {
		if (segment === "" || segment === ".") continue;

		if (pending.length > 0) {
			if (segment === "..") {
				return {
					ok: false,
					input,
					reason: `refusing to resolve ${JSON.stringify(input)}: ".." appears below ${JSON.stringify(
						resolved,
					)}, the deepest part of the path that exists, so its real target cannot be determined without guessing`,
				};
			}
			pending.push(segment);
			continue;
		}

		if (segment === "..") {
			// `resolved` contains no symlink component, so its parent directory is
			// its lexical parent -- which is exactly what POSIX `..` means here.
			// `dirname("/")` is `"/"`, matching the kernel's `/.. == /`.
			resolved = dirname(resolved);
			continue;
		}

		try {
			// One plain name appended to a resolved prefix: no `..`, nothing for a
			// runtime to collapse, and symlink chasing stays in the kernel.
			resolved = realpathNative(join(resolved, segment));
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				// ELOOP, ENOTDIR, EACCES, ... are all "we cannot know what this names".
				// Walking past them would answer a different question than the one asked.
				return { ok: false, input, reason: `cannot resolve ${JSON.stringify(input)}: ${(err as Error).message}` };
			}
			pending.push(segment);
		}
	}

	const path = pending.length > 0 ? join(resolved, ...pending) : resolved;
	return { ok: true, input, path, existed: pending.length === 0 };
}

/**
 * True when `candidate` is `root` itself or lies underneath it. Both arguments
 * must already be real paths -- this is a pure string comparison and makes no
 * claim about symlinks; resolve first.
 *
 * Comparison is exact-case. On case-sensitive filesystems that is correct; on a
 * case-insensitive one (default APFS/HFS+) it is stricter than the kernel, which
 * can only produce a false "not contained", never a false "contained".
 */
export function isContainedIn(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return candidate.startsWith(prefix);
}
