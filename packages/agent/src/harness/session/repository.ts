import { uuidv7 } from "@draht/ai";
import {
	type FileError,
	type Result,
	type SessionCollection,
	type SessionCreateOptions,
	SessionError,
	type SessionForkOptions,
	type SessionMetadata,
	type SessionSearch,
	type SessionSearchHit,
} from "../types.ts";
import { createSessionForkSelection } from "./fork.ts";
import { createSession, type Session, type SessionContextBuildOptions } from "./session.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export class SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	private readonly collection: SessionCollection<TMetadata, TCreateOptions, TListOptions>;
	private readonly sessionSearch: SessionSearch<TMetadata> | undefined;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(options: {
		collection: SessionCollection<TMetadata, TCreateOptions, TListOptions>;
		search?: SessionSearch<TMetadata>;
		contextBuildOptions?: SessionContextBuildOptions;
	}) {
		this.collection = options.collection;
		this.sessionSearch = options.search;
		this.contextBuildOptions = options.contextBuildOptions ?? {};
	}

	async create(options: TCreateOptions): Promise<Session<TMetadata>> {
		return createSession(await this.collection.create(options), this.contextBuildOptions);
	}

	async open(metadata: TMetadata): Promise<Session<TMetadata>> {
		return createSession(await this.collection.open(metadata), this.contextBuildOptions);
	}

	async list(options?: TListOptions): Promise<TMetadata[]> {
		return await this.collection.list(options);
	}

	async delete(metadata: TMetadata): Promise<void> {
		await this.collection.delete(metadata);
	}

	async fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>> {
		const selection = createSessionForkSelection(options);
		const createOptions = { ...options };
		delete createOptions.entryId;
		delete createOptions.position;
		return createSession(await this.collection.fork(source, createOptions, selection), this.contextBuildOptions);
	}

	async search(options: Parameters<SessionSearch<TMetadata>["search"]>[0]): Promise<SessionSearchHit<TMetadata>[]> {
		if (!this.sessionSearch) throw new SessionError("unsupported", "Session search is not configured");
		return await this.sessionSearch.search(options);
	}
}

export function createSessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
>(options: {
	collection: SessionCollection<TMetadata, TCreateOptions, TListOptions>;
	search?: SessionSearch<TMetadata>;
	contextBuildOptions?: SessionContextBuildOptions;
}): SessionRepository<TMetadata, TCreateOptions, TListOptions> {
	return new SessionRepository(options);
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}
