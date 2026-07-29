import { uuidv7 } from "@draht/ai";
import {
	type FileError,
	type Result,
	SessionError,
	type SessionMetadata,
	type SessionSearch,
	type SessionSearchHit,
	type SessionStorage,
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
	private readonly search: SessionSearch<TMetadata>;

	constructor(storage: SessionStorage<TMetadata>, metadata: TMetadata, search: SessionSearch<TMetadata>) {
		this.storage = storage;
		this.metadata = metadata;
		this.search = search;
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		await this.storage.appendEntry(entry);
		await this.search.upsert({ metadata: this.metadata, entry });
	}

	async setLeafId(leafId: string | null) {
		const entry = await this.storage.setLeafId(leafId);
		await this.search.upsert({ metadata: this.metadata, entry });
		return entry;
	}
}

export async function toRepoSession<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
	search: SessionSearch<TMetadata>,
): Promise<Session<TMetadata>> {
	const metadata = await storage.getMetadata();
	return toSession(storage, new SessionRepoWriter(storage, metadata, search));
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
