import { uuidv7 } from "@draht/ai";
import {
	type FileError,
	type Result,
	type SessionCreateOptions,
	SessionError,
	type SessionForkOptions,
	type SessionMetadata,
	type SessionSearch,
	type SessionSearchHit,
	type SessionSearchIndex,
	type SessionStorage,
	type SessionStore,
	type SessionTreeEntry,
	type SessionWriter,
} from "../types.ts";
import { Session } from "./session.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export function toSession<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
	writer?: SessionWriter,
): Session<TMetadata> {
	return new Session(storage, {}, writer);
}

/** Repository-owned coordination between canonical storage writes and independent search indexing. */
class SessionRepoWriter<TMetadata extends SessionMetadata> implements SessionWriter {
	private readonly storage: SessionStorage<TMetadata>;
	private readonly metadata: TMetadata;
	private readonly index: SessionSearchIndex<TMetadata>;

	constructor(storage: SessionStorage<TMetadata>, metadata: TMetadata, index: SessionSearchIndex<TMetadata>) {
		this.storage = storage;
		this.metadata = metadata;
		this.index = index;
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.storage.appendEntry(entry);
		await this.index.upsert({ metadata: this.metadata, entry });
	}

	async setLeafId(leafId: string | null) {
		const entry = await this.storage.setLeafId(leafId);
		await this.index.upsert({ metadata: this.metadata, entry });
		return entry;
	}
}

export async function toRepoSession<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
	search: SessionSearch<TMetadata>,
): Promise<Session<TMetadata>> {
	if (!search.index) return toSession(storage);
	const metadata = await storage.getMetadata();
	return toSession(storage, new SessionRepoWriter(storage, metadata, search.index));
}

type BoundSessionStore<
	TMetadata extends SessionMetadata,
	TCreateOptions extends SessionCreateOptions,
	TListOptions,
> = Omit<SessionStore<TMetadata, TCreateOptions, TListOptions>, "defaultSearch" | "create" | "open" | "fork"> & {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
};

function bindSessionStore<TMetadata extends SessionMetadata, TCreateOptions extends SessionCreateOptions, TListOptions>(
	storage: SessionStore<TMetadata, TCreateOptions, TListOptions>,
	search: SessionSearch<TMetadata> | null,
): BoundSessionStore<TMetadata, TCreateOptions, TListOptions> {
	const wrap = async (sessionStorage: SessionStorage<TMetadata>): Promise<Session<TMetadata>> =>
		search ? await toRepoSession(sessionStorage, search) : toSession(sessionStorage);
	return new Proxy(storage, {
		get(target, property) {
			if (property === "create") {
				return async (options: TCreateOptions) => await wrap(await target.create(options));
			}
			if (property === "open") {
				return async (metadata: TMetadata) => await wrap(await target.open(metadata));
			}
			if (property === "fork") {
				return async (source: TMetadata, options: SessionForkOptions & TCreateOptions) => {
					const sessionStorage = await target.fork(source, options);
					await search?.index?.replaceSession(
						await sessionStorage.getMetadata(),
						await sessionStorage.getEntries(),
					);
					return await wrap(sessionStorage);
				};
			}
			if (property === "delete") {
				return async (metadata: TMetadata) => {
					await search?.index?.removeSession(metadata);
					await target.delete(metadata);
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as BoundSessionStore<TMetadata, TCreateOptions, TListOptions>;
}

/** Composes canonical storage and optional search as independently accessible capabilities. */
export class SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	readonly storage: BoundSessionStore<TMetadata, TCreateOptions, TListOptions>;
	readonly search: SessionSearch<TMetadata> | null;

	constructor(options: {
		storage: SessionStore<TMetadata, TCreateOptions, TListOptions>;
		search?: SessionSearch<TMetadata> | null;
	}) {
		this.search = options.search === undefined ? (options.storage.defaultSearch ?? null) : options.search;
		this.storage = bindSessionStore(options.storage, this.search);
	}
}

export function findSessionEntryMatches<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entries: SessionTreeEntry[],
	text: string,
): SessionSearchHit<TMetadata>[] {
	const normalizedText = text.trim().toLowerCase();
	if (!normalizedText) return [];
	return entries.flatMap((entry) => {
		const payload = JSON.stringify(entry);
		if (!payload.toLowerCase().includes(normalizedText)) return [];
		return [{ metadata, entryId: entry.id, timestamp: entry.timestamp, snippet: payload }];
	});
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	if (!options.entryId) return storage.getEntries();
	const target = await storage.getEntry(options.entryId);
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	let effectiveLeafId: string | null;
	if ((options.position ?? "before") === "at") {
		effectiveLeafId = target.id;
	} else {
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
		effectiveLeafId = target.parentId;
	}
	return storage.getPathToRootOrCompaction(effectiveLeafId);
}
