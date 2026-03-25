import {
	type Api,
	type Context,
	getApiProvider,
	getModel,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@draht/ai";
import { loadConfig } from "./config.js";
import { estimateCost, logCost } from "./cost.js";
import type { CostEntry, ModelRef, RouterConfig, RouterRole } from "./types.js";

/**
 * Model router with role-based resolution, automatic fallback, and @draht/ai integration.
 */
export class ModelRouter {
	private config: RouterConfig;
	private sessionId: string;

	constructor(config?: RouterConfig, sessionId?: string) {
		this.config = config ?? loadConfig();
		this.sessionId = sessionId ?? `session-${Date.now()}`;
	}

	/**
	 * Resolve the primary model for a role.
	 */
	resolve(role: RouterRole): ModelRef {
		const roleConfig = this.config[role];
		if (!roleConfig) {
			throw new Error(`Unknown role: ${role}. Available: ${Object.keys(this.config).join(", ")}`);
		}
		return roleConfig.primary;
	}

	/**
	 * Resolve all models for a role: [primary, ...fallbacks].
	 */
	resolveWithFallbacks(role: RouterRole): ModelRef[] {
		const roleConfig = this.config[role];
		if (!roleConfig) {
			throw new Error(`Unknown role: ${role}`);
		}
		return [roleConfig.primary, ...roleConfig.fallbacks];
	}

	/**
	 * Resolve a ModelRef to an actual @draht/ai Model object.
	 * Looks up in the model registry by provider + model ID.
	 */
	resolveModel(ref: ModelRef): Model<Api> | null {
		try {
			return getModel(ref.provider as any, ref.model as any) ?? null;
		} catch {
			return null;
		}
	}

	/**
	 * Stream a completion using the role's model chain.
	 * Automatically falls back on retryable errors (429, 5xx, timeout).
	 *
	 * Mid-stream failures are detected via error events in the stream.
	 * Events are buffered and only yielded after successful completion,
	 * preventing partial responses from failed providers from leaking through.
	 */
	async *stream(
		role: RouterRole,
		context: Context,
		options?: StreamOptions,
	): AsyncGenerator<import("@draht/ai").AssistantMessageEvent> {
		yield* this.streamWithFallback(role, context, options, (provider, model, opts) =>
			provider.stream(model, context, opts),
		);
	}

	/**
	 * Stream a simple completion (no tool use) with fallback.
	 *
	 * Mid-stream failures are detected via error events in the stream.
	 * Events are buffered and only yielded after successful completion,
	 * preventing partial responses from failed providers from leaking through.
	 */
	async *streamSimple(
		role: RouterRole,
		context: Context,
		options?: SimpleStreamOptions,
	): AsyncGenerator<import("@draht/ai").AssistantMessageEvent> {
		yield* this.streamWithFallback(role, context, options, (provider, model, opts) =>
			provider.streamSimple(model, context, opts as SimpleStreamOptions),
		);
	}

	/**
	 * Internal helper for streaming with fallback support.
	 * Buffers events and checks for error events to trigger fallback.
	 */
	private async *streamWithFallback<T extends StreamOptions>(
		role: RouterRole,
		_context: Context,
		options: T | undefined,
		streamFn: (
			provider: NonNullable<ReturnType<typeof getApiProvider>>,
			model: Model<Api>,
			options: T | undefined,
		) => AsyncIterable<import("@draht/ai").AssistantMessageEvent>,
	): AsyncGenerator<import("@draht/ai").AssistantMessageEvent> {
		const models = this.resolveWithFallbacks(role);
		let lastError: unknown;

		for (const ref of models) {
			const model = this.resolveModel(ref);
			if (!model) continue;

			const provider = getApiProvider(model.api);
			if (!provider) continue;

			// Buffer events to prevent partial responses from leaking on failure
			const bufferedEvents: import("@draht/ai").AssistantMessageEvent[] = [];
			let streamError: Error | null = null;

			try {
				const stream = streamFn(provider, model, options);

				for await (const event of stream) {
					// Check for error events in the stream (mid-stream failures)
					if (event.type === "error") {
						const errorMessage = event.error.errorMessage ?? "Stream error";
						streamError = new Error(errorMessage);
						break;
					}

					bufferedEvents.push(event);

					// If we got a done event, stream completed successfully
					if (event.type === "done") {
						// Yield all buffered events
						for (const bufferedEvent of bufferedEvents) {
							yield bufferedEvent;
						}
						return;
					}
				}

				// If we exited the loop without a done event and no error, something is wrong
				if (!streamError) {
					streamError = new Error("Stream ended without completion");
				}
			} catch (error) {
				streamError = error instanceof Error ? error : new Error(String(error));
			}

			// Handle stream error - check if retryable for fallback
			if (streamError) {
				lastError = streamError;
				if (!isRetryableError(streamError)) {
					throw streamError;
				}
				// Continue to next fallback, discarding buffered events
			}
		}

		throw lastError ?? new Error(`No available model for role: ${role}`);
	}

	/**
	 * Execute a function with automatic fallback on retryable errors.
	 * For non-streaming use cases.
	 */
	async route<T>(role: RouterRole, fn: (model: ModelRef) => Promise<T>): Promise<T> {
		const models = this.resolveWithFallbacks(role);
		let lastError: unknown;

		for (const model of models) {
			try {
				const result = await fn(model);
				return result;
			} catch (error) {
				lastError = error;
				if (!isRetryableError(error)) {
					throw error;
				}
			}
		}

		throw lastError ?? new Error(`All models failed for role: ${role}`);
	}

	/**
	 * Log a cost entry for tracking.
	 */
	trackCost(role: string, ref: ModelRef, inputTokens: number, outputTokens: number, reasoningTokens = 0): void {
		const cost = estimateCost(ref.provider, ref.model, inputTokens, outputTokens, reasoningTokens);
		const entry: CostEntry = {
			timestamp: new Date().toISOString(),
			role,
			provider: ref.provider,
			model: ref.model,
			inputTokens,
			outputTokens,
			...(reasoningTokens > 0 && { reasoningTokens }),
			estimatedCostUsd: cost,
			sessionId: this.sessionId,
		};
		logCost(entry);
	}

	/**
	 * Get current config.
	 */
	getConfig(): RouterConfig {
		return this.config;
	}
}

/**
 * Check if an error is retryable (rate limit, timeout, server error).
 */
export function isRetryableError(error: unknown): boolean {
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		if (msg.includes("rate limit") || msg.includes("429")) return true;
		if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("etimedout")) return true;
		if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) return true;
		if (msg.includes("server error") || msg.includes("internal error")) return true;
		if (msg.includes("overloaded") || msg.includes("capacity")) return true;
	}
	if (error && typeof error === "object" && "status" in error) {
		const status = (error as Record<string, unknown>).status;
		if (typeof status === "number" && (status === 429 || (status >= 500 && status < 600))) return true;
	}
	return false;
}
