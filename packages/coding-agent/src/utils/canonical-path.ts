/** realpath collapses `..` lexically before following links, so this walks one segment at a time. */
// POSIX only: on win32 `\` is a data byte, so a junction is one lstat'd segment and never resolved.

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

/** `prefix` must be resolved, `segment` a single name or `..`. `missing` is ENOENT only: anything else means we cannot know. */
export function resolveRealSegment(prefix: string, segment: string): SegmentResolution {
	const candidate = join(prefix, segment);
	// bun rewrites `\` to `/` before the realpath syscall, answering for a path the kernel would not traverse.
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
	/** The deepest ancestor that resolved, symlink-free. */
	real: string;
	/** Segments below it, verbatim. */
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

/** The real path, or `undefined` when any part of it could not be resolved. The only one a security decision may use. */
export function realPathStrict(path: string): string | undefined {
	const { real, failed } = resolveRealPrefix(path);
	return failed ? undefined : real;
}

/** Trust-store keys only. Total, so the unresolved suffix is spelled literally and may name a directory we are not in. */
export function trustKeyPath(path: string): string {
	return spellRealPrefix(resolveRealPrefix(path));
}

/** Dedup and display identity only. Total, so equality holds no further than the filesystem could be read. */
export function comparablePath(path: string): string {
	return spellRealPrefix(resolveRealPrefix(path));
}

export function realHomeDir(): string | undefined {
	return realPathStrict(process.env.HOME || homedir());
}
