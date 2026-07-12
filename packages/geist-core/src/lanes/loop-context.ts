import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Path segments of the fixed `.planning/loop/LOOP.md` convention, joined onto a worktree root. */
const LOOP_MD_SEGMENTS = [".planning", "loop", "LOOP.md"] as const;

/**
 * `LOOP.md`'s content, surfaced alongside the absolute path it was read
 * from — spec §6 ("`.planning/loop/LOOP.md` surfaced when present") and §3
 * ("file-based, harness-neutral"). Deliberately no relation to any ACP
 * event or harness: this is a plain filesystem check any harness's
 * worktree may or may not have.
 */
export interface LoopContext {
	/** Absolute path to the `LOOP.md` that was read. */
	readonly path: string;
	/** The file's raw content, unparsed. */
	readonly content: string;
}

/**
 * Checks `<worktreePath>/.planning/loop/LOOP.md` and, if present, returns its
 * content alongside the path; returns `undefined` if the file (or its
 * containing `.planning/loop/` directory) doesn't exist.
 *
 * Point-in-time only — no polling or watching. A future phase decides how
 * often to re-check; this is deliberately the smallest honest primitive.
 */
export function readLoopContext(worktreePath: string): LoopContext | undefined {
	const path = join(worktreePath, ...LOOP_MD_SEGMENTS);
	if (!existsSync(path)) {
		return undefined;
	}
	return { path, content: readFileSync(path, "utf8") };
}
