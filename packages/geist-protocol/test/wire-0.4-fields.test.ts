/**
 * T2 — the geist/0.4 field surface, pinned.
 *
 * The 0.4 bump is one cliff on purpose: every 0.x member is mutually incompatible
 * and a 0.4 daemon hard-refuses a cached 0.3 renderer at `hello` with
 * `version_mismatch` + close 1008, so every field Phase 35 needs lands in ONE
 * version, ONE migration note and ONE corpus regeneration. This file holds the
 * SCHEMA half of that: what parses, what is refused, and which of the two the
 * value `"live"` is.
 *
 * WHAT THIS FILE DOES NOT COVER, so nobody mistakes it for coverage it is not:
 *
 *   - it is a schema test, not a transport test. It proves nothing about a daemon
 *     emitting these frames. The Class-3 evidence for that is the conformance
 *     corpus under `conformance/geist-0.4/`, recorded off two real processes by
 *     `bun scripts/generate-geist-conformance.mjs` and re-verified by
 *     `bun scripts/check-geist-protocol.mjs` — including a `fleet_delta` that is
 *     the real diff of two observations of a real socket directory.
 *   - it cannot see the socket-wire MIRROR. This package keeps zero `@draht/*`
 *     dependencies by contract, so `PermissionResolvedMessage.decision` in
 *     `packages/coding-agent/src/core/socket-server/types.ts` is unreachable from
 *     here. Clause C of `scripts/check-geist-protocol.mjs` is what fails when the
 *     two sides move apart, and it was mutated to confirm it really does.
 *   - it says nothing about whether any of this is PRODUCED. `origin`,
 *     `attachable`, `resumable` and `status` are computed by later tasks (T7),
 *     `fleet_delta` is emitted by T8, `session_resume` is answered by T11. Until
 *     then these fields are a shape the shipped daemon does not yet fill in.
 */

import { describe, expect, test } from "bun:test";
import {
	AttachableSessionSchema,
	CLIENT_FRAME_TYPES,
	DEFAULT_TRANSPORT_LIMITS,
	decodeClientFrame,
	decodeServerFrame,
	FleetDeltaFrameSchema,
	FleetFrameSchema,
	FleetResyncFrameSchema,
	GEIST_PROTOCOL_FAMILY,
	GEIST_PROTOCOL_VERSION,
	PermissionResolvedFrameSchema,
	SERVER_FRAME_TYPES,
	ServerHelloFrameSchema,
	SessionResumedFrameSchema,
	SessionResumeFrameSchema,
} from "../src/wire.js";

/** A live socket row: every 0.4 field present, `pid` among them. */
const socketSession = {
	id: "session-live",
	cwd: "/work/draht",
	pid: 4242,
	startedAt: "2026-08-22T09:00:00.000Z",
	origin: "socket" as const,
	attachable: true,
	resumable: true,
	status: "dirty" as const,
	statusAt: "2026-08-22T09:00:05.000Z",
};

/** A history row: no process, so NO `pid` — the field this bump made optional. */
const historySession = {
	id: "session-past",
	cwd: "/work/draht",
	startedAt: "2026-07-01T09:00:00.000Z",
	origin: "history" as const,
	attachable: false,
	resumable: true,
	status: "no_repo" as const,
	statusAt: null,
};

describe("the published member is 0.4", () => {
	test("GEIST_PROTOCOL_VERSION is 0.4 and the family did not move", () => {
		// The literal every renderer's `hello` is matched against. Moving it is the
		// whole cliff: a cached 0.3 renderer is refused here, not at the first field
		// it cannot find.
		expect(GEIST_PROTOCOL_VERSION).toBe("0.4");
		expect(GEIST_PROTOCOL_FAMILY).toBe("geist/0.x");
	});

	test("the four 0.4 message types are declared, in the direction each belongs to", () => {
		expect([...CLIENT_FRAME_TYPES]).toContain("fleet_resync");
		expect([...CLIENT_FRAME_TYPES]).toContain("session_resume");
		expect([...SERVER_FRAME_TYPES]).toContain("fleet_delta");
		expect([...SERVER_FRAME_TYPES]).toContain("session_resumed");
		// The two directions still share no type name, so a frame's direction is
		// never ambiguous from its `type` alone.
		expect(
			[...CLIENT_FRAME_TYPES].filter((type) => (SERVER_FRAME_TYPES as readonly string[]).includes(type)),
		).toEqual([]);
	});
});

describe("server_hello carries capabilities", () => {
	const base = {
		type: "server_hello" as const,
		protocol: GEIST_PROTOCOL_FAMILY,
		version: GEIST_PROTOCOL_VERSION,
		server: { name: "geist-daemon", version: "0.1.0" },
		limits: DEFAULT_TRANSPORT_LIMITS,
	};

	test("capabilities is REQUIRED — a server_hello without it is refused", () => {
		// Required rather than optional on purpose: "absent" would have to mean
		// "pre-0.4", and there is no pre-0.4 daemon that speaks 0.4. This is the
		// assertion that makes the next field addition cheap — a daemon that gains a
		// verb advertises the string here instead of bumping the version, so there is
		// no second hello-refusal cliff.
		expect(ServerHelloFrameSchema.safeParse(base).success).toBe(false);
		expect(ServerHelloFrameSchema.safeParse({ ...base, capabilities: [] }).success).toBe(true);
		expect(ServerHelloFrameSchema.safeParse({ ...base, capabilities: ["fleet-delta"] }).success).toBe(true);
	});

	test("the array is bounded in both length and element size", () => {
		expect(ServerHelloFrameSchema.safeParse({ ...base, capabilities: Array(33).fill("x") }).success).toBe(false);
		expect(ServerHelloFrameSchema.safeParse({ ...base, capabilities: ["x".repeat(65)] }).success).toBe(false);
		expect(ServerHelloFrameSchema.safeParse({ ...base, capabilities: ["x".repeat(64)] }).success).toBe(true);
	});
});

describe("AttachableSession — origin, attachable, resumable, status", () => {
	test("a history row WITHOUT a pid parses; pid is no longer required", () => {
		const parsed = AttachableSessionSchema.parse(historySession);
		expect(parsed).toEqual(historySession);
		expect("pid" in parsed).toBe(false);
	});

	test("a live socket row parses with its pid", () => {
		expect(AttachableSessionSchema.parse(socketSession)).toEqual(socketSession);
	});

	test('origin is "socket" or "history" — "live" is REFUSED', () => {
		// The drafting word. The phase acceptance names `origin:socket` and
		// `origin:history` verbatim, the corpus freezes those two strings, and a
		// renderer switches on them. If "live" ever parses, two vocabularies are on
		// the wire at once and every consumer has to handle both.
		expect(AttachableSessionSchema.safeParse({ ...socketSession, origin: "live" }).success).toBe(false);
		expect(AttachableSessionSchema.safeParse({ ...socketSession, origin: "socket" }).success).toBe(true);
		expect(AttachableSessionSchema.safeParse({ ...socketSession, origin: "history" }).success).toBe(true);
	});

	test("status is the quad-state, and nothing outside it", () => {
		for (const status of ["clean", "dirty", "no_repo", "unknown"]) {
			expect(AttachableSessionSchema.safeParse({ ...socketSession, status }).success).toBe(true);
		}
		// `no_repo` is its own value, not a flavour of `unknown`: on the machine this
		// was measured against it is the MAJORITY case. `unknown` is reserved for a
		// repo that exists and did not answer, and it must never collapse to `clean`.
		expect(AttachableSessionSchema.safeParse({ ...socketSession, status: "missing" }).success).toBe(false);
		expect(AttachableSessionSchema.safeParse({ ...socketSession, status: true }).success).toBe(false);
		expect(AttachableSessionSchema.safeParse({ ...socketSession, status: null }).success).toBe(false);
	});

	test("statusAt is a bounded string or null — never absent", () => {
		// Nullable, not optional. "Never observed" has to be SAID, because a status
		// with no timestamp is a claim about an unstated moment.
		expect(AttachableSessionSchema.safeParse({ ...socketSession, statusAt: null }).success).toBe(true);
		const { statusAt: _dropped, ...withoutStatusAt } = socketSession;
		expect(AttachableSessionSchema.safeParse(withoutStatusAt).success).toBe(false);
		expect(AttachableSessionSchema.safeParse({ ...socketSession, statusAt: "x".repeat(65) }).success).toBe(false);
	});

	test("attachable and resumable are carried separately, not derived", () => {
		// They can legitimately disagree in every combination, so neither may be
		// inferred from the other or from `origin`.
		expect(AttachableSessionSchema.safeParse({ ...socketSession, attachable: true, resumable: false }).success).toBe(
			true,
		);
		expect(
			AttachableSessionSchema.safeParse({ ...historySession, attachable: false, resumable: false }).success,
		).toBe(true);
		const { attachable: _a, ...withoutAttachable } = socketSession;
		expect(AttachableSessionSchema.safeParse(withoutAttachable).success).toBe(false);
		const { resumable: _r, ...withoutResumable } = socketSession;
		expect(AttachableSessionSchema.safeParse(withoutResumable).success).toBe(false);
	});
});

describe("fleet and fleet_delta are orderable on one connection", () => {
	const snapshot = { type: "fleet" as const, sessions: [socketSession, historySession], epoch: "e-1", seq: 0 };

	test("a fleet snapshot carries epoch and seq, and is refused without them", () => {
		expect(FleetFrameSchema.parse(snapshot)).toEqual(snapshot);
		const { epoch: _e, ...noEpoch } = snapshot;
		expect(FleetFrameSchema.safeParse(noEpoch).success).toBe(false);
		const { seq: _s, ...noSeq } = snapshot;
		expect(FleetFrameSchema.safeParse(noSeq).success).toBe(false);
		expect(FleetFrameSchema.safeParse({ ...snapshot, seq: -1 }).success).toBe(false);
		expect(FleetFrameSchema.safeParse({ ...snapshot, seq: 1.5 }).success).toBe(false);
	});

	test("a fleet_delta carries epoch and seq TOO, and is refused without either", () => {
		// The snapshot's pair was pinned above from the start; the delta's was pinned
		// by nothing, and making BOTH optional in the schema left this whole file
		// green. That is the ordering property of the entire delta design sitting on
		// the one frame that carries it, unasserted.
		//
		// Why it is not cosmetic: `fleet_delta`'s own doc comment says a gap in `seq`,
		// or an unseen `epoch`, means send `fleet_resync`. A renderer can only notice
		// a gap in a number that is always there. Absent `seq` is not "a delta with
		// less metadata" — it is a delta that cannot be ordered against the snapshot
		// it follows, so the resync that repairs the gap can never be triggered and
		// the renderer applies deltas in arrival order believing it is current.
		const delta = {
			type: "fleet_delta" as const,
			epoch: "e-1",
			seq: 4,
			changes: [{ kind: "disappeared", id: "session-live" }],
		};
		expect(FleetDeltaFrameSchema.parse(delta)).toEqual(delta);
		const { epoch: _e, ...noEpoch } = delta;
		expect(FleetDeltaFrameSchema.safeParse(noEpoch).success).toBe(false);
		const { seq: _s, ...noSeq } = delta;
		expect(FleetDeltaFrameSchema.safeParse(noSeq).success).toBe(false);
		// Both spellings a weakening takes: absent, and present-but-empty/undefined.
		// `.optional()` admits `undefined`, and an empty `epoch` is an identity no
		// observer run can own — neither may pass.
		expect(FleetDeltaFrameSchema.safeParse({ ...delta, epoch: undefined }).success).toBe(false);
		expect(FleetDeltaFrameSchema.safeParse({ ...delta, seq: undefined }).success).toBe(false);
		expect(FleetDeltaFrameSchema.safeParse({ ...delta, epoch: "" }).success).toBe(false);
		// `seq` is an ordering, so it is an integer and it never goes backwards past
		// zero — the same bounds the snapshot carries, because the two are compared.
		expect(FleetDeltaFrameSchema.safeParse({ ...delta, seq: -1 }).success).toBe(false);
		expect(FleetDeltaFrameSchema.safeParse({ ...delta, seq: 1.5 }).success).toBe(false);
		expect(FleetDeltaFrameSchema.safeParse({ ...delta, seq: "4" }).success).toBe(false);
		// …and it is refused at the BOUNDARY too, not merely by the schema in
		// isolation: an unorderable delta must never reach a renderer's reducer.
		expect(decodeServerFrame(JSON.stringify(noEpoch)).ok).toBe(false);
		expect(decodeServerFrame(JSON.stringify(noSeq)).ok).toBe(false);
	});

	test("appeared and changed carry the FULL session body — an id alone is refused", () => {
		// The property the whole delta design rests on. Resuming a session reuses the
		// SAME id with a NEW pid and startedAt, so the ordinary trace across a resume
		// is disappeared(X) then appeared(X). A client that coalesces on id, or merges
		// instead of replacing, renders the dead pid — and the only thing standing
		// between that and the schema is that an `appeared` cannot be spelled with an
		// id in the first place.
		const appeared = {
			type: "fleet_delta" as const,
			epoch: "e-1",
			seq: 1,
			changes: [{ kind: "appeared", session: socketSession }],
		};
		expect(FleetDeltaFrameSchema.parse(appeared)).toEqual(appeared);
		expect(
			FleetDeltaFrameSchema.safeParse({ ...appeared, changes: [{ kind: "appeared", id: socketSession.id }] })
				.success,
		).toBe(false);
		expect(
			FleetDeltaFrameSchema.safeParse({ ...appeared, changes: [{ kind: "changed", id: socketSession.id }] }).success,
		).toBe(false);
		// …and a PARTIAL body is refused for both kinds, so "full" means full. Asserted
		// per kind on purpose: they are two separate members of the union, and a
		// weakening applied to one of them is invisible to an assertion about the other.
		for (const kind of ["appeared", "changed"]) {
			expect(
				FleetDeltaFrameSchema.safeParse({
					...appeared,
					changes: [{ kind, session: { id: socketSession.id, pid: 9 } }],
				}).success,
			).toBe(false);
			expect(FleetDeltaFrameSchema.safeParse({ ...appeared, changes: [{ kind, session: {} }] }).success).toBe(false);
			// Every field the fleet projection added in 0.4 is load-bearing: a body that
			// drops any one of them is not a body a renderer can replace a row with.
			for (const field of ["origin", "attachable", "resumable", "status", "statusAt"]) {
				const { [field as keyof typeof socketSession]: _dropped, ...missing } = socketSession;
				expect(
					FleetDeltaFrameSchema.safeParse({ ...appeared, changes: [{ kind, session: missing }] }).success,
				).toBe(false);
			}
		}
	});

	test("disappeared carries an id and nothing else is required", () => {
		const gone = {
			type: "fleet_delta" as const,
			epoch: "e-1",
			seq: 2,
			changes: [{ kind: "disappeared", id: "session-live" }],
		};
		expect(FleetDeltaFrameSchema.parse(gone)).toEqual(gone);
		expect(
			FleetDeltaFrameSchema.safeParse({ ...gone, changes: [{ kind: "disappeared", session: socketSession }] })
				.success,
		).toBe(false);
	});

	test("the changes array is non-empty and bounded, and an undeclared kind is refused", () => {
		const base = { type: "fleet_delta" as const, epoch: "e-1", seq: 3 };
		expect(FleetDeltaFrameSchema.safeParse({ ...base, changes: [] }).success).toBe(false);
		expect(
			FleetDeltaFrameSchema.safeParse({ ...base, changes: Array(257).fill({ kind: "disappeared", id: "x" }) })
				.success,
		).toBe(false);
		expect(FleetDeltaFrameSchema.safeParse({ ...base, changes: [{ kind: "moved", id: "x" }] }).success).toBe(false);
	});
});

describe("fleet_resync and session_resume", () => {
	test("fleet_resync is a bare verb, and undeclared fields do not ride along", () => {
		expect(FleetResyncFrameSchema.parse({ type: "fleet_resync" })).toEqual({ type: "fleet_resync" });
		// Dropped, not refused — deliberately. Every frame on this wire strips unknown
		// keys (see `decode`); refusing instead would answer a renderer that sent one
		// extra field with `invalid_frame` and close 1008, which kills the phone for a
		// field nobody read. What matters is that nothing extra survives the boundary.
		const smuggled = decodeClientFrame(JSON.stringify({ type: "fleet_resync", sessions: ["*"], filter: "all" }));
		expect(smuggled.ok).toBe(true);
		if (smuggled.ok) expect(smuggled.frame).toEqual({ type: "fleet_resync" });
	});

	test("session_resume carries an id and NOTHING else survives decoding", () => {
		// This is what keeps resume off the arbitrary-execution surface: a path, an
		// argv or an environment named by the caller is gone before the daemon sees
		// the frame, so the worst a caller can name is a session that exists or one
		// that does not.
		const resume = { type: "session_resume" as const, sessionId: "session-past" };
		expect(SessionResumeFrameSchema.parse(resume)).toEqual(resume);
		const smuggled = decodeClientFrame(
			JSON.stringify({ ...resume, command: ["/bin/sh", "-c", "touch $CANARY"], cwd: "/", env: { PATH: "/tmp" } }),
		);
		expect(smuggled.ok).toBe(true);
		if (smuggled.ok) expect(smuggled.frame).toEqual(resume);
		expect(SessionResumeFrameSchema.safeParse({ type: "session_resume" }).success).toBe(false);
		expect(SessionResumeFrameSchema.safeParse({ type: "session_resume", sessionId: "" }).success).toBe(false);
		expect(SessionResumeFrameSchema.safeParse({ type: "session_resume", sessionId: "x".repeat(129) }).success).toBe(
			false,
		);
	});

	test("session_resumed carries ok, a closed-set code and safe text", () => {
		const answer = {
			type: "session_resumed" as const,
			sessionId: "session-past",
			ok: true,
			code: "resumed" as const,
			message: "started as pid 5150",
		};
		expect(SessionResumedFrameSchema.parse(answer)).toEqual(answer);
		for (const code of [
			"resumed",
			"already_live",
			"not_found",
			"cwd_missing",
			"refused",
			"spawn_failed",
			"timeout",
		]) {
			expect(SessionResumedFrameSchema.safeParse({ ...answer, ok: false, code }).success).toBe(true);
		}
		expect(SessionResumedFrameSchema.safeParse({ ...answer, code: "maybe" }).success).toBe(false);
		// `ok` is carried rather than inferred from the code, so a code added later
		// cannot silently read as a success.
		const { ok: _ok, ...withoutOk } = answer;
		expect(SessionResumedFrameSchema.safeParse(withoutOk).success).toBe(false);
		// `message` quotes paths and errnos, so it is neutralized like every other
		// attacker-influenceable string here: a bidi override in it is refused.
		expect(SessionResumedFrameSchema.safeParse({ ...answer, message: "spawn ‮failed" }).success).toBe(false);
		expect(SessionResumedFrameSchema.safeParse({ ...answer, message: "x".repeat(513) }).success).toBe(false);
	});

	test("both new client verbs decode in the client direction and nowhere else", () => {
		expect(decodeClientFrame(JSON.stringify({ type: "fleet_resync" })).ok).toBe(true);
		expect(decodeServerFrame(JSON.stringify({ type: "fleet_resync" })).ok).toBe(false);
		expect(
			decodeServerFrame(
				JSON.stringify({ type: "fleet_delta", epoch: "e", seq: 0, changes: [{ kind: "disappeared", id: "x" }] }),
			).ok,
		).toBe(true);
		expect(
			decodeClientFrame(
				JSON.stringify({ type: "fleet_delta", epoch: "e", seq: 0, changes: [{ kind: "disappeared", id: "x" }] }),
			).ok,
		).toBe(false);
	});
});

describe("permission_resolved gains the neutral member", () => {
	const resolved = {
		type: "permission_resolved" as const,
		requestId: "req-1",
		decision: "answered" as const,
		chosenOptionId: "opt-next",
		surface: "tui",
		clientId: null,
	};

	test('decision accepts "answered", the word an answered select had no way to say', () => {
		// Phase 34's recorded debt (ROADMAP.md, "Owner: whoever next opens the wire").
		// Without this member a `select` carrying a `tool_permission` detail was
		// recorded `cancelled` — false, the ask was answered and its command ran — or
		// `approved` — false, nobody granted anything — and with such a detail
		// attached the false word reached the DURABLE audit row.
		expect(PermissionResolvedFrameSchema.parse(resolved)).toEqual(resolved);
	});

	test("the five members are exactly the five, and nothing else parses", () => {
		for (const decision of ["approved", "denied", "cancelled", "expired", "answered"]) {
			expect(PermissionResolvedFrameSchema.safeParse({ ...resolved, decision }).success).toBe(true);
		}
		expect(PermissionResolvedFrameSchema.safeParse({ ...resolved, decision: "allowed" }).success).toBe(false);
		expect(PermissionResolvedFrameSchema.safeParse({ ...resolved, decision: "answered " }).success).toBe(false);
	});

	test("an answered resolution still carries the choice that was made", () => {
		// `answered` GRANTS NOTHING — it is neutral, not permissive — so the whole of
		// what it means is which option was chosen, and that travels in
		// `chosenOptionId`. It stays nullable because `cancelled` and `expired` chose
		// nothing.
		expect(PermissionResolvedFrameSchema.safeParse({ ...resolved, chosenOptionId: null }).success).toBe(true);
		const { chosenOptionId: _c, ...withoutChoice } = resolved;
		expect(PermissionResolvedFrameSchema.safeParse(withoutChoice).success).toBe(false);
	});
});
