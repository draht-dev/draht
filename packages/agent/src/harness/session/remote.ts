import { uuidv7 } from "@draht/ai";
import type { Context } from "../context.ts";
import { withoutAbortSignal } from "../context.ts";
import {
	SessionInvalidLaneError,
	SessionInvariantError,
	SessionLaneExistsError,
	SessionPendingAssistantMessageError,
	SessionUnknownTargetError,
} from "./session.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	EntryQuery,
	IdGenerator,
	JsonValue,
	LaneConfiguration,
	Session,
	SessionMetadata,
	SessionMutator,
	SessionStats,
	SessionTree,
	Write,
} from "./types.ts";
import type { ListElement, ListReadOptions, StoredValue, Value, ValueList } from "./values.ts";

/** Untyped invocation boundary used by the remote Session facade. */
export interface RemoteSessionRpc {
	invoke(method: string, args: unknown, context: Context): Promise<unknown>;
}

interface RemoteSessionOpenResult {
	handle: string;
	metadata: SessionMetadata;
}

/** SessionTree facade whose methods execute against one remote Session lane. */
export class RemoteSessionTree implements SessionTree {
	protected readonly rpc: RemoteSessionRpc;
	protected readonly handle: string;
	protected readonly lane: string;

	constructor(rpc: RemoteSessionRpc, handle: string, lane: string) {
		this.rpc = rpc;
		this.handle = handle;
		this.lane = lane;
	}

	async getLeafId(context: Context): Promise<string | null> {
		return expectNullableString(await this.invoke("session.tree.getLeafId", {}, context), "leaf ID");
	}

	async getEntry(id: string, context: Context): Promise<Entry | undefined> {
		const result = await this.invoke("session.tree.getEntry", { id }, context);
		return result === null ? undefined : (expectObject(result, "entry") as unknown as Entry);
	}

	async getStats(context: Context): Promise<SessionStats> {
		return expectObject(
			await this.invoke("session.tree.getStats", {}, context),
			"Session stats",
		) as unknown as SessionStats;
	}

	async getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		const result = await this.invoke("session.tree.getValue", { address }, context);
		return result === null ? undefined : (expectObject(result, "stored value") as unknown as StoredValue<T>);
	}

	async scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		return expectArray(
			await this.invoke("session.tree.scanValues", { prefix }, context),
			"stored values",
		) as StoredValue<T>[];
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		return expectArray(
			await this.invoke("session.tree.readList", { address, options: options ?? null }, context),
			"list elements",
		) as ListElement<T>[];
	}

	async setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void> {
		expectNull(await this.invoke("session.tree.setValue", { address, next }, context));
	}

	async deleteValue<T>(address: Value<T>, context: Context): Promise<void> {
		expectNull(await this.invoke("session.tree.deleteValue", { address }, context));
	}

	async appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void> {
		expectNull(await this.invoke("session.tree.appendList", { address, element }, context));
	}

	async deleteList<T>(address: ValueList<T>, context: Context): Promise<void> {
		expectNull(await this.invoke("session.tree.deleteList", { address }, context));
	}

	async getName(context: Context): Promise<string | undefined> {
		const value = expectNullableString(await this.invoke("session.tree.getName", {}, context), "Session name");
		return value === null ? undefined : value;
	}

	async setName(name: string | undefined, context: Context): Promise<void> {
		expectNull(await this.invoke("session.tree.setName", { name: name ?? null }, context));
	}

	async getLabel(targetId: string, context: Context): Promise<string | undefined> {
		const value = expectNullableString(
			await this.invoke("session.tree.getLabel", { targetId }, context),
			"entry label",
		);
		return value === null ? undefined : value;
	}

	async setLabel(targetId: string, label: string | undefined, context: Context): Promise<void> {
		expectNull(await this.invoke("session.tree.setLabel", { targetId, label: label ?? null }, context));
	}

	async findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]> {
		return expectArray(
			await this.invoke("session.tree.findEntries", { query: query ?? null }, context),
			"entries",
		) as Entry[];
	}

	async findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined> {
		const result = await this.invoke("session.tree.findEntry", { query: query ?? null }, context);
		return result === null ? undefined : (expectObject(result, "entry") as unknown as Entry);
	}

	async findEntriesOnBranch(query: BranchScan | undefined, context: Context): Promise<Entry[]> {
		return expectArray(
			await this.invoke("session.tree.findEntriesOnBranch", { query: query ?? null }, context),
			"branch entries",
		) as Entry[];
	}

	async findEntryOnBranch(query: BranchScan | undefined, context: Context): Promise<Entry | undefined> {
		const result = await this.invoke("session.tree.findEntryOnBranch", { query: query ?? null }, context);
		return result === null ? undefined : (expectObject(result, "entry") as unknown as Entry);
	}

	async appendMessage(message: Parameters<SessionTree["appendMessage"]>[0], context: Context): Promise<string> {
		return expectString(await this.invoke("session.tree.appendMessage", { message }, context), "entry ID");
	}

	async appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string> {
		return expectString(
			await this.invoke(
				"session.tree.appendCustomEntry",
				{ customType, ...(data === undefined ? {} : { data }) },
				context,
			),
			"entry ID",
		);
	}

	protected async invoke(method: string, args: Record<string, unknown>, context: Context): Promise<unknown> {
		try {
			return await this.rpc.invoke(method, { handle: this.handle, lane: this.lane, ...args }, context);
		} catch (error) {
			const code = remoteErrorCode(error);
			if (code === "session_pending_message") throw new SessionPendingAssistantMessageError();
			if (code === "session_invariant") throw new SessionInvariantError(remoteErrorMessage(error));
			throw error;
		}
	}
}

/** Session facade backed entirely by untyped RPC calls. */
export class RemoteSession<TMetadata extends SessionMetadata = SessionMetadata>
	extends RemoteSessionTree
	implements Session<TMetadata>
{
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator = { next: uuidv7 };
	private closed = false;

	constructor(rpc: RemoteSessionRpc, handle: string, metadata: TMetadata) {
		super(rpc, handle, "main");
		this.metadata = metadata;
	}

	static async open(
		rpc: RemoteSessionRpc,
		sessionId: string,
		context: Context,
	): Promise<RemoteSession<SessionMetadata>> {
		const result = expectObject(await rpc.invoke("session.open", { sessionId }, context), "remote Session");
		const opened: RemoteSessionOpenResult = {
			handle: expectString(result.handle, "remote Session handle"),
			metadata: decodeMetadata(result.metadata),
		};
		return new RemoteSession(rpc, opened.handle, opened.metadata);
	}

	view(lane: string): SessionTree {
		this.assertOpen();
		return new RemoteSessionTree(this.rpc, this.handle, lane);
	}

	async getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		const pairs = expectArray(await this.invoke("session.getEntries", { ids }, context), "entry pairs");
		const entries = new Map<string, Entry>();
		for (const pair of pairs) {
			if (!Array.isArray(pair) || pair.length !== 2)
				throw new TypeError("Remote Session returned an invalid entry pair");
			entries.set(expectString(pair[0], "entry ID"), expectObject(pair[1], "entry") as unknown as Entry);
		}
		return entries;
	}

	async getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		const result = await this.invoke("session.getValue", { address }, context);
		return result === null ? undefined : (expectObject(result, "stored value") as unknown as StoredValue<T>);
	}

	async scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		return expectArray(
			await this.invoke("session.scanValues", { prefix }, context),
			"stored values",
		) as StoredValue<T>[];
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		return expectArray(
			await this.invoke("session.readList", { address, options: options ?? null }, context),
			"list elements",
		) as ListElement<T>[];
	}

	async mutate<T>(
		lane: string,
		mutation: (mutator: SessionMutator, context: Context) => T | Promise<T>,
		context: Context,
	): Promise<T> {
		this.assertOpen();
		const opened = expectObject(
			await this.invoke("session.mutation.begin", { mutationLane: lane }, context),
			"remote mutation",
		);
		const mutationId = expectString(opened.mutationId, "remote mutation ID");
		const mutator = new RemoteSessionMutator(this.rpc, this.handle, mutationId, lane);
		let outcome: { ok: true; value: T } | { ok: false; error: unknown };
		try {
			outcome = { ok: true, value: await mutation(mutator, context) };
		} catch (error) {
			outcome = { ok: false, error };
		}
		await mutator.settle();
		mutator.invalidate();
		let finishFailure: { error: unknown } | undefined;
		try {
			expectNull(
				await this.rpc.invoke(
					"session.mutation.finish",
					{ handle: this.handle, mutationId },
					withoutAbortSignal(context),
				),
			);
		} catch (error) {
			finishFailure = { error };
		}
		if (!outcome.ok) {
			if (finishFailure !== undefined) {
				throw new AggregateError(
					[outcome.error, finishFailure.error],
					"Remote Session mutation and cleanup failed",
				);
			}
			throw outcome.error;
		}
		if (finishFailure !== undefined) throw finishFailure.error;
		return outcome.value;
	}

	async createLane(
		name: string,
		at: string | null,
		configuration: LaneConfiguration,
		context: Context,
	): Promise<SessionTree> {
		this.assertOpen();
		try {
			expectNull(await this.invoke("session.createLane", { name, at, configuration }, context));
		} catch (error) {
			const code = remoteErrorCode(error);
			if (code === "session_invalid_lane") throw new SessionInvalidLaneError(name, remoteErrorMessage(error));
			if (code === "session_lane_exists") throw new SessionLaneExistsError(name);
			if (code === "session_unknown_target" && at !== null) throw new SessionUnknownTargetError(at);
			throw error;
		}
		return this.view(name);
	}

	async close(context: Context): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		expectNull(await this.rpc.invoke("session.close", { handle: this.handle }, context));
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Session is closed");
	}
}

class RemoteSessionMutator implements SessionMutator {
	readonly lane: string;
	private readonly rpc: RemoteSessionRpc;
	private readonly handle: string;
	private readonly mutationId: string;
	private active = true;
	private commitPromise: Promise<CommitResult> | undefined;

	constructor(rpc: RemoteSessionRpc, handle: string, mutationId: string, lane: string) {
		this.rpc = rpc;
		this.handle = handle;
		this.mutationId = mutationId;
		this.lane = lane;
	}

	commit(writes: Write[], context: Context): Promise<CommitResult> {
		this.assertActive();
		if (this.commitPromise !== undefined) return Promise.reject(new Error("SessionMutator commit already attempted"));
		this.commitPromise = this.rpc
			.invoke("session.mutation.commit", { handle: this.handle, mutationId: this.mutationId, writes }, context)
			.then(decodeCommitResult);
		return this.commitPromise;
	}

	async getEntries(ids: string[], context: Context): Promise<Map<string, Entry>> {
		this.assertActive();
		const pairs = expectArray(
			await this.rpc.invoke(
				"session.mutation.getEntries",
				{ handle: this.handle, mutationId: this.mutationId, ids },
				context,
			),
			"entry pairs",
		);
		const entries = new Map<string, Entry>();
		for (const pair of pairs) {
			if (!Array.isArray(pair) || pair.length !== 2)
				throw new TypeError("Remote Session returned an invalid entry pair");
			entries.set(expectString(pair[0], "entry ID"), expectObject(pair[1], "entry") as unknown as Entry);
		}
		return entries;
	}

	async getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined> {
		this.assertActive();
		const result = await this.rpc.invoke(
			"session.mutation.getValue",
			{ handle: this.handle, mutationId: this.mutationId, address },
			context,
		);
		return result === null ? undefined : (expectObject(result, "stored value") as unknown as StoredValue<T>);
	}

	async scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]> {
		this.assertActive();
		return expectArray(
			await this.rpc.invoke(
				"session.mutation.scanValues",
				{ handle: this.handle, mutationId: this.mutationId, prefix },
				context,
			),
			"stored values",
		) as StoredValue<T>[];
	}

	async readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]> {
		this.assertActive();
		return expectArray(
			await this.rpc.invoke(
				"session.mutation.readList",
				{ handle: this.handle, mutationId: this.mutationId, address, options: options ?? null },
				context,
			),
			"list elements",
		) as ListElement<T>[];
	}

	settle(): Promise<void> {
		return (
			this.commitPromise?.then(
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

function decodeMetadata(value: unknown): SessionMetadata {
	const metadata = expectObject(value, "Session metadata");
	return {
		id: expectString(metadata.id, "Session ID"),
		createdAt: expectNumber(metadata.createdAt, "Session creation time"),
		storageVersion: expectNumber(metadata.storageVersion, "Session storage version"),
		...(metadata.cwd === undefined ? {} : { cwd: expectString(metadata.cwd, "Session cwd") }),
		...(metadata.parentSessionId === undefined
			? {}
			: { parentSessionId: expectString(metadata.parentSessionId, "parent Session ID") }),
		...(metadata.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: expectString(metadata.legacyParentSessionPath, "legacy parent Session path") }),
	};
}

function decodeCommitResult(value: unknown): CommitResult {
	const result = expectObject(value, "commit result");
	const seqs = expectArray(result.seqs, "commit sequences").map((seq) => expectNumber(seq, "commit sequence"));
	return {
		firstSeq: expectNumber(result.firstSeq, "first commit sequence"),
		seqs,
		timestamp: expectNumber(result.timestamp, "commit timestamp"),
	};
}

function expectObject(value: unknown, description: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`Remote Session returned an invalid ${description}`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`Remote Session returned an invalid ${description}`);
	}
	return value as Record<string, unknown>;
}

function expectArray(value: unknown, description: string): unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`Remote Session returned invalid ${description}`);
	return value;
}

function expectString(value: unknown, description: string): string {
	if (typeof value !== "string") throw new TypeError(`Remote Session returned an invalid ${description}`);
	return value;
}

function expectNullableString(value: unknown, description: string): string | null {
	if (value === null) return null;
	return expectString(value, description);
}

function expectNumber(value: unknown, description: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`Remote Session returned an invalid ${description}`);
	}
	return value;
}

function expectNull(value: unknown): void {
	if (value !== null) throw new TypeError("Remote Session operation returned an invalid result");
}

function remoteErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function remoteErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
