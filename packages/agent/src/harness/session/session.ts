import { uuidv7 } from "@draht/ai";
import { SessionCodec, SessionCodecError } from "./codec.ts";
import type {
	CommitResult,
	Entry,
	IdGenerator,
	Register,
	RegisterNamespace,
	Session,
	SessionCodecOptions,
	SessionMetadata,
	Storage,
	Transaction,
} from "./types.ts";

type StorageBackedSessionContract<TMetadata extends SessionMetadata> = Pick<
	Session<TMetadata>,
	"metadata" | "idGenerator" | "commit" | "getEntries" | "getRegister" | "listRegisters" | "close"
>;

/** Package-internal validated boundary shared by concrete session repositories. */
// TODO: Implement the SessionTree API and replace this subset with Session<TMetadata>.
export class StorageBackedSession<TMetadata extends SessionMetadata = SessionMetadata>
	implements StorageBackedSessionContract<TMetadata>
{
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator = { next: uuidv7 };
	private readonly storage: Storage;
	private readonly codec: SessionCodec;
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(metadata: TMetadata, storage: Storage, codecOptions: SessionCodecOptions = {}) {
		this.metadata = structuredClone(metadata);
		this.storage = storage;
		this.codec = new SessionCodec(codecOptions);
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		this.assertOpen();
		const encoded = this.codec.encodeTransaction(transaction);
		return this.storage.commit(encoded);
	}

	async getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		this.assertOpen();
		const requestedIds = new Set(ids);
		const stored = await this.storage.getEntries(ids);
		const entries = new Map<string, Entry>();
		for (const [key, value] of stored) {
			const path = `$[${JSON.stringify(key)}]`;
			if (!requestedIds.has(key))
				throw new SessionCodecError(path, "storage returned an entry that was not requested");
			const entry = this.codec.decodeEntry(value);
			if (entry.id !== key) throw new SessionCodecError(`${path}.id`, "entry id must equal its storage map key");
			entries.set(key, entry);
		}
		return entries;
	}

	async getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		this.assertOpen();
		const stored = await this.storage.getRegister(namespace, key);
		if (stored === undefined) return undefined;
		const register = this.codec.decodeRegister(namespace, stored);
		if (register.key !== key) throw new SessionCodecError("$.key", "register key must equal the requested key");
		return register;
	}

	async listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]> {
		this.assertOpen();
		const stored = await this.storage.listRegisters(namespace, keyPrefix);
		return stored.map((value, index) => {
			const register = this.codec.decodeRegister(namespace, value);
			if (keyPrefix !== undefined && !register.key.startsWith(keyPrefix)) {
				throw new SessionCodecError(`$[${index}].key`, "register key must match the requested prefix");
			}
			return register;
		});
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = Promise.resolve()
			.then(() => this.storage.close())
			.finally(() => {
				this.state = "closed";
			});
		return this.closePromise;
	}

	private assertOpen(): void {
		if (this.state !== "open") throw new Error("Session is closed");
	}
}
