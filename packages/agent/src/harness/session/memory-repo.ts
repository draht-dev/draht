import {
	type Session,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
	type SessionSearchHit,
	type SessionSearchOptions,
} from "../types.ts";
import { InMemorySessionStorage } from "./memory-storage.ts";
import {
	createSessionId,
	createTimestamp,
	findSessionEntryMatches,
	getEntriesToFork,
	toSession,
} from "./repo-utils.ts";

export class InMemorySessionRepo implements SessionRepo<SessionMetadata, { id?: string }, void> {
	private sessions = new Map<string, Session<SessionMetadata>>();

	async create(options: { id?: string } = {}): Promise<Session<SessionMetadata>> {
		const metadata: SessionMetadata = {
			id: options.id ?? createSessionId(),
			createdAt: createTimestamp(),
		};
		const storage = new InMemorySessionStorage({ metadata });
		const session = toSession(storage);
		this.sessions.set(metadata.id, session);
		return session;
	}

	async open(metadata: SessionMetadata): Promise<Session<SessionMetadata>> {
		const session = this.sessions.get(metadata.id);
		if (!session) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		return session;
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((session) => session.getMetadata()));
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<SessionMetadata>[]> {
		const hits: SessionSearchHit<SessionMetadata>[] = [];
		for (const session of this.sessions.values()) {
			const metadata = await session.getMetadata();
			hits.push(...findSessionEntryMatches(metadata, await session.getEntries(), options.text));
		}
		return hits;
	}

	async delete(metadata: SessionMetadata): Promise<void> {
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
		const session = toSession(storage);
		this.sessions.set(metadata.id, session);
		return session;
	}
}
