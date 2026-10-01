// The two parts of `helpers/attach-journey.ts` that need no daemon, and that fail OPEN: a hand-maintained key list
// that drifts silently from the schema, and the only check able to see a spawn-only extra field at all.

import { describe, expect, test } from "bun:test";
import { AttachableSessionSchema } from "@draht/geist-protocol";
import { AttachJourneyError, assertFrozenRowShape, FROZEN_ROW_KEYS } from "./helpers/attach-journey.js";

/** A literal rather than a schema-built fixture, which would carry whatever keys the schema currently has. */
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
		expect([...FROZEN_ROW_KEYS] as string[]).toEqual(Object.keys(AttachableSessionSchema.shape));
	});

	test("the fixture row in this file is a row the schema actually accepts", () => {
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
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/row under test/);

		expect(() => AttachableSessionSchema.parse(row)).not.toThrow();
		expect(AttachableSessionSchema.parse(row)).not.toHaveProperty("spawnedBy");
		expect(() =>
			assertFrozenRowShape(AttachableSessionSchema.parse(row) as Record<string, unknown>, WHERE),
		).not.toThrow();
	});

	test("an extra key is rejected whether or not a pid is required", () => {
		const row = { ...liveRow(), harness: "claude" };
		expect(() => assertFrozenRowShape(row, { where: "history row", requirePid: false })).toThrow(/harness/);
	});

	test("rejects a missing pid when the caller says the row is live", () => {
		const { pid: _pid, ...row } = liveRow();
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(AttachJourneyError);
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/missing required key\(s\): pid/);
	});

	test("accepts a missing pid when the caller says it is a history row", () => {
		const { pid: _pid, ...row } = liveRow();
		expect(() => assertFrozenRowShape(row, { where: "history row", requirePid: false })).not.toThrow();
	});

	test("rejects a missing statusAt — the exemption stops at pid", () => {
		const { statusAt: _statusAt, ...row } = liveRow();
		expect(() => assertFrozenRowShape(row, WHERE)).toThrow(/missing required key\(s\): statusAt/);
		expect(() => assertFrozenRowShape(row, { where: "history row", requirePid: false })).toThrow(/statusAt/);
	});

	test("a null statusAt is PRESENT — the check is about keys, not truthiness", () => {
		expect(() => assertFrozenRowShape({ ...liveRow(), statusAt: null }, WHERE)).not.toThrow();
		expect(() => assertFrozenRowShape({ ...liveRow(), attachable: false, resumable: false }, WHERE)).not.toThrow();
	});

	test("names every missing key at once, not just the first", () => {
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
