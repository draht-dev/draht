import type {
	SessionCreateOptions,
	SessionForkOptions,
	SessionMetadata,
	SessionSearch,
	SessionSearchIndex,
	SessionStorage,
	SessionStore,
	SessionTreeEntry,
} from "../types.ts";

export function indexSessionStorage<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
	index: SessionSearchIndex<TMetadata>,
): SessionStorage<TMetadata> {
	return new Proxy(storage, {
		get(target, property) {
			if (property === "appendEntry") {
				return async (entry: SessionTreeEntry) => {
					await target.appendEntry(entry);
					await index.upsertEntry(await target.getMetadata(), entry);
				};
			}
			if (property === "setLeafId") {
				return async (leafId: string | null) => {
					const entry = await target.setLeafId(leafId);
					await index.upsertEntry(await target.getMetadata(), entry);
					return entry;
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export class IndexedSessionStore<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> implements SessionStore<TMetadata, TCreateOptions, TListOptions>
{
	readonly defaultSearch?: SessionSearch<TMetadata>;
	private readonly store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	private readonly index: SessionSearchIndex<TMetadata>;

	constructor(options: {
		store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
		index: SessionSearchIndex<TMetadata>;
		defaultSearch?: SessionSearch<TMetadata>;
	}) {
		this.store = options.store;
		this.index = options.index;
		this.defaultSearch = options.defaultSearch ?? options.store.defaultSearch;
	}

	async create(options: TCreateOptions): Promise<SessionStorage<TMetadata>> {
		return indexSessionStorage(await this.store.create(options), this.index);
	}

	async open(metadata: TMetadata): Promise<SessionStorage<TMetadata>> {
		return indexSessionStorage(await this.store.open(metadata), this.index);
	}

	async list(options?: TListOptions): Promise<TMetadata[]> {
		return this.store.list(options);
	}

	async delete(metadata: TMetadata): Promise<void> {
		await this.store.delete(metadata);
		await this.index.deleteSession(metadata);
	}

	async fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<SessionStorage<TMetadata>> {
		const storage = await this.store.fork(source, options);
		await this.index.replaceSession(await storage.getMetadata(), await storage.getEntries());
		return indexSessionStorage(storage, this.index);
	}
}

export async function rebuildSessionSearchIndex<TMetadata extends SessionMetadata, TListOptions>(
	store: SessionStore<TMetadata, SessionCreateOptions, TListOptions>,
	index: SessionSearchIndex<TMetadata>,
	options?: TListOptions,
): Promise<void> {
	for (const metadata of await store.list(options)) {
		const storage = await store.open(metadata);
		try {
			await index.replaceSession(metadata, await storage.getEntries());
		} finally {
			const maybeClosable = storage as SessionStorage<TMetadata> & { cleanup?: () => Promise<void> };
			if (typeof maybeClosable.cleanup === "function") await maybeClosable.cleanup();
		}
	}
}
