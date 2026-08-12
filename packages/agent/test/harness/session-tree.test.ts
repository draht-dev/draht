import { describe, expect, it } from "vitest";
import { LaneMutationLine } from "../../src/harness/session/lane-mutations.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { SessionInvariantError, StorageBackedSession } from "../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type { LaneState, NewEntry, Operation, RunState, SessionMetadata } from "../../src/harness/session/types.ts";

const NOW = 1_700_000_000_000;
const ROOT_ID = "00000000-0000-7000-8000-000000000001";
const CHILD_ID = "00000000-0000-7000-8000-000000000002";
const CUSTOM_ID = "00000000-0000-7000-8000-000000000003";
const OTHER_ID = "00000000-0000-7000-8000-000000000004";
const OPERATION_ID = "00000000-0000-7000-8000-000000000005";
const metadata = {
	id: "session",
	createdAt: NOW,
	storageVersion: 1,
} satisfies SessionMetadata;

function customEntry(id: string, parentId: string | null, customType = "note"): NewEntry {
	return { id, parentId, type: "custom", customType, data: { id } };
}

const idleLaneState = { currentOperationId: null, pendingNextRun: [] } satisfies LaneState;
const operation = {
	operationId: OPERATION_ID,
	lane: "main",
	sourceLeafId: ROOT_ID,
	startedAt: NOW,
	intent: { kind: "run", promptEntryIds: [] },
} satisfies Operation;
const runState = {
	kind: "run",
	control: { status: "running" },
	settings: {
		compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 1 },
		steeringMode: "all",
		followUpMode: "all",
		toolExecution: "parallel",
	},
	phase: {
		kind: "checkpoint",
		continuation: { kind: "may_finish", includeFinalAssistant: false },
		triggerEntryId: ROOT_ID,
	},
	inbox: { steer: [], followUp: [], writes: [] },
	latestAssistantEntryId: null,
} satisfies RunState;

function laneWrites(leafId: string | null, state: LaneState = idleLaneState) {
	return [
		{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: leafId },
		{ kind: "register", op: "set", namespace: "lane.state", key: "main", value: state },
	] as const;
}

async function createTreeSession(): Promise<StorageBackedSession> {
	const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
	await session.commit({
		writes: [
			{ kind: "entry", entry: customEntry(ROOT_ID, null, "root") },
			{
				kind: "entry",
				entry: {
					id: CHILD_ID,
					parentId: ROOT_ID,
					type: "message",
					message: { role: "user", content: "child", timestamp: NOW },
				},
			},
			{ kind: "entry", entry: customEntry(CUSTOM_ID, CHILD_ID) },
			{ kind: "entry", entry: customEntry(OTHER_ID, ROOT_ID, "other") },
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: CUSTOM_ID },
			{ kind: "register", op: "set", namespace: "lane.leaf", key: "other", value: OTHER_ID },
		],
	});
	return session;
}

class CountingLaneMutationLine extends LaneMutationLine {
	runCount = 0;

	override run<T>(lane: string, operation: () => T | Promise<T>) {
		this.runCount++;
		return super.run(lane, operation);
	}
}

class RejectingCommitStorage extends MemoryStorage {
	rejection: Error | undefined;

	override commit(transaction: Parameters<MemoryStorage["commit"]>[0]) {
		return this.rejection === undefined ? super.commit(transaction) : Promise.reject(this.rejection);
	}
}

class BlockingCommitStorage extends MemoryStorage {
	block = false;
	admitted = false;
	private releaseCommit: (() => void) | undefined;

	override async commit(transaction: Parameters<MemoryStorage["commit"]>[0]) {
		if (this.block) {
			this.admitted = true;
			await new Promise<void>((resolve) => {
				this.releaseCommit = resolve;
			});
		}
		return super.commit(transaction);
	}

	release(): void {
		if (this.releaseCommit === undefined) throw new Error("No blocked commit");
		this.releaseCommit();
	}
}

describe("StorageBackedSession SessionTree", () => {
	it("creates lane-bound views over shared entries, facts, and stats", async () => {
		const session = await createTreeSession();
		const other = session.view("other");

		expect(await session.getLeafId()).toBe(CUSTOM_ID);
		expect(await other.getLeafId()).toBe(OTHER_ID);
		expect(await session.getEntry(CHILD_ID)).toMatchObject({ id: CHILD_ID, parentId: ROOT_ID });
		expect(await session.getEntry("00000000-0000-7000-8000-000000000099")).toBeUndefined();
		expect(await session.getStats()).toMatchObject({ messageCount: 1 });
		expect(await other.getStats()).toEqual(await session.getStats());

		await session.setName("shared");
		expect(await other.getName()).toBe("shared");
		await session.close();
	});

	it("rejects missing lanes", async () => {
		const session = await createTreeSession();
		await expect(session.view("missing").getLeafId()).rejects.toThrow("Unknown lane");
		await session.close();
	});

	it("reads, sets, and deletes global facts while preserving JSON null", async () => {
		const session = await createTreeSession();
		const other = session.view("other");

		expect(await session.getName()).toBeUndefined();
		expect(await session.getLabel(ROOT_ID)).toBeUndefined();
		expect(await session.getCustomFact("state")).toBeUndefined();

		await session.setName("name");
		await other.setLabel(ROOT_ID, "root label");
		await session.setCustomFact("state", null);
		expect(await other.getName()).toBe("name");
		expect(await session.getLabel(ROOT_ID)).toBe("root label");
		expect(await other.getCustomFact("state")).toBeNull();

		await other.setName(undefined);
		await session.setLabel(ROOT_ID, undefined);
		await other.setCustomFact("state", undefined);
		expect(await session.getName()).toBeUndefined();
		expect(await other.getLabel(ROOT_ID)).toBeUndefined();
		expect(await session.getCustomFact("state")).toBeUndefined();
		await session.close();
	});

	it("passes fact values directly to storage", async () => {
		const session = await createTreeSession();
		const value = { nested: ["original"] };

		await session.setCustomFact("state", value);
		expect(await session.getCustomFact("state")).toBe(value);
		await session.close();
	});

	it("applies global query ordering, filters, exclusive cursors, and limits", async () => {
		const session = await createTreeSession();
		const all = await session.findEntries();
		const custom = all.find((entry) => entry.id === CUSTOM_ID);
		if (custom === undefined) throw new Error("Expected custom entry");

		expect(all.map((entry) => entry.id)).toEqual([OTHER_ID, CUSTOM_ID, CHILD_ID, ROOT_ID]);
		expect((await session.findEntries({ order: "asc", type: "custom" })).map((entry) => entry.id)).toEqual([
			ROOT_ID,
			CUSTOM_ID,
			OTHER_ID,
		]);
		expect((await session.findEntries({ customType: "note", limit: 1 })).map((entry) => entry.id)).toEqual([
			CUSTOM_ID,
		]);
		expect((await session.findEntries({ cursor: { seq: custom.seq } })).map((entry) => entry.id)).toEqual([
			CHILD_ID,
			ROOT_ID,
		]);
		expect(
			(await session.findEntries({ order: "asc", cursor: { seq: custom.seq } })).map((entry) => entry.id),
		).toEqual([OTHER_ID]);
		expect((await session.findEntry({ type: "message" }))?.id).toBe(CHILD_ID);
		expect(await session.findEntry({ customType: "missing" })).toBeUndefined();
		await session.close();
	});

	it("applies branch defaults, inclusive stops, filters, cursors, and lane leaves", async () => {
		const session = await createTreeSession();
		const path = await session.findEntriesOnBranch();
		const child = path.find((entry) => entry.id === CHILD_ID);
		if (child === undefined) throw new Error("Expected child entry");

		expect(path.map((entry) => entry.id)).toEqual([CUSTOM_ID, CHILD_ID, ROOT_ID]);
		expect((await session.findEntriesOnBranch({ stopAtId: CHILD_ID })).map((entry) => entry.id)).toEqual([
			CUSTOM_ID,
			CHILD_ID,
		]);
		expect((await session.view("other").findEntriesOnBranch()).map((entry) => entry.id)).toEqual([OTHER_ID, ROOT_ID]);
		expect(
			(await session.findEntriesOnBranch({ stopAtType: "message", type: "custom" })).map((entry) => entry.id),
		).toEqual([CUSTOM_ID]);
		expect(
			(await session.findEntriesOnBranch({ order: "oldestFirst", cursor: { seq: child.seq }, limit: 1 })).map(
				(entry) => entry.id,
			),
		).toEqual([CUSTOM_ID]);
		expect((await session.findEntryOnBranch({ customType: "root" }))?.id).toBe(ROOT_ID);
		expect(await session.findEntryOnBranch({ customType: "missing" })).toBeUndefined();
		await session.close();
	});

	it("returns an empty default branch for a lane at the root", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		await session.commit({
			writes: [{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null }],
		});

		expect(await session.findEntriesOnBranch()).toEqual([]);
		expect(await session.findEntryOnBranch()).toBeUndefined();
		await session.close();
	});

	it("atomically appends messages and custom entries to the bound lane", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await session.commit({
			writes: [
				...laneWrites(null),
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "other", value: null },
				{ kind: "register", op: "set", namespace: "lane.state", key: "other", value: idleLaneState },
			],
		});
		storage.clearCommitAttempts();

		const messageId = await session.appendMessage({ role: "user", content: "hello", timestamp: NOW });
		const customId = await session.appendCustomEntry("note", { nested: ["value"] });
		const withoutDataId = await session.view("other").appendCustomEntry("marker");

		expect(storage.getCommitAttempts().map((attempt) => attempt.writes)).toEqual([
			[
				{
					kind: "entry",
					entry: {
						id: messageId,
						parentId: null,
						type: "message",
						message: { role: "user", content: "hello", timestamp: NOW },
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: messageId },
			],
			[
				{
					kind: "entry",
					entry: {
						id: customId,
						parentId: messageId,
						type: "custom",
						customType: "note",
						data: { nested: ["value"] },
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: customId },
			],
			[
				{
					kind: "entry",
					entry: {
						id: withoutDataId,
						parentId: null,
						type: "custom",
						customType: "marker",
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "other", value: withoutDataId },
			],
		]);
		expect(await session.getLeafId()).toBe(customId);
		expect(await session.view("other").getLeafId()).toBe(withoutDataId);
		expect(await session.getEntry(messageId)).toMatchObject({ parentId: null, type: "message" });
		expect(await session.getEntry(customId)).toEqual(
			expect.objectContaining({
				parentId: messageId,
				type: "custom",
				customType: "note",
				data: { nested: ["value"] },
			}),
		);
		const withoutData = await session.getEntry(withoutDataId);
		expect(withoutData).toEqual(expect.objectContaining({ parentId: null, type: "custom", customType: "marker" }));
		expect(withoutData).not.toHaveProperty("data");
		await session.close();
	});

	it("defers appends into an active run without moving the lane leaf", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await session.commit({
			writes: [
				{ kind: "entry", entry: customEntry(ROOT_ID, null) },
				...laneWrites(ROOT_ID, { currentOperationId: OPERATION_ID, pendingNextRun: [] }),
				{ kind: "register", op: "set", namespace: "op.meta", key: OPERATION_ID, value: operation },
				{ kind: "register", op: "set", namespace: "op.state", key: OPERATION_ID, value: runState },
			],
		});
		storage.clearCommitAttempts();

		const [customId, messageId] = await Promise.all([
			session.appendCustomEntry("note", { deferred: true }),
			session.appendMessage({ role: "user", content: "later", timestamp: NOW }),
		]);

		expect(await session.getLeafId()).toBe(ROOT_ID);
		expect(await session.getEntries([customId, messageId])).toEqual(new Map());
		expect(await session.getRegister("pending.entry", customId)).toMatchObject({
			value: { type: "custom", customType: "note", payload: { deferred: true } },
		});
		expect(await session.getRegister("pending.entry", messageId)).toMatchObject({
			value: { type: "message", payload: { role: "user", content: "later", timestamp: NOW } },
		});
		expect(await session.getRegister("op.state", OPERATION_ID)).toMatchObject({
			value: { inbox: { writes: [customId, messageId] } },
		});
		expect(storage.getCommitAttempts()).toHaveLength(2);
		await session.close();
	});

	it("rejects without writing while structural-operation waiting is not implemented", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const structuralState = {
			kind: "compaction",
			control: { status: "running" },
			structural: { taskId: CHILD_ID, status: "deciding" },
		} as const;
		await session.commit({
			writes: [
				{ kind: "entry", entry: customEntry(ROOT_ID, null) },
				...laneWrites(ROOT_ID, { currentOperationId: OPERATION_ID, pendingNextRun: [] }),
				{
					kind: "register",
					op: "set",
					namespace: "op.meta",
					key: OPERATION_ID,
					value: { ...operation, intent: { kind: "compaction" } },
				},
				{ kind: "register", op: "set", namespace: "op.state", key: OPERATION_ID, value: structuralState },
			],
		});

		storage.clearCommitAttempts();
		const append = session.appendCustomEntry("during-structural");
		await expect(append).rejects.toThrow("Cannot append while structural operation");
		expect(storage.getCommitAttempts()).toEqual([]);
		expect(await session.getLeafId()).toBe(ROOT_ID);
		await session.close();
	});

	it("serializes concurrent appends into one linear lane branch", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		await session.commit({
			writes: [{ kind: "entry", entry: customEntry(ROOT_ID, null) }, ...laneWrites(ROOT_ID)],
		});

		const [firstId, secondId] = await Promise.all([
			session.appendCustomEntry("first"),
			session.appendCustomEntry("second"),
		]);

		expect((await session.findEntriesOnBranch()).map((entry) => entry.id)).toEqual([secondId, firstId, ROOT_ID]);
		await session.close();
	});

	it("passes append payloads directly to storage", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const laneMutationLine = new CountingLaneMutationLine();
		const session = new StorageBackedSession(metadata, storage, { laneMutationLine });
		await session.commit({ writes: [...laneWrites(null)] });
		storage.clearCommitAttempts();
		const data = { nested: ["original"] };

		const id = await session.appendCustomEntry("note", data);
		const entry = await session.getEntry(id);
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.data).toBe(data);
		expect(storage.getCommitAttempts()).toHaveLength(1);
		const message = { role: "user" as const, content: "original", timestamp: NOW };
		const messageId = await session.appendMessage(message);
		const messageEntry = await session.getEntry(messageId);
		if (messageEntry?.type !== "message") throw new Error("Expected message entry");
		expect(messageEntry.message).toBe(message);
		expect(laneMutationLine.runCount).toBe(2);
		await session.close();
	});

	it("fails fast when active operation registers are inconsistent", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await session.commit({
			writes: [...laneWrites(null, { currentOperationId: OPERATION_ID, pendingNextRun: [] })],
		});
		storage.clearCommitAttempts();

		const append = session.appendCustomEntry("note");
		await expect(append).rejects.toBeInstanceOf(SessionInvariantError);
		await expect(append).rejects.toThrow("missing op.meta");
		expect(storage.getCommitAttempts()).toEqual([]);
		await session.close();
	});

	it("propagates append storage failures without moving the leaf", async () => {
		const storage = new RejectingCommitStorage({ now: () => NOW });
		await storage.commit({
			writes: [{ kind: "entry", entry: customEntry(ROOT_ID, null) }, ...laneWrites(ROOT_ID)],
		});
		const session = new StorageBackedSession(metadata, storage);
		const rejection = new Error("commit failed");
		storage.rejection = rejection;

		await expect(session.appendCustomEntry("note")).rejects.toBe(rejection);
		storage.rejection = undefined;
		expect(await session.getLeafId()).toBe(ROOT_ID);
		expect((await session.findEntries()).map((entry) => entry.id)).toEqual([ROOT_ID]);
		await session.close();
	});

	it("drains an append whose storage commit was admitted before close", async () => {
		const storage = new BlockingCommitStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);
		await session.commit({ writes: [...laneWrites(null)] });
		storage.block = true;

		const append = session.appendCustomEntry("admitted");
		while (!storage.admitted) await Promise.resolve();
		const close = session.close();
		storage.release();

		const id = await append;
		await close;
		expect(id).toMatch(/^[0-9a-f-]+$/);
	});

	it("rejects all SessionTree operations after close, including existing views", async () => {
		const session = await createTreeSession();
		const view = session.view("other");
		await session.close();

		const operations: Array<() => Promise<unknown>> = [
			() => session.getLeafId(),
			() => view.getEntry(ROOT_ID),
			() => session.getStats(),
			() => view.getName(),
			() => session.setName("closed"),
			() => view.findEntries(),
			() => session.findEntriesOnBranch(),
			() => view.appendCustomEntry("closed"),
		];
		for (const operation of operations) await expect(operation()).rejects.toThrow("Session is closed");
	});
});
