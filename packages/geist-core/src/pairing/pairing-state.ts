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
 *   pairing  --completePairing(token) [mismatch]--> pairing (no-op; see below)
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

/**
 * Timing-safe byte-level string comparison.
 *
 * Compares in constant time relative to the length of `expected`, so the
 * number of matching leading bytes is not observable through response
 * latency — a client that can retry a `pair` frame cheaply must not be able
 * to walk the pairing token out one byte at a time. Always consumes all
 * bytes of `expected`, whatever `actual` looks like.
 *
 * A deliberate local copy of the identically-shaped guard in
 * `@draht/gateway`'s auth middleware rather than an import: the geist family
 * may import only its non-privileged geist siblings (R31-FOUND.4, enforced
 * by `scripts/check-geist-boundary.mjs`), and node's `crypto.timingSafeEqual`
 * throws on a length mismatch — which is exactly the case an attacker
 * controls.
 *
 * @param actual   - The token presented by the client.
 * @param expected - The secret token this session expects.
 * @returns `true` only when both strings are identical.
 */
function timingSafeEqual(actual: string, expected: string): boolean {
	const encoder = new TextEncoder();
	const a = encoder.encode(actual);
	const b = encoder.encode(expected);

	if (a.length !== b.length) {
		// Still iterate `b` to consume time constant in the expected length,
		// then reject.
		let _dummy = 0;
		for (let i = 0; i < b.length; i++) {
			_dummy |= b[i]!;
		}
		return false;
	}

	let mismatch = 0;
	for (let i = 0; i < b.length; i++) {
		mismatch |= a[i]! ^ b[i]!;
	}
	return mismatch === 0;
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
	 * token: `pairing -> paired`.
	 *
	 * Mismatched token: rejected as a pure no-op — the status and the grace
	 * clock are left exactly as they were. This is GSEC-08 / R33-REACH.7:
	 * pairing is socket-scoped, and this object is shared by every socket on
	 * the listener. The previous behaviour reset `currentStatus` to
	 * `"unpaired"` on a mismatch, which let ANY second socket revoke an
	 * already-bound device by presenting one wrong token — knocking the real
	 * headset out of `paired` (and, mid-grace, out of its reconnect window)
	 * without ever holding a credential. A failed attempt therefore leaves a
	 * half-open attempt in `pairing` and a bound session in `paired`; the
	 * caller may retry with the right token, and `disconnect()` is what tears
	 * down an abandoned attempt.
	 *
	 * The comparison is timing-safe: see {@link timingSafeEqual}.
	 */
	completePairing(presentedToken: string): PairingAttemptResult {
		if (!timingSafeEqual(presentedToken, this.token)) {
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

		if (!timingSafeEqual(presentedToken, this.token)) {
			return { ok: false, status: this.currentStatus, reason: "invalid_token" };
		}

		this.disconnectedAtMs = null;
		return { ok: true, status: this.currentStatus };
	}
}
