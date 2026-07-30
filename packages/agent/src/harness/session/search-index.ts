import type {
	LeafEntry,
	SessionCreateOptions,
	SessionEntryCursorOptions,
	SessionForkOptions,
	SessionMetadata,
	SessionSearchIndex,
	SessionSnapshot,
	SessionStore,
	SessionTreeEntry,
} from "../types.ts";

export class IndexedSessionStore<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> implements SessionStore<TMetadata, TCreateOptions, TListOptions>
{
	private readonly store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	private readonly index: SessionSearchIndex<TMetadata>;

	constructor(options: {
		store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
		index: SessionSearchIndex<TMetadata>;
	}) {
		this.store = options.store;
		this.index = options.index;
	}

	create(options: TCreateOptions): Promise<TMetadata> {
		return this.store.create(options);
	}

	load(metadata: TMetadata): Promise<SessionSnapshot<TMetadata>> {
		return this.store.load(metadata);
	}

	list(options?: TListOptions): Promise<TMetadata[]> {
		return this.store.list(options);
	}

	getEntries(metadata: TMetadata, options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
		return this.store.getEntries(metadata, options);
	}

	createEntryId(metadata: TMetadata): Promise<string> {
		return this.store.createEntryId(metadata);
	}

	async appendEntry(metadata: TMetadata, entry: SessionTreeEntry): Promise<void> {
		await this.store.appendEntry(metadata, entry);
		await this.index.upsertEntry(metadata, entry);
	}

	async setLeafId(metadata: TMetadata, leafId: string | null): Promise<LeafEntry> {
		const entry = await this.store.setLeafId(metadata, leafId);
		await this.index.upsertEntry(metadata, entry);
		return entry;
	}

	async delete(metadata: TMetadata): Promise<void> {
		await this.store.delete(metadata);
		await this.index.deleteSession(metadata);
	}

	async fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<TMetadata> {
		const metadata = await this.store.fork(source, options);
		await this.index.replaceSession(metadata, (await this.store.load(metadata)).entries);
		return metadata;
	}
}

export async function rebuildSessionSearchIndex<TMetadata extends SessionMetadata, TListOptions>(
	store: SessionStore<TMetadata, SessionCreateOptions, TListOptions>,
	index: SessionSearchIndex<TMetadata>,
	options?: TListOptions,
): Promise<void> {
	for (const metadata of await store.list(options)) {
		await index.replaceSession(metadata, (await store.load(metadata)).entries);
	}
}
