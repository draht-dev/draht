import type { AssistantMessage } from "@draht/ai";
import { describe, expect, it } from "vitest";
import type { CustomMessage } from "../../src/harness/messages.ts";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type {
	MessageEntry,
	NewEntry,
	Session,
	SessionMetadata,
	SessionMutator,
	Write,
} from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";

const NOW = 1_700_000_000_000;
const ENTRY_ID = "00000000-0000-7000-8000-000000000001";
const metadata = {
	id: "session",
	createdAt: NOW,
	storageVersion: 1,
	cwd: "/workspace",
} satisfies SessionMetadata;

function commitSession(session: Session, transaction: Write[]) {
	return session.mutate("main", (mutator) => mutator.commit(transaction));
}

describe("StorageBackedSession", () => {
	it("delegates typed values directly without validation or cloning", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const data = { nested: ["original"] };
		const transaction: Write[] = [
			sessionWrites.insertEntry({ id: ENTRY_ID, parentId: null, type: "custom", customType: "note", data }),
			storedValues.setValue(storedValues.value<unknown>("test.value", "state"), data),
		];

		const result = await commitSession(session, transaction);

		expect(storage.getCommitAttempts()[0]).toBe(transaction);
		const entry = (await session.getEntries([ENTRY_ID])).get(ENTRY_ID);
		expect(entry).toMatchObject({ seq: result.seqs[0], timestamp: NOW });
		if (entry?.type !== "custom") throw new Error("Expected custom entry");
		expect(entry.data).toBe(data);
		expect((await session.getValue(storedValues.value<unknown>("test.value", "state")))?.value).toBe(data);
		await session.close();
	});

	it("composes bound values and lists atomically with entries and usage", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const scalar = storedValues.value<string>("test.application.scalar");
		const events = storedValues.list<string>("test.application.events");

		const result = await session.mutate("main", (mutator) =>
			mutator.commit([
				sessionWrites.insertEntry({ id: ENTRY_ID, parentId: null, type: "custom", customType: "note" }),
				storedValues.setValue(scalar, "state"),
				storedValues.appendList(events, "event"),
				sessionWrites.insertUsage({
					id: "usage",
					adjustment: false,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			]),
		);

		expect(result.seqs).toHaveLength(4);
		expect((await session.getValue(scalar))?.seq).toBe(result.seqs[1]);
		expect(await session.readList(events)).toEqual([{ seq: result.seqs[2], value: "event" }]);
		expect(storage.getCommitAttempts()).toHaveLength(1);
		await session.close();
	});

	it("rejects pending assistant entries at the durable session write boundary", async () => {
		const storage = new InstrumentedStorage(new MemoryStorage({ now: () => NOW }));
		const session = new StorageBackedSession(metadata, storage);
		const pending: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: NOW,
		};

		await expect(
			commitSession(session, [
				sessionWrites.insertEntry({ id: ENTRY_ID, parentId: null, type: "message", message: pending }),
			]),
		).rejects.toThrow("Cannot persist a pending assistant message");
		expect(storage.getCommitAttempts()).toEqual([]);
		expect(await session.getEntries([ENTRY_ID])).toEqual(new Map());
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

		const result = await commitSession(session, [sessionWrites.insertEntry(entry)]);

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
			expect(await mutator.getValue(storedValues.sessionName)).toBeUndefined();
			await mutator.commit([storedValues.setValue(storedValues.sessionName, "committed")]);
			await expect(mutator.commit([])).rejects.toThrow("commit already attempted");
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
		const transaction = [
			sessionWrites.insertEntry({ id: ENTRY_ID, parentId: "missing", type: "custom", customType: "note" }),
		] satisfies Write[];

		await expect(
			session.mutate("main", async (mutator) => {
				await expect(mutator.commit(transaction)).rejects.toThrow("Missing parent entry");
				await expect(mutator.commit([])).rejects.toThrow("commit already attempted");
			}),
		).resolves.toBeUndefined();
		expect(storage.getCommitAttempts()).toHaveLength(1);
		await session.close();
	});

	it("mints distinct follower ids with the leader timestamp", async () => {
		const session = new StorageBackedSession(metadata, new MemoryStorage({ now: () => NOW }));
		const leaderTimestamp = 0x0123456789ab;
		const leader = session.idGenerator.next(leaderTimestamp);
		const followers = [session.idGenerator.next(leaderTimestamp), session.idGenerator.next(leaderTimestamp)];
		const decodeTimestamp = (id: string): number => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

		expect([leader, ...followers].map(decodeTimestamp)).toEqual([leaderTimestamp, leaderTimestamp, leaderTimestamp]);
		expect(new Set([leader, ...followers])).toHaveLength(3);
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
		await expect(session.getValue(storedValues.sessionName)).rejects.toThrow("Session is closed");
		await expect(session.scanValues(storedValues.sessionName)).rejects.toThrow("Session is closed");
	});
});
