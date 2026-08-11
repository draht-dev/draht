import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	Register,
	RegisterNamespace,
	SessionStats,
	Storage,
	StorageBranchScan,
	Transaction,
	UsageRow,
	UsageScan,
} from "../types.ts";

/** A deeply detached, mutable transaction snapshot captured at commit admission. */
export type RecordedCommitAttempt = Transaction;

/** Test-only transparent Storage decorator that records commit admission. */
export class InstrumentedStorage implements Storage {
	private readonly delegate: Storage;
	private readonly commitAttempts: Transaction[] = [];

	constructor(delegate: Storage) {
		this.delegate = delegate;
	}

	/** Returns a readonly list of freshly cloned, mutable attempt snapshots. */
	getCommitAttempts(): readonly RecordedCommitAttempt[] {
		return structuredClone(this.commitAttempts);
	}

	clearCommitAttempts(): void {
		this.commitAttempts.length = 0;
	}

	/** Clone failure rejects without recording or admitting the transaction to the delegate. */
	commit(transaction: Transaction): Promise<CommitResult> {
		let snapshot: Transaction;
		try {
			snapshot = structuredClone(transaction);
		} catch (error) {
			return Promise.reject(error);
		}
		this.commitAttempts.push(snapshot);
		return this.delegate.commit(transaction);
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		return this.delegate.getEntries(ids);
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		return this.delegate.getRegister(namespace, key);
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]> {
		return this.delegate.listRegisters(namespace, keyPrefix);
	}

	scanBranch(query: StorageBranchScan): Promise<Entry[]> {
		return this.delegate.scanBranch(query);
	}

	scanBranchStructure(query: StorageBranchScan): Promise<EntryStructure[]> {
		return this.delegate.scanBranchStructure(query);
	}

	scanEntries(query: EntryScan): Promise<Entry[]> {
		return this.delegate.scanEntries(query);
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		return this.delegate.scanUsage(query);
	}

	getStats(): Promise<SessionStats> {
		return this.delegate.getStats();
	}

	close(): Promise<void> {
		return this.delegate.close();
	}
}
