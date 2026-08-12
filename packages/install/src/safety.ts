import { lstatSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { COMPONENT_ID_PATTERN } from "./catalog.ts";
import { CliError } from "./errors.ts";

/**
 * A refusal to perform an operation because its inputs could escape the
 * boundaries the engine promises to stay inside. Every one of these is a
 * fail-closed guard: the operation does not happen, and nothing partial is
 * left behind.
 */
export class SafetyError extends CliError {
	constructor(message: string, detail?: Record<string, unknown>) {
		super("unsafe", message, { detail });
		this.name = "SafetyError";
	}
}

/** Rejects any component id that is not the narrow grammar `catalog.ts` defines. */
export function assertSafeComponentId(id: string): void {
	if (typeof id !== "string" || id.length === 0 || id.length > 64 || !COMPONENT_ID_PATTERN.test(id)) {
		throw new SafetyError(`refusing to act on unsafe component id ${JSON.stringify(id)}`, { id });
	}
}

/**
 * Rejects any payload-relative path that is not a plain forward-slash relative
 * path. This is the single choke point every archive entry and every recorded
 * state file path passes through, so traversal (`../`), absolute paths,
 * Windows drive/UNC paths, backslash separators, empty segments and embedded
 * NULs are all unrepresentable downstream rather than handled case by case.
 */
export function assertSafeRelativePath(path: string): void {
	const fail = (reason: string): never => {
		throw new SafetyError(`refusing unsafe payload path ${JSON.stringify(path)}: ${reason}`, { path, reason });
	};

	if (typeof path !== "string" || path.length === 0) fail("empty");
	if (path.includes("\0")) fail("contains a NUL byte");
	if (path.includes("\\")) fail("contains a backslash separator");
	if (path.startsWith("/")) fail("is absolute");
	if (/^[A-Za-z]:/.test(path)) fail("is a Windows drive path");
	if (path.endsWith("/")) fail("names a directory, not a file");

	const segments = path.split("/");
	for (const segment of segments) {
		if (segment === "") fail("has an empty path segment");
		if (segment === "." || segment === "..") fail("has a relative path segment");
	}
	// Belt and braces: even after per-segment checks, a normalized path that
	// starts with ".." or turns absolute is refused.
	const normalized = normalize(path);
	if (normalized.startsWith("..") || isAbsolute(normalized)) fail("normalizes outside the payload directory");
}

export interface TargetBounds {
	/** The resolved home directory. Every engine-managed payload target lives strictly inside it. */
	home: string;
	/** The engine's own state root. Targets may never be it, be inside it, or contain it. */
	installRoot: string;
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Rejects any payload target directory that is not a safe place to swap a
 * directory into and, on uninstall, to delete.
 *
 * The rules together mean a component can only ever own a directory nested at
 * least two levels below the user's home and disjoint from the engine's own
 * state — so a catalog or adapter bug can neither delete the home directory,
 * nor eat the state root, nor reach outside the user's own files.
 */
export function assertSafeTarget(target: string, bounds: TargetBounds): void {
	const fail = (reason: string): never => {
		throw new SafetyError(`refusing unsafe payload target ${JSON.stringify(target)}: ${reason}`, { target, reason });
	};

	if (typeof target !== "string" || target.length === 0) fail("empty");
	if (target.includes("\0")) fail("contains a NUL byte");
	if (!isAbsolute(target)) fail("is not an absolute path");

	const resolvedTarget = resolve(target);
	const home = resolve(bounds.home);
	const installRoot = resolve(bounds.installRoot);

	if (resolvedTarget === sep || resolvedTarget === home) fail("is the home directory or the filesystem root");
	if (!isInside(resolvedTarget, home)) fail("is outside the resolved home directory");
	if (resolvedTarget === installRoot) fail("is the engine's own state root");
	if (isInside(resolvedTarget, installRoot)) fail("is inside the engine's own state root");
	if (isInside(installRoot, resolvedTarget)) fail("contains the engine's own state root");

	const depth = relative(home, resolvedTarget).split(sep).filter(Boolean).length;
	if (depth < 2) fail("is a direct child of the home directory; payload targets must be nested deeper");
}

/**
 * Walks every path segment from `boundary` down to `target` and refuses if any
 * of them is a symbolic link.
 *
 * Without this, an attacker (or a leftover from a hand-edited install) who can
 * create `~/.draht/claude-marketplace` as a symlink turns the engine's atomic
 * "replace this directory" into "delete whatever that link points at". A
 * segment that does not exist yet is fine — it will be created by the engine.
 */
export function assertNoSymlinkPivot(target: string, boundary: string): void {
	const resolvedTarget = resolve(target);
	const resolvedBoundary = resolve(boundary);
	const rel = relative(resolvedBoundary, resolvedTarget);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new SafetyError(`refusing to inspect ${JSON.stringify(target)}: it is outside ${boundary}`, {
			target,
			boundary,
		});
	}

	let current = resolvedBoundary;
	for (const segment of rel.split(sep).filter(Boolean)) {
		current = resolve(current, segment);
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(current);
		} catch {
			// Does not exist yet: nothing can be pivoted through it.
			return;
		}
		if (stats.isSymbolicLink()) {
			throw new SafetyError(
				`refusing to operate through symbolic link ${JSON.stringify(current)} on the way to ${JSON.stringify(target)}`,
				{ target, symlink: current },
			);
		}
	}
}
