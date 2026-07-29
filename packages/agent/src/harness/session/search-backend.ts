import type {
	Session,
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchIndex,
	SessionSearchOptions,
	SessionSearchRecord,
	SessionTreeEntry,
} from "../types.ts";
import { findSessionEntryMatches } from "./repo-utils.ts";

type SessionSearchSource<TMetadata extends SessionMetadata> = {
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(): Promise<TMetadata[]>;
};

/** Searches canonical sessions directly and therefore has no index to maintain. */
export class ScanningSessionSearch<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionSearch<TMetadata>
{
	private readonly source: SessionSearchSource<TMetadata>;

	constructor(source: SessionSearchSource<TMetadata>) {
		this.source = source;
	}

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

class FanoutSessionSearchIndex<TMetadata extends SessionMetadata> implements SessionSearchIndex<TMetadata> {
	private readonly indexes: readonly SessionSearchIndex<TMetadata>[];

	constructor(indexes: readonly SessionSearchIndex<TMetadata>[]) {
		this.indexes = indexes;
	}

	async upsert(record: SessionSearchRecord<TMetadata>): Promise<void> {
		for (const index of this.indexes) await index.upsert(record);
	}

	async replaceSession(metadata: TMetadata, entries: readonly SessionTreeEntry[]): Promise<void> {
		for (const index of this.indexes) await index.replaceSession(metadata, entries);
	}

	async removeSession(metadata: TMetadata): Promise<void> {
		for (const index of this.indexes) await index.removeSession(metadata);
	}
}

/** Delegates queries to one search and fans index mutations out sequentially, like io.MultiWriter. */
export class FanoutSessionSearch<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionSearch<TMetadata>
{
	private readonly reader: SessionSearch<TMetadata>;
	readonly index?: SessionSearchIndex<TMetadata>;

	constructor(options: {
		reader: SessionSearch<TMetadata>;
		writers: readonly SessionSearch<TMetadata>[];
	}) {
		this.reader = options.reader;
		const indexes = options.writers.flatMap((search) => (search.index ? [search.index] : []));
		this.index = indexes.length > 0 ? new FanoutSessionSearchIndex(indexes) : undefined;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		return await this.reader.search(options);
	}
}
