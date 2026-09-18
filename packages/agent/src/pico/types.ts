import type { Message } from "@draht/ai";
import type { Context, JsonValue } from "@draht/chord";

/** Session-global durable record identifier. */
export type Id = number;
/** Storage-assigned atomic commit sequence. */
export type Seq = number;

/** The root conversation always uses this reserved ID. */
export const ROOT_CONVERSATION_ID: Id = 1;

export type StoredError = {
	readonly message: string;
	readonly detail?: JsonValue;
};

export type ConversationRecord = {
	readonly id: Id;
	/** Transcript ancestry and the inclusive entry through which history is inherited. */
	readonly parent?: {
		readonly conversationId: Id;
		readonly at: Id;
	};
	/** Durable task-ownership edge used for subtree abort and idle traversal. */
	readonly owner?: {
		readonly conversationId: Id;
		readonly taskId: Id;
	};
};

export type ContextEdit = {
	readonly target: Id;
	readonly action: "omit" | "replace";
	readonly messages?: readonly Message[];
};

export type EntryRecord = {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	/** Messages contributed to model context; absent for display or bookkeeping entries. */
	readonly model?: readonly Message[];
	readonly data?: JsonValue;
	/** Entry at which the active context begins. */
	readonly head?: Id;
	readonly edits?: readonly ContextEdit[];
	readonly byTaskId?: Id;
};

export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
	readonly head?: Id | "self";
};

type InputBase = {
	readonly id: Id;
	readonly conversationId: Id;
	readonly requestId?: string;
};

/** Durable admission and settlement state for one host input. */
export type Input = InputBase &
	(
		| {
				readonly status: "queued";
				readonly entry?: never;
				readonly answer?: never;
				readonly reason?: never;
				readonly detail?: never;
		  }
		| {
				readonly status: "placed";
				/** User transcript entry created when this input was placed. */
				readonly entry: Id;
				readonly answer?: never;
				readonly reason?: never;
				readonly detail?: never;
		  }
		| {
				readonly status: "done";
				/** User or passive-write transcript entry created when this input was placed. */
				readonly entry: Id;
				/** Assistant answer entry; absent for a completed passive write. */
				readonly answer?: Id;
				readonly reason?: never;
				readonly detail?: never;
		  }
		| {
				readonly status: "unanswered";
				/** Present when the input was placed before becoming unanswered. */
				readonly entry?: Id;
				readonly answer?: never;
				readonly reason: string;
				readonly detail?: JsonValue;
		  }
	);

export type LiveTask<S> = {
	readonly status: "pending" | "running";
	readonly checkpoint: S;
};

export type TaskOutcome<R> =
	| { readonly status: "completed"; readonly result: R }
	/** Expected task/domain failure explicitly committed by its implementation. */
	| { readonly status: "failed"; readonly error: StoredError; readonly result?: R }
	| { readonly status: "aborted"; readonly reason?: string; readonly result?: R }
	| { readonly status: "orphaned"; readonly reason: string }
	/** Harness-detected contract failure, such as an uncaught throw or no durable progress. */
	| { readonly status: "faulted"; readonly error: StoredError };

export type TerminalTask<R> = {
	readonly status: "terminal";
	readonly outcome: TaskOutcome<R>;
};

export type TaskRecord<I, S, R> = {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	readonly version: number;
	readonly input: I;
	readonly state: LiveTask<S> | TerminalTask<R>;
	readonly after: readonly Id[];
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly memos?: Readonly<Record<string, JsonValue>>;
};

/** Persisted identity of one durable document incarnation. */
export type DocumentIdentity = {
	readonly id: Id;
	readonly definitionId: string;
	readonly definitionVersion: number;
	readonly instanceId?: string;
} & (
	| { readonly scope: { readonly kind: "session" } }
	| ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: Id } } & (
			| { readonly history: "latest"; readonly fork: "current" | "initial" }
			| {
					readonly history: "rewindable";
					readonly fork: "asOf" | "current" | "initial";
			  }
	  ))
	| { readonly scope: { readonly kind: "task"; readonly taskId: Id } }
);

/** Commit-sequence lifetime of one persisted document incarnation. */
export type DocumentMetadata = DocumentIdentity & {
	readonly createdAt: Seq;
	readonly retiredAt?: Seq;
};

export type Page<T, C> = {
	readonly items: readonly T[];
	readonly next?: C;
};

/** Backend-owned, JSON-serializable continuation state. Callers must treat it as opaque. */
export type Cursor = Readonly<Record<string, JsonValue>>;

export type EntryQuery = {
	readonly conversationId: Id;
	/** Strict semantic cutoff: only entries with IDs less than this value match. */
	readonly before?: Id;
	readonly kind?: string;
	readonly withHead?: boolean;
};

export type TaskQuery = {
	readonly conversationId?: Id;
	readonly kind?: string;
	readonly status?: "pending" | "running" | "terminal";
	readonly abortRequested?: boolean;
	readonly background?: boolean;
};

/** Package 1 table writes. Document lifecycle writes are added in Package 2. */
export type StorageWrite =
	| { readonly type: "conversation"; readonly value: ConversationRecord }
	| { readonly type: "entry"; readonly value: EntryRecord }
	| { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
	| { readonly type: "input"; readonly value: Input };

export interface Storage {
	/**
	 * Persist one batch atomically and return its commit sequence.
	 * The owning Session serializes calls on its mutation line; Storage implementations
	 * do not provide a second caller-facing mutation mutex.
	 */
	commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;
	mintId(): Id;

	conversation(id: Id, context: Context): Promise<ConversationRecord | undefined>;
	scanConversations(
		cursor: Cursor | undefined,
		limit: number,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>>;

	entries(ids: readonly Id[], context: Context): Promise<ReadonlyMap<Id, EntryRecord>>;
	scanEntries(
		query: EntryQuery,
		cursor: Cursor | undefined,
		limit: number,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;
	entryCommit(id: Id, context: Context): Promise<Seq | undefined>;

	task(id: Id, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	scanTasks(
		query: TaskQuery,
		cursor: Cursor | undefined,
		limit: number,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

	input(id: Id, context: Context): Promise<Input | undefined>;
	inputByRequest(conversationId: Id, requestId: string, context: Context): Promise<Input | undefined>;

	close(context: Context): Promise<void>;
}
