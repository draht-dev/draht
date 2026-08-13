import type { Usage } from "@draht/ai";
import type { FileError, FileSystem, Result } from "../types.ts";
import { addUsage } from "../utils/usage.ts";
import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	Register,
	RegisterNamespace,
	RegisterValues,
	SessionStats,
	Storage,
	StorageBranchScan,
	Transaction,
	UsageRow,
	UsageScan,
	Write,
} from "./types.ts";

export const JSONL_FORMAT_VERSION = 4;

export interface JsonlStorageHeader {
	v: typeof JSONL_FORMAT_VERSION;
	kind: "header";
	id: string;
	storageVersion: number;
	createdAt: number;
	cwd?: string;
}

export interface JsonlStorageOptions {
	fileSystem: FileSystem;
	path: string;
	now?: () => number;
}

type PersistedEntryWrite = Entry & { kind: "entry" };
type PersistedUsageWrite = UsageRow & { kind: "usage" };
type PersistedRegisterSetWrite = {
	kind: "register";
	op: "set";
	seq: number;
	namespace: RegisterNamespace;
	key: string;
	value: RegisterValues[RegisterNamespace];
};
type PersistedRegisterDeleteWrite = {
	kind: "register";
	op: "delete";
	seq: number;
	namespace: RegisterNamespace;
	key: string;
};
type PersistedWrite =
	| PersistedEntryWrite
	| PersistedUsageWrite
	| PersistedRegisterSetWrite
	| PersistedRegisterDeleteWrite;

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

function fileValue<T>(result: Result<T, FileError>, action: string): T {
	if (!result.ok) throw new Error(`${action}: ${result.error.message}`, { cause: result.error });
	return result.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSafeInteger(value: unknown, field: string, minimum: number): void {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid JSONL ${field}`);
}

// TODO(S1): Move header decoding into a shared codec when JsonlSessionRepo consumes metadata and storageVersion.
function parseHeader(line: string): void {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid JSONL header: not valid JSON", { cause: error });
	}
	if (!isRecord(value) || value.kind !== "header" || value.v !== JSONL_FORMAT_VERSION) {
		throw new Error("Invalid JSONL header");
	}
	requireSafeInteger(value.createdAt, "createdAt", 0);
}

function parsePersistedWrite(value: unknown): PersistedWrite {
	if (!isRecord(value)) throw new Error("Invalid JSONL transaction write");
	requireSafeInteger(value.seq, "write seq", 1);
	switch (value.kind) {
		case "entry":
			requireSafeInteger(value.timestamp, "entry timestamp", 0);
			return value as unknown as PersistedEntryWrite;
		case "usage":
			return value as unknown as PersistedUsageWrite;
		case "register":
			if (value.op === "set") return value as unknown as PersistedRegisterSetWrite;
			if (value.op === "delete") return value as unknown as PersistedRegisterDeleteWrite;
			throw new Error(`Invalid JSONL register operation: ${String(value.op)}`);
		default:
			throw new Error(`Invalid JSONL write kind: ${String(value.kind)}`);
	}
}

function parseTransaction(line: string): PersistedWrite[] {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid JSONL transaction: not valid JSON", { cause: error });
	}
	return (Array.isArray(value) ? value : [value]).map(parsePersistedWrite);
}

function persistedWriteFrom(write: Write, seq: number, timestamp: number): PersistedWrite {
	switch (write.kind) {
		case "entry":
			return { kind: "entry", ...write.entry, seq, timestamp } as PersistedEntryWrite;
		case "usage":
			return { kind: "usage", ...write.row, seq };
		case "register":
			return write.op === "set"
				? { kind: "register", op: "set", seq, namespace: write.namespace, key: write.key, value: write.value }
				: { kind: "register", op: "delete", seq, namespace: write.namespace, key: write.key };
	}
}

/** Format-4 JSONL storage backed by an injected filesystem capability. */
export class JsonlStorage implements Storage {
	private readonly fileSystem: FileSystem;
	private readonly path: string;
	private readonly now: () => number;
	private readonly entries = new Map<string, Entry>();
	private readonly entriesBySeq: Entry[] = [];
	private readonly registers = new Map<string, Register>();
	private readonly usage = new Map<string, UsageRow>();
	private stats: SessionStats = { messageCount: 0, usage: emptyUsage() };
	private nextSeq = 1;
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	private constructor(options: JsonlStorageOptions) {
		this.fileSystem = options.fileSystem;
		this.path = options.path;
		this.now = options.now ?? Date.now;
	}

	static async create(options: JsonlStorageOptions, header: JsonlStorageHeader): Promise<JsonlStorage> {
		fileValue(
			await options.fileSystem.writeFile(options.path, `${JSON.stringify(header)}\n`),
			`Failed to create JSONL storage ${options.path}`,
		);
		return new JsonlStorage(options);
	}

	static async open(options: JsonlStorageOptions): Promise<JsonlStorage> {
		const content = fileValue(
			await options.fileSystem.readTextFile(options.path),
			`Failed to read JSONL storage ${options.path}`,
		);
		// TODO(S1): Discard and truncate a torn final transaction before admitting writes.
		if (!content.endsWith("\n")) throw new Error(`Invalid JSONL storage ${options.path}: unterminated final line`);
		const lines = content.slice(0, -1).split("\n");
		if (lines[0] === "") throw new Error(`Invalid JSONL storage ${options.path}: missing header`);
		parseHeader(lines[0]!);
		const storage = new JsonlStorage(options);
		for (let index = 1; index < lines.length; index++) {
			const line = lines[index]!;
			try {
				storage.validateAndApplyPersisted(parseTransaction(line));
			} catch (error) {
				throw new Error(`Invalid JSONL storage ${options.path}: line ${index + 1}`, { cause: error });
			}
		}
		return storage;
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		const result = this.commitQueue.then(() => this.applyCommit(transaction));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async applyCommit(transaction: Transaction): Promise<CommitResult> {
		this.validateNewWrites(transaction.writes);
		const timestamp = this.now();
		const writes = transaction.writes.map((write, index) =>
			persistedWriteFrom(write, this.nextSeq + index, timestamp),
		);
		const firstSeq = this.nextSeq;
		fileValue(
			await this.fileSystem.appendFile(this.path, `${JSON.stringify(writes.length === 1 ? writes[0] : writes)}\n`),
			`Failed to append JSONL storage ${this.path}`,
		);
		this.applyPersisted(writes);
		return { firstSeq, seqs: writes.map((write) => write.seq), timestamp };
	}

	private validateNewWrites(writes: readonly Write[]): void {
		const transactionIds = new Set<string>();
		const transactionEntryIds = new Set<string>();
		for (const write of writes) {
			if (write.kind !== "entry" && write.kind !== "usage") continue;
			const id = write.kind === "entry" ? write.entry.id : write.row.id;
			if (this.entries.has(id) || this.usage.has(id) || transactionIds.has(id)) {
				throw new Error(`Duplicate entry or usage id: ${id}`);
			}
			if (
				write.kind === "entry" &&
				write.entry.parentId !== null &&
				!this.entries.has(write.entry.parentId) &&
				!transactionEntryIds.has(write.entry.parentId)
			) {
				throw new Error(`Missing parent entry: ${write.entry.parentId}`);
			}
			transactionIds.add(id);
			if (write.kind === "entry") transactionEntryIds.add(id);
		}
	}

	private validateAndApplyPersisted(writes: readonly PersistedWrite[]): void {
		let previousSeq = this.nextSeq - 1;
		const transactionIds = new Set<string>();
		const transactionEntryIds = new Set<string>();
		for (const write of writes) {
			if (write.seq <= previousSeq) throw new Error(`Non-monotonic JSONL sequence: ${write.seq}`);
			previousSeq = write.seq;
			if (write.kind !== "entry" && write.kind !== "usage") continue;
			if (this.entries.has(write.id) || this.usage.has(write.id) || transactionIds.has(write.id)) {
				throw new Error(`Duplicate entry or usage id: ${write.id}`);
			}
			if (
				write.kind === "entry" &&
				write.parentId !== null &&
				!this.entries.has(write.parentId) &&
				!transactionEntryIds.has(write.parentId)
			) {
				throw new Error(`Missing parent entry: ${write.parentId}`);
			}
			transactionIds.add(write.id);
			if (write.kind === "entry") transactionEntryIds.add(write.id);
		}
		this.applyPersisted(writes);
	}

	private applyPersisted(writes: readonly PersistedWrite[]): void {
		for (const write of writes) {
			switch (write.kind) {
				case "entry": {
					const { kind: _kind, ...entry } = write;
					this.entries.set(entry.id, entry);
					this.entriesBySeq.push(entry);
					if (entry.type === "message") this.stats = { ...this.stats, messageCount: this.stats.messageCount + 1 };
					break;
				}
				case "usage": {
					const { kind: _kind, ...row } = write;
					this.usage.set(row.id, row);
					this.stats = { ...this.stats, usage: addUsage(this.stats.usage, row.usage) };
					break;
				}
				case "register": {
					const key = registerKey(write.namespace, write.key);
					if (write.op === "delete") {
						this.registers.delete(key);
					} else {
						this.registers.set(key, {
							namespace: write.namespace,
							key: write.key,
							value: write.value,
							seq: write.seq,
						} as Register);
					}
					break;
				}
			}
			this.nextSeq = write.seq + 1;
		}
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		const found = new Map<string, Entry>();
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (entry !== undefined) found.set(id, entry);
		}
		return Promise.resolve(found);
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.registers.get(registerKey(namespace, key)) as Register<TNamespace> | undefined);
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix = "",
	): Promise<Register<TNamespace>[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		const registers = [...this.registers.values()]
			.filter((register) => register.namespace === namespace && register.key.startsWith(keyPrefix))
			.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
		return Promise.resolve(registers as Register<TNamespace>[]);
	}

	private scanBranchEntries(query: StorageBranchScan): Entry[] {
		const start = this.entries.get(query.start);
		if (start === undefined) throw new Error(`Unknown branch start: ${query.start}`);
		const path: Entry[] = [];
		let entry: Entry | undefined = start;
		while (entry !== undefined) {
			path.push(entry);
			if (entry.parentId === null) break;
			entry = this.entries.get(entry.parentId);
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
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.scanBranchEntries(query);
	}

	async scanBranchStructure(query: StorageBranchScan): Promise<EntryStructure[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
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
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		const limit = query.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.trunc(query.limit));
		const entries: Entry[] = [];
		const descending = query.order === "desc";
		let index = descending ? this.entriesBySeq.length - 1 : 0;
		while (index >= 0 && index < this.entriesBySeq.length && entries.length < limit) {
			const entry = this.entriesBySeq[index]!;
			if (
				(query.type === undefined || entry.type === query.type) &&
				(query.customType === undefined || entry.customType === query.customType) &&
				(query.fromSeq === undefined || entry.seq >= query.fromSeq) &&
				(query.toSeq === undefined || entry.seq <= query.toSeq)
			) {
				entries.push(entry);
			}
			index += descending ? -1 : 1;
		}
		return Promise.resolve(entries);
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		const rows = [...this.usage.values()]
			.filter((row) => query.fromSeq === undefined || row.seq >= query.fromSeq)
			.filter((row) => query.toSeq === undefined || row.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return Promise.resolve(query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit)));
	}

	getStats(): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.stats);
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}
}
