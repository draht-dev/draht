import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Project } from "../project.js";

/**
 * Cap on the persisted recents list (spec §3's "recents" source of the
 * project registry). Spec §17.7's own cap list ("caps 4/3/4100") names the
 * fleet-session cap (`MAX_FLEET_SESSIONS`, `fleet-registry.ts` — 4) and the
 * default variants count (3) but not a recents-list size — this is this
 * module's own judgment call. 10 is chosen because: it comfortably covers a
 * day's worth of project-switching across a ≤4-session fleet without ever
 * needing to page a voice disambiguation list (spec §9.5, H4), while staying
 * small enough that "recent" still means something (a 100-entry list would
 * just be a second copy of the whole registry).
 */
export const RECENTS_CAP = 10;

/**
 * Storage port for the recents list (spec §3 "recents" source). Injectable
 * so `ProjectRegistry` (`project-registry.ts`) is unit-testable without real
 * disk I/O — `InMemoryRecentsStore` below is the test double; `FileRecentsStore`
 * is the real default for production use.
 */
export interface RecentsStore {
	/** Most-recently-used first. Empty list if nothing has been recorded yet. */
	load(): Project[];
	/** Replaces the persisted list wholesale (already ordered/capped by the caller). */
	save(projects: Project[]): void;
}

/**
 * In-memory `RecentsStore` — never touches disk, resets on process restart.
 * The default when no store is supplied to `ProjectRegistry`, and the store
 * of choice for unit tests that don't care about persistence.
 */
export class InMemoryRecentsStore implements RecentsStore {
	private projects: Project[] = [];

	load(): Project[] {
		return [...this.projects];
	}

	save(projects: Project[]): void {
		this.projects = [...projects];
	}
}

/**
 * Default disk location for the recents list — a sibling of spec §6's
 * `~/.geist/config.yaml`, under the same per-user `~/.geist/` bridge state
 * directory.
 */
export const DEFAULT_RECENTS_PATH = join(homedir(), ".geist", "recents.json");

/**
 * Disk-backed `RecentsStore`: real `node:fs` I/O against a JSON file
 * (default `DEFAULT_RECENTS_PATH`). A missing file loads as an empty list; a
 * corrupt or shape-mismatched file also degrades to an empty list rather
 * than throwing — the recents cache is a convenience, not a source of truth
 * worth crashing bridge startup over.
 */
export class FileRecentsStore implements RecentsStore {
	private readonly filePath: string;

	constructor(filePath: string = DEFAULT_RECENTS_PATH) {
		this.filePath = filePath;
	}

	load(): Project[] {
		if (!existsSync(this.filePath)) return [];

		try {
			const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
			return Array.isArray(parsed) ? parsed.filter(isProject) : [];
		} catch {
			return [];
		}
	}

	save(projects: Project[]): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(this.filePath, JSON.stringify(projects, null, 2), "utf-8");
	}
}

function isProject(value: unknown): value is Project {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.slug === "string" && typeof candidate.name === "string" && typeof candidate.root === "string"
	);
}

/**
 * Records `project` as the most-recently-used entry: moves it to the front
 * of `recents` (removing any existing entry with the same slug so a re-use
 * bumps rather than duplicates), then caps the result at `cap` — the oldest
 * entries fall off first.
 */
export function touchRecents(recents: readonly Project[], project: Project, cap: number = RECENTS_CAP): Project[] {
	const withoutProject = recents.filter((entry) => entry.slug !== project.slug);
	return [project, ...withoutProject].slice(0, cap);
}
