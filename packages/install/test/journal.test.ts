import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJournal, openTransactions, readJournal } from "../src/journal.ts";
import { journalPath } from "../src/paths.ts";
import type { JournalEntry } from "../src/types.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "draht-install-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function entry(overrides: Partial<JournalEntry> & Pick<JournalEntry, "tx" | "seq" | "event">): JournalEntry {
	return { at: "2026-08-12T00:00:00.000Z", ...overrides };
}

describe("appendJournal / readJournal", () => {
	it("returns an empty, non-torn result for a missing journal file", () => {
		expect(readJournal(root)).toEqual({ entries: [], torn: false });
	});

	it("round-trips entries in append order", () => {
		appendJournal(root, entry({ tx: "tx-1", seq: 1, event: "planned" }));
		appendJournal(root, entry({ tx: "tx-1", seq: 2, event: "staged", detail: { componentId: "foo" } }));
		appendJournal(root, entry({ tx: "tx-1", seq: 3, event: "committed" }));

		const result = readJournal(root);

		expect(result.torn).toBe(false);
		expect(result.entries).toEqual([
			entry({ tx: "tx-1", seq: 1, event: "planned" }),
			entry({ tx: "tx-1", seq: 2, event: "staged", detail: { componentId: "foo" } }),
			entry({ tx: "tx-1", seq: 3, event: "committed" }),
		]);
	});

	it("tolerates a torn final line and reports torn: true", () => {
		appendJournal(root, entry({ tx: "tx-1", seq: 1, event: "planned" }));
		appendJournal(root, entry({ tx: "tx-1", seq: 2, event: "staged" }));
		// Simulate a crash mid-append: a partial line with no trailing newline.
		appendFileSync(journalPath(root), '{"tx":"tx-1","seq":3,"event":"back');

		const result = readJournal(root);

		expect(result.torn).toBe(true);
		expect(result.entries).toEqual([
			entry({ tx: "tx-1", seq: 1, event: "planned" }),
			entry({ tx: "tx-1", seq: 2, event: "staged" }),
		]);
	});

	it("throws for a malformed entry that is not the final line", () => {
		appendJournal(root, entry({ tx: "tx-1", seq: 1, event: "planned" }));
		appendFileSync(journalPath(root), "not json at all\n");
		appendJournal(root, entry({ tx: "tx-1", seq: 3, event: "committed" }));

		expect(() => readJournal(root)).toThrow(/malformed JSON/);
	});
});

describe("openTransactions", () => {
	it("reports transactions with no terminal event, and omits committed/rolled-back ones", () => {
		const entries: JournalEntry[] = [
			entry({ tx: "committed-tx", seq: 1, event: "planned" }),
			entry({ tx: "committed-tx", seq: 2, event: "committed" }),
			entry({ tx: "open-tx", seq: 1, event: "planned" }),
			entry({ tx: "open-tx", seq: 2, event: "staged" }),
			entry({ tx: "rolled-back-tx", seq: 1, event: "planned" }),
			entry({ tx: "rolled-back-tx", seq: 2, event: "rolled-back" }),
		];

		expect(openTransactions(entries)).toEqual(["open-tx"]);
	});

	it("returns an empty array when every transaction has a terminal event", () => {
		const entries: JournalEntry[] = [
			entry({ tx: "a", seq: 1, event: "committed" }),
			entry({ tx: "b", seq: 1, event: "rolled-back" }),
		];

		expect(openTransactions(entries)).toEqual([]);
	});
});
