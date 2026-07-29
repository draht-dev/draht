import type {
	Session,
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
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

	async upsert(_record: SessionSearchRecord<TMetadata>): Promise<void> {}

	async indexSession(_metadata: TMetadata, _entries: readonly SessionTreeEntry[]): Promise<void> {}

	async removeSession(_metadata: TMetadata): Promise<void> {}
}

/** Delegates queries to one search and fans index mutations out sequentially, like io.MultiWriter. */
export class MultiSessionSearch<TMetadata extends SessionMetadata = SessionMetadata>
	implements SessionSearch<TMetadata>
{
	private readonly reader: SessionSearch<TMetadata>;
	private readonly writers: readonly SessionSearch<TMetadata>[];

	constructor(options: {
		reader: SessionSearch<TMetadata>;
		writers: readonly SessionSearch<TMetadata>[];
	}) {
		this.reader = options.reader;
		this.writers = options.writers;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		return await this.reader.search(options);
	}

	async upsert(record: SessionSearchRecord<TMetadata>): Promise<void> {
		for (const writer of this.writers) await writer.upsert(record);
	}

	async indexSession(metadata: TMetadata, entries: readonly SessionTreeEntry[]): Promise<void> {
		for (const writer of this.writers) await writer.indexSession(metadata, entries);
	}

	async removeSession(metadata: TMetadata): Promise<void> {
		for (const writer of this.writers) await writer.removeSession(metadata);
	}
}
