import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall } from "@draht/ai";
import type { Context } from "@draht/chord";
import type { Element, List, PayloadOf, ResolvedValue, UnboundList, UnboundValue, Value } from "./addresses.ts";
import type { Id, JsonValue, Stored } from "./core.ts";
import type { AssistantEntry, ContextEdit, Conversation, Entry, EntryInput, EntryKind, UserEntry } from "./entries.ts";
import type { EmptyHookPoints, HookPoints, HookRunner } from "./hooks.ts";
import type {
	AnyDefinedKind,
	Completion,
	ExactJsonInput,
	InputOf,
	NoExtra,
	OrdinaryKind,
	OutputOf,
	OutputState,
	RunningTask,
	Task,
	TaskCheckpoint,
	TaskOf,
	TaskOutputRef,
} from "./tasks.ts";

export interface TxReaders {
	getConversation(id: Id): Promise<Conversation | undefined>;
	getEntry(id: Id): Promise<Entry | undefined>;
	getEntry<E extends Entry>(kind: EntryKind<E>, id: Id): Promise<E | undefined>;
	getEntries(ids: readonly Id[]): Promise<ReadonlyMap<Id, Entry>>;
	getTask(id: Id): Promise<Task | undefined>;
	getTask<K extends AnyDefinedKind>(kind: K, id: Id): Promise<TaskOf<K> | undefined>;
	getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
}

export interface TxValue<T extends JsonValue, Read = T | undefined> {
	get(at?: Id): Promise<Read>;
	set(value: T): void;
	delete(): void;
}

export interface TxList<T extends JsonValue> {
	read(at?: Id): Promise<readonly Element<T>[]>;
	append(value: T): Id;
	remove(id: Id): void;
	clear(): void;
}

export interface TxState {
	value<D extends Value<JsonValue>>(address: D): TxValue<PayloadOf<D>, ResolvedValue<D>>;
	list<T extends JsonValue>(address: List<T>): TxList<T>;
}

export interface BoundTxState {
	value<D extends Value<JsonValue> | UnboundValue<JsonValue>>(address: D): TxValue<PayloadOf<D>, ResolvedValue<D>>;
	list<T extends JsonValue>(address: List<T> | UnboundList<T>): TxList<T>;
}

export type Acceptance = {
	readonly kind: "send" | "write";
	readonly requestId?: string;
	readonly conversationId: Id;
	readonly inputId: Id;
};

export type TaskSpec<K extends AnyDefinedKind> = {
	readonly conversationId?: Id;
	readonly input: InputOf<K>;
	readonly after?: readonly Id[];
	readonly background?: true;
} & ([OutputOf<K>] extends [never] ? { readonly output?: never } : { readonly output?: TaskOutputRef<OutputOf<K>> });

export interface ConversationCreateSpec {
	readonly parent?: { readonly conversationId: Id; readonly at: Id | "start" };
}

export type UserInput = string | readonly (TextContent | ImageContent)[];

export type StoredEntryDraft = {
	readonly kind: string;
	readonly data?: JsonValue;
	readonly model?: readonly Stored<Message>[];
	readonly head?: Id | "self";
	readonly edits?: readonly ContextEdit[];
};

export type QueuedInput =
	| { readonly mode: "steer" | "followUp"; readonly input: Stored<UserInput>; readonly requestId?: string }
	| { readonly mode: "write"; readonly entry: StoredEntryDraft; readonly requestId?: string };

export type StoredInputResult =
	| { readonly status: "queued"; readonly requestId?: string }
	| { readonly status: "placed"; readonly requestId?: string; readonly entry: Id }
	| { readonly status: "done"; readonly requestId?: string; readonly entry: Id; readonly answer?: Id }
	| {
			readonly status: "unanswered";
			readonly requestId?: string;
			readonly entry?: Id;
			readonly reason: "terminated" | "aborted" | "failed" | "stale";
			readonly detail?: string;
	  };

export type InputOutcome =
	| { readonly status: "queued"; readonly requestId?: string }
	| { readonly status: "placed"; readonly requestId?: string; readonly input: UserEntry }
	| {
			readonly status: "done";
			readonly requestId?: string;
			readonly input: UserEntry;
			readonly answer?: { readonly entry: AssistantEntry; readonly message: AssistantMessage };
	  }
	| {
			readonly status: "unanswered";
			readonly requestId?: string;
			readonly input?: UserEntry;
			readonly reason: "terminated" | "aborted" | "failed" | "stale";
			readonly detail?: string;
	  };

export type TerminalInputOutcome = Extract<InputOutcome, { status: "done" | "unanswered" }>;

export interface InternalAcceptOptions {
	readonly input: UserInput;
	readonly requestId?: string;
	readonly whenBusy?: "followUp" | "steer" | "reject";
}

export interface SendInput {
	readonly requestId?: string;
	readonly content: UserInput;
	readonly whenBusy?: "followUp" | "steer" | "reject";
}

export interface InputHandle {
	readonly id: Id;
	readonly conversationId: Id;
	result(ctx: Context): Promise<InputOutcome | undefined>;
	wait(ctx: Context): Promise<TerminalInputOutcome>;
	abort(ctx: Context): Promise<"aborted" | "already_placed" | "not_found">;
}

interface TaskCreator<Kinds extends AnyDefinedKind, Extra = Record<never, never>> {
	task<K extends Kinds, S extends TaskSpec<K> & Extra>(
		kind: K,
		spec: NoExtra<TaskSpec<K> & Extra, S> & { readonly input: ExactJsonInput<InputOf<K>, S["input"]> },
	): Id;
}

export interface HostTx extends TxReaders, TxState, TaskCreator<OrdinaryKind, { readonly conversationId: Id }> {
	createConversation(spec: ConversationCreateSpec): Id;
	write<E extends Entry>(conversationId: Id, kind: EntryKind<E>, input: EntryInput<E>): Promise<Id>;
}

export interface ConversationTx extends TxReaders, BoundTxState, TaskCreator<OrdinaryKind> {
	createConversation(spec: ConversationCreateSpec): Id;
	write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Promise<Id>;
}

interface TaskTxBase<C extends TaskCheckpoint> extends TxReaders, BoundTxState {
	checkpoint(value: C): void;
	createConversation(spec: ConversationCreateSpec): Id;
}

export interface BaseTaskTx<C extends TaskCheckpoint> extends TaskTxBase<C>, TaskCreator<OrdinaryKind> {
	write<E extends Entry>(kind: EntryKind<E>, input: EntryInput<E>): Promise<Id>;
}

export interface InternalAdmissionTx {
	accept(conversationId: Id, options: InternalAcceptOptions): Promise<Acceptance>;
	queueInput(conversationId: Id, input: QueuedInput): Promise<Acceptance>;
	write<E extends Entry>(
		conversationId: Id,
		kind: EntryKind<E>,
		input: EntryInput<E>,
		requestId?: string,
	): Promise<Acceptance>;
}

export type CoreTaskTx<C extends TaskCheckpoint> = Omit<BaseTaskTx<C>, "task" | "write"> &
	TaskCreator<AnyDefinedKind> &
	InternalAdmissionTx & {
		entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
	};

export interface PublicValue<T extends JsonValue, Read = T | undefined> {
	get(ctx: Context): Promise<Read>;
	get(at: Id, ctx: Context): Promise<Read>;
	set(value: T, ctx: Context): Promise<void>;
	delete(ctx: Context): Promise<void>;
}

export interface StickyPublicValue<T extends JsonValue, Read = T | undefined> {
	get(ctx: Context): Promise<Read>;
	set(value: T, ctx: Context): Promise<void>;
	delete(ctx: Context): Promise<void>;
}

export interface PublicList<T extends JsonValue> {
	read(ctx: Context): Promise<readonly Element<T>[]>;
	read(at: Id, ctx: Context): Promise<readonly Element<T>[]>;
	append(value: T, ctx: Context): Promise<Id>;
	remove(id: Id, ctx: Context): Promise<void>;
	clear(ctx: Context): Promise<void>;
}

export interface BoundPublicState {
	value<D extends Value<JsonValue> | UnboundValue<JsonValue>>(address: D): PublicValue<PayloadOf<D>, ResolvedValue<D>>;
	list<T extends JsonValue>(address: List<T> | UnboundList<T>): PublicList<T>;
}

export interface TaskOutput<O extends OutputState> {
	readonly ref: TaskOutputRef<O>;
	read(ctx: Context): Promise<O>;
	mutate(mutator: (state: O) => undefined, ctx: Context): Promise<void>;
	replace(value: O, ctx: Context): Promise<void>;
}

export interface ReadonlyTaskOutput<O extends OutputState> {
	readonly ref: TaskOutputRef<O>;
	read(ctx: Context): Promise<O>;
}

export type RuntimeOutput<O extends OutputState> = [O] extends [never]
	? Record<never, never>
	: { readonly output: TaskOutput<O> };
export type AbortRuntimeOutput<O extends OutputState> = [O] extends [never]
	? Record<never, never>
	: { readonly output: ReadonlyTaskOutput<O> };
export type FinalOutput<O extends OutputState> = [O] extends [never] ? Record<never, never> : { readonly output: O };

export interface ScratchReader {
	value<D extends Value<JsonValue>>(address: D): Pick<TxValue<PayloadOf<D>, ResolvedValue<D>>, "get">;
	list<T extends JsonValue>(address: List<T>): Pick<TxList<T>, "read">;
}

export interface TaskConversation extends BoundPublicState {
	readonly id: Id;
	send(input: SendInput, ctx: Context): Promise<InputHandle>;
}

export interface AbortTaskConversation extends BoundPublicState {
	readonly id: Id;
}

interface TaskRuntimeBase<H extends HookPoints> {
	readonly taskId: Id;
	scratch<T>(build: (tx: TxState) => T | Promise<T>, ctx: Context): Promise<T>;
	readonly hooks: HookRunner<H>;
	conversation(id: Id, ctx: Context): Promise<TaskConversation | undefined>;
	waitForTask(id: Id, ctx: Context): Promise<Task>;
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
	now(): number;
	sleep(untilMs: number, ctx: Context): Promise<void>;
}

interface CommitRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState, Tx> {
	commit<T>(build: (tx: Tx, current: RunningTask<I, C, O>) => T | Promise<T>, ctx: Context): Promise<T>;
}

export type TaskRuntime<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends OutputState = never,
	H extends HookPoints = EmptyHookPoints,
> = TaskRuntimeBase<H> & CommitRuntime<I, C, O, BaseTaskTx<C>> & RuntimeOutput<O>;

export type CoreTaskRuntime<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends OutputState = never,
	H extends HookPoints = EmptyHookPoints,
> = TaskRuntimeBase<H> & CommitRuntime<I, C, O, CoreTaskTx<C>> & RuntimeOutput<O>;

export type FinalTx<C extends TaskCheckpoint, O extends OutputState> = BaseTaskTx<C> & FinalOutput<O>;
export type CoreFinalTx<C extends TaskCheckpoint, O extends OutputState> = CoreTaskTx<C> & FinalOutput<O>;
export type TerminalClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	O extends OutputState,
> = (tx: FinalTx<C, O>, current: RunningTask<I, C, O>) => Completion<R, F> | Promise<Completion<R, F>>;
export type CoreTerminalClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	O extends OutputState,
> = (tx: CoreFinalTx<C, O>, current: RunningTask<I, C, O>) => Completion<R, F> | Promise<Completion<R, F>>;

export interface AbortTx<C extends TaskCheckpoint> extends TxReaders, BoundTxState {
	checkpoint(value: C): void;
	markTask(id: Id): Promise<"marked" | "terminal">;
}

export interface CoreAbortTx<C extends TaskCheckpoint> extends AbortTx<C> {
	entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
	write<E extends Entry>(
		conversationId: Id,
		kind: EntryKind<E>,
		input: EntryInput<E>,
		requestId?: string,
	): Promise<Acceptance>;
}

export type AbortFinalTx<C extends TaskCheckpoint, O extends OutputState> = AbortTx<C> & FinalOutput<O>;
export type CoreAbortFinalTx<C extends TaskCheckpoint, O extends OutputState> = CoreAbortTx<C> & FinalOutput<O>;
export type AbortClosure<I extends JsonValue, C extends TaskCheckpoint, A extends JsonValue, O extends OutputState> = (
	tx: AbortFinalTx<C, O>,
	current: RunningTask<I, C, O>,
) => A | Promise<A>;
export type CoreAbortClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	A extends JsonValue,
	O extends OutputState,
> = (tx: CoreAbortFinalTx<C, O>, current: RunningTask<I, C, O>) => A | Promise<A>;

interface AbortRuntimeBase<H extends HookPoints> {
	readonly taskId: Id;
	scratch<T>(read: (scratch: ScratchReader) => T | Promise<T>, ctx: Context): Promise<T>;
	readonly hooks: HookRunner<H>;
	conversation(id: Id, ctx: Context): Promise<AbortTaskConversation | undefined>;
	waitForTask(id: Id, ctx: Context): Promise<Task>;
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
	now(): number;
	sleep(untilMs: number, ctx: Context): Promise<void>;
}

export type AbortTaskRuntime<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends OutputState = never,
	H extends HookPoints = EmptyHookPoints,
> = AbortRuntimeBase<H> & CommitRuntime<I, C, O, AbortTx<C>> & AbortRuntimeOutput<O>;

export type CoreAbortTaskRuntime<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends OutputState = never,
	H extends HookPoints = EmptyHookPoints,
> = AbortRuntimeBase<H> & CommitRuntime<I, C, O, CoreAbortTx<C>> & AbortRuntimeOutput<O>;

export type ToolInput = { readonly assistant: Id; readonly call: Stored<ToolCall> };
export type GenerationOutput = { message?: Stored<AssistantMessage> };
export type ToolOutputState = { progress?: string; log: string[]; details?: JsonValue };
