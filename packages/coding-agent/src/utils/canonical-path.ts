/**
 * The one place a path becomes the path the kernel sees. No total `(string) => string`
 * wrapper: it would have to invent an answer on failure, and every caller that had one
 * took the invented answer as a security decision.
 *
 * Both realpath variants collapse `..` lexically before following links, so the walk is
 * one segment at a time against an already-resolved prefix. And bun 1.4 rewrites `\` to
 * `/` before the syscall (`realpathSync` and `.native` alike; node 26 does not), so on the
 * runtime `bun build --compile` ships, `realpathSync("<root>/a\\b")` answers `<root>/a/b`
 * when both exist and `realpathSync("<root>/q\\r")` answers `<root>/q/r` instead of
 * ENOENT — hence `lstat` for such names, and no following a link reached through one.
 */

import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse } from "node:path";
import { normalizePath } from "./paths.ts";

const realpathNative = realpathSync.native;

export type SegmentResolution =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly missing: boolean; readonly reason: string };

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

/**
 * `prefix` must be fully resolved and `segment` a single name or `..`. `missing` is
 * ENOENT only: every other failure means "we cannot know what this names", which is
 * not "it is not there yet".
 */
export function resolveRealSegment(prefix: string, segment: string): SegmentResolution {
	const candidate = join(prefix, segment);
	if (candidate.includes("\\")) {
		try {
			if (lstatSync(candidate).isSymbolicLink()) {
				return {
					ok: false,
					missing: false,
					reason: `refusing to follow ${JSON.stringify(candidate)}: a symbolic link named through a backslash cannot be resolved on every runtime`,
				};
			}
			return { ok: true, path: candidate };
		} catch (error) {
			return { ok: false, missing: errorCode(error) === "ENOENT", reason: `${(error as Error).message}` };
		}
	}
	try {
		return { ok: true, path: realpathNative(candidate) };
	} catch (error) {
		return { ok: false, missing: errorCode(error) === "ENOENT", reason: `${(error as Error).message}` };
	}
}

export interface RealPrefix {
	/** The deepest ancestor that resolved, fully symlink-free. */
	real: string;
	/** Segments below it, verbatim — nothing this process could resolve. */
	unresolved: string[];
	failed: boolean;
}

export function resolveRealPrefix(path: string): RealPrefix {
	const normalized = normalizePath(path, { expandTilde: false });
	const expanded = normalized === "~" || normalized.startsWith("~/") ? homedir() + normalized.slice(1) : normalized;
	const root = isAbsolute(expanded) ? parse(expanded).root : "";
	let real = root || process.cwd();
	const unresolved: string[] = [];
	let failed = false;
	// "/" only: splitting a backslash apart keys a real directory onto a path that does not exist.
	for (const segment of expanded.slice(root.length).split("/")) {
		if (segment === "" || segment === ".") {
			continue;
		}
		if (unresolved.length > 0) {
			if (segment === "..") {
				unresolved.pop();
			} else {
				unresolved.push(segment);
			}
			continue;
		}
		const resolved = resolveRealSegment(real, segment);
		if (resolved.ok) {
			real = resolved.path;
		} else {
			failed = true;
			unresolved.push(segment);
		}
	}
	return { real, unresolved, failed };
}

export function spellRealPrefix({ real, unresolved }: RealPrefix): string {
	return unresolved.length === 0 ? real : join(real, ...unresolved);
}

/** The real path, or `undefined` when any part of it could not be resolved. */
export function realPathStrict(path: string): string | undefined {
	const { real, failed } = resolveRealPrefix(path);
	return failed ? undefined : real;
}

/**
 * FOR KEYING THE TRUST STORE ONLY. Total, because a decision must be recorded even
 * for a cwd that does not resolve; the unresolved suffix is spelled literally, so
 * the result may name a directory we are not in. Never treat it as a real path.
 */
export function trustKeyPath(path: string): string {
	return spellRealPrefix(resolveRealPrefix(path));
}

/**
 * FOR DEDUP AND DISPLAY IDENTITY ONLY, never for a trust, containment or load
 * decision: equality here holds only as far as the filesystem could be read.
 */
export function comparablePath(path: string): string {
	return spellRealPrefix(resolveRealPrefix(path));
}

export function realHomeDir(): string | undefined {
	return realPathStrict(process.env.HOME || homedir());
}
