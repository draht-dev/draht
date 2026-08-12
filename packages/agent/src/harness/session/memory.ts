import type { Usage } from "@draht/ai";
import { addUsage } from "../utils/usage.ts";
import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	Register,
	RegisterNamespace,
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

function registerKey(namespace: RegisterNamespace, key: string): string {
	return `${namespace}\u0000${key}`;
}

function clone<T>(value: T): T {
	return structuredClone(value);
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

export class MemoryStorage implements Storage {
	private readonly now: () => number;
	private entries = new Map<string, Entry>();
	private registers = new Map<string, Register>();
	private usage = new Map<string, UsageRow>();
	private stats: SessionStats = { messageCount: 0, usage: emptyUsage() };
	private nextSeq = 1;
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(options: MemoryStorageOptions = {}) {
		this.now = options.now ?? Date.now;
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		const admittedTransaction = clone(transaction);
		const result = this.commitQueue.then(() => this.applyCommit(admittedTransaction));
		this.commitQueue = result.then(
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

		const timestamp = this.now();
		const entries: Entry[] = [];
		const registers = new Map<string, Register | undefined>();
		const usage: UsageRow[] = [];
		let stats: SessionStats | undefined;
		let nextSeq = this.nextSeq;
		const firstSeq = nextSeq;
		const seqs: number[] = [];

		for (const write of committedTransaction.writes) {
			const seq = nextSeq++;
			seqs.push(seq);
			switch (write.kind) {
				case "entry":
					stats ??= clone(this.stats);
					entries.push({ ...write.entry, seq, timestamp } as Entry);
					if (write.entry.type === "message") stats.messageCount++;
					break;
				case "usage":
					stats ??= clone(this.stats);
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

		for (const entry of entries) this.entries.set(entry.id, entry);
		for (const [key, register] of registers) {
			if (register === undefined) this.registers.delete(key);
			else this.registers.set(key, register);
		}
		for (const row of usage) this.usage.set(row.id, row);
		if (stats !== undefined) this.stats = stats;
		this.nextSeq = nextSeq;
		return { firstSeq, seqs, timestamp };
	}

	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const found = new Map<string, Entry>();
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (entry !== undefined) found.set(id, clone(entry));
		}
		return Promise.resolve(found);
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const register = this.registers.get(registerKey(namespace, key));
		return Promise.resolve(register === undefined ? undefined : (clone(register) as Register<TNamespace>));
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix = "",
	): Promise<Register<TNamespace>[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const registers = [...this.registers.values()]
			.filter((register) => register.namespace === namespace && register.key.startsWith(keyPrefix))
			.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
		return Promise.resolve(clone(registers) as Register<TNamespace>[]);
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
		if (this.state !== "open") throw new Error("MemoryStorage is closed");
		return clone(this.scanBranchEntries(query));
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
		const entries = [...this.entries.values()]
			.filter((entry) => query.type === undefined || entry.type === query.type)
			.filter((entry) => query.customType === undefined || entry.customType === query.customType)
			.filter((entry) => query.fromSeq === undefined || entry.seq >= query.fromSeq)
			.filter((entry) => query.toSeq === undefined || entry.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return Promise.resolve(clone(query.limit === undefined ? entries : entries.slice(0, Math.max(0, query.limit))));
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		const rows = [...this.usage.values()]
			.filter((row) => query.fromSeq === undefined || row.seq >= query.fromSeq)
			.filter((row) => query.toSeq === undefined || row.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return Promise.resolve(clone(query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit))));
	}

	getStats(): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("MemoryStorage is closed"));
		return Promise.resolve(clone(this.stats));
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
