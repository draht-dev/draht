import type { Context } from "@draht/chord";
import type { Id, JsonObject, JsonValue } from "./core.ts";
import type {
	AbortClosure,
	AbortTaskRuntime,
	CoreAbortClosure,
	CoreAbortTaskRuntime,
	CoreTaskRuntime,
	CoreTerminalClosure,
	TaskRuntime,
	TerminalClosure,
} from "./runtime.ts";

export interface TaskCheckpoint extends JsonObject {
	readonly phase: string;
}

export type NoCheckpoint = never;

declare const taskOutputType: unique symbol;

export interface TaskOutputKind<O extends object> {
	readonly kind: string;
	readonly [taskOutputType]?: O;
}

export function defineTaskOutput<O extends object>(kind: string): TaskOutputKind<O> {
	return Object.freeze({ kind });
}

export interface TaskOutputSpec<I extends JsonValue, O extends object> {
	readonly kind: TaskOutputKind<O>;
	initial(input: I): O;
}

export interface StoredTaskOutputRef {
	readonly id: Id;
	readonly kind: string;
}

export interface TaskOutputRef<O extends object> extends StoredTaskOutputRef {
	readonly [taskOutputType]?: O;
}

export type TaskOutputField<O extends object> = [O] extends [never] ? unknown : { readonly output: TaskOutputRef<O> };

export type TaskOutputDefinition<I extends JsonValue, O extends object> = [O] extends [never]
	? { readonly output?: never }
	: { readonly output: TaskOutputSpec<I, O> };

export type TaskOutcome<R extends JsonValue, F extends JsonValue, A extends JsonValue> =
	| { readonly status: "completed"; readonly result: R }
	| { readonly status: "failed"; readonly failure: F }
	| { readonly status: "aborted"; readonly result: A }
	| { readonly status: "orphaned" };

export interface TaskBase<I extends JsonValue, C extends TaskCheckpoint> {
	readonly id: Id;
	readonly conversationId: Id;
	readonly kind: string;
	readonly input: I;
	readonly checkpoint?: C;
	readonly after: readonly Id[];
	readonly background?: true;
	readonly owns: readonly Id[];
	readonly output?: StoredTaskOutputRef;
	readonly abort?: true;
}

export type Task<
	I extends JsonValue = JsonValue,
	C extends TaskCheckpoint = TaskCheckpoint,
	R extends JsonValue = JsonValue,
	F extends JsonValue = JsonValue,
	A extends JsonValue = JsonValue,
> = TaskBase<I, C> &
	(
		| { readonly status: "pending" | "running"; readonly outcome?: never }
		| { readonly status: "terminal"; readonly outcome: TaskOutcome<R, F, A> }
	);

export type RunningTask<I extends JsonValue, C extends TaskCheckpoint, O extends object = never> = Omit<
	TaskBase<I, C>,
	"output"
> &
	TaskOutputField<O> & {
		readonly status: "running";
		readonly outcome?: never;
	};

export type Completion<R extends JsonValue, F extends JsonValue> =
	| { readonly status: "completed"; readonly result: R }
	| { readonly status: "failed"; readonly failure: F };

const taskKindBrand: unique symbol = Symbol("pico.taskKind");

export interface TaskKindBase {
	readonly kind: string;
	readonly [taskKindBrand]: "ordinary";
}

export interface CoreTaskKindBase {
	readonly kind: string;
	readonly [taskKindBrand]: "core";
}

interface TaskKindMethods<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
> extends TaskKindBase {
	execute(
		task: RunningTask<I, C, O>,
		runtime: TaskRuntime<I, C, O>,
		ctx: Context,
	): Promise<TerminalClosure<I, C, R, F, O>>;
	recover(
		task: RunningTask<I, C, O>,
		runtime: TaskRuntime<I, C, O>,
		ctx: Context,
	): Promise<TerminalClosure<I, C, R, F, O>>;
	abort(
		task: RunningTask<I, C, O>,
		runtime: AbortTaskRuntime<I, C, O>,
		ctx: Context,
	): Promise<AbortClosure<I, C, A, O>>;
}

interface CoreTaskKindMethods<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
> extends CoreTaskKindBase {
	execute(
		task: RunningTask<I, C, O>,
		runtime: CoreTaskRuntime<I, C, O>,
		ctx: Context,
	): Promise<CoreTerminalClosure<I, C, R, F, O>>;
	recover(
		task: RunningTask<I, C, O>,
		runtime: CoreTaskRuntime<I, C, O>,
		ctx: Context,
	): Promise<CoreTerminalClosure<I, C, R, F, O>>;
	abort(
		task: RunningTask<I, C, O>,
		runtime: CoreAbortTaskRuntime<I, C, O>,
		ctx: Context,
	): Promise<CoreAbortClosure<I, C, A, O>>;
}

export type TaskKind<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object = never,
> = TaskKindMethods<I, C, R, F, A, O> & TaskOutputDefinition<I, O>;

export type CoreTaskKind<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object = never,
> = CoreTaskKindMethods<I, C, R, F, A, O> & TaskOutputDefinition<I, O>;

export type NoExtra<Expected, Actual extends Expected> = Actual & Record<Exclude<keyof Actual, keyof Expected>, never>;

export type ExactJsonInput<Expected extends JsonValue, Actual extends Expected> = Expected extends readonly JsonValue[]
	? Actual
	: Expected extends JsonObject
		? Actual & Record<Exclude<keyof Actual, keyof Expected>, never>
		: Actual;

type KindDefinition<K> = Omit<K, typeof taskKindBrand>;
type KindFactory<K> = <D extends KindDefinition<K>>(definition: NoExtra<KindDefinition<K>, D>) => D & K;

export type TaskKindFactory<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
> = KindFactory<TaskKind<I, C, R, F, A, O>>;

export type CoreTaskKindFactory<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object,
> = KindFactory<CoreTaskKind<I, C, R, F, A, O>>;

export function defineTask<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object = never,
>(): TaskKindFactory<I, C, R, F, A, O> {
	const define = (definition: KindDefinition<TaskKind<I, C, R, F, A, O>>) =>
		Object.freeze({
			...definition,
			[taskKindBrand]: "ordinary" as const,
		});
	return define as TaskKindFactory<I, C, R, F, A, O>;
}

/** Internal authoring helper for Pico's fixed privileged task kinds. */
export function defineCoreTask<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends object = never,
>(): CoreTaskKindFactory<I, C, R, F, A, O> {
	const define = (definition: KindDefinition<CoreTaskKind<I, C, R, F, A, O>>) =>
		Object.freeze({
			...definition,
			[taskKindBrand]: "core" as const,
		});
	return define as CoreTaskKindFactory<I, C, R, F, A, O>;
}

export type AnyTaskKind = TaskKindBase;
export type AnyCoreTaskKind = CoreTaskKindBase;
export type AnyDefinedTaskKind = AnyTaskKind | AnyCoreTaskKind;

export type PayloadsOf<K> = K extends TaskKind<infer I, infer C, infer R, infer F, infer A, infer O>
	? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O }
	: K extends CoreTaskKind<infer I, infer C, infer R, infer F, infer A, infer O>
		? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O }
		: never;
export type InputOf<K> = PayloadsOf<K>["input"];
export type CheckpointOf<K> = PayloadsOf<K>["checkpoint"];
export type ResultOf<K> = PayloadsOf<K>["result"];
export type FailureOf<K> = PayloadsOf<K>["failure"];
export type AbortedOf<K> = PayloadsOf<K>["aborted"];
export type OutputOf<K> = PayloadsOf<K>["output"];
type WithoutOutput<T> = T extends unknown ? Omit<T, "output"> : never;

export type TaskOf<K extends AnyDefinedTaskKind> = WithoutOutput<
	Task<InputOf<K>, CheckpointOf<K>, ResultOf<K>, FailureOf<K>, AbortedOf<K>>
> &
	TaskOutputField<OutputOf<K>>;
