import {
	type LeafEntry,
	type SessionEntryCursorOptions,
	SessionError,
	type SessionMetadata,
	type SessionSnapshot,
	type SessionStorage,
	type SessionStore,
	type SessionTreeEntry,
} from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import {
	createSessionId,
	createSessionRepository,
	createTimestamp,
	getEntriesToFork,
	type SessionRepository,
} from "./repo-utils.ts";
import { createScanningSessionSearch } from "./search-backend.ts";

export type InMemorySessionCreateOptions = { id?: string };

class InMemorySessionStore implements SessionStore<SessionMetadata, InMemorySessionCreateOptions, void> {
	private sessions = new Map<string, InMemorySessionStorage<SessionMetadata>>();

	async create(options: InMemorySessionCreateOptions = {}): Promise<SessionMetadata> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		this.sessions.set(metadata.id, storage);
		return metadata;
	}

	async open(metadata: SessionMetadata): Promise<SessionStorage<SessionMetadata>> {
		const storage = this.sessions.get(metadata.id);
		if (!storage) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return storage;
	}

	async load(metadata: SessionMetadata): Promise<SessionSnapshot<SessionMetadata>> {
		const storage = await this.open(metadata);
		return {
			metadata: await storage.getMetadata(),
			leafId: await storage.getLeafId(),
			entries: await storage.getEntries(),
		};
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((storage) => storage.getMetadata()));
	}

	async getEntries(metadata: SessionMetadata, options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return await (await this.open(metadata)).getEntries(options);
	}

	async createEntryId(metadata: SessionMetadata): Promise<string> {
		return (await this.open(metadata)).createEntryId();
	}

	async appendEntry(metadata: SessionMetadata, entry: SessionTreeEntry): Promise<void> {
		await (await this.open(metadata)).appendEntry(entry);
	}

	async setLeafId(metadata: SessionMetadata, leafId: string | null): Promise<LeafEntry> {
		return await (await this.open(metadata)).setLeafId(leafId);
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	async fork(
		sourceMetadata: SessionMetadata,
		options: { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<SessionMetadata> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source, options);
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
		this.sessions.set(metadata.id, storage);
		return metadata;
	}
}

export function createInMemorySessionStore(): SessionStore<SessionMetadata, InMemorySessionCreateOptions, void> {
	return new InMemorySessionStore();
}

export function createInMemorySessionRepository(): SessionRepository<
	SessionMetadata,
	InMemorySessionCreateOptions,
	void
> {
	const store = createInMemorySessionStore();
	return createSessionRepository({ store, search: createScanningSessionSearch(store) });
}
