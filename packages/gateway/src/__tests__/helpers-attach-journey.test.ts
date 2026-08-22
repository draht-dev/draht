/**
 * The frozen fleet-row shape, tested without a daemon.
 *
 * `helpers/attach-journey.ts` exists so that R36-SPAWN.8 — a session started from
 * the phone is INDISTINGUISHABLE from one the operator resumed — is proved by
 * running ONE script twice rather than by two suites that each hand-wrote their
 * own idea of the journey. Everything in that module except {@link FROZEN_ROW_KEYS}
 * and {@link assertFrozenRowShape} needs a live daemon, a socket and a real
 * session to exercise. These two do not, and they are the part that fails OPEN:
 *
 *   • the key list is a hand-maintained literal, so it drifts silently the moment
 *     somebody edits `AttachableSessionSchema` and not this file — and a drifted
 *     list still passes every acceptance suite that calls it, because the rows it
 *     is shown were built by the very schema it has stopped matching;
 *   • the shape check is the only thing in the journey that can see a spawn-only
 *     extra field at all, because `z.object` STRIPS unknown keys and the parsed
 *     row therefore arrives already cleaned.
 *
 * So this file pins both directly, with plain object literals, and — in the same
 * discipline as `helpers-process-table.test.ts` — shows the NAIVE form failing on
 * the same input: the schema-based check that a later simplification would reach
 * for accepts the exact row this one rejects.
 *
 * No daemon, no socket, no fixture, no timers. If this file is slow, something is
 * wrong with it.
 */

import { describe, expect, test } from "bun:test";
import { AttachableSessionSchema } from "@draht/geist-protocol";
import { AttachJourneyError, assertFrozenRowShape, FROZEN_ROW_KEYS } from "./helpers/attach-journey.js";

/**
 * A row carrying exactly the frozen key set, with plausible values.
 *
 * Written as a literal rather than produced by the schema on purpose: a fixture
 * built by `AttachableSessionSchema` could not fail the drift alarm below, since
 * it would carry whatever keys the schema currently has.
 */
function liveRow(): Record<string, unknown> {
	return {
		id: "sess-1",
		cwd: "/tmp/work",
		pid: 4242,
		startedAt: "2026-08-21T10:00:00.000Z",
		origin: "socket",
		attachable: true,
		resumable: true,
		status: "clean",
		statusAt: "2026-08-21T10:00:01.000Z",
	};
}

const WHERE = { where: "row under test", requirePid: true };

describe("FROZEN_ROW_KEYS is a drift alarm on AttachableSessionSchema", () => {
	test("lists exactly the schema's keys, in the schema's order", () => {
		// The alarm itself. The list is deliberately NOT derived from the schema —
		// deriving it would make "the row matches the schema" the assertion, which
		// passes the instant somebody adds a spawn-only field to the schema, i.e.
		// precisely the change R36-SPAWN.8 exists to notice. So the list is a
		// literal, and THIS test is what makes the literal honest: adding a key to
		// the schema without deciding, here, that the phone may see it fails.
		// `as string[]` widens the literal tuple only for the compiler; toEqual still
		// compares the runtime values, so the alarm is unchanged.
		expect([...FROZEN_ROW_KEYS] as string[]).toEqual(Object.keys(AttachableSessionSchema.shape));
	});

	test("the fixture row in this file is a row the schema actually accepts", () => {
		// Otherwise the cases below would be assertions about a shape that never
		// travels, and a "rejected" verdict would prove nothing about a real wire.
		expect(() => AttachableSessionSchema.parse(liveRow())).not.toThrow();
		expect(Object.keys(liveRow())).toEqual([...FROZEN_ROW_KEYS]);
	});
});

describe("assertFrozenRowShape", () => {
	test("accepts a complete live row", () => {
		expect(() => assertFrozenRowShape(liveRow(), WHERE)).not.toThrow();
	});

	test("rejects an extra key — the spawn-only field the requirement forbids", () => {
		const row = { ...liveRow(), spawnedBy: "phone" };
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(AttachJourneyError);
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/spawnedBy/);
		// The message must say WHERE, because the caller runs this journey twice
		// over two origins and has to know which run failed.
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/row under test/);

		// ── AND THE NAIVE FORM IS WRONG ABOUT THE SAME ROW ────────────────────
		// `z.object` strips unknown keys, so a check made against the PARSED value
		// — the obvious simplification — can never see the field. This is the whole
		// reason the check is made on raw JSON.
		expect(() => AttachableSessionSchema.parse(row)).not.toThrow();
		expect(AttachableSessionSchema.parse(row)).not.toHaveProperty("spawnedBy");
		expect(() =>
			assertFrozenRowShape(AttachableSessionSchema.parse(row) as Record<string, unknown>, WHERE),
		).not.toThrow();
	});

	test("an extra key is rejected whether or not a pid is required", () => {
		// `requirePid` relaxes ONE key's presence. It is not a general loophole.
		const row = { ...liveRow(), harness: "claude" };
		expect(() => assertFrozenRowShape(row, { where: "history row", requirePid: false })).toThrow(/harness/);
	});

	test("rejects a missing pid when the caller says the row is live", () => {
		const { pid: _pid, ...row } = liveRow();
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(AttachJourneyError);
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/missing required key\(s\): pid/);
	});

	test("accepts a missing pid when the caller says it is a history row", () => {
		// An `origin: "history"` row has no process, so a required `pid` could only
		// be satisfied by inventing one. That is the single exemption.
		const { pid: _pid, ...row } = liveRow();
		expect(() => assertFrozenRowShape(row, { where: "history row", requirePid: false })).not.toThrow();
	});

	test("rejects a missing statusAt — the exemption stops at pid", () => {
		const { statusAt: _statusAt, ...row } = liveRow();
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/missing required key\(s\): statusAt/);
		// Including on a history row, where the pid relaxation might be mistaken for
		// a general "some keys are optional".
		expect(() => assertFrozenRowShape(row, { where: "history row", requirePid: false })).toThrow(/statusAt/);
	});

	test("a null statusAt is PRESENT — the check is about keys, not truthiness", () => {
		// `statusAt` is nullable in the schema: null means the status was never
		// observed. A check written as `if (!raw.statusAt)` would reject every row
		// the daemon has not probed yet, which is most of them at startup.
		expect(() => assertFrozenRowShape({ ...liveRow(), statusAt: null }, WHERE)).not.toThrow();
		// Same argument for the falsy booleans: a history row is attachable:false.
		expect(() => assertFrozenRowShape({ ...liveRow(), attachable: false, resumable: false }, WHERE)).not.toThrow();
	});

	test("names every missing key at once, not just the first", () => {
		// A failure message that stops at the first hole makes a caller re-run the
		// whole journey per key.
		const { status: _status, statusAt: _statusAt, ...row } = liveRow();
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/status, statusAt/);
	});

	test("an empty object fails rather than passing for want of anything to object to", () => {
		expect(() => assertFrozenRowShape({}, WHERE)).toThrow(AttachJourneyError);
		for (const key of FROZEN_ROW_KEYS) {
			expect(() => assertFrozenRowShape({}, WHERE)).toThrow(new RegExp(`\\b${key}\\b`));
		}
	});
});
