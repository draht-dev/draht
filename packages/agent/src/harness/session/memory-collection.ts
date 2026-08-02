import type {
	SessionCollection,
	SessionForkSelection,
	SessionMetadata,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { SessionError } from "../types.ts";
import { ArraySessionIndex } from "./array-session-index.ts";
import { readSessionEntriesForFork } from "./fork.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import { createSessionId, createTimestamp } from "./repository.ts";

export type InMemorySessionCreateOptions = { id?: string };

interface InMemorySessionState {
	metadata: SessionMetadata;
	entries: ArraySessionIndex;
}

class InMemorySessionCollection implements SessionCollection<SessionMetadata, InMemorySessionCreateOptions, void> {
	private readonly sessions = new Map<string, InMemorySessionState>();
	private readonly operations = new KeyedOperationQueue<string>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	create(options: InMemorySessionCreateOptions = {}): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		return this.operations.enqueue(id, () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new ArraySessionIndex(),
			};
			this.sessions.set(id, state);
			return this.storage(state);
		});
	}

	open(metadata: SessionMetadata): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => this.storage(this.getState(metadata)));
	}

	list(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => [...this.sessions.values()].map((state) => state.metadata));
	}

	delete(metadata: SessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.sessions.delete(metadata.id);
		});
	}

	fork(
		source: SessionMetadata,
		options: InMemorySessionCreateOptions,
		selection: SessionForkSelection,
	): Promise<SessionStorage<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		const sourceEntries = this.operations.enqueue(source.id, () =>
			readSessionEntriesForFork(this.getState(source).entries, selection),
		);
		return this.operations.enqueue(id, async () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: new ArraySessionIndex(await sourceEntries),
			};
			this.sessions.set(id, state);
			return this.storage(state);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	private storage(state: InMemorySessionState): SessionStorage<SessionMetadata> {
		const read = <T>(operation: (entries: ArraySessionIndex) => T): Promise<T> => {
			this.assertOpen();
			return this.operations.enqueue(state.metadata.id, () => operation(this.getState(state.metadata).entries));
		};
		return {
			metadata: state.metadata,
			readHead: () => read((entries) => entries.readHead()),
			readEntry: (id) => read((entries) => entries.readEntry(id)),
			readEntries: (options) => read((entries) => entries.readEntries(options)),
			appendEntry: (entry) => this.appendEntry(state.metadata, entry),
			findEntriesOnBranch: (query) => read((entries) => entries.findEntriesOnBranch(query)),
			readPathToRootOrCompaction: (leafId) => read((entries) => entries.readPathToRootOrCompaction(leafId)),
			getLabel: (id) => read((entries) => entries.getLabel(id)),
			getName: () => read((entries) => entries.getName()),
			getStats: () => read((entries) => entries.getStats()),
		};
	}

	private appendEntry(metadata: SessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.getState(metadata).entries.append(entry);
		});
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "In-memory session collection is disposed");
	}

	private getState(metadata: SessionMetadata): InMemorySessionState {
		const state = this.sessions.get(metadata.id);
		if (!state) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return state;
	}
}

export function createInMemorySessionCollection(): SessionCollection<
	SessionMetadata,
	InMemorySessionCreateOptions,
	void
> {
	return new InMemorySessionCollection();
}
