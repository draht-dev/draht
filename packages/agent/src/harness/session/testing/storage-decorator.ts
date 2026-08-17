import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	SessionStats,
	Storage,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "../types.ts";
import type { ListElement, ListReadOptions, StoredValue, Value, ValueList } from "../values.ts";

/** Test-only forwarding base for decorators that alter one part of Storage behavior. */
export class StorageDecorator implements Storage {
	protected readonly delegate: Storage;

	constructor(delegate: Storage) {
		this.delegate = delegate;
	}

	commit(writes: Write[]): Promise<CommitResult> {
		return this.delegate.commit(writes);
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		return this.delegate.getEntries(ids);
	}

	getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
		return this.delegate.getValue(address);
	}

	scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
		return this.delegate.scanValues(prefix);
	}

	readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]> {
		return this.delegate.readList(address, options);
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
