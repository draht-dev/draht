import type { Context } from "../../context.ts";
import type { FileError, FileSystem, Result } from "../../types.ts";
import {
	type CommittedEntryWrite,
	type CommittedListAppendWrite,
	type CommittedListDeleteWrite,
	type CommittedUsageWrite,
	type CommittedValueDeleteWrite,
	type CommittedValueSetWrite,
	type CommittedWrite,
	StorageState,
	type StorageStateSnapshot,
} from "../storage-state.ts";
import type {
	CommitResult,
	Entry,
	EntryScan,
	EntryStructure,
	SessionStats,
	Storage,
	StorageBranchScan,
	UsageRow,
	UsageScan,
	Write,
} from "../types.ts";
import type { ListElement, ListReadOptions, StoredValue, Value, ValueList } from "../values.ts";
import { parseJsonlStorageHeader } from "./codec.ts";
import type { JsonlStorageHeader, JsonlStorageOptions } from "./types.ts";

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

function parseCommittedWrite(value: unknown): CommittedWrite {
	if (!isRecord(value)) throw new Error("Invalid JSONL transaction write");
	requireSafeInteger(value.seq, "write seq", 1);
	switch (value.kind) {
		case "entry":
			requireSafeInteger(value.timestamp, "entry timestamp", 0);
			return value as unknown as CommittedEntryWrite;
		case "usage":
			return value as unknown as CommittedUsageWrite;
		case "value":
			if (value.op === "set") return value as unknown as CommittedValueSetWrite;
			if (value.op === "delete") return value as unknown as CommittedValueDeleteWrite;
			throw new Error(`Invalid JSONL value operation: ${String(value.op)}`);
		case "list":
			if (value.op === "append") return value as unknown as CommittedListAppendWrite;
			if (value.op === "delete") return value as unknown as CommittedListDeleteWrite;
			throw new Error(`Invalid JSONL list operation: ${String(value.op)}`);
		default:
			throw new Error(`Invalid JSONL write kind: ${String(value.kind)}`);
	}
}

function parseTransaction(line: string): CommittedWrite[] {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new Error("Invalid JSONL transaction: not valid JSON", { cause: error });
	}
	return (Array.isArray(value) ? value : [value]).map(parseCommittedWrite);
}

function splitCompleteLines(content: string): { lines: string[]; torn: boolean } {
	if (content.endsWith("\n")) return { lines: content.slice(0, -1).split("\n"), torn: false };
	const lastNewline = content.lastIndexOf("\n");
	if (lastNewline === -1) return { lines: [], torn: true };
	return { lines: content.slice(0, lastNewline).split("\n"), torn: true };
}

type JsonlSnapshotContents = Pick<StorageStateSnapshot, "entries" | "scalarValues" | "listValues" | "nextSeq">;

function snapshotWrites(snapshot: JsonlSnapshotContents): CommittedWrite[] {
	const writes: CommittedWrite[] = [];
	for (const entry of snapshot.entries.values()) writes.push({ kind: "entry", ...entry });
	for (const stored of snapshot.scalarValues) {
		writes.push({
			kind: "value",
			op: "set",
			seq: stored.seq,
			namespace: stored.address.namespace,
			key: stored.address.key,
			value: stored.value,
		});
	}
	for (const stored of snapshot.listValues) {
		for (const element of stored.elements) {
			writes.push({
				kind: "list",
				op: "append",
				seq: element.seq,
				namespace: stored.address.namespace,
				key: stored.address.key,
				value: element.value,
			});
		}
	}
	return writes.sort((left, right) => left.seq - right.seq);
}

async function publishFileAtomically(fileSystem: FileSystem, destinationPath: string, content: string): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		fileValue(await fileSystem.writeFile(tempPath, content), `Failed to stage JSONL storage ${destinationPath}`);
		fileValue(
			await fileSystem.renameFile(tempPath, destinationPath),
			`Failed to publish JSONL storage ${destinationPath}`,
		);
	} catch (error) {
		await fileSystem.remove(tempPath, { force: true });
		throw error;
	}
}

/** Format-4 JSONL storage backed by an injected filesystem capability. */
export class JsonlStorage implements Storage {
	private readonly fileSystem: FileSystem;
	private readonly path: string;
	private readonly now: () => number;
	readonly header: JsonlStorageHeader;
	private readonly storageState = new StorageState();
	private commitQueue: Promise<void> = Promise.resolve();
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	private constructor(options: JsonlStorageOptions, header: JsonlStorageHeader) {
		this.fileSystem = options.fileSystem;
		this.path = options.path;
		this.now = options.now ?? Date.now;
		this.header = header;
	}

	static async create(
		options: JsonlStorageOptions,
		header: JsonlStorageHeader,
		_context: Context,
	): Promise<JsonlStorage> {
		fileValue(
			await options.fileSystem.writeFile(options.path, `${JSON.stringify(header)}\n`),
			`Failed to create JSONL storage ${options.path}`,
		);
		return new JsonlStorage(options, header);
	}

	/** Atomically create storage from a complete prepared snapshot. */
	static async createFromSnapshot(
		options: JsonlStorageOptions,
		header: JsonlStorageHeader,
		snapshot: JsonlSnapshotContents,
		context: Context,
	): Promise<JsonlStorage> {
		const writes = snapshotWrites(snapshot);
		const snapshotHeader = { ...header, nextSeq: snapshot.nextSeq };
		const content = `${[JSON.stringify(snapshotHeader), ...writes.map((write) => JSON.stringify(write))].join("\n")}\n`;
		await publishFileAtomically(options.fileSystem, options.path, content);
		return JsonlStorage.open(options, context);
	}

	static async open(options: JsonlStorageOptions, _context: Context): Promise<JsonlStorage> {
		const content = fileValue(
			await options.fileSystem.readTextFile(options.path),
			`Failed to read JSONL storage ${options.path}`,
		);
		const { lines, torn } = splitCompleteLines(content);
		if (lines[0] === undefined || lines[0] === "") {
			throw new Error(`Invalid JSONL storage ${options.path}: missing header`);
		}
		const header = parseJsonlStorageHeader(lines[0]);
		const storage = new JsonlStorage(options, header);
		for (let index = 1; index < lines.length; index++) {
			const line = lines[index]!;
			try {
				const writes = parseTransaction(line);
				storage.storageState.validateCommitted(writes);
				storage.storageState.applyValidated(writes);
			} catch (error) {
				throw new Error(`Invalid JSONL storage ${options.path}: line ${index + 1}`, { cause: error });
			}
		}
		if (header.nextSeq !== undefined) storage.storageState.advanceNextSeq(header.nextSeq);
		if (torn) await publishFileAtomically(options.fileSystem, options.path, `${lines.join("\n")}\n`);
		return storage;
	}

	async commit(writes: Write[], _context: Context): Promise<CommitResult> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		const result = this.commitQueue.then(() => this.applyCommit(writes));
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async applyCommit(writes: Write[]): Promise<CommitResult> {
		const prepared = this.storageState.prepareCommit(writes, this.now());
		if (prepared.writes.length !== 0) {
			fileValue(
				await this.fileSystem.appendFile(
					this.path,
					`${JSON.stringify(prepared.writes.length === 1 ? prepared.writes[0] : prepared.writes)}\n`,
				),
				`Failed to append JSONL storage ${this.path}`,
			);
		}
		this.storageState.applyValidated(prepared.writes);
		return prepared.result;
	}

	getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getEntries(ids));
	}

	getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getValue(address));
	}

	scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanValues(prefix));
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		_context: Context,
	): Promise<ListElement<T>[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.readList(address, options);
	}

	async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.scanBranch(query);
	}

	async scanBranchStructure(query: StorageBranchScan, _context: Context): Promise<EntryStructure[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.scanBranchStructure(query);
	}

	scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanEntries(query));
	}

	scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanUsage(query));
	}

	getStats(_context: Context): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getStats());
	}

	/** Capture the current entries and values at one serialized boundary between commits. */
	snapshot(_context: Context): Promise<{
		entries: Entry[];
		scalarValues: StoredValue<unknown>[];
		listValues: StorageStateSnapshot["listValues"];
	}> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		const result = this.commitQueue.then(() => {
			const snapshot = this.storageState.snapshot();
			return {
				entries: [...snapshot.entries.values()].sort((left, right) => left.seq - right.seq),
				scalarValues: snapshot.scalarValues,
				listValues: snapshot.listValues,
			};
		});
		this.commitQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	close(_context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.commitQueue.then(() => {
			this.state = "closed";
		});
		return this.closePromise;
	}
}
