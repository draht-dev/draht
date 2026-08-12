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

/** Test-only forwarding base for decorators that alter one part of Storage behavior. */
export class StorageDecorator implements Storage {
	protected readonly delegate: Storage;

	constructor(delegate: Storage) {
		this.delegate = delegate;
	}

	commit(transaction: Transaction): Promise<CommitResult> {
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
