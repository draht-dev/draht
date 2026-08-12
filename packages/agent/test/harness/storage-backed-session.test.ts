import Type from "typebox";
import { describe, expect, it } from "vitest";
import type { CustomMessage } from "../../src/harness/messages.ts";
import { SessionCodecError } from "../../src/harness/session/codec.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type {
	MessageEntry,
	NewEntry,
	RegisterNamespace,
	SessionMetadata,
	Transaction,
} from "../../src/harness/session/types.ts";

const NOW = 1_700_000_000_000;
const ENTRY_ID = "00000000-0000-7000-8000-000000000001";
const OTHER_ID = "00000000-0000-7000-8000-000000000002";
const REQUESTED_ID = "00000000-0000-7000-8000-000000000003";
const MISSING_ID = "00000000-0000-7000-8000-000000000004";
const metadata = {
	id: "session",
	createdAt: NOW,
	storageVersion: 1,
	cwd: "/workspace",
} satisfies SessionMetadata;

function uuidTimestamp(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

class MisdirectingStorage extends MemoryStorage {
	override async getEntries(ids: string[]) {
		const entry = (await super.getEntries([OTHER_ID])).get(OTHER_ID);
		if (entry === undefined) throw new Error("Missing test entry");
		return new Map([[ids[0] === REQUESTED_ID ? REQUESTED_ID : OTHER_ID, entry]]);
	}

	override getRegister<TNamespace extends RegisterNamespace>(namespace: TNamespace, _key: string) {
		return super.getRegister(namespace, "other");
	}

	override listRegisters<TNamespace extends RegisterNamespace>(namespace: TNamespace, _keyPrefix?: string) {
		return super.listRegisters(namespace);
	}
}

describe("StorageBackedSession", () => {
	it("validates, detaches, persists, and decodes durable values", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);
		const data = { nested: ["original"] };
		const transaction: Transaction = {
			writes: [
				{ kind: "entry", entry: { id: ENTRY_ID, parentId: null, type: "custom", customType: "note", data } },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "state", value: data },
			],
		};

		const commit = session.commit(transaction);
		data.nested[0] = "mutated";
		const result = await commit;

		const entries = await session.getEntries([ENTRY_ID]);
		expect(entries.get(ENTRY_ID)).toEqual({
			id: ENTRY_ID,
			parentId: null,
			type: "custom",
			customType: "note",
			data: { nested: ["original"] },
			seq: result.seqs[0],
			timestamp: NOW,
		});
		expect(await session.getRegister("fact.custom", "state")).toEqual({
			namespace: "fact.custom",
			key: "state",
			value: { nested: ["original"] },
			seq: result.seqs[1],
		});

		const entry = entries.get(ENTRY_ID);
		if (
			entry?.type !== "custom" ||
			entry.data === undefined ||
			entry.data === null ||
			typeof entry.data !== "object" ||
			Array.isArray(entry.data)
		) {
			throw new Error("Expected custom entry data");
		}
		const entryNested = entry.data.nested;
		if (!Array.isArray(entryNested)) throw new Error("Expected custom entry nested array");
		entryNested[0] = "observed mutation";
		const register = await session.getRegister("fact.custom", "state");
		if (
			register === undefined ||
			register.value === null ||
			typeof register.value !== "object" ||
			Array.isArray(register.value)
		) {
			throw new Error("Expected custom fact object");
		}
		const registerNested = register.value.nested;
		if (!Array.isArray(registerNested)) throw new Error("Expected custom fact nested array");
		registerNested[0] = "observed mutation";

		expect((await session.getEntries([ENTRY_ID])).get(ENTRY_ID)).toMatchObject({
			data: { nested: ["original"] },
		});
		expect(await session.getRegister("fact.custom", "state")).toMatchObject({
			value: { nested: ["original"] },
		});
		await session.close();
	});

	it("rejects invalid transactions before storage admission", async () => {
		const delegate = new MemoryStorage({ now: () => NOW });
		const storage = new InstrumentedStorage(delegate);
		const session = new StorageBackedSession(metadata, storage);
		const invalid = {
			writes: [
				{
					kind: "entry",
					entry: {
						id: ENTRY_ID,
						parentId: null,
						type: "message",
						message: { role: "unknown", content: "bad", timestamp: NOW },
					},
				},
			],
		} as unknown as Transaction;

		await expect(session.commit(invalid)).rejects.toBeInstanceOf(SessionCodecError);
		expect(storage.getCommitAttempts()).toEqual([]);
		await session.close();
	});

	it("rejects non-UUIDv7 durable identities before storage admission", async () => {
		const delegate = new MemoryStorage({ now: () => NOW });
		const storage = new InstrumentedStorage(delegate);
		const session = new StorageBackedSession(metadata, storage);
		const transaction: Transaction = {
			writes: [{ kind: "entry", entry: { id: "entry", parentId: null, type: "custom", customType: "note" } }],
		};

		await expect(session.commit(transaction)).rejects.toBeInstanceOf(SessionCodecError);
		expect(storage.getCommitAttempts()).toEqual([]);
		await session.close();
	});

	it("applies custom message schemas at the storage boundary", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage, {
			customMessageSchemas: {
				custom: Type.Object(
					{
						role: Type.Literal("custom"),
						customType: Type.String(),
						content: Type.String(),
						display: Type.Boolean(),
						timestamp: Type.Integer(),
					},
					{ additionalProperties: false },
				),
			},
		});
		const message: CustomMessage = {
			role: "custom",
			customType: "notice",
			content: "maintenance",
			display: true,
			timestamp: NOW,
		};
		const entry: NewEntry<MessageEntry> = { id: ENTRY_ID, parentId: null, type: "message", message };

		const result = await session.commit({ writes: [{ kind: "entry", entry }] });

		expect((await session.getEntries([ENTRY_ID])).get(ENTRY_ID)).toEqual({
			...entry,
			seq: result.firstSeq,
			timestamp: result.timestamp,
		});
		await session.close();
	});

	it("rejects corrupted entries and registers returned by storage", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{
					kind: "entry",
					entry: { id: ENTRY_ID, parentId: null, type: "custom" },
				} as unknown as Transaction["writes"][number],
				{
					kind: "register",
					op: "set",
					namespace: "fact.name",
					key: "",
					value: 42,
				} as unknown as Transaction["writes"][number],
			],
		});
		const session = new StorageBackedSession(metadata, storage);

		await expect(session.getEntries([ENTRY_ID])).rejects.toBeInstanceOf(SessionCodecError);
		await expect(session.getRegister("fact.name", "")).rejects.toBeInstanceOf(SessionCodecError);
		await expect(session.listRegisters("fact.name")).rejects.toBeInstanceOf(SessionCodecError);
		await session.close();
	});

	it("rejects storage results that do not match their lookup", async () => {
		const storage = new MisdirectingStorage({ now: () => NOW });
		await storage.commit({
			writes: [
				{ kind: "entry", entry: { id: OTHER_ID, parentId: null, type: "custom", customType: "note" } },
				{ kind: "register", op: "set", namespace: "fact.custom", key: "other", value: null },
			],
		});
		const session = new StorageBackedSession(metadata, storage);

		await expect(session.getEntries([MISSING_ID])).rejects.toThrow("not requested");
		await expect(session.getEntries([REQUESTED_ID])).rejects.toThrow("storage map key");
		await expect(session.getRegister("fact.custom", "requested")).rejects.toThrow("requested key");
		await expect(session.listRegisters("fact.custom", "prefix")).rejects.toThrow("requested prefix");
		await session.close();
	});

	it("exposes detached metadata and the shared UUIDv7 id generator", async () => {
		const sourceMetadata = { ...metadata };
		const session = new StorageBackedSession(sourceMetadata, new MemoryStorage({ now: () => NOW }));
		sourceMetadata.cwd = "/mutated";

		expect(session.metadata).toEqual(metadata);
		expect(uuidTimestamp(session.idGenerator.next(NOW - 1))).toBe(NOW - 1);
		await session.close();
	});

	it("closes idempotently and rejects operations not admitted before close", async () => {
		const storage = new MemoryStorage({ now: () => NOW });
		const session = new StorageBackedSession(metadata, storage);

		await Promise.all([session.close(), session.close()]);
		await expect(session.commit({ writes: [] })).rejects.toThrow("Session is closed");
		await expect(session.getEntries([])).rejects.toThrow("Session is closed");
		await expect(session.getRegister("fact.name", "")).rejects.toThrow("Session is closed");
		await expect(session.listRegisters("fact.name")).rejects.toThrow("Session is closed");
	});
});
