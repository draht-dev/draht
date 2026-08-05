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

const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new SessionError(
			"invalid_payload",
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

function sessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${id}.jsonl`;
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
		return this.enqueue(() => this.createDirect(options));
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
		return this.enqueue(() => this.listDirect(options));
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
		validateSessionId(id);
		// Skip the repository-wide scan for generated UUIDv7 ids because their collision risk is negligible.
		if (options.id !== undefined && (await this.sessionIdExists(id))) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}

		const cwd = fileResult(
			await this.fs.absolutePath(options.cwd ?? this.cwd),
			`Failed to resolve session cwd ${options.cwd ?? this.cwd}`,
		);
		const createdAt = Date.now();
		const sessionDirectory = await this.sessionDirectory(cwd);
		const path = fileResult(
			await this.fs.joinPath([sessionDirectory, sessionFileName(createdAt, id)]),
			`Failed to resolve path for session ${id}`,
		);
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt,
			cwd,
			parentSessionId: options.parentSessionId,
			metadata: options.metadata,
		};
		fileResult(await this.fs.createDir(sessionDirectory, { recursive: true }), `Failed to create sessions directory`);
		fileResult(await this.fs.writeFile(path, encodeHeader(header)), `Failed to create session ${path}`);
		const fileInfo = fileResult(await this.fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(this.fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
		this.storages.set(path, storage);
		return new Session(storage);
	}

	private async listDirect(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		const directories = await this.sessionDirectories(options.cwd);
		const metadata: JsonlSessionMetadata[] = [];
		for (const directory of directories) {
			const files = fileResult(
				await this.fs.listDir(directory),
				`Failed to list sessions directory ${directory}`,
			).filter((entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"));
			for (const file of files) {
				const existing = this.storages.get(file.path);
				if (existing) {
					const existingMetadata = await existing.getMetadata();
					metadata.push({ ...existingMetadata, modifiedAt: file.mtimeMs });
					continue;
				}
				const content = fileResult(
					await this.fs.readTextFile(file.path),
					`Failed to read session header ${file.path}`,
				);
				const firstLine = content.split("\n", 1)[0];
				if (!firstLine) throw invalidFile(file.path, 1, "is missing a header");
				metadata.push(metadataFromHeader(parseHeader(firstLine, file.path), file.path, file.mtimeMs));
			}
		}
		return metadata.sort((left, right) => right.modifiedAt - left.modifiedAt);
	}

	private async sessionIdExists(id: string): Promise<boolean> {
		for (const storage of this.storages.values()) {
			if ((await storage.getMetadata()).id === id) return true;
		}
		const suffix = `_${id}.jsonl`;
		for (const directory of await this.sessionDirectories()) {
			const files = fileResult(await this.fs.listDir(directory), `Failed to list sessions directory ${directory}`);
			if (files.some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix))) return true;
		}
		return false;
	}

	private async sessionDirectories(cwd?: string): Promise<string[]> {
		const root = await this.root();
		if (cwd !== undefined) {
			const resolvedCwd = fileResult(await this.fs.absolutePath(cwd), `Failed to resolve session cwd ${cwd}`);
			const directory = await this.sessionDirectory(resolvedCwd);
			return fileResult(await this.fs.exists(directory), `Failed to check sessions directory ${directory}`)
				? [directory]
				: [];
		}
		if (!fileResult(await this.fs.exists(root), `Failed to check sessions directory ${root}`)) return [];
		return fileResult(await this.fs.listDir(root), `Failed to list sessions directory ${root}`)
			.filter((entry) => entry.kind === "directory" || entry.kind === "symlink")
			.map((entry) => entry.path);
	}

	private async sessionDirectory(cwd: string): Promise<string> {
		return fileResult(
			await this.fs.joinPath([await this.root(), sessionDirectoryName(cwd)]),
			`Failed to resolve sessions directory for ${cwd}`,
		);
	}

	private root(): Promise<string> {
		this.rootPromise ??= this.fs
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileResult(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}
}
