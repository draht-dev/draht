import type { HarnessSession } from "./harness-session.js";
import type { Project } from "./project.js";

/** Spec §17.7 "caps 4/3/4100": at most 4 sessions live in the fleet at once, across projects and harnesses. */
export const MAX_FLEET_SESSIONS = 4;

export class FleetCapacityError extends Error {
	constructor() {
		super(`fleet is at capacity (max ${MAX_FLEET_SESSIONS} sessions)`);
		this.name = "FleetCapacityError";
	}
}

/**
 * `FleetRegistry` (DOMAIN.md Tier F, aggregate root): owns the known
 * `Project`s and the ≤4-session fleet spanning them. Harness-free —
 * sessions are held only through the `HarnessSession` port, never through
 * an ACP-specific type. In-memory for now; persistence (yaml ∪
 * workspaceRoots discovery ∪ recents, spec §3) is a later phase.
 */
export class FleetRegistry {
	private readonly projects = new Map<string, Project>();
	private readonly sessions = new Map<string, HarnessSession>();

	registerProject(project: Project): void {
		this.projects.set(project.slug, project);
	}

	getProject(slug: string): Project | undefined {
		return this.projects.get(slug);
	}

	listProjects(): Project[] {
		return [...this.projects.values()];
	}

	/** Adds a session to the fleet, enforcing the ≤4-session cap. */
	addSession(session: HarnessSession): void {
		if (this.sessions.size >= MAX_FLEET_SESSIONS) {
			throw new FleetCapacityError();
		}
		this.sessions.set(session.id, session);
	}

	getSession(sessionId: string): HarnessSession | undefined {
		return this.sessions.get(sessionId);
	}

	removeSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	listSessions(): HarnessSession[] {
		return [...this.sessions.values()];
	}
}
