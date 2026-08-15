import type {
	CommitResult,
	Entry,
	NewEntry,
	RegisterNamespace,
	RegisterValues,
	Transaction,
	UsageRow,
	Write,
} from "./types.ts";

export type CommittedEntryWrite = Entry & { kind: "entry" };
export type CommittedUsageWrite = UsageRow & { kind: "usage" };
export type CommittedRegisterSetWrite = {
	kind: "register";
	op: "set";
	seq: number;
	namespace: RegisterNamespace;
	key: string;
	value: RegisterValues[RegisterNamespace];
};
export type CommittedRegisterDeleteWrite = {
	kind: "register";
	op: "delete";
	seq: number;
	namespace: RegisterNamespace;
	key: string;
};
export type CommittedWrite =
	| CommittedEntryWrite
	| CommittedUsageWrite
	| CommittedRegisterSetWrite
	| CommittedRegisterDeleteWrite;

export interface PreparedCommit {
	writes: CommittedWrite[];
	result: CommitResult;
}

export interface CommitValidationState {
	hasEntryOrUsageId(id: string): boolean;
	hasEntryId(id: string): boolean;
}

export function commitWrite(write: Write, seq: number, timestamp: number): CommittedWrite {
	switch (write.kind) {
		case "entry":
			return { kind: "entry", ...write.entry, seq, timestamp } as CommittedEntryWrite;
		case "usage":
			return { kind: "usage", ...write.row, seq };
		case "register":
			return write.op === "set"
				? { kind: "register", op: "set", seq, namespace: write.namespace, key: write.key, value: write.value }
				: { kind: "register", op: "delete", seq, namespace: write.namespace, key: write.key };
	}
}

export function materializeCommittedEntry(entry: NewEntry, seq: number, timestamp: number): Entry {
	return { ...entry, seq, timestamp } as Entry;
}

export function prepareStorageCommit(transaction: Transaction, firstSeq: number, timestamp: number): PreparedCommit {
	const writes = transaction.writes.map((write, index) => commitWrite(write, firstSeq + index, timestamp));
	return { writes, result: { firstSeq, seqs: writes.map((write) => write.seq), timestamp } };
}

export function validateCommittedWrites(
	writes: readonly CommittedWrite[],
	firstSeq: number,
	state: CommitValidationState,
): void {
	let previousSeq = firstSeq - 1;
	const transactionIds = new Set<string>();
	const transactionEntryIds = new Set<string>();
	for (const write of writes) {
		if (write.seq <= previousSeq) throw new Error(`Non-monotonic storage sequence: ${write.seq}`);
		previousSeq = write.seq;
		if (write.kind !== "entry" && write.kind !== "usage") continue;
		if (state.hasEntryOrUsageId(write.id) || transactionIds.has(write.id)) {
			throw new Error(`Duplicate entry or usage id: ${write.id}`);
		}
		if (
			write.kind === "entry" &&
			write.parentId !== null &&
			!state.hasEntryId(write.parentId) &&
			!transactionEntryIds.has(write.parentId)
		) {
			throw new Error(`Missing parent entry: ${write.parentId}`);
		}
		transactionIds.add(write.id);
		if (write.kind === "entry") transactionEntryIds.add(write.id);
	}
}
