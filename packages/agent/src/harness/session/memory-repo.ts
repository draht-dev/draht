import {
	SessionError,
	type SessionMetadata,
	type SessionSearch,
	type SessionStorage,
	type SessionStore,
} from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import { createSessionId, createTimestamp, getEntriesToFork } from "./repo-utils.ts";
import { ScanningSessionSearch } from "./search-backend.ts";

export class MemorySessionStore implements SessionStore<SessionMetadata, { id?: string }, void> {
	private sessions = new Map<string, InMemorySessionStorage<SessionMetadata>>();
	readonly defaultSearch: SessionSearch<SessionMetadata>;

	constructor() {
		this.defaultSearch = new ScanningSessionSearch({
			open: (metadata) => this.open(metadata),
			list: () => this.list(),
		});
	}

	async create(options: { id?: string } = {}): Promise<SessionStorage<SessionMetadata>> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		this.sessions.set(metadata.id, storage);
		return storage;
	}

	async open(metadata: SessionMetadata): Promise<SessionStorage<SessionMetadata>> {
		const storage = this.sessions.get(metadata.id);
		if (!storage) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return storage;
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((storage) => storage.getMetadata()));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	async fork(
		sourceMetadata: SessionMetadata,
		options: { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<SessionStorage<SessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source, options);
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
		this.sessions.set(metadata.id, storage);
		return storage;
	}
}
