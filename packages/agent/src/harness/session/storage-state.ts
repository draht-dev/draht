import type { Usage } from "@draht/ai";
import { addUsage } from "../utils/usage.ts";
import { type CommittedWrite, type PreparedCommit, prepareStorageCommit, validateCommittedWrites } from "./commit.ts";

export type {
	CommittedEntryWrite,
	CommittedRegisterDeleteWrite,
	CommittedRegisterSetWrite,
	CommittedUsageWrite,
	CommittedWrite,
	PreparedCommit,
} from "./commit.ts";

import type {
	Entry,
	EntryScan,
	EntryStructure,
	Register,
	RegisterNamespace,
	SessionStats,
	StorageBranchScan,
	Transaction,
	UsageRow,
	UsageScan,
} from "./types.ts";

export interface StorageStateSnapshot {
	entries: Map<string, Entry>;
	registers: Map<string, Register>;
	usage: Map<string, UsageRow>;
	stats: SessionStats;
	nextSeq: number;
}

export function registerKey(namespace: RegisterNamespace, key: string): string {
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

/** Current in-memory projection shared by storage backends. */
export class StorageState {
	private readonly entries: Map<string, Entry>;
	private readonly entriesBySeq: Entry[];
	private readonly registers: Map<string, Register>;
	private readonly usage: Map<string, UsageRow>;
	private stats: SessionStats;
	private nextSeq: number;

	constructor(snapshot?: StorageStateSnapshot) {
		this.entries = snapshot?.entries ?? new Map();
		this.entriesBySeq = [...this.entries.values()].sort((left, right) => left.seq - right.seq);
		this.registers = snapshot?.registers ?? new Map();
		this.usage = snapshot?.usage ?? new Map();
		this.stats = snapshot?.stats ?? { messageCount: 0, usage: emptyUsage() };
		this.nextSeq = snapshot?.nextSeq ?? 1;
	}

	prepareCommit(transaction: Transaction, timestamp: number): PreparedCommit {
		const prepared = prepareStorageCommit(transaction, this.nextSeq, timestamp);
		this.validateCommitted(prepared.writes);
		return prepared;
	}

	validateCommitted(writes: readonly CommittedWrite[]): void {
		validateCommittedWrites(writes, this.nextSeq, {
			hasEntryOrUsageId: (id) => this.entries.has(id) || this.usage.has(id),
			hasEntryId: (id) => this.entries.has(id),
		});
	}

	/** Apply writes already accepted by validateCommitted(). */
	applyValidated(writes: readonly CommittedWrite[]): void {
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

	getEntries(ids: readonly string[]): Map<string, Entry> {
		const found = new Map<string, Entry>();
		for (const id of ids) {
			const entry = this.entries.get(id);
			if (entry !== undefined) found.set(id, entry);
		}
		return found;
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Register<TNamespace> | undefined {
		return this.registers.get(registerKey(namespace, key)) as Register<TNamespace> | undefined;
	}

	listRegisters<TNamespace extends RegisterNamespace>(namespace: TNamespace, keyPrefix = ""): Register<TNamespace>[] {
		return [...this.registers.values()]
			.filter((register) => register.namespace === namespace && register.key.startsWith(keyPrefix))
			.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)) as Register<TNamespace>[];
	}

	scanBranch(query: StorageBranchScan): Entry[] {
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

	scanBranchStructure(query: StorageBranchScan): EntryStructure[] {
		return this.scanBranch(query).map((entry) => ({
			id: entry.id,
			parentId: entry.parentId,
			seq: entry.seq,
			timestamp: entry.timestamp,
			type: entry.type,
			...(entry.customType === undefined ? {} : { customType: entry.customType }),
		}));
	}

	scanEntries(query: EntryScan): Entry[] {
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
		return entries;
	}

	scanUsage(query: UsageScan): UsageRow[] {
		const rows = [...this.usage.values()]
			.filter((row) => query.fromSeq === undefined || row.seq >= query.fromSeq)
			.filter((row) => query.toSeq === undefined || row.seq <= query.toSeq)
			.sort((left, right) => (query.order === "desc" ? right.seq - left.seq : left.seq - right.seq));
		return query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
	}

	getStats(): SessionStats {
		return this.stats;
	}

	snapshot(): StorageStateSnapshot {
		return {
			entries: this.entries,
			registers: this.registers,
			usage: this.usage,
			stats: this.stats,
			nextSeq: this.nextSeq,
		};
	}
}
