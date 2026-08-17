import { describe, expect, it, vi } from "vitest";
import * as sessionWrites from "../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import type { CommitResult, Write } from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";

class ControlledCommitStorage extends MemoryStorage {
	private readonly pending: Array<{
		resolve: (result: CommitResult) => void;
		reject: (error: unknown) => void;
	}> = [];
	private latestCommit: Promise<CommitResult> | undefined;

	override commit(_transaction: Write[]): Promise<CommitResult> {
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
		const firstTransaction: Write[] = [storedValues.setValue(storedValues.sessionName, "first")];
		const secondTransaction: Write[] = [storedValues.setValue(storedValues.sessionName, "second")];

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
	it("records the transaction reference passed to the delegate", async () => {
		const delegate = new ControlledCommitStorage();
		const storage = new InstrumentedStorage(delegate);
		const transaction: Write[] = [storedValues.setValue(storedValues.sessionName, "value")];

		const commit = storage.commit(transaction);
		expect(storage.getCommitAttempts()[0]).toBe(transaction);
		delegate.resolveNextCommit({ firstSeq: 1, seqs: [1], timestamp: 10 });
		await commit;
		await storage.close();
	});

	it("clears recorded attempts between phases without affecting the delegate", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const storage = new InstrumentedStorage(delegate);
		await storage.commit([storedValues.setValue(storedValues.sessionName, "first")]);

		storage.clearCommitAttempts();
		expect(storage.getCommitAttempts()).toEqual([]);
		expect(await storage.getValue(storedValues.sessionName)).toMatchObject({ value: "first" });

		const secondTransaction: Write[] = [storedValues.setValue(storedValues.sessionName, "second")];
		await storage.commit(secondTransaction);
		expect(storage.getCommitAttempts()).toEqual([secondTransaction]);
		await storage.close();
	});

	it("delegates every read and query without recording synthetic writes", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const storage = new InstrumentedStorage(delegate);
		const events = storedValues.list<string>("test.events");
		await storage.commit([
			sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "note" }),
			storedValues.setValue(storedValues.sessionName, "session"),
			storedValues.appendList(events, "event"),
			sessionWrites.insertUsage({
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
			}),
		]);

		expect(await storage.getEntries(["root"])).toEqual(await delegate.getEntries(["root"]));
		expect(await storage.getValue(storedValues.sessionName)).toEqual(
			await delegate.getValue(storedValues.sessionName),
		);
		expect(await storage.scanValues(storedValues.sessionName)).toEqual(
			await delegate.scanValues(storedValues.sessionName),
		);
		expect(await storage.readList(events)).toEqual(await delegate.readList(events));
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

	it("records list appends without reading the target list", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const readList = vi.spyOn(delegate, "readList");
		const storage = new InstrumentedStorage(delegate);
		const events = storedValues.list<string>("test.events");

		await storage.commit([storedValues.appendList(events, "event")]);

		expect(readList).not.toHaveBeenCalled();
		expect(storage.getCommitAttempts()).toEqual([
			[{ kind: "list", op: "append", namespace: "test.events", key: "", value: "event" }],
		]);
		await storage.close();
	});

	it("delegates close idempotence and admitted commit draining", async () => {
		const delegate = new MemoryStorage({ now: () => 100 });
		const storage = new InstrumentedStorage(delegate);
		const admitted = storage.commit([storedValues.setValue(storedValues.sessionName, "admitted")]);

		const firstClose = storage.close();
		const secondClose = storage.close();
		await admitted;
		await Promise.all([firstClose, secondClose]);
		await expect(storage.getStats()).rejects.toThrow("MemoryStorage is closed");
		expect(storage.getCommitAttempts()).toHaveLength(1);
	});
});
