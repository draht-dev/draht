import { uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../types.ts";
import { LaneMutationLine } from "./lane-mutations.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	EntryQuery,
	IdGenerator,
	JsonValue,
	LaneConfiguration,
	Operation,
	OperationState,
	PendingEntry,
	Register,
	RegisterNamespace,
	Session,
	SessionMetadata,
	SessionStats,
	SessionTree,
	Storage,
	Transaction,
} from "./types.ts";

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

/** A requested session lane name is invalid. */
export class SessionInvalidLaneError extends Error {
	readonly lane: string;
	readonly reason: string;

	constructor(lane: string, reason: string) {
		super(`Invalid lane ${JSON.stringify(lane)}: ${reason}`);
		this.name = "SessionInvalidLaneError";
		this.lane = lane;
		this.reason = reason;
	}
}

/** A requested session lane already exists. */
export class SessionLaneExistsError extends Error {
	readonly lane: string;

	constructor(lane: string) {
		super(`Lane already exists: ${lane}`);
		this.name = "SessionLaneExistsError";
		this.lane = lane;
	}
}

/** A requested session entry target does not exist. */
export class SessionUnknownTargetError extends Error {
	readonly targetId: string;

	constructor(targetId: string) {
		super(`Unknown target: ${targetId}`);
		this.name = "SessionUnknownTargetError";
		this.targetId = targetId;
	}
}

/** Package-internal typed boundary shared by concrete session repositories. */
export class StorageBackedSession<TMetadata extends SessionMetadata = SessionMetadata> implements Session<TMetadata> {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator = { next: uuidv7 };
	private readonly storage: Storage;
	private readonly laneMutationLine: LaneMutationLine;
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(metadata: TMetadata, storage: Storage, concurrency: StorageBackedSessionConcurrency = {}) {
		this.metadata = metadata;
		this.storage = storage;
		this.laneMutationLine = concurrency.laneMutationLine ?? new LaneMutationLine();
	}

	async commit(transaction: Transaction): Promise<CommitResult> {
		this.assertOpen();
		return this.storage.commit(transaction);
	}

	async getEntries(ids: string[]): Promise<Map<string, Entry>> {
		this.assertOpen();
		return this.storage.getEntries(ids);
	}

	async getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined> {
		this.assertOpen();
		return this.storage.getRegister(namespace, key);
	}

	async listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]> {
		this.assertOpen();
		return this.storage.listRegisters(namespace, keyPrefix);
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

	async createLane(name: string, at: string | null, configuration: LaneConfiguration): Promise<SessionTree> {
		this.assertOpen();
		if (name.length === 0) throw new SessionInvalidLaneError(name, "lane name must not be empty");
		return this.laneMutationLine.run(name, async () => {
			// R1 owns complete idle-lane and current-state validation. Slice 2 only
			// distinguishes valid existing lane shapes from partial durable lane state.
			const [leaf, storedConfiguration, laneState, lastResult] = await Promise.all([
				this.getRegister("lane.leaf", name),
				this.getRegister("lane.config", name),
				this.getRegister("lane.state", name),
				this.getRegister("lane.lastResult", name),
			]);
			const presentCount = [leaf, storedConfiguration, laneState, lastResult].filter(
				(register) => register !== undefined,
			).length;
			if (
				leaf !== undefined &&
				laneState !== undefined &&
				(storedConfiguration !== undefined || (name === "main" && lastResult === undefined))
			) {
				throw new SessionLaneExistsError(name);
			}
			if (presentCount !== 0) {
				throw new SessionInvariantError(`Lane ${JSON.stringify(name)} has incomplete durable state`);
			}
			if (at !== null && !(await this.getEntries([at])).has(at)) throw new SessionUnknownTargetError(at);

			// R6 adds the harness-wide admission barrier. Until then, close may reject
			// this lane job before Storage.commit admits it; admitted commits still drain.
			await this.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "lane.config", key: name, value: configuration },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: name, value: at },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: name,
						value: { currentOperationId: null, pendingNextRun: [] },
					},
				],
			});
			return this.view(name);
		});
	}

	getLeafId(): Promise<string | null> {
		return this.getLeafIdForLane("main");
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		return (await this.getEntries([id])).get(id);
	}

	async getStats(): Promise<SessionStats> {
		this.assertOpen();
		return this.storage.getStats();
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
		return this.storage.scanEntries({
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
		return this.storage.scanBranch({ ...query, start, order: query.order ?? "newestFirst" });
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

	private async captureAppend(lane: string, pending: PendingEntry): Promise<string> {
		this.assertOpen();
		return this.appendCaptured(lane, this.idGenerator.next(), pending);
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
