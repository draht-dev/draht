import type { Context } from "@draht/chord";
import type { Id } from "./core.ts";

declare const hookIn: unique symbol;
declare const hookOut: unique symbol;

export type Fold = "collect" | "first" | "chain";

export interface HookPoint<In, Out, F extends Fold = Fold> {
	readonly fold: F;
	readonly onThrow: "skip" | "abort";
	readonly [hookIn]?: In;
	readonly [hookOut]?: Out;
}

export function defineHookPoint<In, Out = void>(options: {
	readonly fold: "collect";
	readonly onThrow: "skip" | "abort";
}): HookPoint<In, Out, "collect">;
export function defineHookPoint<In, Out = void>(options: {
	readonly fold: "first";
	readonly onThrow: "skip" | "abort";
}): HookPoint<In, Out, "first">;
export function defineHookPoint<In extends object, Out extends Partial<In>>(options: {
	readonly fold: "chain";
	readonly onThrow: "skip" | "abort";
}): HookPoint<In, Out, "chain">;
export function defineHookPoint(options: {
	readonly fold: Fold;
	readonly onThrow: "skip" | "abort";
}): HookPoint<unknown, unknown> {
	return Object.freeze(options);
}

export type HookPoints = Record<string, HookPoint<unknown, unknown>>;
export type EmptyHookPoints = Record<never, never>;
export type HookIn<P> = P extends HookPoint<infer In, unknown> ? In : never;
export type HookOut<P> = P extends HookPoint<unknown, infer Out> ? Out : never;

// biome-ignore lint/suspicious/noConfusingVoidType: void allows handlers with no return value.
type HookHandlerResult<P> = HookOut<P> | void;
export type HookHandler<P> = (
	input: HookIn<P>,
	info: HookInfo,
	ctx: Context,
) => HookHandlerResult<P> | Promise<HookHandlerResult<P>>;

export interface HookInfo {
	readonly kind: string;
	readonly taskId: Id;
	readonly conversationId: Id;
}

export interface HookRunner<H extends HookPoints> {
	run<P extends H[keyof H]>(point: P, input: HookIn<P>, ctx: Context): Promise<HookResult<P>>;
}

export type HookResult<P> = P extends { fold: "collect" }
	? { readonly outputs: readonly HookOut<P>[]; readonly threw?: unknown }
	: P extends { fold: "first" }
		? { readonly output?: HookOut<P>; readonly threw?: unknown }
		: { readonly output: HookIn<P>; readonly threw?: unknown };
