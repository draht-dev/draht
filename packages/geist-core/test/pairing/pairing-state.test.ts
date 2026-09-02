import { describe, expect, test } from "bun:test";
import { DEFAULT_RECONNECT_GRACE_MS, generatePairingToken, PairingState } from "../../src/pairing/pairing-state.js";

/** Deterministic, manually-advanced clock for grace-window tests. */
function fakeClock(startMs = 0) {
	let current = startMs;
	return {
		now: () => current,
		advance: (byMs: number) => {
			current += byMs;
		},
	};
}

describe("generatePairingToken", () => {
	test("generates a non-empty random hex token, different each call", () => {
		const a = generatePairingToken();
		const b = generatePairingToken();
		expect(a).toMatch(/^[0-9a-f]+$/);
		expect(a.length).toBeGreaterThanOrEqual(16);
		expect(a).not.toBe(b);
	});
});

describe("PairingState", () => {
	test("starts unpaired with a token", () => {
		const state = new PairingState({ token: "secret-lan-token" });
		expect(state.status).toBe("unpaired");
		expect(state.token).toBe("secret-lan-token");
		expect(state.disconnectedAt).toBeNull();
	});

	test("token mismatch rejected — pairing attempt fails and mutates nothing", () => {
		const state = new PairingState({ token: "correct-token" });
		state.beginPairingAttempt();
		expect(state.status).toBe("pairing");

		const result = state.completePairing("wrong-token");

		// A failed pair is a no-op on shared state (GSEC-08): it neither pairs
		// nor tears the machine down behind whoever else is holding it.
		expect(result).toEqual({ ok: false, status: "pairing", reason: "invalid_token" });
		expect(state.status).toBe("pairing");
		expect(state.disconnectedAt).toBeNull();
	});

	test("successful pairing — matching token moves pairing -> paired", () => {
		const state = new PairingState({ token: "correct-token" });
		state.beginPairingAttempt();

		const result = state.completePairing("correct-token");

		expect(result).toEqual({ ok: true, status: "paired" });
		expect(state.status).toBe("paired");
		expect(state.disconnectedAt).toBeNull();
	});

	test("reconnect within grace succeeds — paired session resumes without re-pairing", () => {
		const clock = fakeClock(0);
		const state = new PairingState({ token: "correct-token", now: clock.now, graceWindowMs: 60_000 });
		state.beginPairingAttempt();
		state.completePairing("correct-token");

		state.disconnect();
		expect(state.status).toBe("paired");
		expect(state.disconnectedAt).toBe(0);

		clock.advance(30_000); // 30s < 60s grace window
		const result = state.reconnect("correct-token");

		expect(result).toEqual({ ok: true, status: "paired" });
		expect(state.status).toBe("paired");
		expect(state.disconnectedAt).toBeNull(); // resumed — grace clock cleared
	});

	test("reconnect past grace requires re-pairing — reverts to unpaired, stale token now rejected", () => {
		const clock = fakeClock(0);
		const state = new PairingState({ token: "correct-token", now: clock.now, graceWindowMs: 60_000 });
		state.beginPairingAttempt();
		state.completePairing("correct-token");
		state.disconnect();

		clock.advance(60_001); // just past the 60s grace window
		const result = state.reconnect("correct-token");

		expect(result).toEqual({ ok: false, status: "unpaired", reason: "grace_expired" });
		expect(state.status).toBe("unpaired");

		// A stale reconnect attempt is now meaningless — session must re-pair from scratch.
		const staleReconnect = state.reconnect("correct-token");
		expect(staleReconnect).toEqual({ ok: false, status: "unpaired", reason: "not_paired" });

		// Re-pairing from scratch works.
		state.beginPairingAttempt();
		const rePaired = state.completePairing("correct-token");
		expect(rePaired).toEqual({ ok: true, status: "paired" });
	});

	test("reconnect with wrong token during grace window is rejected but grace clock keeps running", () => {
		const clock = fakeClock(0);
		const state = new PairingState({ token: "correct-token", now: clock.now, graceWindowMs: 60_000 });
		state.beginPairingAttempt();
		state.completePairing("correct-token");
		state.disconnect();

		clock.advance(10_000);
		const result = state.reconnect("wrong-token");

		expect(result).toEqual({ ok: false, status: "paired", reason: "invalid_token" });
		// Still paired+disconnected — a legitimate client can retry within the window.
		expect(state.status).toBe("paired");
		expect(state.disconnectedAt).toBe(0);
	});

	test("reconnect before ever pairing is rejected as not_paired", () => {
		const state = new PairingState({ token: "correct-token" });
		const result = state.reconnect("correct-token");
		expect(result).toEqual({ ok: false, status: "unpaired", reason: "not_paired" });
	});

	test("a second disconnect while already disconnected does NOT reset the grace clock", () => {
		const clock = fakeClock(0);
		const state = new PairingState({ token: "correct-token", now: clock.now, graceWindowMs: 60_000 });
		state.beginPairingAttempt();
		state.completePairing("correct-token");

		// First disconnect at t=0 anchors the grace clock.
		state.disconnect();
		expect(state.disconnectedAt).toBe(0);

		// 40s into the 60s grace window, a stray socket opens then immediately
		// closes (a flaky/hostile client). This MUST NOT extend the window.
		clock.advance(40_000);
		state.disconnect();
		expect(state.disconnectedAt).toBe(0); // still anchored to the FIRST disconnect

		// Another 40s later (80s total, past the 60s grace) a reconnect must be
		// rejected: the grace expired at 60s from the first disconnect. If the
		// second disconnect had reset the clock, only 40s would have elapsed and
		// this would wrongly succeed.
		clock.advance(40_000);
		const result = state.reconnect("correct-token");
		expect(result).toEqual({ ok: false, status: "unpaired", reason: "grace_expired" });
		expect(state.status).toBe("unpaired");
	});

	test("disconnect during an incomplete pairing attempt reverts to unpaired", () => {
		const state = new PairingState({ token: "correct-token" });
		state.beginPairingAttempt();
		expect(state.status).toBe("pairing");

		state.disconnect();
		expect(state.status).toBe("unpaired");
	});

	test("default reconnect grace window is 60s", () => {
		expect(DEFAULT_RECONNECT_GRACE_MS).toBe(60_000);
	});

	test("a wrong-token completePairing leaves currentStatus untouched — a second socket's failed pair cannot move the shared state machine", () => {
		// GSEC-08 / R33-REACH.7: pairing is socket-scoped. A failed `pair`
		// arriving on a SECOND socket must not revoke, mutate or disturb the
		// already-bound device — not its status, and not the grace clock the
		// legitimate device is relying on to resume.
		const clock = fakeClock(0);
		const state = new PairingState({ token: "correct-token", now: clock.now, graceWindowMs: 60_000 });

		// The real headset pairs on socket A, then its app restarts: still
		// paired, grace clock anchored at t=0.
		state.beginPairingAttempt();
		state.completePairing("correct-token");
		state.disconnect();
		expect(state.status).toBe("paired");
		expect(state.disconnectedAt).toBe(0);

		// 10s into the window a second socket presents a wrong token.
		clock.advance(10_000);
		state.beginPairingAttempt(); // no-op while paired
		const result = state.completePairing("wrong-token");

		// Rejected — and nothing about the bound session moved.
		expect(result).toEqual({ ok: false, status: "paired", reason: "invalid_token" });
		expect(state.status).toBe("paired");
		expect(state.disconnectedAt).toBe(0); // grace clock untouched, not restarted

		// The real headset can still resume inside the original window.
		expect(state.reconnect("correct-token")).toEqual({ ok: true, status: "paired" });
		expect(state.status).toBe("paired");
	});

	test("a wrong-token completePairing mid-attempt leaves the attempt in `pairing` rather than tearing it down", () => {
		const state = new PairingState({ token: "correct-token" });
		state.beginPairingAttempt();

		const result = state.completePairing("wrong-token");

		expect(result).toEqual({ ok: false, status: "pairing", reason: "invalid_token" });
		expect(state.status).toBe("pairing");

		// The correct token still completes the same attempt.
		expect(state.completePairing("correct-token")).toEqual({ ok: true, status: "paired" });
	});

	test("token comparison rejects a same-length near-miss and a length-mismatched token alike", () => {
		const state = new PairingState({ token: "abcdef0123456789" });
		state.beginPairingAttempt();

		// Same length, one byte off — the case a timing oracle would leak.
		expect(state.completePairing("abcdef012345678a")).toEqual({
			ok: false,
			status: "pairing",
			reason: "invalid_token",
		});
		// A prefix of the real token must never be accepted.
		expect(state.completePairing("abcdef")).toEqual({ ok: false, status: "pairing", reason: "invalid_token" });
		// And an over-long superstring.
		expect(state.completePairing("abcdef0123456789extra")).toEqual({
			ok: false,
			status: "pairing",
			reason: "invalid_token",
		});
		expect(state.status).toBe("pairing");
	});
});
