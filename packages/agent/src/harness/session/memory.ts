import { uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../types.ts";
import { createForkSnapshot } from "./fork.ts";
import { StorageBackedSession } from "./session.ts";
import { StorageState, type StorageStateSnapshot } from "./storage-state.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	EntryQuery,
	EntryScan,
	EntryStructure,
	ForkOptions,
	IdGenerator,
	JsonValue,
	LaneConfiguration,
	Session,
	SessionCreateOptions,
	SessionMetadata,
	SessionMutator,
	SessionRepo,
	SessionStats,
	SessionTree,
	Storage,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "./types.ts";
import {
	type ListElement,
	type ListReadOptions,
	laneLeaf,
	laneState,
	type StoredValue,
	setValue as setValueWrite,
	type Value,
	type ValueList,
} from "./values.ts";

export interface MemoryStorageOptions {
	now?: () => number;
}

export interface MemorySessionRepoOptions {
	now?: () => number;
}

export class MemoryStorage implements Storage {
	private readonly now: () => number;
	private storageState = new StorageState();
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(options: MemoryStorageOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	async commit(writes: Write[]): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		const result = this.commitQueue.then(() => {
			const prepared = this.storageState.prepareCommit(writes, this.now());
			this.storageState.applyValidated(prepared.writes);
			return prepared.result;
		});
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(this.storageState.getEntries(ids));
	}

	getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(this.storageState.getValue(address));
	}

	scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(this.storageState.scanValues(prefix));
	}

	async readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		return this.storageState.readList(address, options);
	}

	async scanBranch(query: StorageBranchScan): Promise<Entry[]> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		return this.storageState.scanBranch(query);
	}

	async scanBranchStructure(query: StorageBranchScan): Promise<EntryStructure[]> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		return this.storageState.scanBranchStructure(query);
	}

	scanEntries(query: EntryScan): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(this.storageState.scanEntries(query));
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(this.storageState.scanUsage(query));
	}

	getStats(): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(this.storageState.getStats());
	}

	/** Capture the current stores at one serialized boundary between commits. */
	snapshot(): Promise<{
		entries: Entry[];
		scalarValues: StoredValue<unknown>[];
		listValues: StorageStateSnapshot["listValues"];
	}> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const result = this.commitQueue.then(() => {
			const snapshot = this.storageState.snapshot();
			return {
				entries: [...snapshot.entries.values()].sort((left, right) => left.seq - right.seq),
				scalarValues: snapshot.scalarValues,
				listValues: snapshot.listValues,
			};
		});
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}

	static fromSnapshot(options: MemoryStorageOptions, snapshot: StorageStateSnapshot): MemoryStorage {
		const storage = new MemoryStorage(options);
		storage.storageState = new StorageState(snapshot);
		return storage;
	}
}

const MEMORY_STORAGE_VERSION = 1;

interface MemorySessionRecord {
	metadata: SessionMetadata;
	storage: MemoryStorage;
	session: StorageBackedSession;
	open: boolean;
}

class MemorySessionFacade implements Session {
	readonly metadata: SessionMetadata;
	readonly idGenerator: IdGenerator;
	private readonly session: StorageBackedSession;
	private readonly onClose: () => void;
	private readonly admitted = new Set<Promise<unknown>>();
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(session: StorageBackedSession, onClose: () => void) {
		this.session = session;
		this.metadata = session.metadata;
		this.idGenerator = session.idGenerator;
		this.onClose = onClose;
	}

	async mutate<T>(lane: string, mutation: (mutator: SessionMutator) => T | Promise<T>): Promise<T> {
		return this.admit(() => this.session.mutate(lane, mutation));
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		return this.admit(() => this.session.getEntries(ids));
	}

	getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
		return this.admit(() => this.session.getValue(address));
	}

	scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
		return this.admit(() => this.session.scanValues(prefix));
	}

	readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]> {
		return this.admit(() => this.session.readList(address, options));
	}

	view(lane: string): SessionTree {
		const view = this.session.view(lane);
		return {
			getLeafId: () => this.admit(() => view.getLeafId()),
			getEntry: (id) => this.admit(() => view.getEntry(id)),
			getStats: () => this.admit(() => view.getStats()),
			getValue: (address) => this.admit(() => view.getValue(address)),
			scanValues: (prefix) => this.admit(() => view.scanValues(prefix)),
			readList: (address, options) => this.admit(() => view.readList(address, options)),
			setValue: (address, next) => this.admit(() => view.setValue(address, next)),
			deleteValue: (address) => this.admit(() => view.deleteValue(address)),
			appendList: (address, element) => this.admit(() => view.appendList(address, element)),
			deleteList: (address) => this.admit(() => view.deleteList(address)),
			getName: () => this.admit(() => view.getName()),
			setName: (name) => this.admit(() => view.setName(name)),
			getLabel: (targetId) => this.admit(() => view.getLabel(targetId)),
			setLabel: (targetId, label) => this.admit(() => view.setLabel(targetId, label)),
			findEntries: (query) => this.admit(() => view.findEntries(query)),
			findEntry: (query) => this.admit(() => view.findEntry(query)),
			findEntriesOnBranch: (query) => this.admit(() => view.findEntriesOnBranch(query)),
			findEntryOnBranch: (query) => this.admit(() => view.findEntryOnBranch(query)),
			appendMessage: (message) => this.admit(() => view.appendMessage(message)),
			appendCustomEntry: (customType, data) => this.admit(() => view.appendCustomEntry(customType, data)),
		};
	}

	createLane(name: string, at: string | null, configuration: LaneConfiguration): Promise<SessionTree> {
		return this.admit(async () => {
			await this.session.createLane(name, at, configuration);
			return this.view(name);
		});
	}

	getLeafId(): Promise<string | null> {
		return this.admit(() => this.session.getLeafId());
	}

	getEntry(id: string): Promise<Entry | undefined> {
		return this.admit(() => this.session.getEntry(id));
	}

	getStats(): Promise<SessionStats> {
		return this.admit(() => this.session.getStats());
	}

	setValue<T>(address: Value<T>, next: NoInfer<T>): Promise<void> {
		return this.admit(() => this.session.setValue(address, next));
	}

	deleteValue<T>(address: Value<T>): Promise<void> {
		return this.admit(() => this.session.deleteValue(address));
	}

	appendList<T>(address: ValueList<T>, element: NoInfer<T>): Promise<void> {
		return this.admit(() => this.session.appendList(address, element));
	}

	deleteList<T>(address: ValueList<T>): Promise<void> {
		return this.admit(() => this.session.deleteList(address));
	}

	getName(): Promise<string | undefined> {
		return this.admit(() => this.session.getName());
	}

	setName(name: string | undefined): Promise<void> {
		return this.admit(() => this.session.setName(name));
	}

	getLabel(targetId: string): Promise<string | undefined> {
		return this.admit(() => this.session.getLabel(targetId));
	}

	setLabel(targetId: string, label: string | undefined): Promise<void> {
		return this.admit(() => this.session.setLabel(targetId, label));
	}

	findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.admit(() => this.session.findEntries(query));
	}

	findEntry(query?: EntryQuery): Promise<Entry | undefined> {
		return this.admit(() => this.session.findEntry(query));
	}

	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]> {
		return this.admit(() => this.session.findEntriesOnBranch(query));
	}

	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined> {
		return this.admit(() => this.session.findEntryOnBranch(query));
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.admit(() => this.session.appendMessage(message));
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.admit(() => this.session.appendCustomEntry(customType, data));
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = Promise.allSettled([...this.admitted]).then(() => {
			this.state = "closed";
			this.onClose();
		});
		return this.closePromise;
	}

	private admit<T>(operation: () => Promise<T>): Promise<T> {
		if (this.state !== "open") return Promise.reject(this.closedError);
		let result: Promise<T>;
		try {
			result = operation();
		} catch (error) {
			result = Promise.reject(error);
		}
		this.admitted.add(result);
		void result.then(
			() => this.admitted.delete(result),
			() => this.admitted.delete(result),
		);
		return result;
	}
}

export class MemorySessionRepo implements SessionRepo {
	private readonly now: () => number;
	private readonly sessions = new Map<string, MemorySessionRecord>();
	private readonly pendingIds = new Set<string>();
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: MemorySessionRepoOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	async create(options: SessionCreateOptions): Promise<Session> {
		this.assertOpen();
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const metadata: SessionMetadata = {
			id,
			createdAt,
			storageVersion: MEMORY_STORAGE_VERSION,
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
		};
		const storage = new MemoryStorage({ now: this.now });
		const session = new StorageBackedSession(metadata, storage);
		try {
			await session.mutate("main", (mutator) =>
				mutator.commit([
					setValueWrite(laneLeaf("main"), null),
					setValueWrite(laneState("main"), { currentOperationId: null, pendingNextRun: [] }),
				]),
			);
			const record: MemorySessionRecord = { metadata, storage, session, open: true };
			this.sessions.set(id, record);
			return this.openRecord(record);
		} catch (error) {
			await session.close();
			throw error;
		} finally {
			this.pendingIds.delete(id);
		}
	}

	open(metadata: SessionMetadata): Promise<Session> {
		// Memory sessions are always created at the current storage version, so
		// persistent-backend version gating does not apply here.
		this.assertOpen();
		const record = this.sessions.get(metadata.id);
		if (record === undefined) return Promise.reject(new Error(`Unknown session: ${metadata.id}`));
		if (record.open) return Promise.reject(new Error(`Session is already open: ${metadata.id}`));
		record.open = true;
		return Promise.resolve(this.openRecord(record));
	}

	list(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return Promise.resolve([...this.sessions.values()].map(({ metadata }) => metadata));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		this.assertOpen();
		const record = this.sessions.get(metadata.id);
		if (record === undefined) throw new Error(`Unknown session: ${metadata.id}`);
		if (record.open) throw new Error(`Session is open: ${metadata.id}`);
		await record.session.close();
		this.sessions.delete(metadata.id);
	}

	async fork(source: SessionMetadata, options: ForkOptions): Promise<Session> {
		this.assertOpen();
		const sourceRecord = this.sessions.get(source.id);
		if (sourceRecord === undefined) throw new Error(`Unknown session: ${source.id}`);
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);

		try {
			const snapshot = createForkSnapshot(await sourceRecord.storage.snapshot(), options);
			const storage = MemoryStorage.fromSnapshot({ now: this.now }, snapshot);
			const metadata: SessionMetadata = {
				id,
				createdAt,
				storageVersion: MEMORY_STORAGE_VERSION,
				parentSessionId: sourceRecord.metadata.id,
			};
			const session = new StorageBackedSession(metadata, storage);
			const record: MemorySessionRecord = { metadata, storage, session, open: true };
			this.sessions.set(id, record);
			return this.openRecord(record);
		} finally {
			this.pendingIds.delete(id);
		}
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		this.closePromise = Promise.all([...this.sessions.values()].map(({ session }) => session.close())).then(
			() => undefined,
		);
		return this.closePromise;
	}

	private openRecord(record: MemorySessionRecord): Session {
		return new MemorySessionFacade(record.session, () => {
			record.open = false;
		});
	}

	private reserveId(id: string): void {
		if (this.sessions.has(id) || this.pendingIds.has(id)) throw new Error(`Session already exists: ${id}`);
		this.pendingIds.add(id);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemorySessionRepo is closed");
	}
}
