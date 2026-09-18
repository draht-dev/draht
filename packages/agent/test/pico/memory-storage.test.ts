import type { JsonValue } from "@draht/chord";
import { BACKGROUND_CONTEXT } from "@draht/chord/context";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/pico/memory-storage.ts";
import {
	type EntryRecord,
	type Id,
	type Input,
	ROOT_CONVERSATION_ID,
	type StorageWrite,
	type TaskRecord,
} from "../../src/pico/types.ts";

const context = BACKGROUND_CONTEXT;
type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

async function createRoot(storage: MemoryStorage): Promise<Id> {
	await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
	return ROOT_CONVERSATION_ID;
}

function pendingTask(id: Id, conversationId: Id, phase = "ready"): StoredTask {
	return {
		id,
		conversationId,
		kind: "test.task",
		version: 1,
		input: { value: id },
		state: { status: "pending", checkpoint: { phase } },
		after: [],
		background: false,
		abortRequested: false,
	};
}

function entry(id: Id, conversationId: Id, kind = "message", extra: Partial<EntryRecord> = {}): EntryRecord {
	return { id, conversationId, kind, ...extra };
}

describe("Pico MemoryStorage", () => {
	it("reserves ID 1 for the immutable root conversation", async () => {
		const storage = new MemoryStorage();
		expect(storage.mintId()).toBe(2);
		await expect(createRoot(storage)).resolves.toBe(ROOT_CONVERSATION_ID);
		expect(await storage.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
		await expect(
			storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context),
		).rejects.toThrow(`ID ${ROOT_CONVERSATION_ID} already belongs to conversation`);
	});

	it("commits mixed table writes atomically and rolls all of them back on failure", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const entryId = storage.mintId();
		const taskId = storage.mintId();
		const inputId = storage.mintId();
		const task = pendingTask(taskId, rootId);
		const input: Input = {
			id: inputId,
			conversationId: rootId,
			requestId: "request-1",
			status: "placed",
			entry: entryId,
		};
		const initialSeq = await storage.commit(
			[
				{ type: "entry", value: entry(entryId, rootId, "user", { data: { text: "hello" } }) },
				{ type: "task", value: task },
				{ type: "input", value: input },
			],
			context,
		);

		expect(await storage.entries([entryId], context)).toEqual(
			new Map([[entryId, entry(entryId, rootId, "user", { data: { text: "hello" } })]]),
		);
		expect(await storage.task(taskId, context)).toEqual(task);
		expect(await storage.input(inputId, context)).toEqual(input);

		const transientEntryId = storage.mintId();
		const runningTask: StoredTask = {
			...task,
			state: { status: "running", checkpoint: { phase: "effect" } },
		};
		const doneInput: Input = { ...input, status: "done", answer: transientEntryId };
		await expect(
			storage.commit(
				[
					{ type: "task", value: runningTask },
					{ type: "input", value: doneInput },
					{ type: "entry", value: entry(transientEntryId, rootId, "assistant") },
					{ type: "conversation", value: { id: rootId } },
				],
				context,
			),
		).rejects.toThrow(`ID ${rootId} already belongs to conversation`);

		expect(await storage.task(taskId, context)).toEqual(task);
		expect(await storage.input(inputId, context)).toEqual(input);
		expect(await storage.entries([transientEntryId], context)).toEqual(new Map());
		expect(await storage.entryCommit(transientEntryId, context)).toBeUndefined();
		expect(
			await storage.commit([{ type: "entry", value: entry(storage.mintId(), rootId, "after-rollback") }], context),
		).toBe(initialSeq + 1);
	});

	it("detaches retained writes and every returned record", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const entryId = storage.mintId();
		const taskId = storage.mintId();
		const inputId = storage.mintId();
		const entryData = { nested: [1, 2] };
		const checkpoint = { phase: "ready", nested: { count: 1 } };
		const detail = { codes: ["initial"] };
		const storedEntry = entry(entryId, rootId, "note", { data: entryData });
		const storedTask: StoredTask = {
			...pendingTask(taskId, rootId),
			state: { status: "pending", checkpoint },
		};
		const storedInput: Input = {
			id: inputId,
			conversationId: rootId,
			status: "unanswered",
			reason: "failed",
			detail,
		};
		await storage.commit(
			[
				{ type: "entry", value: storedEntry },
				{ type: "task", value: storedTask },
				{ type: "input", value: storedInput },
			],
			context,
		);

		entryData.nested.push(3);
		checkpoint.nested.count = 2;
		detail.codes.push("mutated");
		expect((await storage.entries([entryId], context)).get(entryId)?.data).toEqual({ nested: [1, 2] });
		expect((await storage.task(taskId, context))?.state).toEqual({
			status: "pending",
			checkpoint: { phase: "ready", nested: { count: 1 } },
		});
		expect((await storage.input(inputId, context))?.detail).toEqual({ codes: ["initial"] });

		const readEntry = (await storage.entries([entryId], context)).get(entryId)!;
		(readEntry.data as { nested: number[] }).nested.push(9);
		const readTask = (await storage.task(taskId, context))!;
		if (readTask.state.status !== "terminal") {
			(readTask.state.checkpoint as { phase: string; nested: { count: number } }).nested.count = 9;
		}
		const readInput = (await storage.input(inputId, context))!;
		(readInput.detail as { codes: string[] }).codes.push("read mutation");

		expect((await storage.entries([entryId], context)).get(entryId)?.data).toEqual({ nested: [1, 2] });
		expect((await storage.task(taskId, context))?.state).toEqual({
			status: "pending",
			checkpoint: { phase: "ready", nested: { count: 1 } },
		});
		expect((await storage.input(inputId, context))?.detail).toEqual({ codes: ["initial"] });
	});

	it("paginates conversations by opaque cursor in ascending ID order", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const secondId = storage.mintId();
		const thirdId = storage.mintId();
		await storage.commit(
			[
				{ type: "conversation", value: { id: secondId } },
				{ type: "conversation", value: { id: thirdId } },
			],
			context,
		);

		const first = await storage.scanConversations(undefined, 2, context);
		expect(first.items.map(({ id }) => id)).toEqual([rootId, secondId]);
		expect(first.next).toEqual({ after: secondId });
		const second = await storage.scanConversations(first.next, 2, context);
		expect(second.items.map(({ id }) => id)).toEqual([thirdId]);
		expect(second.next).toBeUndefined();
	});

	it("scans deep fork history newest-first through every ancestor cap", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const rootFirst = storage.mintId();
		const rootForkPoint = storage.mintId();
		const rootExcludedSameCommit = storage.mintId();
		const rootEntriesSeq = await storage.commit(
			[
				{ type: "entry", value: entry(rootFirst, rootId) },
				{
					type: "entry",
					value: entry(rootForkPoint, rootId, "marker", { head: rootFirst }),
				},
				{ type: "entry", value: entry(rootExcludedSameCommit, rootId) },
			],
			context,
		);
		const childId = storage.mintId();
		await storage.commit(
			[
				{
					type: "conversation",
					value: { id: childId, parent: { conversationId: rootId, at: rootForkPoint } },
				},
			],
			context,
		);
		const childForkPoint = storage.mintId();
		const childExcluded = storage.mintId();
		await storage.commit(
			[
				{ type: "entry", value: entry(childForkPoint, childId, "note") },
				{ type: "entry", value: entry(childExcluded, childId) },
			],
			context,
		);
		const rootExcludedLater = storage.mintId();
		await storage.commit([{ type: "entry", value: entry(rootExcludedLater, rootId) }], context);
		const grandchildId = storage.mintId();
		await storage.commit(
			[
				{
					type: "conversation",
					value: { id: grandchildId, parent: { conversationId: childId, at: childForkPoint } },
				},
			],
			context,
		);
		const grandchildHead = storage.mintId();
		const grandchildTail = storage.mintId();
		const grandchildEntriesSeq = await storage.commit(
			[
				{
					type: "entry",
					value: entry(grandchildHead, grandchildId, "marker", { head: grandchildHead }),
				},
				{ type: "entry", value: entry(grandchildTail, grandchildId) },
			],
			context,
		);
		const childExcludedLater = storage.mintId();
		await storage.commit([{ type: "entry", value: entry(childExcludedLater, childId) }], context);

		const first = await storage.scanEntries({ conversationId: grandchildId }, undefined, 2, context);
		expect(first.items.map(({ id }) => id)).toEqual([grandchildTail, grandchildHead]);
		const second = await storage.scanEntries({ conversationId: grandchildId }, first.next, 2, context);
		expect(second.items.map(({ id }) => id)).toEqual([childForkPoint, rootForkPoint]);
		const third = await storage.scanEntries({ conversationId: grandchildId }, second.next, 2, context);
		expect(third.items.map(({ id }) => id)).toEqual([rootFirst]);
		expect(third.next).toBeUndefined();

		expect(
			(
				await storage.scanEntries({ conversationId: grandchildId, before: grandchildHead }, undefined, 10, context)
			).items.map(({ id }) => id),
		).toEqual([childForkPoint, rootForkPoint, rootFirst]);
		expect(
			(
				await storage.scanEntries({ conversationId: grandchildId, kind: "marker" }, undefined, 10, context)
			).items.map(({ id }) => id),
		).toEqual([grandchildHead, rootForkPoint]);
		expect(
			(
				await storage.scanEntries({ conversationId: grandchildId, withHead: true }, undefined, 10, context)
			).items.map(({ id }) => id),
		).toEqual([grandchildHead, rootForkPoint]);

		expect(await storage.entryCommit(rootFirst, context)).toBe(rootEntriesSeq);
		expect(await storage.entryCommit(rootForkPoint, context)).toBe(rootEntriesSeq);
		expect(await storage.entryCommit(grandchildHead, context)).toBe(grandchildEntriesSeq);
		expect(await storage.entryCommit(grandchildTail, context)).toBe(grandchildEntriesSeq);
		expect(await storage.entryCommit(999_999, context)).toBeUndefined();
		await expect(storage.scanEntries({ conversationId: 999_999 }, undefined, 10, context)).rejects.toThrow(
			"Unknown conversation",
		);
	});

	it("replaces complete task records and pages filtered task scans", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const firstId = storage.mintId();
		const secondId = storage.mintId();
		const thirdId = storage.mintId();
		const first = { ...pendingTask(firstId, rootId), memos: { winner: "first" } } satisfies StoredTask;
		const second = { ...pendingTask(secondId, rootId), background: true } satisfies StoredTask;
		const third = { ...pendingTask(thirdId, rootId), abortRequested: true } satisfies StoredTask;
		await storage.commit(
			[
				{ type: "task", value: first },
				{ type: "task", value: second },
				{ type: "task", value: third },
			],
			context,
		);

		const running: StoredTask = {
			...first,
			state: { status: "running", checkpoint: { phase: "effect", attempt: 1 } },
			abortRequested: true,
		};
		await storage.commit([{ type: "task", value: running }], context);
		expect(await storage.task(firstId, context)).toEqual(running);
		const terminal: StoredTask = {
			id: firstId,
			conversationId: rootId,
			kind: first.kind,
			version: first.version,
			input: first.input,
			state: { status: "terminal", outcome: { status: "completed", result: { entryId: 99 } } },
			after: [],
			background: false,
			abortRequested: true,
		};
		await storage.commit([{ type: "task", value: terminal }], context);
		expect(await storage.task(firstId, context)).toEqual(terminal);

		const pendingPage = await storage.scanTasks({ status: "pending" }, undefined, 1, context);
		expect(pendingPage.items.map(({ id }) => id)).toEqual([secondId]);
		expect(pendingPage.next).toBeDefined();
		expect(
			(await storage.scanTasks({ status: "pending" }, pendingPage.next, 1, context)).items.map(({ id }) => id),
		).toEqual([thirdId]);
		expect(
			(await storage.scanTasks({ status: "terminal", abortRequested: true }, undefined, 10, context)).items,
		).toEqual([terminal]);
		expect((await storage.scanTasks({ background: true }, undefined, 10, context)).items.map(({ id }) => id)).toEqual(
			[secondId],
		);
	});

	it("indexes request IDs per conversation and replaces complete input records", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const secondConversationId = storage.mintId();
		await storage.commit([{ type: "conversation", value: { id: secondConversationId } }], context);
		const firstId = storage.mintId();
		const secondId = storage.mintId();
		const otherConversationId = storage.mintId();
		const first: Input = {
			id: firstId,
			conversationId: rootId,
			requestId: "same",
			status: "queued",
		};
		const second: Input = {
			id: secondId,
			conversationId: rootId,
			requestId: "other",
			status: "queued",
		};
		const otherConversation: Input = {
			id: otherConversationId,
			conversationId: secondConversationId,
			requestId: "same",
			status: "queued",
		};
		await storage.commit(
			[
				{ type: "input", value: first },
				{ type: "input", value: second },
				{ type: "input", value: otherConversation },
			],
			context,
		);
		expect(await storage.inputByRequest(rootId, "same", context)).toEqual(first);
		expect(await storage.inputByRequest(secondConversationId, "same", context)).toEqual(otherConversation);

		const placedSecond: Input = { ...second, status: "placed", entry: storage.mintId() };
		await storage.commit([{ type: "input", value: placedSecond }], context);
		expect(await storage.input(secondId, context)).toEqual(placedSecond);
		expect(await storage.inputByRequest(rootId, "other", context)).toEqual(placedSecond);
	});

	it("keeps one global record ID namespace and rejects exhausted ID minting", async () => {
		const storage = new MemoryStorage();
		const rootId = await createRoot(storage);
		const explicitEntryId = 100;
		await storage.commit([{ type: "entry", value: entry(explicitEntryId, rootId) }], context);
		expect(storage.mintId()).toBe(101);
		await expect(
			storage.commit([{ type: "task", value: pendingTask(explicitEntryId, rootId) }], context),
		).rejects.toThrow(`ID ${explicitEntryId} already belongs to entry`);

		await storage.commit([{ type: "entry", value: entry(Number.MAX_SAFE_INTEGER, rootId, "last-id") }], context);
		expect(() => storage.mintId()).toThrow("ID space is exhausted");
		expect(() => storage.mintId()).toThrow("ID space is exhausted");
	});

	it("rejects every operation after close", async () => {
		const storage = new MemoryStorage();
		await createRoot(storage);
		await storage.close(context);
		await expect(storage.conversation(ROOT_CONVERSATION_ID, context)).rejects.toThrow("closed");
		await expect(storage.commit([] satisfies StorageWrite[], context)).rejects.toThrow("closed");
		expect(() => storage.mintId()).toThrow("closed");
	});
});
