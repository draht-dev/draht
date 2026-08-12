import { describe, expect, it } from "vitest";
import type { CustomMessage } from "../../src/harness/messages.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type {
	MessageEntry,
	NewEntry,
	Session,
	SessionMetadata,
	SessionMutator,
	Transaction,
} from "../../src/harness/session/types.ts";

const NOW = 1_700_000_000_000;
const ENTRY_ID = "00000000-0000-7000-8000-000000000001";
const metadata = {
	id: "session",
	createdAt: NOW,
	storageVersion: 1,
	cwd: "/workspace",
} satisfies SessionMetadata;

function commitSession(session: Session, transaction: Transaction) {
	return session.mutate("main", (mutator) => mutator.commit(transaction));
}

describe("StorageBackedSession", () => {
	it("delegates typed values directly without validation or cloning", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const data = { nested: ["original"] };
		const transaction: Transaction = {
			writes: [
				{ kind: "entry", entry: { id: ENTRY_ID, parentId: null, type: "custom", customType: "note", data } },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "state", value: data },
			],
		};

		const result = await commitSession(session, transaction);

		expect(storage.getCommitAttempts()[0]).toBe(transaction);
		const entry = (await session.getEntries([ENTRY_ID])).get(ENTRY_ID);
		expect(entry).toMatchObject({ seq: result.seqs[0], timestamp: NOW });
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.data).toBe(data);
		expect((await session.getRegister("fact.custom", "state"))?.value).toBe(data);
		await session.close();
	});

	it("trusts typed custom messages without repository schema registration", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);
		const message: CustomMessage = {
			role: "custom",
			customType: "notice",
			content: "maintenance",
			display: true,
			timestamp: NOW,
		};
		const entry: NewEntry<MessageEntry> = { id: ENTRY_ID, parentId: null, type: "message", message };

		const result = await commitSession(session, { writes: [{ kind: "entry", entry }] });

		expect((await session.getEntries([ENTRY_ID])).get(ENTRY_ID)).toEqual({
			...entry,
			seq: result.firstSeq,
			timestamp: result.timestamp,
		});
		await session.close();
	});

	it("serializes mutations, permits one commit attempt, and invalidates the mutator", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		let captured: SessionMutator | undefined;

		await session.mutate("review", async (mutator) => {
			captured = mutator;
			expect(mutator.lane).toBe("review");
			expect(await mutator.getRegister("fact.name", "")).toBeUndefined();
			await mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "committed" }],
			});
			await expect(mutator.commit({ writes: [] })).rejects.toThrow("commit already attempted");
		});

		expect(storage.getCommitAttempts()).toHaveLength(1);
		expect(await session.getName()).toBe("committed");
		const invalidated = captured;
		if (invalidated === undefined) throw new Error("Expected captured mutator");
		expect(() => invalidated.getEntries([])).toThrow("outside its mutation callback");
		await session.close();
	});

	it("consumes the commit guard when the first commit fails", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const transaction = {
			writes: [{ kind: "entry", entry: { id: ENTRY_ID, parentId: "missing", type: "custom", customType: "note" } }],
		} satisfies Transaction;

		await expect(
			session.mutate("main", async (mutator) => {
				await expect(mutator.commit(transaction)).rejects.toThrow("Missing parent entry");
				await expect(mutator.commit({ writes: [] })).rejects.toThrow("commit already attempted");
			}),
		).resolves.toBeUndefined();
		expect(storage.getCommitAttempts()).toHaveLength(1);
		await session.close();
	});

	it("exposes metadata directly and the shared UUIDv7 id generator", async () => {
		const sourceMetadata = { ...metadata };
		const session = new StorageBackedSession(sourceMetadata, new MemoryStorage({ now: () => NOW }));

		expect(session.metadata).toBe(sourceMetadata);
		expect(session.idGenerator.next()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		await session.close();
	});

	it("closes idempotently and rejects operations not admitted before close", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);

		await Promise.all([session.close(), session.close()]);
		await expect(session.mutate("main", () => undefined)).rejects.toThrow("Session is closed");
		await expect(session.getEntries([])).rejects.toThrow("Session is closed");
		await expect(session.getRegister("fact.name", "")).rejects.toThrow("Session is closed");
		await expect(session.listRegisters("fact.name")).rejects.toThrow("Session is closed");
	});
});
