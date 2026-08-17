import { uuidv7 } from "@draht/ai";
import type { FileError, FileSystem, Result } from "../../types.ts";
import { createForkSnapshot, type ForkSourceSnapshot } from "../fork.ts";
import { StorageBackedSession } from "../session.ts";
import type { ForkOptions, Session, SessionRepo } from "../types.ts";
import { laneLeaf, laneState, setValue } from "../values.ts";
import { type JsonlParsedSessionHeader, parseJsonlSessionHeader } from "./codec.ts";
import { metadataFromLegacyV3Header } from "./legacy-v3.ts";
import { JsonlStorage } from "./storage.ts";
import {
	JSONL_FORMAT_VERSION,
	JSONL_STORAGE_VERSION,
	type JsonlSessionCreateOptions,
	type JsonlSessionListOptions,
	type JsonlSessionMetadata,
	type JsonlSessionRepoOptions,
	type JsonlStorageHeader,
} from "./types.ts";

function fileValue<T>(result: Result<T, FileError>, action: string): T {
	if (!result.ok) throw new Error(`${action}: ${result.error.message}`, { cause: result.error });
	return result.value;
}

function metadataFromHeader(header: JsonlStorageHeader, path: string, modifiedAt: number): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.createdAt,
		storageVersion: header.storageVersion,
		cwd: header.cwd,
		path,
		modifiedAt,
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(header.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: header.legacyParentSessionPath }),
	};
}

function metadataFromParsedHeader(
	parsed: JsonlParsedSessionHeader,
	path: string,
	modifiedAt: number,
): JsonlSessionMetadata {
	if (parsed.format === "v3-legacy") return metadataFromLegacyV3Header(parsed.header, path, modifiedAt);
	return metadataFromHeader(parsed.header, path, modifiedAt);
}

function sessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${encodeURIComponent(id)}.jsonl`;
}

/** File-backed format-4 session repository lifecycle. */
export class JsonlSessionRepo
	implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	private readonly fileSystem: FileSystem;
	private readonly sessionsRootInput: string;
	private readonly now: () => number;
	private readonly openSessions = new Map<string, JsonlStorage>();
	private readonly pendingCreates = new Set<string>();
	private rootPromise: Promise<string> | undefined;
	private closed = false;
	private closePromise: Promise<void> | undefined;

	constructor(options: JsonlSessionRepoOptions) {
		this.fileSystem = options.fileSystem;
		this.sessionsRootInput = options.sessionsRoot;
		this.now = options.now ?? Date.now;
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		this.assertOpen();
		const createdAt = this.now();
		const { cwd, id } = await this.resolveCreateDestination(options.cwd, options.id, createdAt);
		const key = this.sessionKey(cwd, id);
		if (this.openSessions.has(key) || this.pendingCreates.has(key)) throw new Error(`Session already exists: ${id}`);
		this.pendingCreates.add(key);
		let path: string | undefined;
		let storage: JsonlStorage | undefined;
		try {
			path = await this.resolveNewSessionPath(cwd, createdAt, id);
			const header: JsonlStorageHeader = {
				v: JSONL_FORMAT_VERSION,
				kind: "header",
				id,
				storageVersion: JSONL_STORAGE_VERSION,
				createdAt,
				cwd,
				...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			};
			// TODO: do we want to make session creation atomic?
			storage = await JsonlStorage.create({ fileSystem: this.fileSystem, path, now: this.now }, header);
			await storage.commit([
				setValue(laneLeaf("main"), null),
				setValue(laneState("main"), { currentOperationId: null, pendingNextRun: [] }),
			]);
			const info = fileValue(await this.fileSystem.fileInfo(path), `Failed to read session ${path}`);
			return this.publishOpenSession(metadataFromHeader(header, path, info.mtimeMs), storage, key);
		} catch (error) {
			await storage?.close();
			if (path !== undefined) await this.fileSystem.remove(path, { force: true });
			throw error;
		} finally {
			this.pendingCreates.delete(key);
		}
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		this.assertOpen();
		const key = this.sessionKey(metadata.cwd, metadata.id);
		if (this.openSessions.has(key)) throw new Error(`Session is already open: ${metadata.id}`);
		let storage: JsonlStorage | undefined;
		try {
			storage = await this.loadStorage(metadata);
			return this.publishOpenSession(metadata, storage, key);
		} catch (error) {
			await storage?.close();
			throw error;
		}
	}

	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		this.assertOpen();
		const cwd =
			options.cwd === undefined
				? undefined
				: fileValue(
						await this.fileSystem.absolutePath(options.cwd),
						`Failed to resolve session cwd ${options.cwd}`,
					);
		const root = await this.root();
		if (!fileValue(await this.fileSystem.exists(root), `Failed to check sessions root ${root}`)) return [];
		const directories = cwd === undefined ? await this.sessionDirectories(root) : [await this.sessionDirectory(cwd)];
		const metadata: JsonlSessionMetadata[] = [];
		for (const directory of directories) metadata.push(...(await this.listDirectory(directory, cwd)));
		return metadata.sort(
			(left, right) =>
				right.createdAt - left.createdAt || left.id.localeCompare(right.id) || left.cwd.localeCompare(right.cwd),
		);
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		this.assertOpen();
		const key = this.sessionKey(metadata.cwd, metadata.id);
		if (this.openSessions.has(key)) throw new Error(`Session is open: ${metadata.id}`);
		if (!fileValue(await this.fileSystem.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
			throw new Error(`Session file does not exist: ${metadata.path}`);
		}
		fileValue(await this.fileSystem.remove(metadata.path), `Failed to delete session ${metadata.path}`);
	}

	async fork(source: JsonlSessionMetadata, options: ForkOptions): Promise<Session<JsonlSessionMetadata>> {
		this.assertOpen();
		const createdAt = this.now();
		const sourceStorage = this.openSessions.get(this.sessionKey(source.cwd, source.id));
		const sourceSnapshot = await (sourceStorage === undefined
			? this.loadClosedForkSourceSnapshot(source)
			: sourceStorage.snapshot());
		const { cwd, id } = await this.resolveCreateDestination(source.cwd, options.id, createdAt);
		const destinationKey = this.sessionKey(cwd, id);
		if (this.openSessions.has(destinationKey) || this.pendingCreates.has(destinationKey)) {
			throw new Error(`Session already exists: ${id}`);
		}
		this.pendingCreates.add(destinationKey);

		let path: string | undefined;
		let storage: JsonlStorage | undefined;
		try {
			path = await this.resolveNewSessionPath(cwd, createdAt, id);
			const snapshot = createForkSnapshot(sourceSnapshot, options);
			const header: JsonlStorageHeader = {
				v: JSONL_FORMAT_VERSION,
				kind: "header",
				id,
				storageVersion: JSONL_STORAGE_VERSION,
				createdAt,
				cwd,
				parentSessionId: source.id,
			};
			storage = await JsonlStorage.createFromSnapshot(
				{ fileSystem: this.fileSystem, path, now: this.now },
				header,
				snapshot,
			);
			const info = fileValue(await this.fileSystem.fileInfo(path), `Failed to read session ${path}`);
			return this.publishOpenSession(metadataFromHeader(header, path, info.mtimeMs), storage, destinationKey);
		} catch (error) {
			await storage?.close().catch(() => undefined);
			if (path !== undefined) await this.fileSystem.remove(path, { force: true });
			throw error;
		} finally {
			this.pendingCreates.delete(destinationKey);
		}
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.closed = true;
		// TODO: Define ownership semantics before deciding whether repository close should close session handles.
		this.closePromise = Promise.resolve();
		return this.closePromise;
	}

	private async resolveCreateDestination(
		cwdInput: string,
		id: string | undefined,
		createdAt: number,
	): Promise<{ cwd: string; id: string }> {
		const destinationId = id ?? uuidv7(createdAt);
		const cwd = fileValue(await this.fileSystem.absolutePath(cwdInput), `Failed to resolve session cwd ${cwdInput}`);
		return { cwd, id: destinationId };
	}

	private async listDirectory(directory: string, cwd?: string): Promise<JsonlSessionMetadata[]> {
		if (!fileValue(await this.fileSystem.exists(directory), `Failed to check sessions directory ${directory}`)) {
			return [];
		}
		const files = fileValue(
			await this.fileSystem.listDir(directory),
			`Failed to list sessions directory ${directory}`,
		).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
		const metadata: JsonlSessionMetadata[] = [];
		for (const file of files) {
			const lines = fileValue(
				await this.fileSystem.readTextLines(file.path, { maxLines: 1 }),
				`Failed to read session header ${file.path}`,
			);
			if (lines[0] === undefined) continue;
			const header = parseJsonlSessionHeader(lines[0]);
			if (!header.ok) continue;
			const discovered = metadataFromParsedHeader(header.value, file.path, file.mtimeMs);
			// Directory encoding is lossy: /a/b and /a-b both map to --a-b--.
			if (cwd === undefined || discovered.cwd === cwd) metadata.push(discovered);
		}
		return metadata;
	}

	private async sessionDirectories(root: string): Promise<string[]> {
		return fileValue(await this.fileSystem.listDir(root), `Failed to list sessions root ${root}`)
			.filter((entry) => entry.kind === "directory")
			.map((entry) => entry.path);
	}

	private async sessionDirectory(cwd: string): Promise<string> {
		return fileValue(
			await this.fileSystem.joinPath([await this.root(), sessionDirectoryName(cwd)]),
			`Failed to resolve sessions directory for ${cwd}`,
		);
	}

	private async resolveNewSessionPath(cwd: string, createdAt: number, id: string): Promise<string> {
		const directory = await this.sessionDirectory(cwd);
		await this.assertSessionIdAvailable(directory, id);
		fileValue(await this.fileSystem.createDir(directory), `Failed to create sessions directory ${directory}`);
		return fileValue(
			await this.fileSystem.joinPath([directory, sessionFileName(createdAt, id)]),
			`Failed to resolve path for session ${id}`,
		);
	}

	private async assertSessionIdAvailable(directory: string, id: string): Promise<void> {
		if (!fileValue(await this.fileSystem.exists(directory), `Failed to check sessions directory ${directory}`))
			return;

		const suffix = `_${encodeURIComponent(id)}.jsonl`;
		const idExists = fileValue(
			await this.fileSystem.listDir(directory),
			`Failed to list sessions directory ${directory}`,
		).some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix));
		if (idExists) throw new Error(`Session already exists: ${id}`);
	}

	private async loadClosedForkSourceSnapshot(source: JsonlSessionMetadata): Promise<ForkSourceSnapshot> {
		const storage = await this.loadStorage(source);
		try {
			return await storage.snapshot();
		} finally {
			await storage.close();
		}
	}

	private publishOpenSession(
		metadata: JsonlSessionMetadata,
		storage: JsonlStorage,
		key: string,
	): StorageBackedSession<JsonlSessionMetadata> {
		if (this.openSessions.has(key)) throw new Error(`Session is already open: ${metadata.id}`);
		const session = new StorageBackedSession(metadata, storage, {
			onClose: () => {
				if (this.openSessions.get(key) === storage) this.openSessions.delete(key);
			},
		});
		this.openSessions.set(key, storage);
		return session;
	}

	private sessionKey(cwd: string, id: string): string {
		return `${cwd}\0${id}`;
	}

	private async loadStorage(metadata: JsonlSessionMetadata): Promise<JsonlStorage> {
		// TODO: normalize discovered legacy v3 sessions on open instead of rejecting them here.
		if (!fileValue(await this.fileSystem.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
			throw new Error(`Session file does not exist: ${metadata.path}`);
		}
		const storage = await JsonlStorage.open({
			fileSystem: this.fileSystem,
			path: metadata.path,
			now: this.now,
		});
		try {
			if (storage.header.id !== metadata.id || storage.header.cwd !== metadata.cwd) {
				throw new Error(`Session identity does not match header: ${metadata.id}`);
			}
			if (storage.header.storageVersion !== JSONL_STORAGE_VERSION) {
				throw new Error(`Session ${metadata.id} uses unsupported storage version ${storage.header.storageVersion}`);
			}
			return storage;
		} catch (error) {
			await storage.close();
			throw error;
		}
	}

	private root(): Promise<string> {
		this.rootPromise ??= this.fileSystem
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileValue(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("JsonlSessionRepo is closed");
	}
}
