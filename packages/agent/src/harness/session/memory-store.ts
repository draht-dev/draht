import type { SessionMetadata, SessionSnapshot, SessionStore, SessionTreeEntry } from "../types.ts";
import { SessionError } from "../types.ts";
import { KeyedOperationQueue } from "./keyed-operation-queue.ts";
import { createSessionId, createTimestamp } from "./repository.ts";

export type InMemorySessionCreateOptions = { id?: string };

interface InMemorySessionState {
	metadata: SessionMetadata;
	entries: SessionTreeEntry[];
}

class InMemorySessionStore implements SessionStore<SessionMetadata, InMemorySessionCreateOptions, void> {
	private readonly sessions = new Map<string, InMemorySessionState>();
	private readonly operations = new KeyedOperationQueue<string>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	create(options: InMemorySessionCreateOptions = {}): Promise<SessionSnapshot<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		return this.operations.enqueue(id, () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: [],
			};
			this.sessions.set(state.metadata.id, state);
			return this.snapshot(state);
		});
	}

	load(metadata: SessionMetadata): Promise<SessionSnapshot<SessionMetadata>> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => this.snapshot(this.getState(metadata)));
	}

	list(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return this.operations.enqueueBarrier(() => [...this.sessions.values()].map((state) => state.metadata));
	}

	appendEntry(metadata: SessionMetadata, entry: SessionTreeEntry): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			const state = this.getState(metadata);
			if (state.entries.some((existing) => existing.id === entry.id)) {
				throw new SessionError("invalid_entry", `Entry ${entry.id} already exists`);
			}
			state.entries.push(entry);
		});
	}

	delete(metadata: SessionMetadata): Promise<void> {
		this.assertOpen();
		return this.operations.enqueue(metadata.id, () => {
			this.sessions.delete(metadata.id);
		});
	}

	fork(
		_source: SessionMetadata,
		options: InMemorySessionCreateOptions,
		entries: readonly SessionTreeEntry[],
	): Promise<SessionSnapshot<SessionMetadata>> {
		this.assertOpen();
		const id = options.id ?? createSessionId();
		return this.operations.enqueue(id, () => {
			const state: InMemorySessionState = {
				metadata: { id, createdAt: createTimestamp() },
				entries: [...entries],
			};
			this.sessions.set(state.metadata.id, state);
			return this.snapshot(state);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.disposePromise) {
			this.disposed = true;
			this.disposePromise = this.operations.drain();
		}
		await this.disposePromise;
	}

	private assertOpen(): void {
		if (this.disposed) throw new SessionError("storage", "In-memory session store is disposed");
	}

	private getState(metadata: SessionMetadata): InMemorySessionState {
		const state = this.sessions.get(metadata.id);
		if (!state) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return state;
	}

	private snapshot(state: InMemorySessionState): SessionSnapshot<SessionMetadata> {
		return { metadata: state.metadata, entries: [...state.entries] };
	}
}

export function createInMemorySessionStore(): SessionStore<SessionMetadata, InMemorySessionCreateOptions, void> {
	return new InMemorySessionStore();
}
