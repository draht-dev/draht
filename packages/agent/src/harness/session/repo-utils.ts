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
	type SessionStats,
	type SessionStorage,
	type SessionStore,
	type SessionTreeEntry,
} from "../types.ts";
import { Session } from "./session.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

function entriesById(entries: readonly SessionTreeEntry[]): Map<string, SessionTreeEntry> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

function getLabel(entries: readonly SessionTreeEntry[], id: string): string | undefined {
	let label: string | undefined;
	for (const entry of entries) {
		if (entry.type !== "label" || entry.targetId !== id) continue;
		label = entry.label?.trim() || undefined;
	}
	return label;
}

function getSessionName(entries: readonly SessionTreeEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "session_info") return entry.name?.trim() || undefined;
	}
	return undefined;
}

function getSessionStats(entries: readonly SessionTreeEntry[]): SessionStats {
	let messageCount = 0;
	let cachedTokens = 0;
	let uncachedTokens = 0;
	let totalTokens = 0;
	let costTotal = 0;
	for (const entry of entries) {
		if (entry.type === "message") messageCount += 1;
		const usage =
			entry.type === "message"
				? entry.message.role === "assistant"
					? entry.message.usage
					: undefined
				: entry.type === "compaction" || entry.type === "branch_summary"
					? entry.usage
					: undefined;
		if (
			!usage ||
			typeof usage.input !== "number" ||
			typeof usage.output !== "number" ||
			typeof usage.cacheRead !== "number" ||
			typeof usage.cacheWrite !== "number" ||
			typeof usage.cost?.total !== "number"
		) {
			continue;
		}
		cachedTokens += usage.cacheRead;
		uncachedTokens += usage.input + usage.cacheWrite;
		totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		costTotal += usage.cost.total;
	}
	return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
}

function getPathToRootOrCompaction(entries: readonly SessionTreeEntry[], leafId: string | null): SessionTreeEntry[] {
	if (leafId === null) return [];
	const byId = entriesById(entries);
	const path: SessionTreeEntry[] = [];
	let stopAtEntryId: string | null = null;
	let current = byId.get(leafId);
	if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
	while (current) {
		path.unshift(current);
		if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
		if (current.type === "compaction") {
			if (current.retainedTail) break;
			stopAtEntryId = current.firstKeptEntryId ?? null;
		}
		if (!current.parentId) break;
		const parent = byId.get(current.parentId);
		if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
		current = parent;
	}
	return path;
}

export function toStoreSession<TMetadata extends SessionMetadata>(
	store: Pick<SessionStore<TMetadata>, "load" | "getEntries" | "createEntryId" | "appendEntry" | "setLeafId">,
	metadata: TMetadata,
): Session<TMetadata> {
	const load = () => store.load(metadata);
	const storage: SessionStorage<TMetadata> = {
		async getMetadata() {
			return metadata;
		},
		async getLeafId() {
			return (await load()).leafId;
		},
		setLeafId: (leafId) => store.setLeafId(metadata, leafId),
		createEntryId: () => store.createEntryId(metadata),
		appendEntry: (entry) => store.appendEntry(metadata, entry),
		async getEntry(id) {
			return entriesById((await load()).entries).get(id);
		},
		async findEntries(type) {
			return (await load()).entries.filter(
				(entry): entry is Extract<SessionTreeEntry, { type: typeof type }> => entry.type === type,
			);
		},
		async getLabel(id) {
			return getLabel((await load()).entries, id);
		},
		async getSessionName() {
			return getSessionName((await load()).entries);
		},
		async getSessionStats() {
			return getSessionStats((await load()).entries);
		},
		async getPathToRootOrCompaction(leafId) {
			return getPathToRootOrCompaction((await load()).entries, leafId);
		},
		getEntries: (options) => store.getEntries(metadata, options),
	};
	return new Session(storage);
}

export class SessionRepository<
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
		const snapshot = await this.store.load(metadata);
		return toStoreSession(this.store, snapshot.metadata);
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

export function createSessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
>(options: {
	store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	search?: SessionSearch<TMetadata> | null;
}): SessionRepository<TMetadata, TCreateOptions, TListOptions> {
	return new SessionRepository(options);
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
