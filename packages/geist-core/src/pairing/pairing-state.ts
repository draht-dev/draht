import { randomBytes } from "node:crypto";

/**
 * The bridge↔headset pairing state machine (spec §7 "geist-core: pairing",
 * §16 M1: "pairing survives restart"). Pure, framework-free logic — no
 * network, no WS. `@draht/geist` wires this into a real transport
 * (`packages/geist/src/pairing/server.ts`); this module owns none of that.
 *
 * Lifecycle:
 *   unpaired --beginPairingAttempt()--> pairing
 *   pairing  --completePairing(token) [match]--> paired
 *   pairing  --completePairing(token) [mismatch]--> unpaired
 *   paired   --disconnect()--> paired (disconnectedAt set; grace clock starts)
 *   paired+disconnected --reconnect(token) [match, within grace]--> paired (resumed, no re-pair)
 *   paired+disconnected --reconnect(token) [grace expired]--> unpaired (must re-pair)
 */

export type PairingStatus = "unpaired" | "pairing" | "paired";

/** Spec §16 M1: reconnect grace window default, in ms. */
export const DEFAULT_RECONNECT_GRACE_MS = 60_000;

/** Number of random bytes used to generate a LAN pairing token (128 bits, hex-encoded). */
const PAIRING_TOKEN_BYTES = 16;

/** Generates a random LAN pairing token (hex-encoded, cryptographically random). */
export function generatePairingToken(): string {
	return randomBytes(PAIRING_TOKEN_BYTES).toString("hex");
}

export interface PairingStateOptions {
	/** Reconnect grace window in ms. Defaults to `DEFAULT_RECONNECT_GRACE_MS` (60s). */
	graceWindowMs?: number;
	/** Clock injection, for deterministic tests. Defaults to `Date.now`. */
	now?: () => number;
	/** Fixed pairing token, for deterministic tests. Defaults to a fresh random token. */
	token?: string;
}

export interface PairingAttemptResult {
	ok: boolean;
	status: PairingStatus;
	reason?: "invalid_token";
}

export interface ReconnectAttemptResult {
	ok: boolean;
	status: PairingStatus;
	reason?: "invalid_token" | "grace_expired" | "not_paired";
}

export class PairingState {
	/** The active LAN pairing token this session expects. Stable for the object's lifetime. */
	readonly token: string;

	private readonly graceWindowMs: number;
	private readonly now: () => number;
	private currentStatus: PairingStatus = "unpaired";
	private disconnectedAtMs: number | null = null;

	constructor(options: PairingStateOptions = {}) {
		this.token = options.token ?? generatePairingToken();
		this.graceWindowMs = options.graceWindowMs ?? DEFAULT_RECONNECT_GRACE_MS;
		this.now = options.now ?? Date.now;
	}

	get status(): PairingStatus {
		return this.currentStatus;
	}

	/** Wall-clock ms at which the paired session last disconnected, or `null` if connected/never paired. */
	get disconnectedAt(): number | null {
		return this.disconnectedAtMs;
	}

	/**
	 * A new inbound connection begins a pairing attempt (e.g. a WS socket
	 * opens). `unpaired -> pairing`. No-op when already `pairing` or `paired`
	 * — in particular, a reconnecting headset's socket reopening does NOT
	 * disturb an existing `paired` session; `reconnect()` handles that path.
	 */
	beginPairingAttempt(): void {
		if (this.currentStatus === "unpaired") {
			this.currentStatus = "pairing";
		}
	}

	/**
	 * The client presents a token to complete a pairing attempt. Matching
	 * token: `pairing -> paired`. Mismatched token: rejected, reverts to
	 * `unpaired` so a fresh attempt can start (`beginPairingAttempt()` again).
	 */
	completePairing(presentedToken: string): PairingAttemptResult {
		if (presentedToken !== this.token) {
			this.currentStatus = "unpaired";
			return { ok: false, status: this.currentStatus, reason: "invalid_token" };
		}

		this.currentStatus = "paired";
		this.disconnectedAtMs = null;
		return { ok: true, status: this.currentStatus };
	}

	/**
	 * The active connection drops. A `paired` session stays `paired` — the
	 * disconnect is recorded as `disconnectedAt`, opening the reconnect grace
	 * window (spec §16 M1 "pairing survives restart"). A half-completed
	 * `pairing` attempt that drops before a token is presented reverts to
	 * `unpaired` (nothing to preserve).
	 *
	 * The grace clock is anchored to the FIRST disconnect since the last
	 * successful pairing/reconnect: a second `disconnect()` while already
	 * disconnected-but-still-paired is a no-op on the timestamp. Otherwise a
	 * stray socket opening then immediately closing during the grace window
	 * would reset the clock, letting a flaky or hostile client hold a session
	 * `paired` indefinitely past the intended grace period.
	 */
	disconnect(): void {
		if (this.currentStatus === "paired") {
			if (this.disconnectedAtMs === null) {
				this.disconnectedAtMs = this.now();
			}
		} else if (this.currentStatus === "pairing") {
			this.currentStatus = "unpaired";
		}
	}

	/**
	 * A reconnecting client presents a token to resume a `paired` session
	 * after a disconnect. Within the grace window and a matching token:
	 * resumes `paired` without re-pairing. Past the grace window: reverts to
	 * `unpaired` — the caller must re-pair from scratch
	 * (`beginPairingAttempt()` + `completePairing()`). A mismatched token
	 * inside the grace window is rejected but leaves the grace clock running,
	 * so a legitimate client can still retry.
	 */
	reconnect(presentedToken: string): ReconnectAttemptResult {
		if (this.currentStatus !== "paired" || this.disconnectedAtMs === null) {
			return { ok: false, status: this.currentStatus, reason: "not_paired" };
		}

		const elapsedMs = this.now() - this.disconnectedAtMs;
		if (elapsedMs > this.graceWindowMs) {
			this.currentStatus = "unpaired";
			this.disconnectedAtMs = null;
			return { ok: false, status: this.currentStatus, reason: "grace_expired" };
		}

		if (presentedToken !== this.token) {
			return { ok: false, status: this.currentStatus, reason: "invalid_token" };
		}

		this.disconnectedAtMs = null;
		return { ok: true, status: this.currentStatus };
	}
}
