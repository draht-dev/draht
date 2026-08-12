import { type Usage, uuidv7 } from "@draht/ai";
import { addUsage } from "../utils/usage.ts";
import { StorageBackedSession } from "./session.ts";
import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	ForkOptions,
	Register,
	RegisterNamespace,
	Session,
	SessionCreateOptions,
	SessionMetadata,
	SessionRepo,
	SessionStats,
	Storage,
	StorageBranchScan,
	Transaction,
	UsageRow,
	UsageScan,
} from "./types.ts";

export interface MemoryStorageOptions {
	now?: () => number;
}

export interface MemorySessionRepoOptions {
	now?: () => number;
}

interface MemoryStorageState {
	entries: Map<string, Entry>;
	registers: Map<string, Register>;
	usage: Map<string, UsageRow>;
	stats: SessionStats;
	nextSeq: number;
	commitQueue: Promise<void>;
}

function registerKey(namespace: RegisterNamespace, key: string): string {
	return `${namespace}\u0000${key}`;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createMemoryStorageState(): MemoryStorageState {
	return {
		entries: new Map(),
		registers: new Map(),
		usage: new Map(),
		stats: { messageCount: 0, usage: emptyUsage() },
		nextSeq: 1,
		commitQueue: Promise.resolve(),
	};
}

export class MemoryStorage implements Storage {
	private readonly now: () => number;
	private readonly data: MemoryStorageState;
	private readonly onClose: () => void;
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(options: MemoryStorageOptions = {}, data = createMemoryStorageState(), onClose: () => void = () => {}) {
		this.now = options.now ?? Date.now;
		this.data = data;
		this.onClose = onClose;
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		const result = this.data.commitQueue.then(() => this.applyCommit(transaction));
		this.data.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private applyCommit(committedTransaction: Transaction): CommitResult {
		const transactionIds = new Set<string>();
		const transactionEntryIds = new Set<string>();
		for (const write of committedTransaction.writes) {
			if (write.kind !== "entry" && write.kind !== "usage") continue;
			const id = write.kind === "entry" ? write.entry.id : write.row.id;
			if (this.data.entries.has(id) || this.data.usage.has(id) || transactionIds.has(id)) {
				throw new Error(`Duplicate entry or usage id: ${id}`);
			}
			if (
				write.kind === "entry" &&
				write.entry.parentId !== null &&
				!this.data.entries.has(write.entry.parentId) &&
				!transactionEntryIds.has(write.entry.parentId)
			) {
				throw new Error(`Missing parent entry: ${write.entry.parentId}`);
			}
			transactionIds.add(id);
			if (write.kind === "entry") transactionEntryIds.add(id);
		}

		const timestamp = this.now();
		const entries: Entry[] = [];
		const registers = new Map<string, Register | undefined>();
		const usage: UsageRow[] = [];
		let stats: SessionStats | undefined;
		let nextSeq = this.data.nextSeq;
		const firstSeq = nextSeq;
		const seqs: number[] = [];

		for (const write of committedTransaction.writes) {
			const seq = nextSeq++;
			seqs.push(seq);
			switch (write.kind) {
				case "entry":
					stats ??= { messageCount: this.data.stats.messageCount, usage: this.data.stats.usage };
					entries.push({ ...write.entry, seq, timestamp } as Entry);
					if (write.entry.type === "message") stats.messageCount++;
					break;
				case "usage":
					stats ??= { messageCount: this.data.stats.messageCount, usage: this.data.stats.usage };
					usage.push({ ...write.row, seq });
					stats.usage = addUsage(stats.usage, write.row.usage);
					break;
				case "register": {
					const key = registerKey(write.namespace, write.key);
					if (write.op === "delete") {
						registers.set(key, undefined);
					} else {
						registers.set(key, {
							namespace: write.namespace,
							key: write.key,
							value: write.value,
							seq,
						});
					}
					break;
				}
			}
		}

		for (const entry of entries) this.data.entries.set(entry.id, entry);
		for (const [key, register] of registers) {
			if (register === undefined) this.data.registers.delete(key);
			else this.data.registers.set(key, register);
		}
		for (const row of usage) this.data.usage.set(row.id, row);
		if (stats !== undefined) this.data.stats = stats;
		this.data.nextSeq = nextSeq;
		return { firstSeq, seqs, timestamp };
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const found = new Map<string, Entry>();
		for (const id of ids) {
			const entry = this.data.entries.get(id);
			if (entry !== undefined) found.set(id, entry);
		}
		return Promise.resolve(found);
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const register = this.data.registers.get(registerKey(namespace, key));
		return Promise.resolve(register as Register<TNamespace> | undefined);
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix = "",
	): Promise<Register<TNamespace>[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const registers = [...this.data.registers.values()]
			.filter((register) => register.namespace === namespace && register.key.startsWith(keyPrefix))
			.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
		return Promise.resolve(registers as Register<TNamespace>[]);
	}

	private scanBranchEntries(query: StorageBranchScan): Entry[] {
		const start = this.data.entries.get(query.start);
		if (start === undefined) throw new Error(`Unknown branch start: ${query.start}`);

		const path: Entry[] = [];
		let entry: Entry | undefined = start;
		while (entry !== undefined) {
			path.push(entry);
			if (entry.parentId === null) break;
			entry = this.data.entries.get(entry.parentId);
			if (entry === undefined) throw new Error("Corrupt branch: missing parent");
		}
		if (query.order === "oldestFirst") path.reverse();

		const stopped: Entry[] = [];
		for (const candidate of path) {
			stopped.push(candidate);
			if (candidate.id === query.stopAtId || candidate.type === query.stopAtType) break;
		}
		const filtered = stopped
			.filter((candidate) => query.type === undefined || candidate.type === query.type)
			.filter((candidate) => query.customType === undefined || candidate.customType === query.customType)
			.filter(
				(candidate) =>
					query.cursor === undefined ||
					(query.order === "oldestFirst" ? candidate.seq > query.cursor.seq : candidate.seq < query.cursor.seq),
			);
		return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
	}

	async scanBranch(query: StorageBranchScan): Promise<Entry[]> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		return this.scanBranchEntries(query);
	}

	async scanBranchStructure(query: StorageBranchScan): Promise<EntryStructure[]> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		return this.scanBranchEntries(query).map((entry) => ({
			id: entry.id,
			parentId: entry.parentId,
			seq: entry.seq,
			timestamp: entry.timestamp,
			type: entry.type,
			...(entry.customType === undefined ? {} : { customType: entry.customType }),
		}));
	}

	scanEntries(query: EntryScan): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const entries = [...this.data.entries.values()]
			.filter((entry) => query.type === undefined || entry.type === query.type)
			.filter((entry) => query.customType === undefined || entry.customType === query.customType)
			.filter((entry) => query.fromSeq === undefined || entry.seq >= query.fromSeq)
			.filter((entry) => query.toSeq === undefined || entry.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return Promise.resolve(query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit)));
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const rows = [...this.data.usage.values()]
			.filter((row) => query.fromSeq === undefined || row.seq >= query.fromSeq)
			.filter((row) => query.toSeq === undefined || row.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return Promise.resolve(query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit)));
	}

	getStats(): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(this.data.stats);
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.data.commitQueue.then(() => {
			this.state = "closed";
			this.onClose();
		});
		return this.closePromise;
	}
}

const MEMORY_STORAGE_VERSION = 1;

interface MemorySessionRecord {
	metadata: SessionMetadata;
	storage: MemoryStorageState;
	open: boolean;
}

export class MemorySessionRepo implements SessionRepo {
	private readonly now: () => number;
	private readonly sessions = new Map<string, MemorySessionRecord>();
	private readonly pendingIds = new Set<string>();
	private closed = false;

	constructor(options: MemorySessionRepoOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	async create(options: SessionCreateOptions): Promise<Session> {
		this.assertOpen();
		const createdAt = this.now();
		const id = options.id ?? uuidv7(createdAt);
		this.reserveId(id);
		const metadata: SessionMetadata = {
			id,
			createdAt,
			storageVersion: MEMORY_STORAGE_VERSION,
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
		};
		const record: MemorySessionRecord = { metadata, storage: createMemoryStorageState(), open: true };
		const session = this.openRecord(record);
		try {
			await session.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: null, pendingNextRun: [] },
					},
				],
			});
			this.sessions.set(id, record);
			return session;
		} catch (error) {
			await session.close();
			throw error;
		} finally {
			this.pendingIds.delete(id);
		}
	}

	open(metadata: SessionMetadata): Promise<Session> {
		this.assertOpen();
		const record = this.sessions.get(metadata.id);
		if (record === undefined) return Promise.reject(new Error(`Unknown session: ${metadata.id}`));
		if (record.open) return Promise.reject(new Error(`Session is already open: ${metadata.id}`));
		record.open = true;
		return Promise.resolve(this.openRecord(record));
	}

	list(): Promise<SessionMetadata[]> {
		this.assertOpen();
		return Promise.resolve([...this.sessions.values()].map(({ metadata }) => metadata));
	}

	delete(metadata: SessionMetadata): Promise<void> {
		this.assertOpen();
		const record = this.sessions.get(metadata.id);
		if (record === undefined) return Promise.reject(new Error(`Unknown session: ${metadata.id}`));
		if (record.open) return Promise.reject(new Error(`Session is open: ${metadata.id}`));
		this.sessions.delete(metadata.id);
		return Promise.resolve();
	}

	async fork(source: SessionMetadata, options: ForkOptions & SessionCreateOptions): Promise<Session> {
		this.assertOpen();
		const sourceRecord = this.sessions.get(source.id);
		if (sourceRecord === undefined) throw new Error(`Unknown session: ${source.id}`);
		const capturedOptions = { ...options };
		const createdAt = this.now();
		const id = capturedOptions.id ?? uuidv7(createdAt);
		this.reserveId(id);

		try {
			const snapshot = sourceRecord.storage.commitQueue.then(() =>
				this.createForkStorage(sourceRecord.storage, capturedOptions),
			);
			sourceRecord.storage.commitQueue = snapshot.then(
				() => undefined,
				() => undefined,
			);
			const storage = await snapshot;
			const metadata: SessionMetadata = {
				id,
				createdAt,
				storageVersion: MEMORY_STORAGE_VERSION,
				parentSessionId: sourceRecord.metadata.id,
			};
			const record: MemorySessionRecord = { metadata, storage, open: true };
			this.sessions.set(id, record);
			return this.openRecord(record);
		} finally {
			this.pendingIds.delete(id);
		}
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}

	private openRecord(record: MemorySessionRecord): StorageBackedSession {
		return new StorageBackedSession(
			record.metadata,
			new MemoryStorage({ now: this.now }, record.storage, () => {
				record.open = false;
			}),
		);
	}

	private createForkStorage(source: MemoryStorageState, options: ForkOptions): MemoryStorageState {
		const sourceLeaves = [...source.registers.values()].filter((register) => register.namespace === "lane.leaf");
		const sourceLeafKeys = new Set(sourceLeaves.map((register) => register.key));
		if (!sourceLeafKeys.has("main")) throw new Error("Source session is missing main lane");
		for (const register of source.registers.values()) {
			if (
				(register.namespace === "lane.config" ||
					register.namespace === "lane.state" ||
					register.namespace === "lane.lastResult") &&
				!sourceLeafKeys.has(register.key)
			) {
				throw new Error(`Source session lane ${JSON.stringify(register.key)} is missing lane.leaf`);
			}
		}
		for (const leaf of sourceLeaves) {
			if (!source.registers.has(registerKey("lane.state", leaf.key))) {
				throw new Error(`Source session lane ${JSON.stringify(leaf.key)} is missing lane.state`);
			}
			if (leaf.key !== "main" && !source.registers.has(registerKey("lane.config", leaf.key))) {
				throw new Error(`Source session lane ${JSON.stringify(leaf.key)} is missing lane.config`);
			}
			if (leaf.value !== null && !source.entries.has(leaf.value as string)) {
				throw new Error(`Source session lane ${JSON.stringify(leaf.key)} has an unknown leaf`);
			}
		}
		const copiedEntryIds = new Set<string>();
		const destinationLeaves = new Map<string, string | null>();
		if (options.scope === "tree") {
			for (const id of source.entries.keys()) copiedEntryIds.add(id);
			for (const register of sourceLeaves) destinationLeaves.set(register.key, register.value as string | null);
		} else {
			const mainLeaf = source.registers.get(registerKey("lane.leaf", "main"));
			if (mainLeaf === undefined) throw new Error("Source session is missing main lane");
			const requested = options.entryId ?? (mainLeaf.value as string | null);
			let leaf = requested;
			if (requested !== null) {
				const target = source.entries.get(requested);
				if (target === undefined) throw new Error(`Unknown fork entry: ${requested}`);
				if (options.position === "before") leaf = target.parentId;
			}
			let entryId = leaf;
			while (entryId !== null) {
				const entry = source.entries.get(entryId);
				if (entry === undefined) throw new Error(`Corrupt source branch: missing parent ${entryId}`);
				copiedEntryIds.add(entryId);
				entryId = entry.parentId;
			}
			destinationLeaves.set("main", leaf);
		}

		const entries = new Map<string, Entry>();
		for (const id of copiedEntryIds) entries.set(id, source.entries.get(id)!);
		const registers = new Map<string, Register>();
		let nextSeq = Math.max(0, ...[...entries.values()].map((entry) => entry.seq)) + 1;
		const setRegister = (namespace: RegisterNamespace, key: string, value: Register["value"]): void => {
			registers.set(registerKey(namespace, key), { namespace, key, value, seq: nextSeq++ } as Register);
		};
		for (const [lane, leaf] of destinationLeaves) {
			const configuration = source.registers.get(registerKey("lane.config", lane));
			if (configuration !== undefined) setRegister("lane.config", lane, configuration.value);
			setRegister("lane.leaf", lane, leaf);
			setRegister("lane.state", lane, { currentOperationId: null, pendingNextRun: [] });
		}
		for (const register of source.registers.values()) {
			if (
				register.namespace === "fact.name" ||
				register.namespace === "fact.custom" ||
				(register.namespace === "fact.label" && copiedEntryIds.has(register.key))
			) {
				setRegister(register.namespace, register.key, register.value);
			}
		}
		return {
			entries,
			registers,
			usage: new Map(),
			stats: {
				messageCount: [...entries.values()].filter((entry) => entry.type === "message").length,
				usage: emptyUsage(),
			},
			nextSeq,
			commitQueue: Promise.resolve(),
		};
	}

	private reserveId(id: string): void {
		if (this.sessions.has(id) || this.pendingIds.has(id)) throw new Error(`Session already exists: ${id}`);
		this.pendingIds.add(id);
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("MemorySessionRepo is closed");
	}
}
