/**
 * The `HarnessSession` port (spec §5, §7): the one interface geist-core uses
 * to talk to a running agent, whatever the harness. `geist-core` owns this
 * interface and never speaks ACP; `geist-acp` is the only package that
 * implements it, over a real ACP client (Phase 35, M3). No ACP wire types
 * appear here — that boundary is enforced by `scripts/check-geist-boundary.mjs`.
 */

/**
 * Capabilities negotiated at ACP handshake time (spec §9.2's `fleet_state`
 * row). geist degrades per capability, never per harness name.
 */
export interface HarnessCapabilities {
	readonly images: boolean;
	readonly commands: boolean;
	readonly modes: boolean;
	readonly resume: boolean;
}

/**
 * `running` while a turn streams; `awaiting_review` once the turn ends AND
 * git is dirty/ahead (git is the truth, not the agent's claim — spec §12);
 * `stopped` once the underlying subprocess has exited.
 */
export type HarnessSessionStatus = "running" | "awaiting_review" | "stopped";

/**
 * One ACP subprocess session as geist-core sees it. Method bodies are not
 * part of this interface (interfaces have none) — the real implementation,
 * which throws until it does the ACP work, lands in `geist-acp` in Phase 35.
 */
export interface HarnessSession {
	/** Stable session id, generated at spawn time. */
	readonly id: string;
	/** Launch-spec name from `geist.yaml`'s `harness.agents` map (e.g. `"claude"`). */
	readonly harness: string;
	/** Capabilities negotiated at ACP handshake time. */
	readonly capabilities: HarnessCapabilities;
	/** Current lifecycle status. */
	readonly status: HarnessSessionStatus;

	/** Sends a composed situation prompt (spec §9.4) to the agent's current turn. */
	dispatch(prompt: string): Promise<void>;

	/** Cancels the in-flight turn. Steer fallback = cancel + re-prompt where mid-turn steer isn't offered. */
	cancel(): Promise<void>;

	/** Resolves a pending ACP permission request with the chosen option id (spec §9.2, §15). */
	answerPermission(requestId: string, optionId: string): Promise<void>;

	/** Terminates the underlying ACP subprocess. */
	stop(): Promise<void>;
}
