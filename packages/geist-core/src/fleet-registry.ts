import type { HarnessSession } from "./harness-session.js";
import { ShaLedger } from "./ledger/sha-ledger.js";
import type { Project } from "./project.js";

/** Spec §17.7 "caps 4/3/4100": at most 4 sessions live in the fleet at once, across projects and harnesses. */
export const MAX_FLEET_SESSIONS = 4;

export class FleetCapacityError extends Error {
	constructor() {
		super(`fleet is at capacity (max ${MAX_FLEET_SESSIONS} sessions)`);
		this.name = "FleetCapacityError";
	}
}

/** Raised by the scoped session operations (`approve`/`undo`/`stop`) when `sessionId` isn't registered in the fleet. */
export class UnknownSessionError extends Error {
	constructor(sessionId: string) {
		super(`no session registered in the fleet with id: ${sessionId}`);
		this.name = "UnknownSessionError";
	}
}

/**
 * One fleet-registered session, paired with the `Project` it belongs to and
 * the worktree path its sha-ledger bookkeeping lives at (spec §6's
 * `<repo>/.geist/wt/<slug>`). This is the public, stable shape a `fleet_state`
 * wire-layer (spec §9.2) is built from: `project` + `session.harness` +
 * `session.capabilities` + `session.status` cover that row's "sessions gain
 * harness, capabilities... agents" fields. `worktreePath` is exposed too
 * (a wire layer may need it for path-scoped affordances) even though inside
 * `FleetRegistry` it exists mainly to scope `approve`/`undo` to the right
 * worktree.
 */
export interface FleetEntry {
	readonly session: HarnessSession;
	readonly project: Project;
	readonly worktreePath: string;
}

/**
 * `FleetRegistry` (DOMAIN.md Tier F, aggregate root): owns the known
 * `Project`s and the ≤4-session fleet spanning them. Harness-free —
 * sessions are held only through the `HarnessSession` port, never through
 * an ACP-specific type. In-memory for now; persistence (yaml ∪
 * workspaceRoots discovery ∪ recents, spec §3) is a later phase.
 *
 * Every session in the fleet is linked to the `Project` + worktree path it
 * runs in, so `approve`/`undo`/`stop` (spec §6, §12) can be scoped to a
 * single session's worktree rather than acting fleet-wide — a fleet spanning
 * multiple projects and harnesses (spec §17.7, §16 M5) must never let an
 * operation on one session's worktree leak into another's.
 */
export class FleetRegistry {
	private readonly projects = new Map<string, Project>();
	private readonly entries = new Map<string, FleetEntry>();
	private readonly ledger = new ShaLedger();

	registerProject(project: Project): void {
		this.projects.set(project.slug, project);
	}

	getProject(slug: string): Project | undefined {
		return this.projects.get(slug);
	}

	listProjects(): Project[] {
		return [...this.projects.values()];
	}

	/**
	 * Adds a session to the fleet, enforcing the ≤4-session cap (spec §17.7
	 * "caps 4/3/4100"), and links it to the `Project` it belongs to and the
	 * worktree path its git bookkeeping lives at. Captures `worktreePath`'s
	 * current `HEAD` as `baseSha` via `ShaLedger.record` — the same "resolve
	 * project + harness → worktree + `baseSha`" spawn step spec §12 describes
	 * — so `approve(sessionId)`/`undo(sessionId)` work from the moment the
	 * session joins the fleet.
	 */
	addSession(session: HarnessSession, project: Project, worktreePath: string): void {
		if (this.entries.size >= MAX_FLEET_SESSIONS) {
			throw new FleetCapacityError();
		}
		this.ledger.record(worktreePath);
		this.entries.set(session.id, { session, project, worktreePath });
	}

	getSession(sessionId: string): HarnessSession | undefined {
		return this.entries.get(sessionId)?.session;
	}

	/** The richer `{ session, project, worktreePath }` view — see `FleetEntry`. */
	getEntry(sessionId: string): FleetEntry | undefined {
		return this.entries.get(sessionId);
	}

	removeSession(sessionId: string): void {
		this.entries.delete(sessionId);
	}

	listSessions(): HarnessSession[] {
		return [...this.entries.values()].map((entry) => entry.session);
	}

	/** The richer `{ session, project, worktreePath }` view for every fleet-registered session — see `FleetEntry`. */
	listEntries(): FleetEntry[] {
		return [...this.entries.values()];
	}

	/**
	 * Approves ONLY `sessionId`'s worktree via the sha ledger (spec §6
	 * "approve/undo via sha ledger") — marks the worktree's current `HEAD` as
	 * `lastApprovedSha` without touching any other session's worktree, even
	 * one in the same project. Throws `UnknownSessionError` if `sessionId`
	 * isn't in the fleet.
	 */
	approve(sessionId: string): void {
		const entry = this.requireEntry(sessionId);
		this.ledger.approve(entry.worktreePath);
	}

	/**
	 * Undoes ONLY `sessionId`'s worktree via the sha ledger — `reset --hard`
	 * back to its `lastApprovedSha` (or `baseSha` if never approved), leaving
	 * every other fleet session's worktree untouched. Throws
	 * `UnknownSessionError` if `sessionId` isn't in the fleet.
	 */
	undo(sessionId: string): void {
		const entry = this.requireEntry(sessionId);
		this.ledger.undo(entry.worktreePath);
	}

	/**
	 * Stops ONLY `sessionId`'s underlying harness subprocess
	 * (`HarnessSession.stop()`) and removes it from the fleet, freeing a slot
	 * under the ≤4-session cap. Throws `UnknownSessionError` if `sessionId`
	 * isn't in the fleet.
	 */
	async stop(sessionId: string): Promise<void> {
		const entry = this.requireEntry(sessionId);
		await entry.session.stop();
		this.removeSession(sessionId);
	}

	private requireEntry(sessionId: string): FleetEntry {
		const entry = this.entries.get(sessionId);
		if (!entry) {
			throw new UnknownSessionError(sessionId);
		}
		return entry;
	}
}
