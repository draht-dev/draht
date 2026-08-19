import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { LaneMutationLine } from "../../src/harness/session/lane-mutations.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { SessionInvariantError, StorageBackedSession } from "../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type {
	LaneState,
	NewEntry,
	OperationMeta,
	RunState,
	Session,
	SessionMetadata,
	Write,
} from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";

const NOW = 1_700_000_000_000;
const ROOT_ID = "00000000-0000-7000-8000-000000000001";
const CHILD_ID = "00000000-0000-7000-8000-000000000002";
const CUSTOM_ID = "00000000-0000-7000-8000-000000000003";
const OTHER_ID = "00000000-0000-7000-8000-000000000004";
const OPERATION_ID = "00000000-0000-7000-8000-000000000005";
const applicationState = storedValues.value<unknown>("test.application.state");
const objectApplicationState = storedValues.value<{ nested: string[] }>("test.application.object");
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
} satisfies OperationMeta;
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

function commitSession(session: Session, transaction: Write[]) {
	return session.mutate("main", (mutator) => mutator.commit(transaction, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
}

function laneWrites(leafId: string | null, state: LaneState = idleLaneState) {
	return [
		storedValues.setValue(storedValues.laneLeaf("main"), leafId),
		storedValues.setValue(storedValues.laneState("main"), state),
	] as const;
}

async function createTreeSession(): Promise<StorageBackedSession> {
	const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
	await commitSession(session, [
		sessionWrites.insertEntry(customEntry(ROOT_ID, null, "root")),
		sessionWrites.insertEntry({
			id: CHILD_ID,
			parentId: ROOT_ID,
			type: "message",
			message: { role: "user", content: "child", timestamp: NOW },
		}),
		sessionWrites.insertEntry(customEntry(CUSTOM_ID, CHILD_ID)),
		sessionWrites.insertEntry(customEntry(OTHER_ID, ROOT_ID, "other")),
		storedValues.setValue(storedValues.laneLeaf("main"), CUSTOM_ID),
		storedValues.setValue(storedValues.laneLeaf("other"), OTHER_ID),
	]);
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
		return this.rejection === undefined
			? super.commit(transaction, BACKGROUND_CONTEXT)
			: Promise.reject(this.rejection);
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
		return super.commit(transaction, BACKGROUND_CONTEXT);
	}

	release(): void {
		if (this.releaseCommit === undefined) throw new Error("No blocked commit");
		this.releaseCommit();
	}
}

describe("StorageBackedSession SessionTree", () => {
	it("creates lane-bound views over shared entries, values, and stats", async () => {
		const session = await createTreeSession();
		const other = session.view("other");

		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(CUSTOM_ID);
		expect(await other.getLeafId(BACKGROUND_CONTEXT)).toBe(OTHER_ID);
		expect(await session.getEntry(CHILD_ID, BACKGROUND_CONTEXT)).toMatchObject({ id: CHILD_ID, parentId: ROOT_ID });
		expect(await session.getEntry("00000000-0000-7000-8000-000000000099", BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getStats(BACKGROUND_CONTEXT)).toMatchObject({ messageCount: 1 });
		expect(await other.getStats(BACKGROUND_CONTEXT)).toEqual(await session.getStats(BACKGROUND_CONTEXT));

		await session.setName("shared", BACKGROUND_CONTEXT);
		expect(await other.getName(BACKGROUND_CONTEXT)).toBe("shared");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("rejects missing lanes", async () => {
		const session = await createTreeSession();
		await expect(session.view("missing").getLeafId(BACKGROUND_CONTEXT)).rejects.toThrow("Unknown lane");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("reads, sets, and deletes global values while preserving JSON null", async () => {
		const session = await createTreeSession();
		const other = session.view("other");

		expect(await session.getName(BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getLabel(ROOT_ID, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(applicationState, BACKGROUND_CONTEXT)).toBeUndefined();

		await session.setName("name", BACKGROUND_CONTEXT);
		await other.setLabel(ROOT_ID, "root label", BACKGROUND_CONTEXT);
		await session.setValue(applicationState, null, BACKGROUND_CONTEXT);
		expect(await other.getName(BACKGROUND_CONTEXT)).toBe("name");
		expect(await session.getLabel(ROOT_ID, BACKGROUND_CONTEXT)).toBe("root label");
		expect((await other.getValue(applicationState, BACKGROUND_CONTEXT))?.value).toBeNull();

		await other.setName(undefined, BACKGROUND_CONTEXT);
		await session.setLabel(ROOT_ID, undefined, BACKGROUND_CONTEXT);
		await other.deleteValue(applicationState, BACKGROUND_CONTEXT);
		expect(await session.getName(BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await other.getLabel(ROOT_ID, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(applicationState, BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("passes application values directly to storage", async () => {
		const session = await createTreeSession();
		const value = { nested: ["original"] };

		await session.setValue(objectApplicationState, value, BACKGROUND_CONTEXT);
		expect((await session.getValue(objectApplicationState, BACKGROUND_CONTEXT))?.value).toBe(value);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("exposes bound application values and lists through every lane view", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, [...laneWrites(null)]);
		storage.clearCommitAttempts();
		const scalar = storedValues.value<{ count: number }>("test.application.scalar");
		const events = (workspace: string) => storedValues.list<string>("test.application.events", workspace);
		const workspaceEvents = events("workspace");
		const other = session.view("main");

		await session.setValue(scalar, { count: 1 }, BACKGROUND_CONTEXT);
		await other.appendList(workspaceEvents, "first", BACKGROUND_CONTEXT);
		await session.appendList(workspaceEvents, "second", BACKGROUND_CONTEXT);
		expect((await other.getValue(scalar, BACKGROUND_CONTEXT))?.value).toEqual({ count: 1 });
		expect(
			(await session.readList(workspaceEvents, { limit: 1 }, BACKGROUND_CONTEXT)).map(({ value }) => value),
		).toEqual(["first"]);
		expect(storage.getCommitAttempts()).toHaveLength(3);
		expect(storage.getCommitAttempts().map((writes) => writes.map(({ kind }) => kind))).toEqual([
			["value"],
			["list"],
			["list"],
		]);

		await other.deleteList(workspaceEvents, BACKGROUND_CONTEXT);
		await session.deleteValue(scalar, BACKGROUND_CONTEXT);
		expect(await session.readList(workspaceEvents, undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await session.getValue(scalar, BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("applies global query ordering, filters, exclusive cursors, and limits", async () => {
		const session = await createTreeSession();
		const all = await session.findEntries(undefined, BACKGROUND_CONTEXT);
		const custom = all.find((entry) => entry.id === CUSTOM_ID);
		if (custom === undefined) throw new Error("Expected custom entry");

		expect(all.map((entry) => entry.id)).toEqual([OTHER_ID, CUSTOM_ID, CHILD_ID, ROOT_ID]);
		expect(
			(await session.findEntries({ order: "asc", type: "custom" }, BACKGROUND_CONTEXT)).map((entry) => entry.id),
		).toEqual([ROOT_ID, CUSTOM_ID, OTHER_ID]);
		expect(
			(await session.findEntries({ customType: "note", limit: 1 }, BACKGROUND_CONTEXT)).map((entry) => entry.id),
		).toEqual([CUSTOM_ID]);
		expect(
			(await session.findEntries({ cursor: { seq: custom.seq } }, BACKGROUND_CONTEXT)).map((entry) => entry.id),
		).toEqual([CHILD_ID, ROOT_ID]);
		expect(
			(await session.findEntries({ order: "asc", cursor: { seq: custom.seq } }, BACKGROUND_CONTEXT)).map(
				(entry) => entry.id,
			),
		).toEqual([OTHER_ID]);
		expect((await session.findEntry({ type: "message" }, BACKGROUND_CONTEXT))?.id).toBe(CHILD_ID);
		expect(await session.findEntry({ customType: "missing" }, BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("applies branch defaults, inclusive stops, filters, cursors, and lane leaves", async () => {
		const session = await createTreeSession();
		const path = await session.findEntriesOnBranch(undefined, BACKGROUND_CONTEXT);
		const child = path.find((entry) => entry.id === CHILD_ID);
		if (child === undefined) throw new Error("Expected child entry");

		expect(path.map((entry) => entry.id)).toEqual([CUSTOM_ID, CHILD_ID, ROOT_ID]);
		expect(
			(await session.findEntriesOnBranch({ stopAtId: CHILD_ID }, BACKGROUND_CONTEXT)).map((entry) => entry.id),
		).toEqual([CUSTOM_ID, CHILD_ID]);
		expect(
			(await session.view("other").findEntriesOnBranch(undefined, BACKGROUND_CONTEXT)).map((entry) => entry.id),
		).toEqual([OTHER_ID, ROOT_ID]);
		expect(
			(await session.findEntriesOnBranch({ stopAtType: "message", type: "custom" }, BACKGROUND_CONTEXT)).map(
				(entry) => entry.id,
			),
		).toEqual([CUSTOM_ID]);
		expect(
			(
				await session.findEntriesOnBranch(
					{ order: "oldestFirst", cursor: { seq: child.seq }, limit: 1 },
					BACKGROUND_CONTEXT,
				)
			).map((entry) => entry.id),
		).toEqual([CUSTOM_ID]);
		expect((await session.findEntryOnBranch({ customType: "root" }, BACKGROUND_CONTEXT))?.id).toBe(ROOT_ID);
		expect(await session.findEntryOnBranch({ customType: "missing" }, BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("returns an empty default branch for a lane at the root", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		await commitSession(session, [storedValues.setValue(storedValues.laneLeaf("main"), null)]);

		expect(await session.findEntriesOnBranch(undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await session.findEntryOnBranch(undefined, BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("atomically appends messages and custom entries to the bound lane", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, [
			...laneWrites(null),
			storedValues.setValue(storedValues.laneLeaf("other"), null),
			storedValues.setValue(storedValues.laneState("other"), idleLaneState),
		]);
		storage.clearCommitAttempts();

		const messageId = await session.appendMessage(
			{ role: "user", content: "hello", timestamp: NOW },
			BACKGROUND_CONTEXT,
		);
		const customId = await session.appendCustomEntry("note", { nested: ["value"] }, BACKGROUND_CONTEXT);
		const withoutDataId = await session.view("other").appendCustomEntry("marker", undefined, BACKGROUND_CONTEXT);

		expect(storage.getCommitAttempts()).toEqual([
			[
				sessionWrites.insertEntry({
					id: messageId,
					parentId: null,
					type: "message",
					message: { role: "user", content: "hello", timestamp: NOW },
				}),
				storedValues.setValue(storedValues.laneLeaf("main"), messageId),
			],
			[
				sessionWrites.insertEntry({
					id: customId,
					parentId: messageId,
					type: "custom",
					customType: "note",
					data: { nested: ["value"] },
				}),
				storedValues.setValue(storedValues.laneLeaf("main"), customId),
			],
			[
				sessionWrites.insertEntry({
					id: withoutDataId,
					parentId: null,
					type: "custom",
					customType: "marker",
				}),
				storedValues.setValue(storedValues.laneLeaf("other"), withoutDataId),
			],
		]);
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(customId);
		expect(await session.view("other").getLeafId(BACKGROUND_CONTEXT)).toBe(withoutDataId);
		expect(await session.getEntry(messageId, BACKGROUND_CONTEXT)).toMatchObject({ parentId: null, type: "message" });
		expect(await session.getEntry(customId, BACKGROUND_CONTEXT)).toEqual(
			expect.objectContaining({
				parentId: messageId,
				type: "custom",
				customType: "note",
				data: { nested: ["value"] },
			}),
		);
		const withoutData = await session.getEntry(withoutDataId, BACKGROUND_CONTEXT);
		expect(withoutData).toEqual(expect.objectContaining({ parentId: null, type: "custom", customType: "marker" }));
		expect(withoutData).not.toHaveProperty("data");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("defers appends into an active run without moving the lane leaf", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, [
			sessionWrites.insertEntry(customEntry(ROOT_ID, null)),
			...laneWrites(ROOT_ID, { currentOperationId: OPERATION_ID, pendingNextRun: [] }),
			storedValues.setValue(storedValues.operationMeta(OPERATION_ID), operation),
			storedValues.setValue(storedValues.operationState(OPERATION_ID), runState),
		]);
		storage.clearCommitAttempts();

		const [customId, messageId] = await Promise.all([
			session.appendCustomEntry("note", { deferred: true }, BACKGROUND_CONTEXT),
			session.appendMessage({ role: "user", content: "later", timestamp: NOW }, BACKGROUND_CONTEXT),
		]);

		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(ROOT_ID);
		expect(await session.getEntries([customId, messageId], BACKGROUND_CONTEXT)).toEqual(new Map());
		expect(await session.getValue(storedValues.pendingEntry(customId), BACKGROUND_CONTEXT)).toMatchObject({
			value: { type: "custom", customType: "note", payload: { deferred: true } },
		});
		expect(await session.getValue(storedValues.pendingEntry(messageId), BACKGROUND_CONTEXT)).toMatchObject({
			value: { type: "message", payload: { role: "user", content: "later", timestamp: NOW } },
		});
		expect(await session.getValue(storedValues.operationState(OPERATION_ID), BACKGROUND_CONTEXT)).toMatchObject({
			value: { inbox: { writes: [customId, messageId] } },
		});
		expect(storage.getCommitAttempts()).toHaveLength(2);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("rejects without writing while structural-operation waiting is not implemented", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const structuralState = {
			kind: "compaction",
			control: { status: "running" },
			structural: { taskId: CHILD_ID, status: "deciding" },
		} as const;
		await commitSession(session, [
			sessionWrites.insertEntry(customEntry(ROOT_ID, null)),
			...laneWrites(ROOT_ID, { currentOperationId: OPERATION_ID, pendingNextRun: [] }),
			storedValues.setValue(storedValues.operationMeta(OPERATION_ID), {
				...operation,
				intent: { kind: "compaction" },
			}),
			storedValues.setValue(storedValues.operationState(OPERATION_ID), structuralState),
		]);

		storage.clearCommitAttempts();
		const append = session.appendCustomEntry("during-structural", undefined, BACKGROUND_CONTEXT);
		await expect(append).rejects.toThrow("Cannot append while structural operation");
		expect(storage.getCommitAttempts()).toEqual([]);
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(ROOT_ID);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("diverges lanes that append from the same shared leaf", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		await commitSession(session, [sessionWrites.insertEntry(customEntry(ROOT_ID, null)), ...laneWrites(ROOT_ID)]);
		const configuration = {
			model: { provider: "provider", modelId: "model" },
			thinkingLevel: "off" as const,
			activeToolNames: [],
		};
		const review = await session.createLane("review", ROOT_ID, configuration, undefined, BACKGROUND_CONTEXT);

		const [mainId, reviewId] = await Promise.all([
			session.appendCustomEntry("main-child", undefined, BACKGROUND_CONTEXT),
			review.appendCustomEntry("review-child", undefined, BACKGROUND_CONTEXT),
		]);

		expect((await session.findEntriesOnBranch(undefined, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
			mainId,
			ROOT_ID,
		]);
		expect((await review.findEntriesOnBranch(undefined, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
			reviewId,
			ROOT_ID,
		]);
		expect((await session.getEntry(mainId, BACKGROUND_CONTEXT))?.parentId).toBe(ROOT_ID);
		expect((await session.getEntry(reviewId, BACKGROUND_CONTEXT))?.parentId).toBe(ROOT_ID);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("serializes concurrent appends into one linear lane branch", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		await commitSession(session, [sessionWrites.insertEntry(customEntry(ROOT_ID, null)), ...laneWrites(ROOT_ID)]);

		const [firstId, secondId] = await Promise.all([
			session.appendCustomEntry("first", undefined, BACKGROUND_CONTEXT),
			session.appendCustomEntry("second", undefined, BACKGROUND_CONTEXT),
		]);

		expect((await session.findEntriesOnBranch(undefined, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([
			secondId,
			firstId,
			ROOT_ID,
		]);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("passes append payloads directly to storage", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const laneMutationLine = new CountingLaneMutationLine();
		const session = new StorageBackedSession(metadata, storage, { laneMutationLine });
		await commitSession(session, [...laneWrites(null)]);
		storage.clearCommitAttempts();
		const data = { nested: ["original"] };
		const runCountBeforeAppends = laneMutationLine.runCount;

		const id = await session.appendCustomEntry("note", data, BACKGROUND_CONTEXT);
		const entry = await session.getEntry(id, BACKGROUND_CONTEXT);
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.data).toBe(data);
		expect(storage.getCommitAttempts()).toHaveLength(1);
		const message = { role: "user" as const, content: "original", timestamp: NOW };
		const messageId = await session.appendMessage(message, BACKGROUND_CONTEXT);
		const messageEntry = await session.getEntry(messageId, BACKGROUND_CONTEXT);
		if (messageEntry?.type !== "message") throw new Error("Expected message entry");
		expect(messageEntry.message).toBe(message);
		expect(laneMutationLine.runCount - runCountBeforeAppends).toBe(2);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("fails fast when active operation registers are inconsistent", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, [...laneWrites(null, { currentOperationId: OPERATION_ID, pendingNextRun: [] })]);
		storage.clearCommitAttempts();

		const append = session.appendCustomEntry("note", undefined, BACKGROUND_CONTEXT);
		await expect(append).rejects.toBeInstanceOf(SessionInvariantError);
		await expect(append).rejects.toThrow("missing op.meta");
		expect(storage.getCommitAttempts()).toEqual([]);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("propagates append storage failures without moving the leaf", async () => {
		const storage = new RejectingCommitStorage({ now: () => NOW });
		await storage.commit([sessionWrites.insertEntry(customEntry(ROOT_ID, null)), ...laneWrites(ROOT_ID)]);
		const session = new StorageBackedSession(metadata, storage);
		const rejection = new Error("commit failed");
		storage.rejection = rejection;

		await expect(session.appendCustomEntry("note", undefined, BACKGROUND_CONTEXT)).rejects.toBe(rejection);
		storage.rejection = undefined;
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(ROOT_ID);
		expect((await session.findEntries(undefined, BACKGROUND_CONTEXT)).map((entry) => entry.id)).toEqual([ROOT_ID]);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("drains an append whose storage commit was admitted before close", async () => {
		const storage = new BlockingCommitStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);
		await commitSession(session, [...laneWrites(null)]);
		storage.block = true;

		const append = session.appendCustomEntry("admitted", undefined, BACKGROUND_CONTEXT);
		while (!storage.admitted) await Promise.resolve();
		const close = session.close(BACKGROUND_CONTEXT);
		storage.release();

		const id = await append;
		await close;
		expect(id).toMatch(/^[0-9a-f-]+$/);
	});

	it("rejects all SessionTree operations after close, including existing views", async () => {
		const session = await createTreeSession();
		const view = session.view("other");
		await session.close(BACKGROUND_CONTEXT);

		const operations: Array<() => Promise<unknown>> = [
			() => session.getLeafId(BACKGROUND_CONTEXT),
			() => view.getEntry(ROOT_ID, BACKGROUND_CONTEXT),
			() => session.getStats(BACKGROUND_CONTEXT),
			() => view.getName(BACKGROUND_CONTEXT),
			() => session.setName("closed", BACKGROUND_CONTEXT),
			() => view.findEntries(undefined, BACKGROUND_CONTEXT),
			() => session.findEntriesOnBranch(undefined, BACKGROUND_CONTEXT),
			() => view.appendCustomEntry("closed", undefined, BACKGROUND_CONTEXT),
		];
		for (const operation of operations) await expect(operation()).rejects.toThrow("Session is closed");
	});
});
