import { uuidv7 } from "@draht/ai";
import type { FileError, FileSystem, Result } from "../types.ts";
import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlV4Header,
} from "./jsonl/types.ts";
import { assertJsonSerializable, Session } from "./session.ts";
import { type SessionMutation, SessionState } from "./state.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	SessionError,
	type SessionRepo,
	type SessionStats,
	type SessionStorage,
} from "./types.ts";

export type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlV4Header,
} from "./jsonl/types.ts";

export type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "cwd"
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "writeFile"
	| "appendFile"
	| "fileInfo"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

export interface JsonlSessionRepoOptions {
	fs: JsonlSessionRepoFileSystem;
	sessionsRoot: string;
	cwd?: string;
}

const ENTRY_TYPES = new Set<Entry["type"]>([
	"message",
	"model_change",
	"thinking_level_change",
	"active_tools_change",
	"compaction",
	"branch_summary",
	"custom",
]);
const RECORD_TYPES = new Set<LaneRecord["type"]>([
	"operation_started",
	"abort_requested",
	"operation_finished",
	"step_attempt",
	"tool_started",
	"queue_enqueued",
	"queue_cancelled",
	"write_deferred",
	"usage",
]);

function fileResult<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) {
		throw new SessionError(
			result.error.code === "not_found" ? "not_found" : "storage",
			`${message}: ${result.error.message}`,
			result.error,
		);
	}
	return result.value;
}

function invalidFile(path: string, line: number, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid JSONL v4 session ${path}: line ${line} ${message}`, cause);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string, path: string, lineNumber: number): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw invalidFile(path, lineNumber, "is not valid JSON", error instanceof Error ? error : undefined);
	}
	if (!isObject(value)) throw invalidFile(path, lineNumber, "is not a JSON object");
	return value;
}

function requireString(value: unknown, path: string, line: number, field: string): string {
	if (typeof value !== "string") throw invalidFile(path, line, `has invalid ${field}`);
	return value;
}

function requireSequence(value: unknown, path: string, line: number): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalidFile(path, line, "has invalid seq");
	return value as number;
}

function requireTimestamp(value: unknown, path: string, line: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidFile(path, line, "has invalid timestamp");
	return value as number;
}

function requireNullableId(value: unknown, path: string, line: number, field: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw invalidFile(path, line, `has invalid ${field}`);
	}
	return value as string | null;
}

function parseHeader(line: string, path: string): JsonlV4Header {
	const value = parseObject(line, path, 1);
	if (value.kind !== "header") throw invalidFile(path, 1, "is not a header");
	if (value.version !== 4) throw invalidFile(path, 1, "has unsupported session version");
	const parentSessionId = value.parentSessionId;
	if (parentSessionId !== undefined && typeof parentSessionId !== "string") {
		throw invalidFile(path, 1, "has invalid parentSessionId");
	}
	const legacyParentSessionPath = value.legacyParentSessionPath;
	if (legacyParentSessionPath !== undefined && typeof legacyParentSessionPath !== "string") {
		throw invalidFile(path, 1, "has invalid legacyParentSessionPath");
	}
	if (parentSessionId !== undefined && legacyParentSessionPath !== undefined) {
		throw invalidFile(path, 1, "has both parentSessionId and legacyParentSessionPath");
	}
	const metadataValue = value.metadata;
	if (metadataValue !== undefined && !isObject(metadataValue)) throw invalidFile(path, 1, "has invalid metadata");
	const metadata = metadataValue as JsonlV4Header["metadata"];
	return {
		kind: "header",
		version: 4,
		id: requireString(value.id, path, 1, "id"),
		createdAt: requireTimestamp(value.createdAt, path, 1),
		cwd: requireString(value.cwd, path, 1, "cwd"),
		parentSessionId,
		legacyParentSessionPath,
		metadata,
	};
}

function metadataFromHeader(header: JsonlV4Header, path: string, modifiedAt: number): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.createdAt,
		cwd: header.cwd,
		path,
		modifiedAt,
		sourceFormat: 4,
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(header.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: header.legacyParentSessionPath }),
		...(header.metadata === undefined ? {} : { metadata: header.metadata }),
	};
}

function parseMutation(line: string, path: string, lineNumber: number): SessionMutation {
	const value = parseObject(line, path, lineNumber);
	const seq = requireSequence(value.seq, path, lineNumber);
	switch (value.kind) {
		case "entry": {
			const lane = value.lane === undefined ? undefined : requireString(value.lane, path, lineNumber, "lane");
			const id = requireString(value.id, path, lineNumber, "id");
			const type = requireString(value.type, path, lineNumber, "entry type");
			if (!ENTRY_TYPES.has(type as Entry["type"]))
				throw invalidFile(path, lineNumber, `has unknown entry type ${type}`);
			const parentId = requireNullableId(value.parentId, path, lineNumber, "parentId");
			const timestamp = requireTimestamp(value.timestamp, path, lineNumber);
			const { kind: _kind, lane: _lane, ...entryFields } = value;
			const entry = { ...entryFields, id, type, parentId, seq, timestamp } as unknown as Entry;
			return lane === undefined ? { kind: "entry", entry } : { kind: "entry", lane, entry };
		}
		case "record": {
			const id = requireString(value.id, path, lineNumber, "id");
			const lane = requireString(value.lane, path, lineNumber, "lane");
			const type = requireString(value.type, path, lineNumber, "record type");
			if (!RECORD_TYPES.has(type as LaneRecord["type"]))
				throw invalidFile(path, lineNumber, `has unknown record type ${type}`);
			const timestamp = requireTimestamp(value.timestamp, path, lineNumber);
			const { kind: _kind, ...recordFields } = value;
			return {
				kind: "record",
				record: { ...recordFields, id, lane, type, seq, timestamp } as unknown as LaneRecord,
			};
		}
		case "lane":
			return {
				kind: "lane",
				seq,
				lane: requireString(value.lane, path, lineNumber, "lane"),
				leafId: requireNullableId(value.leafId, path, lineNumber, "leafId"),
			};
		case "fact":
			if (value.fact === "name") {
				return { kind: "fact", seq, fact: "name", name: requireString(value.name, path, lineNumber, "name") };
			}
			if (value.fact === "label") {
				if (value.label !== undefined && typeof value.label !== "string") {
					throw invalidFile(path, lineNumber, "has invalid label");
				}
				return {
					kind: "fact",
					seq,
					fact: "label",
					targetId: requireString(value.targetId, path, lineNumber, "targetId"),
					label: value.label,
				};
			}
			throw invalidFile(path, lineNumber, "has unknown fact type");
		default:
			throw invalidFile(path, lineNumber, "has unknown mutation kind");
	}
}

function encodeMutation(mutation: SessionMutation): string {
	switch (mutation.kind) {
		case "entry":
			return `${JSON.stringify({ kind: "entry", lane: mutation.lane, ...mutation.entry })}\n`;
		case "record":
			return `${JSON.stringify({ kind: "record", ...mutation.record })}\n`;
		case "lane":
			return `${JSON.stringify(mutation)}\n`;
		case "fact":
			return `${JSON.stringify(mutation)}\n`;
	}
}

class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly metadata: JsonlSessionMetadata;
	private readonly state = new SessionState();
	private tail: Promise<void> = Promise.resolve();

	constructor(fs: JsonlSessionRepoFileSystem, metadata: JsonlSessionMetadata) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
	}

	static async load(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) throw invalidFile(path, 1, "is missing a header");
		const header = parseHeader(physicalLines[0], path);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			let mutation: SessionMutation;
			try {
				mutation = parseMutation(line, path, index + 1);
			} catch (error) {
				if (index !== physicalLines.length - 1 || !(error instanceof SessionError) || error.cause === undefined)
					throw error;
				const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
				fileResult(await fs.writeFile(path, validPrefix), `Failed to truncate torn session tail ${path}`);
				return storage;
			}
			storage.applyMutation(mutation, path, index + 1);
		}
		if (!content.endsWith("\n")) {
			fileResult(await fs.appendFile(path, "\n"), `Failed to repair unterminated session tail ${path}`);
		}
		return storage;
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateNewLane(lane);
			this.state.validateTarget(at);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.requireLane(lane);
			this.state.validateTarget(to);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const parentId = this.state.requireLane(lane);
			this.state.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TEntry;
			const mutation: SessionMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	appendCopiedEntry<TEntry extends Entry>(source: TEntry): Promise<TEntry> {
		return this.enqueue(async () => {
			this.state.validateUnusedId(source.id);
			this.state.validateTarget(source.parentId);
			const entry = { ...structuredClone(source), seq: this.state.nextSequence };
			const mutation: SessionMutation = { kind: "entry", entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	appendForkLane(lane: string, leafId: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateTarget(leafId);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			this.state.requireLane(newRecord.lane);
			this.state.validateUnusedId(newRecord.id);
			const record = {
				...structuredClone(newRecord),
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TRecord;
			const mutation: SessionMutation = { kind: "record", record };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(record);
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return structuredClone(this.state.findRecords(query));
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return structuredClone(this.state.findOpenOperations(lane, options));
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	setName(name: string): Promise<void> {
		return this.enqueue(async () => {
			const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "name", name };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateTarget(id);
			const mutation: SessionMutation = {
				kind: "fact",
				seq: this.state.nextSequence,
				fact: "label",
				targetId: id,
				label,
			};
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async appendMutation(mutation: SessionMutation): Promise<void> {
		fileResult(
			await this.fs.appendFile(this.metadata.path, encodeMutation(mutation)),
			`Failed to append session ${this.metadata.path}`,
		);
	}

	private applyMutation(
		mutation: SessionMutation,
		path = this.metadata.path,
		line = this.state.nextSequence + 1,
	): void {
		this.state.applyMutation(mutation, (message) => {
			throw invalidFile(path, line, message);
		});
	}
}

export class JsonlSessionRepo
	implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>, AsyncDisposable
{
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private readonly cwd: string;
	private readonly storages = new Map<string, JsonlSessionStorage>();
	private rootPromise: Promise<string> | undefined;
	private tail: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(options: JsonlSessionRepoOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
		this.cwd = options.cwd ?? options.fs.cwd;
	}

	create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		return this.enqueue(async () => {
			const id = options.id ?? uuidv7();
			const path = await this.pathForId(id);
			if (fileResult(await this.fs.exists(path), `Failed to check session ${path}`)) {
				throw new SessionError("already_exists", `Session already exists: ${id}`);
			}
			const cwd = options.cwd ?? this.cwd;
			if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
			const header: JsonlV4Header = {
				kind: "header",
				version: 4,
				id,
				createdAt: Date.now(),
				cwd,
				parentSessionId: options.parentSessionId,
				metadata: options.metadata,
			};
			fileResult(
				await this.fs.createDir(await this.root(), { recursive: true }),
				`Failed to create sessions directory`,
			);
			fileResult(await this.fs.writeFile(path, `${JSON.stringify(header)}\n`), `Failed to create session ${path}`);
			const fileInfo = fileResult(await this.fs.fileInfo(path), `Failed to read session metadata ${path}`);
			const storage = new JsonlSessionStorage(this.fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
			this.storages.set(path, storage);
			return new Session(storage);
		});
	}

	open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return this.enqueue(async () => {
			const existing = this.storages.get(metadata.path);
			if (existing) return new Session(existing);
			if (!fileResult(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
				throw new SessionError("not_found", `Session not found: ${metadata.id}`);
			}
			const storage = await JsonlSessionStorage.load(this.fs, metadata.path);
			const loadedMetadata = await storage.getMetadata();
			if (loadedMetadata.id !== metadata.id)
				throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
			this.storages.set(metadata.path, storage);
			return new Session(storage);
		});
	}

	list(): Promise<JsonlSessionMetadata[]>;
	list(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]>;
	list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		return this.enqueue(async () => {
			const root = await this.root();
			if (!fileResult(await this.fs.exists(root), `Failed to check sessions directory ${root}`)) return [];
			const files = fileResult(await this.fs.listDir(root), `Failed to list sessions directory ${root}`).filter(
				(entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"),
			);
			const metadata: JsonlSessionMetadata[] = [];
			for (const file of files) {
				const existing = this.storages.get(file.path);
				if (existing) {
					const existingMetadata = await existing.getMetadata();
					if (options.cwd === undefined || existingMetadata.cwd === options.cwd) {
						metadata.push({ ...existingMetadata, modifiedAt: file.mtimeMs });
					}
					continue;
				}
				const content = fileResult(
					await this.fs.readTextFile(file.path),
					`Failed to read session header ${file.path}`,
				);
				const firstLine = content.split("\n", 1)[0];
				if (!firstLine) throw invalidFile(file.path, 1, "is missing a header");
				const header = parseHeader(firstLine, file.path);
				if (options.cwd !== undefined && header.cwd !== options.cwd) continue;
				metadata.push(metadataFromHeader(header, file.path, file.mtimeMs));
			}
			return metadata.sort((left, right) => right.modifiedAt - left.modifiedAt);
		});
	}

	delete(metadata: JsonlSessionMetadata): Promise<void> {
		return this.enqueue(async () => {
			const storage = this.storages.get(metadata.path);
			if (storage) await storage.drain();
			fileResult(await this.fs.remove(metadata.path, { force: true }), `Failed to delete session ${metadata.path}`);
			this.storages.delete(metadata.path);
		});
	}

	fork(
		source: JsonlSessionMetadata,
		options: ForkOptions & JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		return this.enqueue(async () => {
			const sourceSession = await this.openDirect(source);
			let copiedEntries: Entry[];
			let forkLanes: LanePointer[];
			if (options.scope === "tree") {
				copiedEntries = await sourceSession.findEntries({ order: "oldestFirst" });
				forkLanes = await sourceSession.getLanes();
			} else {
				const selectedEntryId = options.entryId ?? (await sourceSession.getLeafId());
				let targetId: string | null = null;
				if (selectedEntryId !== null) {
					const entry = await sourceSession.getEntry(selectedEntryId);
					if (!entry || entry.type !== "message") {
						throw new SessionError(
							"invalid_fork_target",
							`Fork target is not a message entry: ${selectedEntryId}`,
						);
					}
					const position = options.position ?? (options.entryId === undefined ? "at" : "before");
					targetId = position === "at" ? entry.id : entry.parentId;
				}
				copiedEntries =
					targetId === null
						? []
						: await sourceSession.findEntriesOnBranch({ start: targetId, order: "oldestFirst" });
				forkLanes = [{ lane: "main", leafId: targetId }];
			}

			const target = await this.createDirect({
				...options,
				parentSessionId: options.parentSessionId ?? source.id,
			});
			const targetStorage = this.storages.get((await target.getMetadata()).path)!;
			for (const entry of copiedEntries) await targetStorage.appendCopiedEntry(entry);
			for (const pointer of forkLanes) await targetStorage.appendForkLane(pointer.lane, pointer.leafId);
			const name = await sourceSession.getName();
			if (name !== undefined) await target.setName(name);
			for (const entry of copiedEntries) {
				const label = await sourceSession.getLabel(entry.id);
				if (label !== undefined) await target.setLabel(entry.id, label);
			}
			return target;
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.tail;
		await Promise.all([...this.storages.values()].map((storage) => storage.drain()));
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new SessionError("storage", "JSONL session repository is disposed"));
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async openDirect(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		const existing = this.storages.get(metadata.path);
		if (existing) return new Session(existing);
		if (!fileResult(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
			throw new SessionError("not_found", `Session not found: ${metadata.id}`);
		}
		const storage = await JsonlSessionStorage.load(this.fs, metadata.path);
		this.storages.set(metadata.path, storage);
		return new Session(storage);
	}

	private async createDirect(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? uuidv7();
		const path = await this.pathForId(id);
		if (fileResult(await this.fs.exists(path), `Failed to check session ${path}`)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}
		const cwd = options.cwd ?? this.cwd;
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt: Date.now(),
			cwd,
			parentSessionId: options.parentSessionId,
			metadata: options.metadata,
		};
		fileResult(
			await this.fs.createDir(await this.root(), { recursive: true }),
			`Failed to create sessions directory`,
		);
		fileResult(await this.fs.writeFile(path, `${JSON.stringify(header)}\n`), `Failed to create session ${path}`);
		const fileInfo = fileResult(await this.fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(this.fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
		this.storages.set(path, storage);
		return new Session(storage);
	}

	private root(): Promise<string> {
		this.rootPromise ??= this.fs
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileResult(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}

	private async pathForId(id: string): Promise<string> {
		let encoded: string;
		try {
			encoded = encodeURIComponent(id);
		} catch (error) {
			throw new SessionError(
				"invalid_payload",
				`Invalid session id ${JSON.stringify(id)}`,
				error instanceof Error ? error : undefined,
			);
		}
		return fileResult(
			await this.fs.joinPath([await this.root(), `session-${encoded}.jsonl`]),
			`Failed to resolve path for session ${id}`,
		);
	}
}
