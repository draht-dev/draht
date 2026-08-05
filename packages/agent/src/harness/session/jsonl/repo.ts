import { uuidv7 } from "@draht/ai";
import { assertJsonSerializable, Session } from "../session.ts";
import { type Entry, type ForkOptions, type LanePointer, SessionError, type SessionRepo } from "../types.ts";
import { encodeHeader, metadataFromHeader, parseHeader } from "./codec.ts";
import { fileResult, invalidFile } from "./errors.ts";
import { JsonlSessionStorage } from "./storage.ts";
import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoFileSystem,
	JsonlSessionRepoOptions,
	JsonlV4Header,
} from "./types.ts";

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
			fileResult(await this.fs.writeFile(path, encodeHeader(header)), `Failed to create session ${path}`);
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
		fileResult(await this.fs.writeFile(path, encodeHeader(header)), `Failed to create session ${path}`);
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
