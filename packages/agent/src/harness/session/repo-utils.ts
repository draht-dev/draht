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
	type SessionStorage,
	type SessionStore,
	type SessionTreeEntry,
} from "../types.ts";
import { Session, type SessionDependencies } from "./session.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

export function toStoreSession<TMetadata extends SessionMetadata>(
	store: Pick<SessionStore<TMetadata>, "load" | "getEntries" | "createEntryId" | "appendEntry" | "setLeafId">,
	metadata: TMetadata,
): Session<TMetadata> {
	const dependencies: SessionDependencies<TMetadata> = {
		metadata,
		load: () => store.load(metadata),
		getEntries: (options) => store.getEntries(metadata, options),
		createEntryId: () => store.createEntryId(metadata),
		appendEntry: (entry) => store.appendEntry(metadata, entry),
		setLeafId: (leafId) => store.setLeafId(metadata, leafId),
	};
	return new Session(dependencies);
}

export function after<TArgs extends unknown[], TResult>(
	operation: (...args: TArgs) => Promise<TResult>,
	callback: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<TResult> {
	return async (...args: TArgs) => {
		const result = await operation(...args);
		await callback(...args);
		return result;
	};
}

export class SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	private readonly store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	private readonly searchBackend: SessionSearch<TMetadata> | null;

	constructor(options: {
		store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
		search?: SessionSearch<TMetadata> | null;
	}) {
		this.store = options.store;
		this.searchBackend = options.search ?? null;
	}

	async create(options: TCreateOptions): Promise<Session<TMetadata>> {
		return toStoreSession(this.store, await this.store.create(options));
	}

	async open(metadata: TMetadata): Promise<Session<TMetadata>> {
		await this.store.load(metadata);
		return toStoreSession(this.store, metadata);
	}

	list(options?: TListOptions): Promise<TMetadata[]> {
		return this.store.list(options);
	}

	async delete(metadata: TMetadata): Promise<void> {
		await this.store.delete(metadata);
	}

	async fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>> {
		return toStoreSession(this.store, await this.store.fork(source, options));
	}

	async search(options: Parameters<SessionSearch<TMetadata>["search"]>[0]): Promise<SessionSearchHit<TMetadata>[]> {
		return this.searchBackend ? await this.searchBackend.search(options) : [];
	}
}

export function createSessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
>(options: {
	store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	search?: SessionSearch<TMetadata> | null;
}): SessionRepo<TMetadata, TCreateOptions, TListOptions> {
	return new SessionRepo(options);
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
