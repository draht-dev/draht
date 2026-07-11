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
