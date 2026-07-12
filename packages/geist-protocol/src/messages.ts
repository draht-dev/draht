import { z } from "zod";

/**
 * Minimal, genuinely extensible WS message envelope (spec §9.2). The full
 * protocol table (`fleet_state`, `session_new`, `variants_new`, etc.) lands
 * incrementally across phases 32-40 as each milestone needs it; this stub
 * lets packages type against the envelope shape today without depending on
 * message types that don't exist yet.
 */
export interface WsMessage {
	type: string;
	payload: unknown;
}

/**
 * One selectable option on a pending permission request (spec §9.2).
 * `kind` mirrors the ACP permission-option vocabulary (e.g. allow/reject,
 * once/always); the exact enum is pinned when the real ACP client lands in
 * Phase 35 (M3) — kept as a free-form string here rather than guessed at.
 */
export const PermissionOptionSchema = z.object({
	id: z.string(),
	label: z.string(),
	kind: z.string(),
});
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

/**
 * `permission_request` — bridge → headset (spec §9.2). An ACP agent asked
 * for permission; the headset renders `options` as chips on the session's
 * card.
 */
export const PermissionRequestMessageSchema = z.object({
	type: z.literal("permission_request"),
	payload: z.object({
		sessionId: z.string(),
		requestId: z.string(),
		title: z.string(),
		options: z.array(PermissionOptionSchema),
	}),
});
export type PermissionRequestMessage = z.infer<typeof PermissionRequestMessageSchema>;

/**
 * `permission_answer` — headset → bridge (spec §9.2). Resolves a pending
 * `permission_request` with the chosen option (voice allow/deny maps to the
 * closest offered option upstream, in geist-core).
 */
export const PermissionAnswerMessageSchema = z.object({
	type: z.literal("permission_answer"),
	payload: z.object({
		sessionId: z.string(),
		requestId: z.string(),
		optionId: z.string(),
	}),
});
export type PermissionAnswerMessage = z.infer<typeof PermissionAnswerMessageSchema>;

/**
 * Capabilities negotiated at ACP handshake time (spec §9.2's `fleet_state`
 * row: "capabilities: {images, commands, modes, resume}"). Field-for-field
 * mirror of `HarnessCapabilities` in `geist-core`'s `HarnessSession` port —
 * duplicated here rather than imported because `geist-protocol` has zero
 * `@draht/*`/package dependencies of its own (it's the shared wire-type leaf
 * package geist-core itself depends on, not the other way around). geist
 * degrades per capability, never per harness name (spec §3).
 */
export const FleetSessionCapabilitiesSchema = z.object({
	images: z.boolean(),
	commands: z.boolean(),
	modes: z.boolean(),
	resume: z.boolean(),
});
export type FleetSessionCapabilities = z.infer<typeof FleetSessionCapabilitiesSchema>;

/**
 * A session's lifecycle status crossing onto the wire (spec §12: `running`
 * while a turn streams, `awaiting_review` once the turn ends AND git is
 * dirty/ahead — git is the truth, never the agent's claim — `stopped` once
 * the subprocess has exited). Field-for-field mirror of `HarnessSessionStatus`
 * in `geist-core`'s `HarnessSession` port, duplicated for the same
 * zero-`@draht/*`-dependency reason as `FleetSessionCapabilitiesSchema` above.
 * A fleet board cannot surface the approve/undo affordance without this —
 * that's the whole point of a session card.
 */
export const FleetSessionStatusSchema = z.enum(["running", "awaiting_review", "stopped"]);
export type FleetSessionStatus = z.infer<typeof FleetSessionStatusSchema>;

/**
 * One session card's wire shape inside `fleet_state` (spec §9.2: "sessions
 * gain `harness, capabilities: {...}`"). `id`, `projectSlug`, and `status`
 * are the baseline session-identity fields a fleet board needs beyond what
 * the spec table spells out explicitly. `projectSlug` stays optional — it's
 * a `FleetRegistry` (geist-core) implementation detail this protocol leaf
 * package shouldn't assume is guaranteed for every session, not a marker of
 * an unfinished association (as of Phase 37, `FleetRegistry` does record and
 * `buildFleetState` does populate it for every registered session).
 */
export const FleetSessionSchema = z.object({
	id: z.string(),
	projectSlug: z.string().optional(),
	harness: z.string(),
	capabilities: FleetSessionCapabilitiesSchema,
	status: FleetSessionStatusSchema,
});
export type FleetSession = z.infer<typeof FleetSessionSchema>;

/**
 * One configured agent's auth status (spec §9.2: "agents: [{name, authOk}]").
 * `authOk` reflects the agent's own vendor auth on the dev machine (`geist
 * doctor`, spec §3) — geist stores no provider credentials itself (spec §15).
 */
export const FleetAgentSchema = z.object({
	name: z.string(),
	authOk: z.boolean(),
});
export type FleetAgent = z.infer<typeof FleetAgentSchema>;

/**
 * `fleet_state` — bridge → headset (spec §9.2). The full fleet snapshot: every
 * live session (≤`MAX_FLEET_SESSIONS`, spec §17.7) across projects and
 * harnesses, plus the configured agents' auth status for the harness picker.
 */
export const FleetStateMessageSchema = z.object({
	type: z.literal("fleet_state"),
	payload: z.object({
		sessions: z.array(FleetSessionSchema),
		agents: z.array(FleetAgentSchema),
	}),
});
export type FleetStateMessage = z.infer<typeof FleetStateMessageSchema>;
