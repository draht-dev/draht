import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@draht/telemetry";

/** Typed identity for one value carried by a {@link Context}. */
export interface ContextKey<T> {
	readonly token: symbol;
	/** Type-only marker that prevents keys with different value types from being interchangeable. */
	readonly valueType?: (value: T) => T;
}

const ABORT_SIGNAL_CONTEXT_KEY: ContextKey<AbortSignal | undefined> = Object.freeze({
	token: Symbol("pi.abortSignal"),
});
const TELEMETRY_CONTEXT_KEY: ContextKey<TelemetryContext> = Object.freeze({ token: Symbol("pi.telemetryContext") });

/** Immutable invocation-scoped values passed explicitly through harness operations. */
export interface Context {
	readonly abortSignal: AbortSignal | undefined;
	readonly telemetryContext: TelemetryContext;
	value<T>(key: ContextKey<T>): T | undefined;
	toString(): string;
}

abstract class BaseContext implements Context {
	abstract value<T>(key: ContextKey<T>): T | undefined;
	abstract toString(): string;

	get abortSignal(): AbortSignal | undefined {
		return this.value(ABORT_SIGNAL_CONTEXT_KEY);
	}

	get telemetryContext(): TelemetryContext {
		return this.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
	}
}

class EmptyContext extends BaseContext {
	readonly #name: string;

	constructor(name: string) {
		super();
		this.#name = name;
	}

	value<T>(_key: ContextKey<T>): T | undefined {
		return undefined;
	}

	toString(): string {
		return this.#name;
	}
}

/** One copy-on-write value layered over a parent context. */
class ContextValue<T> extends BaseContext {
	readonly #parent: Context;
	readonly #key: ContextKey<T>;
	readonly #value: T;

	constructor(parent: Context, key: ContextKey<T>, value: T) {
		super();
		this.#parent = parent;
		this.#key = key;
		this.#value = value;
	}

	value<Value>(key: ContextKey<Value>): Value | undefined {
		if (key.token === this.#key.token) return this.#value as unknown as Value;
		return this.#parent.value(key);
	}

	toString(): string {
		return `${this.#parent}.WithValue(${this.#key.token.description ?? "anonymous"})`;
	}
}

/** Root context for work that has no caller. */
export const BACKGROUND_CONTEXT: Context = new EmptyContext("[Context BACKGROUND_CONTEXT]");

/** Temporary root context marking a call site that still needs context propagation. */
export const TODO_CONTEXT: Context = new EmptyContext("[Context TODO_CONTEXT]");

export function createContextKey<T>(description: string): ContextKey<T> {
	return Object.freeze({ token: Symbol(description) });
}

/** Derive a context containing one additional or replaced value. */
export function withContextValue<T>(key: ContextKey<T>, value: T, parent: Context): Context {
	return new ContextValue(parent, key, value);
}

/**
 * Derive a context cancelled by either the parent signal or the supplied signal.
 * The parent context remains unchanged.
 */
export function withAbortSignal(signal: AbortSignal, context: Context): Context {
	const parentSignal = context.abortSignal;
	const combined = parentSignal === undefined ? signal : AbortSignal.any([parentSignal, signal]);
	return withContextValue(ABORT_SIGNAL_CONTEXT_KEY, combined, context);
}

/** Derive a context retaining all values except caller cancellation. Intended for mandatory cleanup only. */
export function withoutAbortSignal(context: Context): Context {
	return withContextValue(ABORT_SIGNAL_CONTEXT_KEY, undefined, context);
}

/** Derive an independently cancellable child context. */
export function withCancel(context: Context): {
	readonly context: Context;
	readonly cancel: (reason?: unknown) => void;
} {
	const controller = new AbortController();
	return {
		context: withAbortSignal(controller.signal, context),
		cancel: (reason?: unknown) => controller.abort(reason),
	};
}

/** Derive a context whose telemetry children use the supplied parent or active span. */
export function withTelemetryContext(telemetryContext: TelemetryContext, context: Context): Context {
	return withContextValue(TELEMETRY_CONTEXT_KEY, telemetryContext, context);
}
