import {
	BACKGROUND_CONTEXT,
	type Context,
	type ContextKey,
	INTERNAL_CONTEXT_OPERATIONS,
	TODO_CONTEXT,
} from "@draht/chord/context";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@draht/telemetry";

export { BACKGROUND_CONTEXT, type Context, type ContextKey, TODO_CONTEXT };
export const awaitWithContext = INTERNAL_CONTEXT_OPERATIONS.awaitWithContext;
export const createContextKey = INTERNAL_CONTEXT_OPERATIONS.createContextKey;
export const withAbortSignal = INTERNAL_CONTEXT_OPERATIONS.withAbortSignal;
export const withCancel = INTERNAL_CONTEXT_OPERATIONS.withCancel;
export const withContextValue = INTERNAL_CONTEXT_OPERATIONS.withContextValue;
export const withoutAbortSignal = INTERNAL_CONTEXT_OPERATIONS.withoutAbortSignal;

const TELEMETRY_CONTEXT_KEY = createContextKey<TelemetryContext>("pi.telemetryContext");

/** Return the telemetry parent attached to a context, or the shared no-op parent. */
export function getTelemetryContext(context: Context): TelemetryContext {
	return context.value(TELEMETRY_CONTEXT_KEY) ?? NOOP_TELEMETRY_CONTEXT;
}

/** Derive a context whose telemetry children use the supplied parent or active span. */
export function withTelemetryContext(telemetryContext: TelemetryContext, context: Context): Context {
	return withContextValue(TELEMETRY_CONTEXT_KEY, telemetryContext, context);
}
