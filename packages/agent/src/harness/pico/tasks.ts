import type { Context } from "@draht/chord";
import type { ConversationValueDefinition } from "./addresses.ts";
import type { Id, JsonObject, JsonValue } from "./core.ts";
import type { EmptyHookPoints, HookPoints } from "./hooks.ts";
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
export type OutputState = JsonObject | JsonValue[];
export type ConfigBundle = Record<string, ConversationValueDefinition<JsonValue>>;
export type ReservedConfigKeys = "set" | "get";
export type KeysOf<U> = U extends unknown ? keyof U : never;
export type Collides<M, N extends keyof M, Reserved extends PropertyKey> = [
	Extract<keyof M[N], KeysOf<M[Exclude<keyof M, N>]> | Reserved>,
] extends [never]
	? false
	: true;
export type AnyCollision<M, Reserved extends PropertyKey> = true extends {
	[N in keyof M]: Collides<M, N, Reserved>;
}[keyof M]
	? true
	: false;
export type DisjointBundles<M, Reserved extends PropertyKey = never> = AnyCollision<M, Reserved> extends false
	? true
	: false;

declare const taskOutputType: unique symbol;
const taskKindBrand: unique symbol = Symbol("pico.taskKind");

export interface TaskOutputKind<O extends OutputState> {
	readonly kind: string;
	readonly [taskOutputType]?: O;
}

export function defineTaskOutput<O extends OutputState>(kind: string): TaskOutputKind<O> {
	return Object.freeze({ kind });
}

export interface StoredTaskOutputRef {
	readonly id: Id;
	readonly kind: string;
}

export interface TaskOutputRef<O extends OutputState> extends StoredTaskOutputRef {
	readonly [taskOutputType]?: O;
}

export type TaskOutputField<O extends OutputState> = [O] extends [never]
	? Record<never, never>
	: { readonly output: TaskOutputRef<O> };

export type TaskOutputDefinition<I extends JsonValue, O extends OutputState> = [O] extends [never]
	? { readonly output?: never }
	: { readonly output: { readonly kind: TaskOutputKind<O>; initial(input: I): O } };

export type TaskOutcome<
	R extends JsonValue = JsonValue,
	F extends JsonValue = JsonValue,
	A extends JsonValue = JsonValue,
> =
	| { readonly status: "completed"; readonly result: R }
	| { readonly status: "failed"; readonly failure: F }
	| { readonly status: "aborted"; readonly result: A }
	| { readonly status: "orphaned" };

export interface TaskBase<I extends JsonValue = JsonValue, C extends TaskCheckpoint = TaskCheckpoint> {
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

export type RunningTask<I extends JsonValue, C extends TaskCheckpoint, O extends OutputState = never> = Omit<
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

interface TaskKindMethods<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState,
	H extends HookPoints,
> {
	readonly kind: string;
	readonly hooks?: H;
	readonly config?: ConfigBundle;
	execute(
		task: RunningTask<I, C, O>,
		runtime: TaskRuntime<I, C, O, H>,
		ctx: Context,
	): Promise<TerminalClosure<I, C, R, F, O>>;
	recover(
		task: RunningTask<I, C, O>,
		runtime: TaskRuntime<I, C, O, H>,
		ctx: Context,
	): Promise<TerminalClosure<I, C, R, F, O>>;
	abort(
		task: RunningTask<I, C, O>,
		runtime: AbortTaskRuntime<I, C, O, H>,
		ctx: Context,
	): Promise<AbortClosure<I, C, A, O>>;
}

interface CoreTaskKindMethods<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState,
	H extends HookPoints,
> {
	readonly kind: string;
	readonly hooks?: H;
	readonly config?: ConfigBundle;
	execute(
		task: RunningTask<I, C, O>,
		runtime: CoreTaskRuntime<I, C, O, H>,
		ctx: Context,
	): Promise<CoreTerminalClosure<I, C, R, F, O>>;
	recover(
		task: RunningTask<I, C, O>,
		runtime: CoreTaskRuntime<I, C, O, H>,
		ctx: Context,
	): Promise<CoreTerminalClosure<I, C, R, F, O>>;
	abort(
		task: RunningTask<I, C, O>,
		runtime: CoreAbortTaskRuntime<I, C, O, H>,
		ctx: Context,
	): Promise<CoreAbortClosure<I, C, A, O>>;
}

export type TaskKind<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState = never,
	H extends HookPoints = EmptyHookPoints,
> = TaskKindMethods<I, C, R, F, A, O, H> & TaskOutputDefinition<I, O> & { readonly [taskKindBrand]: "ordinary" };

export type CoreTaskKind<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState = never,
	H extends HookPoints = EmptyHookPoints,
> = CoreTaskKindMethods<I, C, R, F, A, O, H> & TaskOutputDefinition<I, O> & { readonly [taskKindBrand]: "core" };

export type NoExtra<Expected, Actual extends Expected> = Actual & Record<Exclude<keyof Actual, keyof Expected>, never>;

export type ExactJsonInput<Expected extends JsonValue, Actual extends Expected> = Expected extends readonly JsonValue[]
	? Actual
	: Expected extends JsonObject
		? NoExtra<Expected, Actual>
		: Actual;

export type TaskKindDefinition<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState,
	H extends HookPoints,
> = Omit<TaskKind<I, C, R, F, A, O, H>, typeof taskKindBrand>;

export type CoreTaskKindDefinition<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState,
	H extends HookPoints,
> = Omit<CoreTaskKind<I, C, R, F, A, O, H>, typeof taskKindBrand>;

export type TaskKindFactory<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState,
> = <H extends HookPoints, D extends TaskKindDefinition<I, C, R, F, A, O, H>>(
	definition: NoExtra<TaskKindDefinition<I, C, R, F, A, O, H>, D> & { readonly hooks?: H },
) => D & TaskKind<I, C, R, F, A, O, H>;

export type CoreTaskKindFactory<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState,
> = <H extends HookPoints, D extends CoreTaskKindDefinition<I, C, R, F, A, O, H>>(
	definition: NoExtra<CoreTaskKindDefinition<I, C, R, F, A, O, H>, D> & { readonly hooks?: H },
) => D & CoreTaskKind<I, C, R, F, A, O, H>;

export function defineTask<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState = never,
>(): TaskKindFactory<I, C, R, F, A, O> {
	const define = <H extends HookPoints, D extends TaskKindDefinition<I, C, R, F, A, O, H>>(
		definition: NoExtra<TaskKindDefinition<I, C, R, F, A, O, H>, D> & { readonly hooks?: H },
	): D & TaskKind<I, C, R, F, A, O, H> =>
		Object.freeze({
			...definition,
			[taskKindBrand]: "ordinary" as const,
		}) as D & TaskKind<I, C, R, F, A, O, H>;
	return define as TaskKindFactory<I, C, R, F, A, O>;
}

/** Internal authoring helper for Pico's fixed privileged task kinds. */
export function defineCoreTask<
	I extends JsonValue,
	C extends TaskCheckpoint,
	R extends JsonValue,
	F extends JsonValue,
	A extends JsonValue,
	O extends OutputState = never,
>(): CoreTaskKindFactory<I, C, R, F, A, O> {
	const define = <H extends HookPoints, D extends CoreTaskKindDefinition<I, C, R, F, A, O, H>>(
		definition: NoExtra<CoreTaskKindDefinition<I, C, R, F, A, O, H>, D> & { readonly hooks?: H },
	): D & CoreTaskKind<I, C, R, F, A, O, H> =>
		Object.freeze({
			...definition,
			[taskKindBrand]: "core" as const,
		}) as D & CoreTaskKind<I, C, R, F, A, O, H>;
	return define as CoreTaskKindFactory<I, C, R, F, A, O>;
}

export type OrdinaryKind = {
	readonly kind: string;
	readonly [taskKindBrand]: "ordinary";
	readonly hooks?: HookPoints;
	readonly config?: ConfigBundle;
};
export type CoreKind = {
	readonly kind: string;
	readonly [taskKindBrand]: "core";
	readonly hooks?: HookPoints;
	readonly config?: ConfigBundle;
};
export type AnyDefinedKind = OrdinaryKind | CoreKind;

export type PayloadsOf<K> = K extends TaskKind<infer I, infer C, infer R, infer F, infer A, infer O, infer H>
	? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O; hooks: H }
	: K extends CoreTaskKind<infer I, infer C, infer R, infer F, infer A, infer O, infer H>
		? { input: I; checkpoint: C; result: R; failure: F; aborted: A; output: O; hooks: H }
		: never;
export type InputOf<K> = PayloadsOf<K>["input"];
export type CheckpointOf<K> = PayloadsOf<K>["checkpoint"];
export type ResultOf<K> = PayloadsOf<K>["result"];
export type FailureOf<K> = PayloadsOf<K>["failure"];
export type AbortedOf<K> = PayloadsOf<K>["aborted"];
export type OutputOf<K> = PayloadsOf<K>["output"];
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type TaskOf<K> = DistributiveOmit<
	Task<InputOf<K>, CheckpointOf<K>, ResultOf<K>, FailureOf<K>, AbortedOf<K>>,
	"output"
> &
	TaskOutputField<OutputOf<K>>;
