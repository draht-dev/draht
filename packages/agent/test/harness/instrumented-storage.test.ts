import { describe, expect, it } from "vitest";
import { type CommitResult, MemoryStorage, type Transaction } from "../../src/harness/session/index.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";

class ControlledCommitStorage extends MemoryStorage {
	private readonly pending: Array<{
		resolve: (result: CommitResult) => void;
		reject: (error: unknown) => void;
	}> = [];
	private latestCommit: Promise<CommitResult> | undefined;

	override commit(_transaction: Transaction): Promise<CommitResult> {
		this.latestCommit = new Promise((resolve, reject) => {
			this.pending.push({ resolve, reject });
		});
		return this.latestCommit;
	}

	get admissionCount(): number {
		return this.pending.length;
	}

	get lastCommit(): Promise<CommitResult> | undefined {
		return this.latestCommit;
	}

	resolveNextCommit(result: CommitResult): void {
		const pending = this.pending.shift();
		if (pending === undefined) throw new Error("No pending commit");
		pending.resolve(result);
	}

	rejectNextCommit(error: unknown): void {
		const pending = this.pending.shift();
		if (pending === undefined) throw new Error("No pending commit");
		pending.reject(error);
	}
}

describe("InstrumentedStorage", () => {
	it("records commit attempts synchronously in admission order before settlement", async () => {
		const delegate = new ControlledCommitStorage();
		const storage = new InstrumentedStorage(delegate);
		const firstTransaction: Transaction = {
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "first" }],
		};
		const secondTransaction: Transaction = {
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "second" }],
		};

		const firstCommit = storage.commit(firstTransaction);
		expect(firstCommit).toBe(delegate.lastCommit);
		expect(storage.getCommitAttempts()).toEqual([firstTransaction]);
		const secondCommit = storage.commit(secondTransaction);
		expect(secondCommit).toBe(delegate.lastCommit);
		expect(storage.getCommitAttempts()).toEqual([firstTransaction, secondTransaction]);

		const firstResult = { firstSeq: 1, seqs: [1], timestamp: 10 };
		delegate.resolveNextCommit(firstResult);
		expect(await firstCommit).toBe(firstResult);
		expect(storage.getCommitAttempts()).toEqual([firstTransaction, secondTransaction]);
		const secondResult = { firstSeq: 2, seqs: [2], timestamp: 20 };
		delegate.resolveNextCommit(secondResult);
		expect(await secondCommit).toBe(secondResult);
		await storage.close();
	});
	it("captures a detached snapshot of a failed commit attempt without replacing its rejection", async () => {
		const delegate = new ControlledCommitStorage();
		const storage = new InstrumentedStorage(delegate);
		const value = { nested: ["original"] };
		const transaction: Transaction = {
			writes: [{ kind: "register", op: "set", namespace: "fact.custom", key: "state", value }],
		};

		const commit = storage.commit(transaction);
		value.nested[0] = "mutated";
		const rejection = new Error("delegate rejection");
		delegate.rejectNextCommit(rejection);

		await expect(commit).rejects.toBe(rejection);
		expect(storage.getCommitAttempts()).toEqual([
			{
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "fact.custom",
						key: "state",
						value: { nested: ["original"] },
					},
				],
			},
		]);
		await storage.close();
	});

	it("returns detached observation snapshots", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const storage = new InstrumentedStorage(delegate);
		await storage.commit({
			writes: [
				{
					kind: "register",
					op: "set",
					namespace: "fact.custom",
					key: "state",
					value: { nested: ["original"] },
				},
			],
		});

		const observed = storage.getCommitAttempts() as Transaction[];
		const write = observed[0]?.writes[0];
		if (write?.kind !== "register" || write.op !== "set" || write.namespace !== "fact.custom") {
			throw new Error("Expected recorded fact.custom set");
		}
		if (write.value === null || Array.isArray(write.value) || typeof write.value !== "object") {
			throw new Error("Expected recorded object value");
		}
		const nested = write.value.nested;
		if (!Array.isArray(nested)) throw new Error("Expected recorded nested array");
		nested[0] = "mutated";
		observed.length = 0;

		expect(storage.getCommitAttempts()).toEqual([
			{
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "fact.custom",
						key: "state",
						value: { nested: ["original"] },
					},
				],
			},
		]);
		await storage.close();
	});

	it("clears recorded attempts between phases without affecting the delegate", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const storage = new InstrumentedStorage(delegate);
		await storage.commit({
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "first" }],
		});

		storage.clearCommitAttempts();
		expect(storage.getCommitAttempts()).toEqual([]);
		expect(await storage.getRegister("fact.name", "")).toMatchObject({ value: "first" });

		const secondTransaction: Transaction = {
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "second" }],
		};
		await storage.commit(secondTransaction);
		expect(storage.getCommitAttempts()).toEqual([secondTransaction]);
		await storage.close();
	});

	it("delegates every read and query without recording synthetic writes", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const storage = new InstrumentedStorage(delegate);
		await storage.commit({
			writes: [
				{ kind: "entry", entry: { id: "root", parentId: null, type: "custom", customType: "note" } },
				{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "session" },
				{
					kind: "usage",
					row: {
						id: "usage",
						adjustment: false,
						usage: {
							input: 1,
							output: 2,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 3,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				},
			],
		});

		expect(await storage.getEntries(["root"])).toEqual(await delegate.getEntries(["root"]));
		expect(await storage.getRegister("fact.name", "")).toEqual(await delegate.getRegister("fact.name", ""));
		expect(await storage.listRegisters("fact.name")).toEqual(await delegate.listRegisters("fact.name"));
		expect(await storage.scanBranch({ start: "root" })).toEqual(await delegate.scanBranch({ start: "root" }));
		expect(await storage.scanBranchStructure({ start: "root" })).toEqual(
			await delegate.scanBranchStructure({ start: "root" }),
		);
		expect(await storage.scanEntries({ order: "asc" })).toEqual(await delegate.scanEntries({ order: "asc" }));
		expect(await storage.scanUsage({ order: "asc" })).toEqual(await delegate.scanUsage({ order: "asc" }));
		expect(await storage.getStats()).toEqual(await delegate.getStats());
		expect(storage.getCommitAttempts()).toHaveLength(1);
		await storage.close();
	});

	it("delegates close idempotence and admitted commit draining", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const storage = new InstrumentedStorage(delegate);
		const admitted = storage.commit({
			writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "admitted" }],
		});

		const firstClose = storage.close();
		const secondClose = storage.close();
		await admitted;
		await Promise.all([firstClose, secondClose]);
		await expect(storage.getStats()).rejects.toThrow("MemoryStorage is closed");
		expect(storage.getCommitAttempts()).toHaveLength(1);
	});

	it("fails before delegate admission when an attempt cannot be cloned", async () => {
		const delegate = new ControlledCommitStorage();
		const storage = new InstrumentedStorage(delegate);
		const transaction = new Proxy<Transaction>(
			{
				writes: [{ kind: "register", op: "set", namespace: "fact.name", key: "", value: "uncloneable" }],
			},
			{},
		);

		await expect(storage.commit(transaction)).rejects.toThrow();
		expect(delegate.admissionCount).toBe(0);
		expect(storage.getCommitAttempts()).toEqual([]);
		await storage.close();
	});
});
