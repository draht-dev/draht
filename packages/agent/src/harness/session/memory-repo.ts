import {
	type Session,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
	type SessionSearch,
	type SessionSearchOptions,
} from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import { createSessionId, createTimestamp, getEntriesToFork, toRepoSession } from "./repo-utils.ts";
import { ScanningSessionSearch } from "./search-backend.ts";

export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
	private sessions = new Map<string, Session<SessionMetadata>>();
	private readonly sessionSearch: SessionSearch<SessionMetadata>;

	constructor(options: { search?: SessionSearch<SessionMetadata> } = {}) {
		this.sessionSearch =
			options.search ??
			new ScanningSessionSearch({
				open: (metadata) => this.open(metadata),
				list: () => this.list(),
			});
	}

	async create(options: { id?: string } = {}): Promise<Session<SessionMetadata>> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		const session = await toRepoSession(storage, this.sessionSearch);
		this.sessions.set(metadata.id, session);
		return session;
	}

	async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
		const session = this.sessions.get(metadata.id);
		if (!session) throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		return session;
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((session) => session.getMetadata()));
	}

	async search(options: SessionSearchOptions) {
		return await this.sessionSearch.search(options);
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		await this.sessionSearch.removeSession(metadata);
		this.sessions.delete(metadata.id);
	}

	async fork(
		sourceMetadata: SessionMetadata,
		options: { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<SessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata, entries: forkedEntries });
		await this.sessionSearch.indexSession(metadata, forkedEntries);
		const session = await toRepoSession(storage, this.sessionSearch);
		this.sessions.set(metadata.id, session);
		return session;
	}
}
