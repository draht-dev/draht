import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../project.js";

/** `readdirSync(dir, { withFileTypes: true })`, or `[]` if `dir` can't be read (e.g. a permissions error). */
function safeReaddir(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * The "workspaceRoots discovery" source of the project registry (spec §3:
 * "registry = yaml ∪ workspaceRoots discovery ∪ recents"). For each
 * directory in `workspaceRoots`, scans its IMMEDIATE subdirectories (not
 * recursive) for git repos — a `.git` entry present, directory or file (the
 * file form is how `git worktree add` marks a linked worktree, so this also
 * discovers worktrees, not only primary clones) — and turns each into a
 * `Project`.
 *
 * Real `node:fs` I/O throughout; no in-memory simulation. A missing or
 * unreadable `workspaceRoots` entry is skipped rather than thrown — a stale
 * or not-yet-mounted directory in config shouldn't crash registry resolution.
 */
export function discoverWorkspaceProjects(workspaceRoots: readonly string[]): Project[] {
	const discovered: Project[] = [];

	for (const root of workspaceRoots) {
		if (!existsSync(root)) continue;

		for (const entry of safeReaddir(root)) {
			if (!entry.isDirectory()) continue;

			const projectRoot = join(root, entry.name);
			if (!existsSync(join(projectRoot, ".git"))) continue;

			discovered.push({ slug: slugify(entry.name), name: entry.name, root: projectRoot });
		}
	}

	return discovered;
}

/**
 * Turns a directory name into a stable, voice-typeable slug (spec §9.5's
 * project qualifier is spoken/typed text, so it can't contain arbitrary
 * directory-name characters): lowercased, runs of anything other than
 * `[a-z0-9]` collapsed to a single `-`, leading/trailing `-` trimmed. Falls
 * back to the lowercased original if that leaves nothing (e.g. a name made
 * entirely of symbols) — a project always gets a non-empty slug.
 */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return slug.length > 0 ? slug : name.toLowerCase();
}
