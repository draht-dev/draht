import { uuidv7 } from "@draht/ai";
import type { AgentMessage } from "../../types.ts";
import type { Context } from "../context.ts";
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
	StorageBranchScan,
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

/**
 * Package-internal lane creation procedure for callers that own the lane mutation callback.
 *
 * TODO: Replace this one-off procedure if lane creation gains a shared command abstraction. The Harness must own the
 * new lane's mutation so the durable commit, in-memory lane publication, and recipient-bound `lane_created` enqueue
 * all happen before line release. Calling event-free `Session.createLane()` and emitting afterward would permit both
 * snapshot-after plus a stale event and delivery to listeners registered after the commit.
 */
export async function createLaneWithMutator(
	mutator: SessionMutator,
	name: string,
	at: string | null,
	configuration: LaneConfiguration,
	context: Context,
): Promise<void> {
	if (mutator.lane !== name) {
		throw new SessionInvariantError(
			`Lane mutation for ${JSON.stringify(mutator.lane)} cannot create ${JSON.stringify(name)}`,
		);
	}
	if (name.length === 0) throw new SessionInvalidLaneError(name, "lane name must not be empty");

	// R1 owns complete idle-lane and current-state validation. Slice 2 only
	// distinguishes valid existing lane shapes from partial durable lane state.
	const [leaf, storedConfiguration, storedLaneState, lastResult] = await Promise.all([
		mutator.getValue(laneLeaf(name), context),
		mutator.getValue(laneConfig(name), context),
		mutator.getValue(laneState(name), context),
		mutator.getValue(laneLastResult(name), context),
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
	if (at !== null && !(await mutator.getEntries([at], context)).has(at)) {
		throw new SessionUnknownTargetError(at);
	}

	// R6 adds the harness-wide admission barrier. Until then, close may reject
	// this lane job before Storage.commit admits it; admitted commits still drain.
	await mutator.commit(
		[
			setValueWrite(laneConfig(name), configuration),
			setValueWrite(laneLeaf(name), at),
			setValueWrite(laneState(name), { currentOperationId: null, pendingNextRun: [] }),
		],
		context,
	);
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

	commit(writes: Write[], context: Context): Promise<CommitResult> {
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
			this.commitResult = this.storage.commit(writes, context);
		} catch (error) {
			this.commitResult = Promise.reject(error);
		}
		return this.commitResult;
	}

	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		this.assertActive();
		return this.storage.getEntries(ids, context);
	}

	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		this.assertActive();
		return this.storage.getValue(address, context);
	}

	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		this.assertActive();
		return this.storage.scanValues(prefix, context);
	}

	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		this.assertActive();
		return this.storage.readList(address, options, context);
	}

	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
		this.assertActive();
		return this.storage.scanBranch(query, context);
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

	async mutate<T>(
		lane: string,
		mutation: (mutator: SessionMutator, context: Context) => T | Promise<T>,
		context: Context,
	): Promise<T> {
		this.assertOpen();
		return this.laneMutationLine.run(lane, async () => {
			const mutator = new StorageBackedSessionMutator(lane, this.storage);
			try {
				try {
					return await mutation(mutator, context);
				} finally {
					await mutator.settle();
				}
			} finally {
				mutator.invalidate();
			}
		});
	}

	async getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		this.assertOpen();
		return this.storage.getEntries(ids, context);
	}

	async getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		this.assertOpen();
		return this.storage.getValue(address, context);
	}

	async scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		this.assertOpen();
		return this.storage.scanValues(prefix, context);
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		this.assertOpen();
		return this.storage.readList(address, options, context);
	}

	async scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]> {
		this.assertOpen();
		return this.storage.scanBranch(query, context);
	}

	view(lane: string): SessionTree {
		return {
			getLeafId: (context) => this.getLeafIdForLane(lane, context),
			getEntry: (id, context) => this.getEntry(id, context),
			getStats: (context) => this.getStats(context),
			getValue: (address, context) => this.getValue(address, context),
			scanValues: (prefix, context) => this.scanValues(prefix, context),
			readList: (address, options, context) => this.readList(address, options, context),
			setValue: (address, next, context) => this.setValueForLane(lane, address, next, context),
			deleteValue: (address, context) => this.deleteValueForLane(lane, address, context),
			appendList: (address, element, context) => this.appendListForLane(lane, address, element, context),
			deleteList: (address, context) => this.deleteListForLane(lane, address, context),
			getName: (context) => this.getName(context),
			setName: (name, context) => this.setNameForLane(lane, name, context),
			getLabel: (targetId, context) => this.getLabel(targetId, context),
			setLabel: (targetId, label, context) => this.setLabelForLane(lane, targetId, label, context),
			findEntries: (query, context) => this.findEntries(query, context),
			findEntry: (query, context) => this.findEntry(query, context),
			findEntriesOnBranch: (query, context) => this.findEntriesOnBranchForLane(lane, query, context),
			findEntryOnBranch: (query, context) => this.findEntryOnBranchForLane(lane, query, context),
			appendMessage: (message, context) => this.appendMessageForLane(lane, message, context),
			appendCustomEntry: (customType, data, context) =>
				this.appendCustomEntryForLane(lane, customType, data, context),
		};
	}

	async createLane(
		name: string,
		at: string | null,
		configuration: LaneConfiguration,
		context: Context,
	): Promise<SessionTree> {
		this.assertOpen();
		await this.mutate(name, (mutator) => createLaneWithMutator(mutator, name, at, configuration, context), context);
		return this.view(name);
	}

	getLeafId(context: Context): Promise<string | null> {
		return this.getLeafIdForLane("main", context);
	}

	async getEntry(id: string, context: Context): Promise<Entry | undefined> {
		return (await this.getEntries([id], context)).get(id);
	}

	async getStats(context: Context): Promise<SessionStats> {
		this.assertOpen();
		return this.storage.getStats(context);
	}

	setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void> {
		return this.setValueForLane("main", address, next, context);
	}

	deleteValue<T>(address: Value<T>, context: Context): Promise<void> {
		return this.deleteValueForLane("main", address, context);
	}

	appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void> {
		return this.appendListForLane("main", address, element, context);
	}

	deleteList<T>(address: ValueList<T>, context: Context): Promise<void> {
		return this.deleteListForLane("main", address, context);
	}

	async getName(context: Context): Promise<string | undefined> {
		return (await this.getValue(sessionName, context))?.value;
	}

	setName(name: string | undefined, context: Context): Promise<void> {
		return this.setNameForLane("main", name, context);
	}

	async getLabel(targetId: string, context: Context): Promise<string | undefined> {
		return (await this.getValue(entryLabel(targetId), context))?.value;
	}

	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void> {
		return this.setLabelForLane("main", targetId, label, context);
	}

	async findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]> {
		query ??= {};
		this.assertOpen();
		const order = query.order ?? "desc";
		if (query.cursor !== undefined) {
			if (order === "asc" && query.cursor.seq === Number.MAX_SAFE_INTEGER) return [];
			if (order === "desc" && query.cursor.seq <= 1) return [];
		}
		return this.storage.scanEntries(
			{
				type: query.type,
				customType: query.customType,
				order,
				limit: query.limit,
				...(query.cursor === undefined
					? {}
					: order === "asc"
						? { fromSeq: query.cursor.seq + 1 }
						: { toSeq: query.cursor.seq - 1 }),
			},
			context,
		);
	}

	async findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined> {
		query ??= {};
		const entries = await this.findEntries(
			{
				...query,
				limit: query.limit === undefined ? 1 : Math.min(query.limit, 1),
			},
			context,
		);
		return entries[0];
	}

	findEntriesOnBranch(query: BranchScan | undefined, context: Context): Promise<Entry[]> {
		return this.findEntriesOnBranchForLane("main", query, context);
	}

	findEntryOnBranch(query: BranchScan | undefined, context: Context): Promise<Entry | undefined> {
		return this.findEntryOnBranchForLane("main", query, context);
	}

	appendMessage(message: AgentMessage, context: Context): Promise<string> {
		return this.captureAppend("main", { type: "message", payload: message }, context);
	}

	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string> {
		return this.captureAppend(
			"main",
			{
				type: "custom",
				customType,
				...(data === undefined ? {} : { payload: data }),
			},
			context,
		);
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		this.closePromise = this.laneMutationLine
			.seal(this.closedError)
			.then(() => this.storage.close(context))
			.finally(() => {
				this.state = "closed";
				this.onClose?.();
			});
		return this.closePromise;
	}

	private async getLeafIdForLane(lane: string, context: Context): Promise<string | null> {
		const leaf = await this.getValue(laneLeaf(lane), context);
		if (leaf === undefined) throw new Error(`Unknown lane: ${lane}`);
		return leaf.value;
	}

	private async findEntriesOnBranchForLane(
		lane: string,
		query: BranchScan | undefined,
		context: Context,
	): Promise<Entry[]> {
		query ??= {};
		this.assertOpen();
		const start = query.start ?? (await this.getLeafIdForLane(lane, context));
		if (start === null) return [];
		return this.storage.scanBranch({ ...query, start, order: query.order ?? "newestFirst" }, context);
	}

	private async findEntryOnBranchForLane(
		lane: string,
		query: BranchScan | undefined,
		context: Context,
	): Promise<Entry | undefined> {
		query ??= {};
		const entries = await this.findEntriesOnBranchForLane(
			lane,
			{
				...query,
				limit: query.limit === undefined ? 1 : Math.min(query.limit, 1),
			},
			context,
		);
		return entries[0];
	}

	private setValueForLane<T>(lane: string, address: Value<T>, next: NoInfer<T>, context: Context): Promise<void> {
		return this.mutate(
			lane,
			async (mutator) => {
				await mutator.commit([setValueWrite(address, next)], context);
			},
			context,
		);
	}

	private deleteValueForLane<T>(lane: string, address: Value<T>, context: Context): Promise<void> {
		return this.mutate(
			lane,
			async (mutator) => {
				await mutator.commit([deleteValueWrite(address)], context);
			},
			context,
		);
	}

	private appendListForLane<T>(
		lane: string,
		address: ValueList<T>,
		element: NoInfer<T>,
		context: Context,
	): Promise<void> {
		return this.mutate(
			lane,
			async (mutator) => {
				await mutator.commit([appendListWrite(address, element)], context);
			},
			context,
		);
	}

	private deleteListForLane<T>(lane: string, address: ValueList<T>, context: Context): Promise<void> {
		return this.mutate(
			lane,
			async (mutator) => {
				await mutator.commit([deleteListWrite(address)], context);
			},
			context,
		);
	}

	private setNameForLane(lane: string, name: string | undefined, context: Context): Promise<void> {
		return name === undefined
			? this.deleteValueForLane(lane, sessionName, context)
			: this.setValueForLane(lane, sessionName, name, context);
	}

	private setLabelForLane(lane: string, targetId: string, label: string | undefined, context: Context): Promise<void> {
		const address = entryLabel(targetId);
		return label === undefined
			? this.deleteValueForLane(lane, address, context)
			: this.setValueForLane(lane, address, label, context);
	}

	private appendMessageForLane(lane: string, message: AgentMessage, context: Context): Promise<string> {
		return this.captureAppend(lane, { type: "message", payload: message }, context);
	}

	private appendCustomEntryForLane(
		lane: string,
		customType: string,
		data: JsonValue | undefined,
		context: Context,
	): Promise<string> {
		return this.captureAppend(
			lane,
			{
				type: "custom",
				customType,
				...(data === undefined ? {} : { payload: data }),
			},
			context,
		);
	}

	private async captureAppend(lane: string, pending: PendingEntry, context: Context): Promise<string> {
		this.assertOpen();
		if (
			pending.type === "message" &&
			pending.payload.role === "assistant" &&
			pending.payload.stopReason === "pending"
		) {
			throw new SessionPendingAssistantMessageError();
		}
		return this.appendCaptured(lane, this.idGenerator.next(), pending, context);
	}

	private async appendCaptured(lane: string, id: string, pending: PendingEntry, context: Context): Promise<string> {
		await this.mutate(lane, (mutator) => this.appendCapturedIfReady(mutator, id, pending, context), context);
		return id;
	}

	private async appendCapturedIfReady(
		mutator: SessionMutator,
		id: string,
		pending: PendingEntry,
		context: Context,
	): Promise<void> {
		const { lane } = mutator;
		const [leaf, storedLaneState] = await Promise.all([
			mutator.getValue(laneLeaf(lane), context),
			mutator.getValue(laneState(lane), context),
		]);
		if (leaf === undefined) throw new SessionInvariantError(`Unknown lane: ${lane}`);
		if (storedLaneState === undefined)
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.state`);
		const operationId = storedLaneState.value.currentOperationId;
		if (operationId === null) {
			await mutator.commit(
				[
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
				],
				context,
			);
			return;
		}

		const [operation, storedOperationState] = await Promise.all([
			mutator.getValue(operationMeta(operationId), context),
			mutator.getValue(operationState(operationId), context),
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

		await mutator.commit(
			[
				setValueWrite(pendingEntry(id), pending),
				setValueWrite(operationState(operationId), {
					...storedOperationState.value,
					inbox: {
						...storedOperationState.value.inbox,
						writes: [...storedOperationState.value.inbox.writes, id],
					},
				}),
			],
			context,
		);
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
