import { uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../types.ts";
import { insertEntry } from "./commit.ts";
import { LaneMutationLine } from "./lane-mutations.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	EntryQuery,
	IdGenerator,
	JsonValue,
	LaneConfiguration,
	OperationMeta,
	OperationState,
	PendingEntry,
	Session,
	SessionMetadata,
	SessionMutator,
	SessionStats,
	SessionTree,
	Storage,
	Write,
} from "./types.ts";
import {
	appendList as appendListWrite,
	deleteList as deleteListWrite,
	deleteValue as deleteValueWrite,
	entryLabel,
	type ListElement,
	type ListReadOptions,
	laneConfig,
	laneLastResult,
	laneLeaf,
	laneState,
	operationMeta,
	operationState,
	pendingEntry,
	type StoredValue,
	sessionName,
	setValue as setValueWrite,
	type Value,
	type ValueList,
} from "./values.ts";

interface StorageBackedSessionOptions {
	laneMutationLine?: LaneMutationLine;
	onClose?: () => void;
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

/** A pending assistant message cannot be persisted as a session entry. */
export class SessionPendingAssistantMessageError extends Error {
	constructor() {
		super("Cannot persist a pending assistant message");
		this.name = "SessionPendingAssistantMessageError";
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

class StorageBackedSessionMutator implements SessionMutator {
	readonly lane: string;
	private readonly storage: Storage;
	private active = true;
	private commitResult: Promise<CommitResult> | undefined;

	constructor(lane: string, storage: Storage) {
		this.lane = lane;
		this.storage = storage;
	}

	commit(writes: Write[]): Promise<CommitResult> {
		this.assertActive();
		if (this.commitResult !== undefined) return Promise.reject(new Error("SessionMutator commit already attempted"));
		try {
			for (const write of writes) {
				if (
					write.kind === "entry" &&
					write.entry.type === "message" &&
					write.entry.message.role === "assistant" &&
					write.entry.message.stopReason === "pending"
				) {
					throw new SessionPendingAssistantMessageError();
				}
			}
			this.commitResult = this.storage.commit(writes);
		} catch (error) {
			this.commitResult = Promise.reject(error);
		}
		return this.commitResult;
	}

	getEntries(ids: string[]): Promise<Map<string, Entry>> {
		this.assertActive();
		return this.storage.getEntries(ids);
	}

	getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
		this.assertActive();
		return this.storage.getValue(address);
	}

	scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
		this.assertActive();
		return this.storage.scanValues(prefix);
	}

	readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]> {
		this.assertActive();
		return this.storage.readList(address, options);
	}

	settle(): Promise<void> {
		return (
			this.commitResult?.then(
				() => undefined,
				() => undefined,
			) ?? Promise.resolve()
		);
	}

	invalidate(): void {
		this.active = false;
	}

	private assertActive(): void {
		if (!this.active) throw new Error("SessionMutator cannot be used outside its mutation callback");
	}
}

/** Package-internal typed boundary shared by concrete session repositories. */
export class StorageBackedSession<TMetadata extends SessionMetadata = SessionMetadata> implements Session<TMetadata> {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator = { next: uuidv7 };
	private readonly storage: Storage;
	private readonly laneMutationLine: LaneMutationLine;
	private readonly onClose: (() => void) | undefined;
	private readonly closedError = new Error("Session is closed");
	private state: "open" | "closing" | "closed" = "open";
	private closePromise: Promise<void> | undefined;

	constructor(metadata: TMetadata, storage: Storage, options: StorageBackedSessionOptions = {}) {
		this.metadata = metadata;
		this.storage = storage;
		this.laneMutationLine = options.laneMutationLine ?? new LaneMutationLine();
		this.onClose = options.onClose;
	}

	async mutate<T>(lane: string, mutation: (mutator: SessionMutator) => T | Promise<T>): Promise<T> {
		this.assertOpen();
		return this.laneMutationLine.run(lane, async () => {
			const mutator = new StorageBackedSessionMutator(lane, this.storage);
			try {
				try {
					return await mutation(mutator);
				} finally {
					await mutator.settle();
				}
			} finally {
				mutator.invalidate();
			}
		});
	}

	async getEntries(ids: string[]): Promise<Map<string, Entry>> {
		this.assertOpen();
		return this.storage.getEntries(ids);
	}

	async getValue<T>(address: Value<T>): Promise<StoredValue<T> | undefined> {
		this.assertOpen();
		return this.storage.getValue(address);
	}

	async scanValues<T>(prefix: Value<T>): Promise<StoredValue<T>[]> {
		this.assertOpen();
		return this.storage.scanValues(prefix);
	}

	async readList<T>(address: ValueList<T>, options?: ListReadOptions): Promise<ListElement<T>[]> {
		this.assertOpen();
		return this.storage.readList(address, options);
	}

	view(lane: string): SessionTree {
		return {
			getLeafId: () => this.getLeafIdForLane(lane),
			getEntry: (id) => this.getEntry(id),
			getStats: () => this.getStats(),
			getValue: (address) => this.getValue(address),
			scanValues: (prefix) => this.scanValues(prefix),
			readList: (address, options) => this.readList(address, options),
			setValue: (address, next) => this.setValueForLane(lane, address, next),
			deleteValue: (address) => this.deleteValueForLane(lane, address),
			appendList: (address, element) => this.appendListForLane(lane, address, element),
			deleteList: (address) => this.deleteListForLane(lane, address),
			getName: () => this.getName(),
			setName: (name) => this.setNameForLane(lane, name),
			getLabel: (targetId) => this.getLabel(targetId),
			setLabel: (targetId, label) => this.setLabelForLane(lane, targetId, label),
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
		return this.mutate(name, async (mutator) => {
			// R1 owns complete idle-lane and current-state validation. Slice 2 only
			// distinguishes valid existing lane shapes from partial durable lane state.
			const [leaf, storedConfiguration, storedLaneState, lastResult] = await Promise.all([
				mutator.getValue(laneLeaf(name)),
				mutator.getValue(laneConfig(name)),
				mutator.getValue(laneState(name)),
				mutator.getValue(laneLastResult(name)),
			]);
			const presentCount = [leaf, storedConfiguration, storedLaneState, lastResult].filter(
				(stored) => stored !== undefined,
			).length;
			if (
				leaf !== undefined &&
				storedLaneState !== undefined &&
				(storedConfiguration !== undefined || (name === "main" && lastResult === undefined))
			) {
				throw new SessionLaneExistsError(name);
			}
			if (presentCount !== 0) {
				throw new SessionInvariantError(`Lane ${JSON.stringify(name)} has incomplete durable state`);
			}
			if (at !== null && !(await mutator.getEntries([at])).has(at)) throw new SessionUnknownTargetError(at);

			// R6 adds the harness-wide admission barrier. Until then, close may reject
			// this lane job before Storage.commit admits it; admitted commits still drain.
			await mutator.commit([
				setValueWrite(laneConfig(name), configuration),
				setValueWrite(laneLeaf(name), at),
				setValueWrite(laneState(name), { currentOperationId: null, pendingNextRun: [] }),
			]);
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

	setValue<T>(address: Value<T>, next: NoInfer<T>): Promise<void> {
		return this.setValueForLane("main", address, next);
	}

	deleteValue<T>(address: Value<T>): Promise<void> {
		return this.deleteValueForLane("main", address);
	}

	appendList<T>(address: ValueList<T>, element: NoInfer<T>): Promise<void> {
		return this.appendListForLane("main", address, element);
	}

	deleteList<T>(address: ValueList<T>): Promise<void> {
		return this.deleteListForLane("main", address);
	}

	async getName(): Promise<string | undefined> {
		return (await this.getValue(sessionName))?.value;
	}

	setName(name: string | undefined): Promise<void> {
		return this.setNameForLane("main", name);
	}

	async getLabel(targetId: string): Promise<string | undefined> {
		return (await this.getValue(entryLabel(targetId)))?.value;
	}

	setLabel(targetId: string, label: string | undefined): Promise<void> {
		return this.setLabelForLane("main", targetId, label);
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
				this.onClose?.();
			});
		return this.closePromise;
	}

	private async getLeafIdForLane(lane: string): Promise<string | null> {
		const leaf = await this.getValue(laneLeaf(lane));
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

	private setValueForLane<T>(lane: string, address: Value<T>, next: NoInfer<T>): Promise<void> {
		return this.mutate(lane, async (mutator) => {
			await mutator.commit([setValueWrite(address, next)]);
		});
	}

	private deleteValueForLane<T>(lane: string, address: Value<T>): Promise<void> {
		return this.mutate(lane, async (mutator) => {
			await mutator.commit([deleteValueWrite(address)]);
		});
	}

	private appendListForLane<T>(lane: string, address: ValueList<T>, element: NoInfer<T>): Promise<void> {
		return this.mutate(lane, async (mutator) => {
			await mutator.commit([appendListWrite(address, element)]);
		});
	}

	private deleteListForLane<T>(lane: string, address: ValueList<T>): Promise<void> {
		return this.mutate(lane, async (mutator) => {
			await mutator.commit([deleteListWrite(address)]);
		});
	}

	private setNameForLane(lane: string, name: string | undefined): Promise<void> {
		return name === undefined
			? this.deleteValueForLane(lane, sessionName)
			: this.setValueForLane(lane, sessionName, name);
	}

	private setLabelForLane(lane: string, targetId: string, label: string | undefined): Promise<void> {
		const address = entryLabel(targetId);
		return label === undefined ? this.deleteValueForLane(lane, address) : this.setValueForLane(lane, address, label);
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
		if (
			pending.type === "message" &&
			pending.payload.role === "assistant" &&
			pending.payload.stopReason === "pending"
		) {
			throw new SessionPendingAssistantMessageError();
		}
		return this.appendCaptured(lane, this.idGenerator.next(), pending);
	}

	private async appendCaptured(lane: string, id: string, pending: PendingEntry): Promise<string> {
		await this.mutate(lane, (mutator) => this.appendCapturedIfReady(mutator, id, pending));
		return id;
	}

	private async appendCapturedIfReady(mutator: SessionMutator, id: string, pending: PendingEntry): Promise<void> {
		const { lane } = mutator;
		const [leaf, storedLaneState] = await Promise.all([
			mutator.getValue(laneLeaf(lane)),
			mutator.getValue(laneState(lane)),
		]);
		if (leaf === undefined) throw new SessionInvariantError(`Unknown lane: ${lane}`);
		if (storedLaneState === undefined)
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.state`);
		const operationId = storedLaneState.value.currentOperationId;
		if (operationId === null) {
			await mutator.commit([
				insertEntry(
					pending.type === "message"
						? { id, parentId: leaf.value, type: "message", message: pending.payload }
						: {
								id,
								parentId: leaf.value,
								type: "custom",
								customType: pending.customType,
								...(pending.payload === undefined ? {} : { data: pending.payload }),
							},
				),
				setValueWrite(laneLeaf(lane), id),
			]);
			return;
		}

		const [operation, storedOperationState] = await Promise.all([
			mutator.getValue(operationMeta(operationId)),
			mutator.getValue(operationState(operationId)),
		]);
		if (operation === undefined) {
			throw new SessionInvariantError(`Active operation ${operationId} is missing op.meta`);
		}
		if (storedOperationState === undefined) {
			throw new SessionInvariantError(`Active operation ${operationId} is missing op.state`);
		}
		this.validateCurrentOperation(lane, operation.value, storedOperationState.value);
		if (storedOperationState.value.kind !== "run") {
			// TODO: Tree writes during structural operations must wait for the operation to finish,
			// then re-evaluate the lane state. That coordination is not yet implemented.
			throw new Error(`Cannot append while structural operation ${operationId} is active`);
		}

		await mutator.commit([
			setValueWrite(pendingEntry(id), pending),
			setValueWrite(operationState(operationId), {
				...storedOperationState.value,
				inbox: {
					...storedOperationState.value.inbox,
					writes: [...storedOperationState.value.inbox.writes, id],
				},
			}),
		]);
	}

	private validateCurrentOperation(lane: string, operation: OperationMeta, state: OperationState): void {
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
