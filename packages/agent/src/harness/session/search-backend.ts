import type {
	Session,
	SessionMetadata,
	SessionSearchBackend,
	SessionSearchBackendFactory,
	SessionSearchHit,
	SessionSearchOptions,
	SessionSearchRecord,
	SessionStorage,
	SessionTreeEntry,
} from "../types.ts";
import { findSessionEntryMatches, toSession } from "./repo-utils.ts";

export function toSessionSearchRecord<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entry: SessionTreeEntry,
): SessionSearchRecord<TMetadata> {
	return { metadata, entry };
}

type SessionSearchSource<TMetadata extends SessionMetadata> = {
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(): Promise<TMetadata[]>;
};

/** Patches a canonical session storage so writes are mirrored into the configured search backend. */
function attachSearchBackend<TMetadata extends SessionMetadata>(
	storage: SessionStorage<TMetadata>,
	getBackend: () => Promise<SessionSearchBackend<TMetadata> | undefined>,
): SessionStorage<TMetadata> {
	const appendEntry = storage.appendEntry.bind(storage);
	storage.appendEntry = async (entry: SessionTreeEntry): Promise<void> => {
		await appendEntry(entry);
		const backend = await getBackend();
		if (backend) {
			await backend.upsert(toSessionSearchRecord(await storage.getMetadata(), entry));
		}
	};

	const setLeafId = storage.setLeafId.bind(storage);
	storage.setLeafId = async (leafId: string | null) => {
		const entry = await setLeafId(leafId);
		const backend = await getBackend();
		if (backend) {
			await backend.upsert(toSessionSearchRecord(await storage.getMetadata(), entry));
		}
		return entry;
	};

	return storage;
}

export interface SessionSearch<TMetadata extends SessionMetadata> {
	createSession(storage: SessionStorage<TMetadata>): Session<TMetadata>;
	search(options: SessionSearchOptions): Promise<SessionSearchHit<TMetadata>[]>;
	removeSession(metadata: TMetadata): Promise<void>;
	indexSession(session: Session<TMetadata>): Promise<void>;
}

async function scanSessions<TMetadata extends SessionMetadata>(
	source: SessionSearchSource<TMetadata>,
	options: SessionSearchOptions,
): Promise<SessionSearchHit<TMetadata>[]> {
	const hits: SessionSearchHit<TMetadata>[] = [];
	for (const metadata of await source.list()) {
		const cwd = (metadata as { cwd?: unknown }).cwd;
		if (options.cwd !== undefined && cwd !== options.cwd) continue;
		const session = await source.open(metadata);
		try {
			hits.push(...findSessionEntryMatches(metadata, await session.getEntries(), options.text));
		} finally {
			const storage = session.getStorage() as { cleanup?: () => Promise<void> };
			if (typeof storage.cleanup === "function") await storage.cleanup();
		}
	}
	return hits;
}

/** Repository-owned search operations, shared by concrete repositories without a base class. */
export function createSessionSearch<TMetadata extends SessionMetadata>(
	factory: SessionSearchBackendFactory<TMetadata> | undefined,
	source: SessionSearchSource<TMetadata>,
): SessionSearch<TMetadata> {
	let backendPromise: Promise<SessionSearchBackend<TMetadata> | undefined> | undefined;

	function getBackend(): Promise<SessionSearchBackend<TMetadata> | undefined> {
		if (!backendPromise) {
			backendPromise = factory ? Promise.resolve(factory.create()) : Promise.resolve(undefined);
		}
		return backendPromise;
	}

	return {
		createSession: (storage) => toSession(factory ? attachSearchBackend(storage, getBackend) : storage),
		search: async (options) => {
			const backend = await getBackend();
			return backend ? backend.search(options) : scanSessions(source, options);
		},
		removeSession: async (metadata) => {
			const backend = await getBackend();
			if (backend) await backend.removeSession(metadata);
		},
		indexSession: async (session) => {
			const backend = await getBackend();
			if (!backend) return;
			const metadata = await session.getMetadata();
			for (const entry of await session.getEntries()) {
				await backend.upsert(toSessionSearchRecord(metadata, entry));
			}
		},
	};
}
