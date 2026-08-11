import type { Usage } from "@draht/ai";
import { describe, expect, it } from "vitest";
import { MemoryStorage, type NewEntry, type Transaction } from "../../src/harness/session/index.ts";

const NOW = 1_700_000_000_000;

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: input / 100, output: output / 100, cacheRead: 0, cacheWrite: 0, total: (input + output) / 100 },
	};
}

function messageEntry(id: string, parentId: string | null = null, text = id): NewEntry {
	return {
		id,
		parentId,
		type: "message",
		message: { role: "user", content: text, timestamp: NOW - 1 },
	};
}

function customEntry(id: string, parentId: string | null, customType: string): NewEntry {
	return { id, parentId, type: "custom", customType, data: { id } };
}

function compactionEntry(id: string, parentId: string | null): NewEntry {
	return {
		id,
		parentId,
		type: "compaction",
		summary: id,
		retainedTail: [],
		tokensBefore: 10,
		fromHook: false,
	};
}

describe("MemoryStorage", () => {
	it("commits entries, registers, and usage as one transaction", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const result = await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("entry") },
				{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "session" },
				{ kind: "usage", row: { id: "usage", usage: usage(2, 3), adjustment: false, entryId: "entry" } },
			],
		});

		expect(result).toEqual({ firstSeq: 1, seqs: [1, 2, 3], timestamp: NOW });
		expect(await storage.getEntries(["entry"])).toEqual(
			new Map([["entry", { ...messageEntry("entry"), seq: 1, timestamp: NOW }]]),
		);
		expect(await storage.getRegister("fact.name", "")).toEqual({
			namespace: "fact.name",
			key: "",
			value: "session",
			seq: 2,
		});
		expect(await storage.scanUsage({})).toEqual([
			{ id: "usage", seq: 3, usage: usage(2, 3), adjustment: false, entryId: "entry" },
		]);
	});

	it("rolls back every write when an entry or usage id already exists", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({ writes: [{ kind: "entry", entry: messageEntry("taken") }] });

		await expect(
			storage.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "must roll back" },
					{ kind: "usage", row: { id: "taken", usage: usage(1, 1), adjustment: true } },
				],
			}),
		).rejects.toThrow("Duplicate entry or usage id: taken");
		expect(await storage.getRegister("fact.name", "")).toBeUndefined();
		expect(await storage.scanUsage({})).toEqual([]);

		await expect(
			storage.commit({ writes: [{ kind: "entry", entry: messageEntry("after-rollback") }] }),
		).resolves.toEqual({ firstSeq: 2, seqs: [2], timestamp: NOW });
	});
	it("sets, replaces, deletes, and recreates registers without tombstones", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/b", value: 1 },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/a", value: 2 },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "other", value: 3 },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/a", value: null },
			],
		});
		await storage.commit({
			writes: [
				{ kind: "register", op: "delete", namespace: "fact.custom", key: "prefix/a" },
				{ kind: "register", op: "delete", namespace: "fact.custom", key: "absent" },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/a", value: "recreated" },
			],
		});

		expect(await storage.listRegisters("fact.custom", "prefix/")).toEqual([
			{ namespace: "fact.custom", key: "prefix/a", value: "recreated", seq: 7 },
			{ namespace: "fact.custom", key: "prefix/b", value: 1, seq: 1 },
		]);
		expect(await storage.getRegister("fact.custom", "absent")).toBeUndefined();
	});

	it("accepts parents inserted earlier in the transaction and rejects missing parents atomically", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("root") },
				{ kind: "entry", entry: messageEntry("child", "root") },
			],
		});
		expect([...(await storage.getEntries(["child"])).values()][0]?.parentId).toBe("root");

		await expect(
			storage.commit({
				writes: [
					{ kind: "entry", entry: messageEntry("orphan", "missing") },
					{ kind: "register", op: "set", namespace: "fact.label", key: "orphan", value: "rolled back" },
				],
			}),
		).rejects.toThrow("Missing parent entry: missing");
		expect(await storage.getEntries(["orphan"])).toEqual(new Map());
		expect(await storage.getRegister("fact.label", "orphan")).toBeUndefined();
	});

	it("scans global entries by inclusive sequence range, filters, order, and limit", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("root") },
				{ kind: "entry", entry: customEntry("note-1", "root", "note") },
				{ kind: "entry", entry: customEntry("other", "note-1", "other") },
				{ kind: "entry", entry: customEntry("note-2", "other", "note") },
				{ kind: "entry", entry: messageEntry("tail", "note-2") },
			],
		});

		expect(
			(await storage.scanEntries({ type: "custom", customType: "note", fromSeq: 2, toSeq: 4, order: "desc" })).map(
				(entry) => entry.id,
			),
		).toEqual(["note-2", "note-1"]);
		expect((await storage.scanEntries({ order: "asc", limit: 2 })).map((entry) => entry.id)).toEqual([
			"root",
			"note-1",
		]);
		expect((await storage.scanEntries({})).map((entry) => entry.id)).toEqual([
			"root",
			"note-1",
			"other",
			"note-2",
			"tail",
		]);
		expect(await storage.scanEntries({ limit: 0 })).toEqual([]);
	});

	it("scans a branch with inclusive stops before filters, exclusive cursors, ordering, and limits", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("root") },
				{ kind: "entry", entry: customEntry("marker", "root", "marker") },
				{ kind: "entry", entry: messageEntry("middle", "marker") },
				{ kind: "entry", entry: compactionEntry("compact", "middle") },
				{ kind: "entry", entry: customEntry("note", "compact", "note") },
				{ kind: "entry", entry: messageEntry("leaf", "note") },
			],
		});

		expect(
			(await storage.scanBranch({ start: "leaf", stopAtType: "compaction", type: "message" })).map(
				(entry) => entry.id,
			),
		).toEqual(["leaf"]);
		expect(
			(
				await storage.scanBranch({
					start: "leaf",
					order: "oldestFirst",
					stopAtId: "middle",
					type: "custom",
				})
			).map((entry) => entry.id),
		).toEqual(["marker"]);
		expect(
			(await storage.scanBranch({ start: "leaf", cursor: { seq: 5 }, order: "newestFirst", limit: 2 })).map(
				(entry) => entry.id,
			),
		).toEqual(["compact", "middle"]);
		expect(await storage.scanBranch({ start: "leaf", customType: "note" })).toMatchObject([{ id: "note" }]);
		await expect(storage.scanBranch({ start: "missing" })).rejects.toThrow("Unknown branch start: missing");
	});

	it("projects branch structure without entry payloads", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("root") },
				{ kind: "entry", entry: customEntry("child", "root", "note") },
			],
		});

		expect(await storage.scanBranchStructure({ start: "child", order: "oldestFirst" })).toEqual([
			{ id: "root", parentId: null, seq: 1, timestamp: NOW, type: "message" },
			{ id: "child", parentId: "root", seq: 2, timestamp: NOW, type: "custom", customType: "note" },
		]);
	});

	it("keeps stats equal to message entries and the complete usage ledger after every commit", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		expect(await storage.getStats()).toEqual({ messageCount: 0, usage: usage(0, 0) });

		const firstUsage = { ...usage(2, 3), cacheWrite1h: 4, reasoning: 1 };
		await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("message") },
				{ kind: "usage", row: { id: "usage-1", usage: firstUsage, adjustment: false } },
			],
		});
		expect(await storage.getStats()).toEqual({ messageCount: 1, usage: firstUsage });

		const secondUsage = { ...usage(5, 7), cacheWrite1h: 6, reasoning: 2 };
		await storage.commit({
			writes: [
				{ kind: "entry", entry: customEntry("custom", "message", "note") },
				{ kind: "usage", row: { id: "usage-2", usage: secondUsage, adjustment: true } },
				{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "unchanged totals" },
			],
		});
		expect(await storage.getStats()).toEqual({
			messageCount: 1,
			usage: {
				input: 7,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cacheWrite1h: 10,
				reasoning: 3,
				totalTokens: 17,
				cost: {
					input: firstUsage.cost.input + secondUsage.cost.input,
					output: firstUsage.cost.output + secondUsage.cost.output,
					cacheRead: 0,
					cacheWrite: 0,
					total: firstUsage.cost.total + secondUsage.cost.total,
				},
			},
		});
	});

	it("serializes reentrant commits in admission order", async () => {
		let storage: MemoryStorage;
		let secondCommit: ReturnType<MemoryStorage["commit"]> | undefined;
		let clockCalls = 0;
		storage = new MemoryStorage({
			now: () => {
				clockCalls++;
				if (clockCalls === 1) {
					secondCommit = storage.commit({ writes: [{ kind: "entry", entry: messageEntry("second") }] });
				}
				return NOW + clockCalls;
			},
		});

		const firstCommit = storage.commit({ writes: [{ kind: "entry", entry: messageEntry("first") }] });
		await expect(firstCommit).resolves.toEqual({ firstSeq: 1, seqs: [1], timestamp: NOW + 1 });
		await expect(secondCommit).resolves.toEqual({ firstSeq: 2, seqs: [2], timestamp: NOW + 2 });
		expect((await storage.scanEntries({ order: "asc" })).map((entry) => entry.id)).toEqual(["first", "second"]);
	});

	it("seals admission, drains admitted commits, and closes idempotently", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const admitted = storage.commit({ writes: [{ kind: "entry", entry: messageEntry("admitted") }] });
		const firstClose = storage.close();
		const secondClose = storage.close();

		await expect(storage.getStats()).rejects.toThrow("MemoryStorage is closed");
		await expect(storage.commit({ writes: [] })).rejects.toThrow("MemoryStorage is closed");
		await expect(admitted).resolves.toEqual({ firstSeq: 1, seqs: [1], timestamp: NOW });
		await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined]);

		const rejectedReads = [
			storage.getEntries([]),
			storage.getRegister("fact.name", ""),
			storage.listRegisters("fact.name"),
			storage.scanBranch({ start: "admitted" }),
			storage.scanBranchStructure({ start: "admitted" }),
			storage.scanEntries({}),
			storage.scanUsage({}),
			storage.getStats(),
		];
		await Promise.all(rejectedReads.map((read) => expect(read).rejects.toThrow("MemoryStorage is closed")));
	});

	it.each([
		[
			"entry then usage",
			[
				{ kind: "entry", entry: messageEntry("shared") },
				{ kind: "usage", row: { id: "shared", usage: usage(1, 1), adjustment: false } },
			],
		],
		[
			"usage then entry",
			[
				{ kind: "usage", row: { id: "shared", usage: usage(1, 1), adjustment: false } },
				{ kind: "entry", entry: messageEntry("shared") },
			],
		],
	] satisfies Array<[string, Transaction["writes"]]>)(
		"rejects duplicate ids in the shared entry and usage namespace: %s",
		async (_name, writes) => {
			const storage = new MemoryStorage({ now: () => NOW });
			await expect(storage.commit({ writes })).rejects.toThrow("Duplicate entry or usage id: shared");
			expect(await storage.getEntries(["shared"])).toEqual(new Map());
			expect(await storage.scanUsage({})).toEqual([]);
		},
	);

	it("scans usage by inclusive sequence range, order, and limit", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "usage", row: { id: "usage-1", usage: usage(1, 1), adjustment: false } },
				{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "sequence gap" },
				{ kind: "usage", row: { id: "usage-2", usage: usage(2, 2), adjustment: false } },
				{ kind: "usage", row: { id: "usage-3", usage: usage(3, 3), adjustment: true } },
			],
		});

		expect((await storage.scanUsage({ fromSeq: 2, toSeq: 3 })).map((row) => row.id)).toEqual(["usage-2"]);
		expect((await storage.scanUsage({ order: "desc", limit: 2 })).map((row) => row.id)).toEqual([
			"usage-3",
			"usage-2",
		]);
		expect((await storage.scanUsage({})).map((row) => row.id)).toEqual(["usage-1", "usage-2", "usage-3"]);
		expect(await storage.scanUsage({ limit: 0 })).toEqual([]);
	});

	it("detaches transaction inputs and every read result", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const transaction: Transaction = {
			writes: [
				{ kind: "entry", entry: messageEntry("entry", null, "original") },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "object", value: { nested: [1] } },
				{
					kind: "usage",
					row: { id: "usage", usage: usage(4, 5), adjustment: false, details: { source: "original" } },
				},
			],
		};
		const commit = storage.commit(transaction);
		const entryWrite = transaction.writes[0];
		if (entryWrite?.kind === "entry" && entryWrite.entry.type === "message") {
			entryWrite.entry.message.timestamp = 0;
		}
		const registerWrite = transaction.writes[1];
		if (
			registerWrite?.kind === "register" &&
			registerWrite.op === "set" &&
			registerWrite.namespace === "fact.custom"
		) {
			registerWrite.value = { nested: [999] };
		}
		const usageWrite = transaction.writes[2];
		if (usageWrite?.kind === "usage") {
			usageWrite.row.usage.input = 999;
			usageWrite.row.details = { source: "mutated" };
		}
		await commit;

		const entries = await storage.getEntries(["entry"]);
		const readEntry = entries.get("entry");
		if (readEntry?.type === "message") readEntry.message.timestamp = 0;
		(entries as Map<string, unknown>).clear();
		const register = await storage.getRegister("fact.custom", "object");
		if (register && typeof register.value === "object" && register.value !== null && !Array.isArray(register.value)) {
			register.value.nested = [999];
		}
		const registers = await storage.listRegisters("fact.custom");
		registers.length = 0;
		const rows = await storage.scanUsage({});
		rows[0]!.usage.input = 999;
		const scanned = await storage.scanEntries({});
		if (scanned[0]?.type === "message") scanned[0].message.timestamp = 0;
		const branch = await storage.scanBranch({ start: "entry" });
		if (branch[0]?.type === "message") branch[0].message.timestamp = 0;
		const structure = await storage.scanBranchStructure({ start: "entry" });
		structure[0]!.timestamp = 0;
		const stats = await storage.getStats();
		stats.usage.input = 999;

		const storedEntry = (await storage.getEntries(["entry"])).get("entry");
		expect(storedEntry?.type === "message" ? storedEntry.message.timestamp : undefined).toBe(NOW - 1);
		expect(await storage.getRegister("fact.custom", "object")).toMatchObject({ value: { nested: [1] } });
		expect(await storage.listRegisters("fact.custom")).toHaveLength(1);
		expect(await storage.scanUsage({})).toMatchObject([{ usage: { input: 4 } }]);
		expect(await storage.scanEntries({})).toMatchObject([{ timestamp: NOW }]);
		expect(await storage.getStats()).toMatchObject({ usage: { input: 4 } });
	});

	it("preserves historical stores across register-only commits", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("root") },
				{ kind: "usage", row: { id: "historical-usage", usage: usage(2, 3), adjustment: false } },
			],
		});
		const entriesBefore = await storage.scanEntries({});
		const usageBefore = await storage.scanUsage({});
		const statsBefore = await storage.getStats();

		await expect(
			storage.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "first" },
					{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "second" },
				],
			}),
		).resolves.toEqual({ firstSeq: 3, seqs: [3, 4], timestamp: NOW });

		expect(await storage.scanEntries({})).toEqual(entriesBefore);
		expect(await storage.scanUsage({})).toEqual(usageBefore);
		expect(await storage.getStats()).toEqual(statsBefore);
		expect(await storage.getRegister("fact.name", "")).toEqual({
			namespace: "fact.name",
			key: "",
			value: "second",
			seq: 4,
		});
	});

	it("isolates every store when a mixed transaction fails", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "entry", entry: messageEntry("root") },
				{ kind: "usage", row: { id: "taken", usage: usage(1, 1), adjustment: false } },
			],
		});
		const statsBefore = await storage.getStats();

		await expect(
			storage.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "must roll back" },
					{ kind: "entry", entry: messageEntry("transient", "root") },
					{ kind: "usage", row: { id: "transient-usage", usage: usage(5, 8), adjustment: true } },
					{ kind: "entry", entry: messageEntry("taken", "root") },
				],
			}),
		).rejects.toThrow("Duplicate entry or usage id: taken");

		expect(await storage.getRegister("fact.name", "")).toBeUndefined();
		expect(await storage.getEntries(["root", "transient"])).toEqual(
			new Map([["root", { ...messageEntry("root"), seq: 1, timestamp: NOW }]]),
		);
		expect((await storage.scanUsage({})).map((row) => row.id)).toEqual(["taken"]);
		expect(await storage.getStats()).toEqual(statsBefore);
		await expect(
			storage.commit({ writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "after" }] }),
		).resolves.toEqual({ firstSeq: 3, seqs: [3], timestamp: NOW });
	});
});
