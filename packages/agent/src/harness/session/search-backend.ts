import type {
	LeafEntry,
	Session,
	SessionEntryCursorOptions,
	SessionMetadata,
	SessionSearchBackend,
	SessionSearchBackendFactory,
	SessionSearchHit,
	SessionSearchOptions,
	SessionSearchRecord,
	SessionStats,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { findSessionEntryMatches } from "./repo-utils.ts";

export function toSessionSearchRecord<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entry: SessionTreeEntry,
): SessionSearchRecord<TMetadata> {
	return { metadata, entry };
}

type SessionSearchSource<TMetadata extends SessionMetadata> = {
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(): Promise<TMetadata[]>;
};

/** A session storage sink that writes canonically, then mirrors records to search. */
class SearchWritingSessionStorage<TMetadata extends SessionMetadata> implements SessionStorage<TMetadata> {
	private readonly storage: SessionStorage<TMetadata>;
	private readonly searchBackend: SessionSearchBackend<TMetadata>;

	constructor(storage: SessionStorage<TMetadata>, searchBackend: SessionSearchBackend<TMetadata>) {
		this.storage = storage;
		this.searchBackend = searchBackend;
	}

	getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	getLeafId(): Promise<string | null> {
		return this.storage.getLeafId();
	}

	async setLeafId(leafId: string | null): Promise<LeafEntry> {
		const entry = await this.storage.setLeafId(leafId);
		await this.searchBackend.upsert(toSessionSearchRecord(await this.storage.getMetadata(), entry));
		return entry;
	}

	createEntryId(): Promise<string> {
		return this.storage.createEntryId();
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.storage.appendEntry(entry);
		await this.searchBackend.upsert(toSessionSearchRecord(await this.storage.getMetadata(), entry));
	}

	getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		return this.storage.getEntry(id);
	}

	findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		return this.storage.findEntries(type);
	}

	getLabel(id: string): Promise<string | undefined> {
		return this.storage.getLabel(id);
	}

	getSessionName(): Promise<string | undefined> {
		return this.storage.getSessionName();
	}

	getSessionStats(): Promise<SessionStats> {
		return this.storage.getSessionStats();
	}

	getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
		return this.storage.getPathToRootOrCompaction(leafId);
	}

	getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return this.storage.getEntries(options);
	}

	async cleanup(): Promise<void> {
		const storage = this.storage as SessionStorage<TMetadata> & { cleanup?: () => Promise<void> };
		if (typeof storage.cleanup === "function") await storage.cleanup();
	}
}

export interface SessionSearch<TMetadata extends SessionMetadata> {
	wrapStorage(storage: SessionStorage<TMetadata>): Promise<SessionStorage<TMetadata>>;
	search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]>;
	removeSession(metadata: TMetadata): Promise<void>;
	indexSession(session: Session<TMetadata>): Promise<void>;
}

/** Repository-owned search operations, shared by concrete repositories without a base class. */
export function createSessionSearch<TMetadata extends SessionMetadata>(
	factory: SessionSearchBackendFactory<TMetadata> | undefined,
	source: SessionSearchSource<TMetadata>,
): SessionSearch<TMetadata> {
	let backendPromise: Promise<SessionSearchBackend<TMetadata>> | undefined;

	function getBackend(): Promise<SessionSearchBackend<TMetadata>> {
		if (!backendPromise) {
			backendPromise = factory
				? Promise.resolve(factory.create()).then((backend) => backend ?? new ScanningSessionSearchBackend(source))
				: Promise.resolve(new ScanningSessionSearchBackend(source));
		}
		return backendPromise;
	}

	return {
		wrapStorage: async (storage) => new SearchWritingSessionStorage(storage, await getBackend()),
		search: async (options) => (await getBackend()).search(options),
		removeSession: async (metadata) => {
			await (await getBackend()).removeSession(metadata);
		},
		indexSession: async (session) => {
			const metadata = await session.getMetadata();
			const backend = await getBackend();
			for (const entry of await session.getEntries()) {
				await backend.upsert(toSessionSearchRecord(metadata, entry));
			}
		},
	};
}

/** Generic fallback that searches canonical sessions directly. */
export class ScanningSessionSearchBackend<TMetadata extends SessionMetadata>
	implements SessionSearchBackend<TMetadata>
{
	private readonly source: SessionSearchSource<TMetadata>;

	constructor(source: SessionSearchSource<TMetadata>) {
		this.source = source;
	}

	async upsert(_record: SessionSearchRecord<TMetadata>): Promise<void> {}

	async removeSession(_metadata: TMetadata): Promise<void> {}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const hits: SessionSearchHit<TMetadata>[] = [];
		for (const metadata of await this.source.list()) {
			const cwd = (metadata as { cwd?: unknown }).cwd;
			if (options.cwd !== undefined && cwd !== options.cwd) continue;
			const session = await this.source.open(metadata);
			try {
				hits.push(...findSessionEntryMatches(metadata, await session.getEntries(), options.text));
			} finally {
				const storage = session.getStorage() as { cleanup?: () => Promise<void> };
				if (typeof storage.cleanup === "function") await storage.cleanup();
			}
		}
		return hits;
	}
}
