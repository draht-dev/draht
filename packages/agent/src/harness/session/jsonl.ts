import type { FileError, FileSystem, Result } from "../types.ts";
import {
	type CommittedEntryWrite,
	type CommittedRegisterDeleteWrite,
	type CommittedRegisterSetWrite,
	type CommittedUsageWrite,
	type CommittedWrite,
	StorageState,
} from "./storage-state.ts";
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

function parseCommittedWrite(value: unknown): CommittedWrite {
	if (!isRecord(value)) throw new Error("Invalid JSONL transaction write");
	requireSafeInteger(value.seq, "write seq", 1);
	switch (value.kind) {
		case "entry":
			requireSafeInteger(value.timestamp, "entry timestamp", 0);
			return value as unknown as CommittedEntryWrite;
		case "usage":
			return value as unknown as CommittedUsageWrite;
		case "register":
			if (value.op === "set") return value as unknown as CommittedRegisterSetWrite;
			if (value.op === "delete") return value as unknown as CommittedRegisterDeleteWrite;
			throw new Error(`Invalid JSONL register operation: ${String(value.op)}`);
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
	private readonly storageState = new StorageState();
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
		const { lines, torn } = splitCompleteLines(content);
		if (lines[0] === undefined || lines[0] === "") {
			throw new Error(`Invalid JSONL storage ${options.path}: missing header`);
		}
		parseHeader(lines[0]);
		const storage = new JsonlStorage(options);
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
		if (torn) await publishFileAtomically(options.fileSystem, options.path, `${lines.join("\n")}\n`);
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
		const prepared = this.storageState.prepareCommit(transaction, this.now());
		fileValue(
			await this.fileSystem.appendFile(
				this.path,
				`${JSON.stringify(prepared.writes.length === 1 ? prepared.writes[0] : prepared.writes)}\n`,
			),
			`Failed to append JSONL storage ${this.path}`,
		);
		this.storageState.applyValidated(prepared.writes);
		return prepared.result;
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getEntries(ids));
	}

	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getRegister(namespace, key));
	}

	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix = "",
	): Promise<Register<TNamespace>[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.listRegisters(namespace, keyPrefix));
	}

	async scanBranch(query: StorageBranchScan): Promise<Entry[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.scanBranch(query);
	}

	async scanBranchStructure(query: StorageBranchScan): Promise<EntryStructure[]> {
		if (this.state !== "open") throw new Error("JsonlStorage is closed");
		return this.storageState.scanBranchStructure(query);
	}

	scanEntries(query: EntryScan): Promise<Entry[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanEntries(query));
	}

	scanUsage(query: UsageScan): Promise<UsageRow[]> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.scanUsage(query));
	}

	getStats(): Promise<SessionStats> {
		if (this.state !== "open") return Promise.reject(new Error("JsonlStorage is closed"));
		return Promise.resolve(this.storageState.getStats());
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
