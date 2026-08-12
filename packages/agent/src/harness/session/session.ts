import { uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../types.ts";
import { SessionCodec, SessionCodecError } from "./codec.ts";
import { LaneMutationLine } from "./lane-mutations.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	EntryQuery,
	IdGenerator,
	JsonValue,
	Operation,
	OperationState,
	PendingEntry,
	Register,
	RegisterNamespace,
	Session,
	SessionCodecOptions,
	SessionMetadata,
	SessionStats,
	SessionTree,
	Storage,
	Transaction,
} from "./types.ts";

type StorageBackedSessionContract<TMetadata extends SessionMetadata> = Pick<
	Session<TMetadata>,
	| keyof SessionTree
	| "metadata"
	| "idGenerator"
	| "view"
	| "commit"
	| "getEntries"
	| "getRegister"
	| "listRegisters"
	| "close"
>;
interface StorageBackedSessionConcurrency {
	laneMutationLine?: LaneMutationLine;
}

/** Durable session state is internally inconsistent and cannot be safely advanced. */
export class SessionInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionInvariantError";
	}
}

/** Package-internal validated boundary shared by concrete session repositories. */
// TODO: Implement createLane() and replace this subset with Session<TMetadata>.
export class StorageBackedSession<TMetadata extends SessionMetadata = SessionMetadata>
	implements StorageBackedSessionContract<TMetadata>
{
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator = { next: uuidv7 };
	private readonly storage: Storage;
	private readonly codec: SessionCodec;
	private readonly laneMutationLine: LaneMutationLine;
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(
		metadata: TMetadata,
		storage: Storage,
		codecOptions: SessionCodecOptions = {},
		concurrency: StorageBackedSessionConcurrency = {},
	) {
		this.metadata = structuredClone(metadata);
		this.storage = storage;
		this.codec = new SessionCodec(codecOptions);
		this.laneMutationLine = concurrency.laneMutationLine ?? new LaneMutationLine();
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		this.assertOpen();
		const encoded = this.codec.encodeTransaction(transaction);
		return this.storage.commit(encoded);
	}

	async getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>> {
		this.assertOpen();
		const requestedIds = new Set(ids);
		const stored = await this.storage.getEntries(ids);
		const entries = new Map<string, Entry>();
		for (const [key, value] of stored) {
			const path = `$[${JSON.stringify(key)}]`;
			if (!requestedIds.has(key))
				throw new SessionCodecError(path, "storage returned an entry that was not requested");
			const entry = this.codec.decodeEntry(value);
			if (entry.id !== key) throw new SessionCodecError(`${path}.id`, "entry id must equal its storage map key");
			entries.set(key, entry);
		}
		return entries;
	}

	async getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		this.assertOpen();
		const stored = await this.storage.getRegister(namespace, key);
		if (stored === undefined) return undefined;
		const register = this.codec.decodeRegister(namespace, stored);
		if (register.key !== key) throw new SessionCodecError("$.key", "register key must equal the requested key");
		return register;
	}

	async listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]> {
		this.assertOpen();
		const stored = await this.storage.listRegisters(namespace, keyPrefix);
		return stored.map((value, index) => {
			const register = this.codec.decodeRegister(namespace, value);
			if (keyPrefix !== undefined && !register.key.startsWith(keyPrefix)) {
				throw new SessionCodecError(`$[${index}].key`, "register key must match the requested prefix");
			}
			return register;
		});
	}

	view(lane: string): SessionTree {
		return {
			getLeafId: () => this.getLeafIdForLane(lane),
			getEntry: (id) => this.getEntry(id),
			getStats: () => this.getStats(),
			getName: () => this.getName(),
			setName: (name) => this.setName(name),
			getLabel: (targetId) => this.getLabel(targetId),
			setLabel: (targetId, label) => this.setLabel(targetId, label),
			getCustomFact: (key) => this.getCustomFact(key),
			setCustomFact: (key, value) => this.setCustomFact(key, value),
			findEntries: (query) => this.findEntries(query),
			findEntry: (query) => this.findEntry(query),
			findEntriesOnBranch: (query) => this.findEntriesOnBranchForLane(lane, query),
			findEntryOnBranch: (query) => this.findEntryOnBranchForLane(lane, query),
			appendMessage: (message) => this.appendMessageForLane(lane, message),
			appendCustomEntry: (customType, data) => this.appendCustomEntryForLane(lane, customType, data),
		};
	}

	getLeafId(): Promise<string | null> {
		return this.getLeafIdForLane("main");
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		return (await this.getEntries([id])).get(id);
	}

	async getStats(): Promise<SessionStats> {
		this.assertOpen();
		return this.codec.decodeSessionStats(await this.storage.getStats());
	}

	async getName(): Promise<string | undefined> {
		return (await this.getRegister("fact.name", ""))?.value;
	}

	async setName(name: string | undefined): Promise<void> {
		await this.commit({
			writes: [
				name === undefined
					? { kind: "register", op: "delete", namespace: "fact.name", key: "" }
					: { kind: "register", op: "set", namespace: "fact.name", key: "", value: name },
			],
		});
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return (await this.getRegister("fact.label", targetId))?.value;
	}

	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.commit({
			writes: [
				label === undefined
					? { kind: "register", op: "delete", namespace: "fact.label", key: targetId }
					: { kind: "register", op: "set", namespace: "fact.label", key: targetId, value: label },
			],
		});
	}

	async getCustomFact(key: string): Promise<JsonValue | undefined> {
		return (await this.getRegister("fact.custom", key))?.value;
	}

	async setCustomFact(key: string, value: JsonValue | undefined): Promise<void> {
		await this.commit({
			writes: [
				value === undefined
					? { kind: "register", op: "delete", namespace: "fact.custom", key }
					: { kind: "register", op: "set", namespace: "fact.custom", key, value },
			],
		});
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		this.assertOpen();
		const order = query.order ?? "desc";
		if (query.cursor !== undefined) {
			if (order === "asc" && query.cursor.seq === Number.MAX_SAFE_INTEGER) return [];
			if (order === "desc" && query.cursor.seq <= 1) return [];
		}
		const stored = await this.storage.scanEntries({
			type: query.type,
			customType: query.customType,
			order,
			limit: query.limit,
			...(query.cursor === undefined
				? {}
				: order === "asc"
					? { fromSeq: query.cursor.seq + 1 }
					: { toSeq: query.cursor.seq - 1 }),
		});
		return stored.map((entry) => this.codec.decodeEntry(entry));
	}

	async findEntry(query: EntryQuery = {}): Promise<Entry | undefined> {
		const entries = await this.findEntries({
			...query,
			limit: query.limit === undefined ? 1 : Math.min(query.limit, 1),
		});
		return entries[0];
	}

	findEntriesOnBranch(query: BranchScan = {}): Promise<Entry[]> {
		return this.findEntriesOnBranchForLane("main", query);
	}

	findEntryOnBranch(query: BranchScan = {}): Promise<Entry | undefined> {
		return this.findEntryOnBranchForLane("main", query);
	}

	appendMessage(message: AgentMessage): Promise<string> {
		return this.captureAppend("main", { type: "message", payload: message });
	}

	appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
		return this.captureAppend("main", {
			type: "custom",
			customType,
			...(data === undefined ? {} : { payload: data }),
		});
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.laneMutationLine
			.seal(this.closedError)
			.then(() => this.storage.close())
			.finally(() => {
				this.state = "closed";
			});
		return this.closePromise;
	}

	private async getLeafIdForLane(lane: string): Promise<string | null> {
		const leaf = await this.getRegister("lane.leaf", lane);
		if (leaf === undefined) throw new Error(`Unknown lane: ${lane}`);
		return leaf.value;
	}

	private async findEntriesOnBranchForLane(lane: string, query: BranchScan = {}): Promise<Entry[]> {
		this.assertOpen();
		const start = query.start ?? (await this.getLeafIdForLane(lane));
		if (start === null) return [];
		const stored = await this.storage.scanBranch({ ...query, start, order: query.order ?? "newestFirst" });
		return stored.map((entry) => this.codec.decodeEntry(entry));
	}

	private async findEntryOnBranchForLane(lane: string, query: BranchScan = {}): Promise<Entry | undefined> {
		const entries = await this.findEntriesOnBranchForLane(lane, {
			...query,
			limit: query.limit === undefined ? 1 : Math.min(query.limit, 1),
		});
		return entries[0];
	}

	private appendMessageForLane(lane: string, message: AgentMessage): Promise<string> {
		return this.captureAppend(lane, { type: "message", payload: message });
	}

	private appendCustomEntryForLane(lane: string, customType: string, data?: JsonValue): Promise<string> {
		return this.captureAppend(lane, {
			type: "custom",
			customType,
			...(data === undefined ? {} : { payload: data }),
		});
	}

	private captureAppend(lane: string, value: unknown): Promise<string> {
		try {
			this.assertOpen();
			const pending = this.codec.encodePendingEntry(value);
			const id = this.idGenerator.next();
			return this.appendCaptured(lane, id, pending);
		} catch (error) {
			// SessionTree methods return promises; translate synchronous validation into that declared boundary.
			return Promise.reject(error);
		}
	}

	private async appendCaptured(lane: string, id: string, pending: PendingEntry): Promise<string> {
		await this.laneMutationLine.run(lane, () => this.appendCapturedIfReady(lane, id, pending));
		return id;
	}

	private async appendCapturedIfReady(lane: string, id: string, pending: PendingEntry): Promise<void> {
		const [leaf, laneState] = await Promise.all([
			this.getRegister("lane.leaf", lane),
			this.getRegister("lane.state", lane),
		]);
		if (leaf === undefined) throw new SessionInvariantError(`Unknown lane: ${lane}`);
		if (laneState === undefined)
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.state`);
		const operationId = laneState.value.currentOperationId;
		if (operationId === null) {
			await this.commit({
				writes: [
					{
						kind: "entry",
						entry:
							pending.type === "message"
								? { id, parentId: leaf.value, type: "message", message: pending.payload }
								: {
										id,
										parentId: leaf.value,
										type: "custom",
										customType: pending.customType,
										...(pending.payload === undefined ? {} : { data: pending.payload }),
									},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: id },
				],
			});
			return;
		}

		const [operation, operationState] = await Promise.all([
			this.getRegister("op.meta", operationId),
			this.getRegister("op.state", operationId),
		]);
		if (operation === undefined) {
			throw new SessionInvariantError(`Active operation ${operationId} is missing op.meta`);
		}
		if (operationState === undefined) {
			throw new SessionInvariantError(`Active operation ${operationId} is missing op.state`);
		}
		this.validateCurrentOperation(lane, operation.value, operationState.value);
		if (operationState.value.kind !== "run") {
			// TODO: Tree writes during structural operations must wait for the operation to finish,
			// then re-evaluate the lane state. That coordination is not yet implemented.
			throw new Error(`Cannot append while structural operation ${operationId} is active`);
		}

		await this.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "pending.entry", key: id, value: pending },
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: operationId,
					value: {
						...operationState.value,
						inbox: {
							...operationState.value.inbox,
							writes: [...operationState.value.inbox.writes, id],
						},
					},
				},
			],
		});
	}

	private validateCurrentOperation(lane: string, operation: Operation, state: OperationState): void {
		if (operation.lane !== lane) {
			throw new SessionInvariantError(
				`Active operation ${operation.operationId} belongs to lane ${JSON.stringify(operation.lane)}, not ${JSON.stringify(lane)}`,
			);
		}
		if (operation.intent.kind !== state.kind) {
			throw new SessionInvariantError(
				`Active operation ${operation.operationId} intent ${operation.intent.kind} does not match state ${state.kind}`,
			);
		}
	}

	private assertOpen(): void {
		if (this.state !== "open") throw this.closedError;
	}
}
