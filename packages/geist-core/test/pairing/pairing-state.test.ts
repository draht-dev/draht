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

	test("token mismatch rejected — pairing attempt fails and reverts to unpaired", () => {
		const state = new PairingState({ token: "correct-token" });
		state.beginPairingAttempt();
		expect(state.status).toBe("pairing");

		const result = state.completePairing("wrong-token");

		expect(result).toEqual({ ok: false, status: "unpaired", reason: "invalid_token" });
		expect(state.status).toBe("unpaired");
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
});
