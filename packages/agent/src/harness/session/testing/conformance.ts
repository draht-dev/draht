import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import type { TextContent, Usage } from "@draht/ai";
import type { CompactionEntry, CustomEntry, Entry, MessageEntry, NewEntry, Register, Transaction } from "../types.ts";
import type { StorageConformanceCase, StorageFixture, StorageFixtureFactory } from "./types.ts";

const MESSAGE_TIMESTAMP = 1_650_000_000_000;

type ConformanceTest = (fixture: StorageFixture) => Promise<void>;

function createCase(
	factory: StorageFixtureFactory,
	group: string,
	name: string,
	test: ConformanceTest,
): StorageConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture);
		},
	};
}

function usage(input: number, output: number, options: { cacheWrite1h?: number; reasoning?: number } = {}): Usage {
	return {
		input,
		output,
		cacheRead: input + 1,
		cacheWrite: output + 1,
		...(options.cacheWrite1h === undefined ? {} : { cacheWrite1h: options.cacheWrite1h }),
		...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
		totalTokens: input + output,
		cost: {
			input: input / 100,
			output: output / 100,
			cacheRead: (input + 1) / 100,
			cacheWrite: (output + 1) / 100,
			total: (input + output + 2) / 100,
		},
	};
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userEntry(id: string, parentId: string | null = null, text = id): NewEntry<MessageEntry> {
	return {
		id,
		parentId,
		type: "message",
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: MESSAGE_TIMESTAMP,
		},
	};
}

function userEntryTextContent(entry: NewEntry<MessageEntry> | MessageEntry): TextContent {
	const { message } = entry;
	ok(message.role === "user");
	ok(Array.isArray(message.content));
	const content = message.content[0];
	ok(content?.type === "text");
	return content;
}

function setUserEntryText(entry: NewEntry<MessageEntry> | MessageEntry, text: string): void {
	const content = userEntryTextContent(entry);
	content.text = text;
}

function customEntry(
	id: string,
	parentId: string | null,
	customType = "note",
	data: CustomEntry["data"] = { id },
): NewEntry<CustomEntry> {
	return { id, parentId, type: "custom", customType, data };
}

function compactionEntry(id: string, parentId: string | null): NewEntry<CompactionEntry> {
	return {
		id,
		parentId,
		type: "compaction",
		summary: `summary:${id}`,
		retainedTail: [],
		tokensBefore: 10,
		fromHook: false,
	};
}

function ids(entries: readonly Entry[]): string[] {
	return entries.map((entry) => entry.id);
}

function assertStrictlyIncreasing(values: readonly number[]): void {
	for (let index = 1; index < values.length; index++) {
		ok(values[index - 1]! < values[index]!, `Expected ${values.join(", ")} to be strictly increasing`);
	}
}

function sortRegisters(registers: Register[]): Register[] {
	return [...registers].sort((left, right) => left.key.localeCompare(right.key));
}

/** Creates fresh, runner-independent cases for the durable Storage contract. */
export function createStorageConformance(factory: StorageFixtureFactory): readonly StorageConformanceCase[] {
	return [
		createCase(factory, "transactions", "commits mixed writes atomically in write order", async ({ storage }) => {
			const result = await storage.commit({
				writes: [
					{ kind: "entry", entry: userEntry("entry") },
					{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "session" },
					{
						kind: "usage",
						row: { id: "usage", usage: usage(2, 3), adjustment: false, entryId: "entry" },
					},
				],
			});

			strictEqual(result.seqs.length, 3);
			strictEqual(result.firstSeq, result.seqs[0]);
			assertStrictlyIncreasing(result.seqs);
			ok(Number.isSafeInteger(result.timestamp) && result.timestamp >= 0);
			deepStrictEqual(
				await storage.getEntries(["entry"]),
				new Map([["entry", { ...userEntry("entry"), seq: result.seqs[0], timestamp: result.timestamp }]]),
			);
			deepStrictEqual(await storage.getRegister("fact.name", ""), {
				namespace: "fact.name",
				key: "",
				value: "session",
				seq: result.seqs[1],
			});
			deepStrictEqual(await storage.scanUsage({ order: "asc" }), [
				{ id: "usage", seq: result.seqs[2], usage: usage(2, 3), adjustment: false, entryId: "entry" },
			]);
		}),

		createCase(
			factory,
			"transactions",
			"rolls back every store when a mixed transaction fails",
			async ({ storage }) => {
				await storage.commit({
					writes: [
						{ kind: "entry", entry: userEntry("root") },
						{ kind: "usage", row: { id: "taken", usage: usage(1, 1), adjustment: false } },
					],
				});
				const entriesBefore = await storage.scanEntries({ order: "asc" });
				const usageBefore = await storage.scanUsage({ order: "asc" });
				const statsBefore = await storage.getStats();

				await rejects(
					storage.commit({
						writes: [
							{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "transient" },
							{ kind: "entry", entry: customEntry("transient-entry", "root") },
							{ kind: "usage", row: { id: "transient-usage", usage: usage(5, 8), adjustment: true } },
							{ kind: "entry", entry: customEntry("taken", "root") },
						],
					}),
				);

				deepStrictEqual(await storage.scanEntries({ order: "asc" }), entriesBefore);
				deepStrictEqual(await storage.scanUsage({ order: "asc" }), usageBefore);
				deepStrictEqual(await storage.getStats(), statsBefore);
				strictEqual(await storage.getRegister("fact.name", ""), undefined);
			},
		),

		createCase(factory, "transactions", "enforces one shared entry and usage id namespace", async ({ storage }) => {
			await storage.commit({
				writes: [
					{ kind: "entry", entry: userEntry("existing-entry") },
					{ kind: "usage", row: { id: "existing-usage", usage: usage(1, 1), adjustment: false } },
				],
			});

			await rejects(
				storage.commit({
					writes: [{ kind: "usage", row: { id: "existing-entry", usage: usage(2, 2), adjustment: false } }],
				}),
			);
			await rejects(storage.commit({ writes: [{ kind: "entry", entry: customEntry("existing-usage", null) }] }));

			for (const [id, writes] of [
				[
					"entry-then-usage",
					[
						{ kind: "entry", entry: customEntry("entry-then-usage", null) },
						{
							kind: "usage",
							row: { id: "entry-then-usage", usage: usage(3, 3), adjustment: false },
						},
					],
				],
				[
					"usage-then-entry",
					[
						{
							kind: "usage",
							row: { id: "usage-then-entry", usage: usage(4, 4), adjustment: false },
						},
						{ kind: "entry", entry: customEntry("usage-then-entry", null) },
					],
				],
			] satisfies Array<[string, Transaction["writes"]]>) {
				await rejects(storage.commit({ writes }), `Expected duplicate id ${id} to reject`);
			}

			deepStrictEqual(ids(await storage.scanEntries({ order: "asc" })), ["existing-entry"]);
			deepStrictEqual(
				(await storage.scanUsage({ order: "asc" })).map((row) => row.id),
				["existing-usage"],
			);
		}),

		createCase(
			factory,
			"transactions",
			"resolves parents only from prior entries and earlier writes",
			async ({ storage }) => {
				await storage.commit({ writes: [{ kind: "entry", entry: userEntry("root") }] });
				await storage.commit({
					writes: [
						{ kind: "entry", entry: customEntry("child", "root") },
						{ kind: "entry", entry: customEntry("grandchild", "child") },
					],
				});
				deepStrictEqual(ids(await storage.scanBranch({ start: "grandchild", order: "oldestFirst" })), [
					"root",
					"child",
					"grandchild",
				]);

				await rejects(
					storage.commit({
						writes: [
							{ kind: "entry", entry: customEntry("before-parent", "later-parent") },
							{ kind: "entry", entry: customEntry("later-parent", "root") },
							{ kind: "register", op: "set", namespace: "fact.label", key: "before-parent", value: "transient" },
						],
					}),
				);
				await rejects(storage.commit({ writes: [{ kind: "entry", entry: customEntry("orphan", "missing") }] }));
				await storage.commit({
					writes: [{ kind: "usage", row: { id: "usage-is-not-parent", usage: usage(1, 1), adjustment: false } }],
				});
				await rejects(
					storage.commit({
						writes: [{ kind: "entry", entry: customEntry("usage-child", "usage-is-not-parent") }],
					}),
				);

				deepStrictEqual(
					await storage.getEntries(["before-parent", "later-parent", "orphan", "usage-child"]),
					new Map(),
				);
				strictEqual(await storage.getRegister("fact.label", "before-parent"), undefined);
			},
		),

		createCase(
			factory,
			"registers",
			"sets, replaces, deletes, and recreates registers without tombstones",
			async ({ storage }) => {
				const first = await storage.commit({
					writes: [
						{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/b", value: 1 },
						{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/a", value: 2 },
						{ kind: "register", op: "set", namespace: "fact.custom", key: "other", value: 3 },
						{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/a", value: null },
					],
				});
				deepStrictEqual(await storage.getRegister("fact.custom", "prefix/a"), {
					namespace: "fact.custom",
					key: "prefix/a",
					value: null,
					seq: first.seqs[3],
				});

				const second = await storage.commit({
					writes: [
						{ kind: "register", op: "delete", namespace: "fact.custom", key: "prefix/a" },
						{ kind: "register", op: "delete", namespace: "fact.custom", key: "absent" },
						{ kind: "register", op: "set", namespace: "fact.custom", key: "prefix/a", value: "recreated" },
					],
				});

				deepStrictEqual(sortRegisters(await storage.listRegisters("fact.custom", "prefix/")), [
					{ namespace: "fact.custom", key: "prefix/a", value: "recreated", seq: second.seqs[2] },
					{ namespace: "fact.custom", key: "prefix/b", value: 1, seq: first.seqs[0] },
				]);
				strictEqual(await storage.getRegister("fact.custom", "absent"), undefined);
			},
		),

		createCase(
			factory,
			"registers",
			"does not change historical stores during register-only commits",
			async ({ storage }) => {
				await storage.commit({
					writes: [
						{ kind: "entry", entry: userEntry("root") },
						{ kind: "usage", row: { id: "historical-usage", usage: usage(2, 3), adjustment: false } },
					],
				});
				const entriesBefore = await storage.scanEntries({ order: "asc" });
				const usageBefore = await storage.scanUsage({ order: "asc" });
				const statsBefore = await storage.getStats();

				const result = await storage.commit({
					writes: [
						{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "first" },
						{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "second" },
					],
				});

				deepStrictEqual(await storage.scanEntries({ order: "asc" }), entriesBefore);
				deepStrictEqual(await storage.scanUsage({ order: "asc" }), usageBefore);
				deepStrictEqual(await storage.getStats(), statsBefore);
				deepStrictEqual(await storage.getRegister("fact.name", ""), {
					namespace: "fact.name",
					key: "",
					value: "second",
					seq: result.seqs[1],
				});
			},
		),

		createCase(factory, "entry queries", "stores custom entries with and without data", async ({ storage }) => {
			const result = await storage.commit({
				writes: [
					{
						kind: "entry",
						entry: { id: "without-data", parentId: null, type: "custom", customType: "marker" },
					},
					{
						kind: "entry",
						entry: customEntry("with-data", "without-data", "note", { nested: [1, 2] }),
					},
				],
			});

			deepStrictEqual(
				await storage.getEntries(["without-data", "with-data"]),
				new Map([
					[
						"without-data",
						{
							id: "without-data",
							parentId: null,
							type: "custom",
							customType: "marker",
							seq: result.seqs[0],
							timestamp: result.timestamp,
						},
					],
					[
						"with-data",
						{
							...customEntry("with-data", "without-data", "note", { nested: [1, 2] }),
							seq: result.seqs[1],
							timestamp: result.timestamp,
						},
					],
				]),
			);
		}),

		createCase(
			factory,
			"entry queries",
			"scans global entries with explicit ranges, filters, orders, and limits",
			async ({ storage }) => {
				const result = await storage.commit({
					writes: [
						{ kind: "entry", entry: userEntry("root") },
						{ kind: "entry", entry: customEntry("note-1", "root", "note") },
						{ kind: "entry", entry: customEntry("other", "note-1", "other") },
						{ kind: "entry", entry: customEntry("note-2", "other", "note") },
						{ kind: "entry", entry: userEntry("tail", "note-2") },
					],
				});

				deepStrictEqual(
					ids(
						await storage.scanEntries({
							type: "custom",
							customType: "note",
							fromSeq: result.seqs[1],
							toSeq: result.seqs[3],
							order: "desc",
						}),
					),
					["note-2", "note-1"],
				);
				deepStrictEqual(ids(await storage.scanEntries({ order: "asc", limit: 2 })), ["root", "note-1"]);
				deepStrictEqual(ids(await storage.scanEntries({ order: "desc", limit: 2 })), ["tail", "note-2"]);
			},
		),

		createCase(
			factory,
			"branch queries",
			"applies stops before filters and cursors before limits",
			async ({ storage }) => {
				const result = await storage.commit({
					writes: [
						{ kind: "entry", entry: userEntry("root") },
						{ kind: "entry", entry: customEntry("marker", "root", "marker") },
						{ kind: "entry", entry: userEntry("middle", "marker") },
						{ kind: "entry", entry: compactionEntry("compact", "middle") },
						{ kind: "entry", entry: customEntry("note", "compact", "note") },
						{ kind: "entry", entry: userEntry("leaf", "note") },
					],
				});

				deepStrictEqual(
					ids(await storage.scanBranch({ start: "leaf", stopAtType: "compaction", type: "message" })),
					["leaf"],
				);
				deepStrictEqual(
					ids(
						await storage.scanBranch({
							start: "leaf",
							order: "oldestFirst",
							stopAtId: "middle",
							type: "custom",
						}),
					),
					["marker"],
				);
				deepStrictEqual(
					ids(
						await storage.scanBranch({
							start: "leaf",
							order: "newestFirst",
							cursor: { seq: result.seqs[4] },
							limit: 2,
						}),
					),
					["compact", "middle"],
				);
				deepStrictEqual(
					ids(
						await storage.scanBranch({
							start: "leaf",
							order: "oldestFirst",
							cursor: { seq: result.seqs[1] },
							limit: 2,
						}),
					),
					["middle", "compact"],
				);
				deepStrictEqual(ids(await storage.scanBranch({ start: "leaf", stopAtId: "leaf", type: "custom" })), []);
				deepStrictEqual(ids(await storage.scanBranch({ start: "leaf", customType: "note" })), ["note"]);
				await rejects(storage.scanBranch({ start: "missing" }));
			},
		),

		createCase(factory, "branch queries", "returns branch structure without payload fields", async ({ storage }) => {
			const result = await storage.commit({
				writes: [
					{ kind: "entry", entry: userEntry("root") },
					{ kind: "entry", entry: customEntry("child", "root", "note") },
				],
			});

			deepStrictEqual(await storage.scanBranchStructure({ start: "child", order: "oldestFirst" }), [
				{
					id: "root",
					parentId: null,
					seq: result.seqs[0],
					timestamp: result.timestamp,
					type: "message",
				},
				{
					id: "child",
					parentId: "root",
					seq: result.seqs[1],
					timestamp: result.timestamp,
					type: "custom",
					customType: "note",
				},
			]);
		}),

		createCase(
			factory,
			"usage and stats",
			"scans the usage ledger with explicit ranges, orders, and limits",
			async ({ storage }) => {
				const result = await storage.commit({
					writes: [
						{ kind: "usage", row: { id: "usage-1", usage: usage(1, 1), adjustment: false } },
						{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "sequence gap" },
						{ kind: "usage", row: { id: "usage-2", usage: usage(2, 2), adjustment: false } },
						{ kind: "usage", row: { id: "usage-3", usage: usage(3, 3), adjustment: true } },
					],
				});

				deepStrictEqual(
					(await storage.scanUsage({ fromSeq: result.seqs[1], toSeq: result.seqs[2], order: "asc" })).map(
						(row) => row.id,
					),
					["usage-2"],
				);
				deepStrictEqual(
					(await storage.scanUsage({ order: "desc", limit: 2 })).map((row) => row.id),
					["usage-3", "usage-2"],
				);
				deepStrictEqual(
					(await storage.scanUsage({ order: "asc", limit: 2 })).map((row) => row.id),
					["usage-1", "usage-2"],
				);
			},
		),

		createCase(
			factory,
			"usage and stats",
			"keeps stats equal to message count and ledger totals",
			async ({ storage }) => {
				deepStrictEqual(await storage.getStats(), { messageCount: 0, usage: zeroUsage() });

				const firstUsage = usage(2, 3, { cacheWrite1h: 4, reasoning: 1 });
				await storage.commit({
					writes: [
						{ kind: "entry", entry: userEntry("message") },
						{ kind: "usage", row: { id: "usage-1", usage: firstUsage, adjustment: false } },
					],
				});
				deepStrictEqual(await storage.getStats(), { messageCount: 1, usage: firstUsage });

				const secondUsage = usage(5, 7, { cacheWrite1h: 6, reasoning: 2 });
				await storage.commit({
					writes: [
						{ kind: "entry", entry: customEntry("custom", "message") },
						{ kind: "entry", entry: compactionEntry("compaction", "custom") },
						{ kind: "usage", row: { id: "usage-2", usage: secondUsage, adjustment: true } },
					],
				});
				deepStrictEqual(await storage.getStats(), {
					messageCount: 1,
					usage: {
						input: 7,
						output: 10,
						cacheRead: 9,
						cacheWrite: 12,
						cacheWrite1h: 10,
						reasoning: 3,
						totalTokens: 17,
						cost: {
							input: firstUsage.cost.input + secondUsage.cost.input,
							output: firstUsage.cost.output + secondUsage.cost.output,
							cacheRead: firstUsage.cost.cacheRead + secondUsage.cost.cacheRead,
							cacheWrite: firstUsage.cost.cacheWrite + secondUsage.cost.cacheWrite,
							total: firstUsage.cost.total + secondUsage.cost.total,
						},
					},
				});
			},
		),

		createCase(
			factory,
			"immutability",
			"detaches nested transaction inputs and read results",
			async ({ storage }) => {
				const entryData = { nested: { values: [1, 2] } };
				const messageEntry = userEntry("message", "entry", "original");
				const registerValue = { nested: [3, 4] };
				const details = { source: { name: "original" } };
				const transaction: Transaction = {
					writes: [
						{ kind: "entry", entry: customEntry("entry", null, "nested", entryData) },
						{ kind: "entry", entry: messageEntry },
						{ kind: "register", op: "set", namespace: "fact.custom", key: "object", value: registerValue },
						{ kind: "usage", row: { id: "usage", usage: usage(4, 5), adjustment: false, details } },
					],
				};
				await storage.commit(transaction);
				entryData.nested.values[0] = 99;
				setUserEntryText(messageEntry, "mutated input");
				registerValue.nested[0] = 99;
				details.source.name = "mutated";

				const messageMap = await storage.getEntries(["message"]);
				const readMessage = messageMap.get("message");
				ok(readMessage?.type === "message");
				setUserEntryText(readMessage, "mutated read");

				const entryMap = await storage.getEntries(["entry"]);
				const entry = entryMap.get("entry");
				ok(entry?.type === "custom");
				(entry.data as { nested: { values: number[] } }).nested.values[0] = 88;
				(entryMap as Map<string, Entry>).clear();
				const register = await storage.getRegister("fact.custom", "object");
				ok(register !== undefined);
				(register.value as { nested: number[] }).nested[0] = 88;
				const rows = await storage.scanUsage({ order: "asc" });
				(rows[0]!.details as { source: { name: string } }).source.name = "changed";
				rows[0]!.usage.input = 88;
				const scannedEntries = await storage.scanEntries({ order: "asc" });
				(scannedEntries[0] as CustomEntry).data = { replaced: true };
				const scannedMessage = scannedEntries.find((candidate) => candidate.id === "message");
				ok(scannedMessage?.type === "message");
				setUserEntryText(scannedMessage, "mutated scan");
				const branchEntries = await storage.scanBranch({ start: "entry" });
				(branchEntries[0] as CustomEntry).data = { replaced: true };
				const messageBranchEntries = await storage.scanBranch({ start: "message" });
				const branchMessage = messageBranchEntries.find((candidate) => candidate.id === "message");
				ok(branchMessage?.type === "message");
				setUserEntryText(branchMessage, "mutated branch");
				const structures = await storage.scanBranchStructure({ start: "entry" });
				structures[0]!.timestamp = 0;
				const stats = await storage.getStats();
				stats.usage.input = 88;

				deepStrictEqual((await storage.getEntries(["entry"])).get("entry"), {
					...customEntry("entry", null, "nested", { nested: { values: [1, 2] } }),
					seq: entry.seq,
					timestamp: entry.timestamp,
				});
				const storedMessage = (await storage.getEntries(["message"])).get("message");
				ok(storedMessage?.type === "message");
				strictEqual(userEntryTextContent(storedMessage).text, "original");
				deepStrictEqual(await storage.getRegister("fact.custom", "object"), {
					namespace: "fact.custom",
					key: "object",
					value: { nested: [3, 4] },
					seq: register.seq,
				});
				deepStrictEqual(await storage.scanUsage({ order: "asc" }), [
					{
						id: "usage",
						seq: rows[0]!.seq,
						usage: usage(4, 5),
						adjustment: false,
						details: { source: { name: "original" } },
					},
				]);
				deepStrictEqual((await storage.scanEntries({ order: "asc" }))[0]?.type, "custom");
				deepStrictEqual((await storage.scanBranch({ start: "entry" }))[0]?.type, "custom");
				strictEqual((await storage.scanBranchStructure({ start: "entry" }))[0]?.timestamp, entry.timestamp);
				strictEqual((await storage.getStats()).usage.input, 4);
			},
		),

		createCase(
			factory,
			"serialization",
			"serializes back-to-back commits in admission order",
			async ({ storage }) => {
				const first = storage.commit({ writes: [{ kind: "entry", entry: userEntry("first") }] });
				const second = storage.commit({ writes: [{ kind: "entry", entry: userEntry("second", "first") }] });
				const [firstResult, secondResult] = await Promise.all([first, second]);

				ok(firstResult.seqs[0]! < secondResult.seqs[0]!);
				deepStrictEqual(ids(await storage.scanEntries({ order: "asc" })), ["first", "second"]);
			},
		),

		createCase(
			factory,
			"lifecycle",
			"seals admission, drains admitted commits, and closes idempotently",
			async ({ storage }) => {
				const admitted = storage.commit({ writes: [{ kind: "entry", entry: userEntry("admitted") }] });
				const firstClose = storage.close();
				const secondClose = storage.close();

				await rejects(storage.getStats());
				await rejects(storage.commit({ writes: [] }));
				strictEqual((await admitted).seqs.length, 1);
				await Promise.all([firstClose, secondClose]);

				const rejectedReads = [
					storage.getEntries([]),
					storage.getRegister("fact.name", ""),
					storage.listRegisters("fact.name"),
					storage.scanBranch({ start: "admitted" }),
					storage.scanBranchStructure({ start: "admitted" }),
					storage.scanEntries({ order: "asc" }),
					storage.scanUsage({ order: "asc" }),
					storage.getStats(),
				];
				for (const read of rejectedReads) await rejects(read);
			},
		),
	];
}
