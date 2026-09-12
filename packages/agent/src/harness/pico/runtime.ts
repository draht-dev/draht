import type { ImageContent, Message, TextContent } from "@draht/ai";
import type { Context } from "@draht/chord";
import type { Element, List, Value } from "./addresses.ts";
import type { Id, JsonValue } from "./core.ts";
import type { ContextEdit, Conversation, Entry, EntryInput, EntryKind } from "./entries.ts";
import type {
	AnyDefinedTaskKind,
	AnyTaskKind,
	Completion,
	ExactJsonInput,
	InputOf,
	NoExtra,
	OutputOf,
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
	getTask<K extends AnyDefinedTaskKind>(kind: K, id: Id): Promise<TaskOf<K> | undefined>;
	getTasks(ids: readonly Id[]): Promise<ReadonlyMap<Id, Task>>;
}

export interface TxValue<T extends JsonValue> {
	get(at?: Id): Promise<T | undefined>;
	set(value: T): void;
	delete(): void;
}

export interface TxList<T extends JsonValue> {
	read(): Promise<readonly Element<T>[]>;
	read(at: Id): Promise<readonly Element<T>[]>;
	append(value: T): Id;
	remove(id: Id): void;
	clear(): void;
}

export interface Acceptance {
	readonly requestId?: string;
	readonly conversationId: Id;
	readonly inputId: Id;
}

interface TaskSpecBase<I extends JsonValue> {
	readonly conversationId?: Id;
	readonly input: I;
	readonly after?: readonly Id[];
	readonly background?: true;
}

export type TaskSpec<I extends JsonValue, O extends object = never> = TaskSpecBase<I> &
	([O] extends [never] ? { readonly output?: never } : { readonly output?: TaskOutputRef<O> });

export interface ConversationCreateSpec {
	readonly parent?: { readonly conversationId: Id; readonly at: Id };
}

export type UserInput = string | readonly (TextContent | ImageContent)[];

export interface StoredEntryDraft {
	readonly kind: string;
	readonly data?: JsonValue;
	readonly model?: readonly Message[];
	readonly head?: Id | "self";
	readonly edits?: readonly ContextEdit[];
}

export type QueuedInput =
	| { readonly mode: "steer" | "followUp"; readonly input: UserInput; readonly requestId?: string }
	| { readonly mode: "write"; readonly entry: StoredEntryDraft; readonly requestId?: string };

export type InputResult =
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

export type TerminalInputResult = Extract<InputResult, { status: "done" | "unanswered" }>;

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
	result(ctx: Context): Promise<InputResult | undefined>;
	wait(ctx: Context): Promise<TerminalInputResult>;
	abort(ctx: Context): Promise<"aborted" | "already_placed" | "not_found">;
}

interface TaskCreator<Kinds extends AnyDefinedTaskKind> {
	task<K extends Kinds, S extends TaskSpec<InputOf<K>, OutputOf<K>>>(
		kind: K,
		spec: NoExtra<TaskSpec<InputOf<K>, OutputOf<K>>, S> & {
			readonly input: ExactJsonInput<InputOf<K>, S["input"]>;
		},
	): Id;
}

interface TaskTxBase<C extends TaskCheckpoint> extends TxReaders {
	checkpoint(value: C): void;
	createConversation(spec: ConversationCreateSpec): Id;
	value<T extends JsonValue>(address: Value<T>): TxValue<T>;
	list<T extends JsonValue>(address: List<T>): TxList<T>;
}

export type BaseTaskTx<C extends TaskCheckpoint> = TaskTxBase<C> & TaskCreator<AnyTaskKind>;

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

export type CoreTaskTx<C extends TaskCheckpoint> = TaskTxBase<C> &
	TaskCreator<AnyDefinedTaskKind> &
	InternalAdmissionTx & {
		entry<E extends Entry>(kind: EntryKind<E>, conversationId: Id, input: EntryInput<E>): Id;
	};

export interface PublicValue<T extends JsonValue> {
	get(ctx: Context): Promise<T | undefined>;
	get(at: Id, ctx: Context): Promise<T | undefined>;
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

export interface TaskOutput<O extends object> {
	readonly ref: TaskOutputRef<O>;
	read(ctx: Context): Promise<O>;
	mutate(mutator: (state: O) => undefined, ctx: Context): Promise<void>;
	replace(value: O, ctx: Context): Promise<void>;
}

export interface ReadonlyTaskOutput<O extends object> {
	readonly ref: TaskOutputRef<O>;
	read(ctx: Context): Promise<O>;
}

export type RuntimeOutput<O extends object> = [O] extends [never] ? unknown : { readonly output: TaskOutput<O> };
export type AbortRuntimeOutput<O extends object> = [O] extends [never]
	? unknown
	: { readonly output: ReadonlyTaskOutput<O> };
export type FinalOutput<O extends object> = [O] extends [never] ? unknown : { readonly output: O };

export interface ScratchTx {
	value<T extends JsonValue>(address: Value<T>): TxValue<T>;
	list<T extends JsonValue>(address: List<T>): TxList<T>;
}

export interface ScratchReader {
	value<T extends JsonValue>(address: Value<T>): Pick<TxValue<T>, "get">;
	list<T extends JsonValue>(address: List<T>): Pick<TxList<T>, "read">;
}

export interface TaskConversation {
	readonly id: Id;
	send(input: SendInput, ctx: Context): Promise<InputHandle>;
	value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
	list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

export interface AbortTaskConversation {
	readonly id: Id;
	value<T extends JsonValue>(address: Value<T>): PublicValue<T>;
	list<T extends JsonValue>(address: List<T>): PublicList<T>;
}

interface TaskRuntimeBase {
	readonly taskId: Id;
	scratch<T>(build: (tx: ScratchTx) => T | Promise<T>, ctx: Context): Promise<T>;
	conversation(id: Id, ctx: Context): Promise<TaskConversation | undefined>;
	waitForTask(id: Id, ctx: Context): Promise<Task>;
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
	now(): number;
	sleep(untilMs: number, ctx: Context): Promise<void>;
}

interface CommitRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object, Tx> {
	commit<T>(build: (tx: Tx, current: RunningTask<I, C, O>) => T | Promise<T>, ctx: Context): Promise<T>;
}

export type TaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> = TaskRuntimeBase &
	CommitRuntime<I, C, O, BaseTaskTx<C>> &
	RuntimeOutput<O>;

export type CoreTaskRuntime<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> = TaskRuntimeBase &
	CommitRuntime<I, C, O, CoreTaskTx<C>> &
	RuntimeOutput<O>;

type TerminalClosureFor<
	Tx,
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	O extends object,
> = (tx: Tx & FinalOutput<O>, current: RunningTask<I, C, O>) => Completion<R, F> | Promise<Completion<R, F>>;

export type FinalTx<C extends TaskCheckpoint, O extends object> = BaseTaskTx<C> & FinalOutput<O>;
export type CoreFinalTx<C extends TaskCheckpoint, O extends object> = CoreTaskTx<C> & FinalOutput<O>;
export type TerminalClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	O extends object,
> = TerminalClosureFor<BaseTaskTx<C>, I, C, R, F, O>;
export type CoreTerminalClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	O extends object,
> = TerminalClosureFor<CoreTaskTx<C>, I, C, R, F, O>;

export interface AbortTx<C extends TaskCheckpoint> extends TxReaders {
	checkpoint(value: C): void;
	value<T extends JsonValue>(address: Value<T>): TxValue<T>;
	list<T extends JsonValue>(address: List<T>): TxList<T>;
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

type AbortClosureFor<Tx, I extends JsonValue, C extends TaskCheckpoint, A extends JsonValue, O extends object> = (
	tx: Tx & FinalOutput<O>,
	current: RunningTask<I, C, O>,
) => A | Promise<A>;

export type AbortFinalTx<C extends TaskCheckpoint, O extends object> = AbortTx<C> & FinalOutput<O>;
export type CoreAbortFinalTx<C extends TaskCheckpoint, O extends object> = CoreAbortTx<C> & FinalOutput<O>;
export type AbortClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	A extends JsonValue,
	O extends object,
> = AbortClosureFor<AbortTx<C>, I, C, A, O>;
export type CoreAbortClosure<
	I extends JsonValue,
	C extends TaskCheckpoint,
	A extends JsonValue,
	O extends object,
> = AbortClosureFor<CoreAbortTx<C>, I, C, A, O>;

interface AbortRuntimeBase {
	readonly taskId: Id;
	scratch<T>(read: (scratch: ScratchReader) => T | Promise<T>, ctx: Context): Promise<T>;
	conversation(id: Id, ctx: Context): Promise<AbortTaskConversation | undefined>;
	waitForTask(id: Id, ctx: Context): Promise<Task>;
	abortTask(id: Id, ctx: Context): Promise<"marked" | "terminal">;
	now(): number;
}

export type AbortTaskRuntime<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends object = never,
> = AbortRuntimeBase & CommitRuntime<I, C, O, AbortTx<C>> & AbortRuntimeOutput<O>;

export type CoreAbortTaskRuntime<
	I extends JsonValue,
	C extends TaskCheckpoint,
	O extends object = never,
> = AbortRuntimeBase & CommitRuntime<I, C, O, CoreAbortTx<C>> & AbortRuntimeOutput<O>;
