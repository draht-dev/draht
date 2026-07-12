import type { FleetAgent, FleetSession, FleetStateMessage } from "@draht/geist-protocol";
import type { FleetRegistry } from "../fleet-registry.js";

/**
 * Projects a `FleetRegistry`'s current state into the `fleet_state` wire
 * shape (spec §9.2) — the view model a future fleet board would consume.
 * Pure: no side effects, no git, no ACP. Reads only `FleetRegistry`'s public
 * API (`listEntries()`), the boundary set for this phase — `fleet-registry.ts`
 * itself is not touched here.
 *
 * Uses `listEntries()` (not the plainer `listSessions()`) specifically for
 * its `{ session, project }` pairing, which is what lets `projectSlug` be
 * populated correctly per session below — `FleetSessionSchema.projectSlug`
 * stays optional in the wire schema regardless, since a session's project
 * link is a `FleetRegistry` implementation detail this view has no business
 * assuming will always be present.
 *
 * `agents` (with `authOk`) is supplied by the caller rather than derived
 * here: whether a configured agent's own vendor auth is currently valid is a
 * `geist doctor`-style check (spec §3, §15) that `FleetRegistry` has no
 * opinion on and this phase does not implement.
 */
export function buildFleetState(registry: FleetRegistry, agents: readonly FleetAgent[]): FleetStateMessage {
	const sessions: FleetSession[] = registry.listEntries().map((entry) => ({
		id: entry.session.id,
		projectSlug: entry.project.slug,
		harness: entry.session.harness,
		capabilities: { ...entry.session.capabilities },
		status: entry.session.status,
	}));

	return {
		type: "fleet_state",
		payload: {
			sessions,
			agents: agents.map((agent) => ({ ...agent })),
		},
	};
}
