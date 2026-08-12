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

/** A transaction captured at commit admission. */
export type RecordedCommitAttempt = Transaction;

/** Test-only transparent Storage decorator that records commit admission. */
export class InstrumentedStorage implements Storage {
	private readonly delegate: Storage;
	private readonly commitAttempts: Transaction[] = [];

	constructor(delegate: Storage) {
		this.delegate = delegate;
	}

	getCommitAttempts(): readonly RecordedCommitAttempt[] {
		return this.commitAttempts.slice();
	}

	clearCommitAttempts(): void {
		this.commitAttempts.length = 0;
	}

	commit(transaction: Transaction): Promise<CommitResult> {
		this.commitAttempts.push(transaction);
		return this.delegate.commit(transaction);
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
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
