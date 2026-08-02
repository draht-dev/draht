import type {
	SessionMetadata,
	SessionSearch,
	SessionSearchHit,
	SessionSearchOptions,
	SessionStorage,
} from "../types.ts";

type SessionSearchSource<TMetadata extends SessionMetadata> = {
	open(metadata: TMetadata): Promise<SessionStorage<TMetadata>>;
	list(): Promise<TMetadata[]>;
};

/** Searches canonical sessions directly and therefore has no index to maintain. */
class ScanningSessionSearch<TMetadata extends SessionMetadata = SessionMetadata> implements SessionSearch<TMetadata> {
	private readonly source: SessionSearchSource<TMetadata>;

	constructor(source: SessionSearchSource<TMetadata>) {
		this.source = source;
	}

	async search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]> {
		const normalizedText = options.text.trim().toLowerCase();
		if (!normalizedText) return [];
		const hits: SessionSearchHit<TMetadata>[] = [];
		for (const metadata of await this.source.list()) {
			const cwd = (metadata as { cwd?: unknown }).cwd;
			if (options.cwd !== undefined && cwd !== options.cwd) continue;
			const storage = await this.source.open(metadata);
			for (const entry of await storage.readEntries()) {
				const payload = JSON.stringify(entry);
				if (!payload.toLowerCase().includes(normalizedText)) continue;
				hits.push({
					metadata: storage.metadata,
					entryId: entry.id,
					timestamp: entry.timestamp,
					snippet: payload,
				});
			}
		}
		return hits;
	}
}

export function createScanningSessionSearch<TMetadata extends SessionMetadata>(
	source: SessionSearchSource<TMetadata>,
): SessionSearch<TMetadata> {
	return new ScanningSessionSearch(source);
}
