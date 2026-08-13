import type { CommitResult, Entry, RegisterNamespace, RegisterValues, Transaction, UsageRow, Write } from "./types.ts";

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

export function prepareStorageCommit(transaction: Transaction, firstSeq: number, timestamp: number): PreparedCommit {
	const writes = transaction.writes.map((write, index) => commitWrite(write, firstSeq + index, timestamp));
	return { writes, result: { firstSeq, seqs: writes.map((write) => write.seq), timestamp } };
}
