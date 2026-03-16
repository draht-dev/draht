import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	AssistantMessageEventStream,
	type Context,
	clearApiProviders,
	type Model,
	registerApiProvider,
	type StreamOptions,
} from "@draht/ai";
import { ModelRouter } from "../src/router.js";
import type { ModelRef, RouterConfig } from "../src/types.js";

// =============================================================================
// Mock Provider Infrastructure
// =============================================================================

/**
 * Configuration for mock stream behavior.
 *
 * The mock provider can be configured to:
 * - Fail immediately before yielding any events (eventsBeforeFailure = 0, shouldFail = true)
 * - Yield N events then fail (eventsBeforeFailure > 0, shouldFail = true)
 * - Succeed after yielding events (shouldFail = false)
 *
 * Error messages containing "429", "503", "timeout", etc. are classified as retryable
 * by the router's isRetryableError function and trigger fallback behavior.
 * Non-retryable errors (e.g., "invalid API key") cause immediate failure without fallback.
 */
interface MockStreamConfig {
	/** Number of text events to yield before failing (0 = fail immediately) */
	eventsBeforeFailure: number;
	/** Error message when failing. Use "429" or "503" for retryable errors. */
	errorMessage: string;
	/** Whether this provider should fail */
	shouldFail: boolean;
	/** Text prefix to identify which provider produced events (for assertions) */
	textPrefix: string;
	/** API type for the mock stream */
	api: Api;
}

/**
 * Creates an AssistantMessage base object for testing.
 */
function createBaseMessage(api: Api): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Creates a mock stream function with configurable behavior.
 *
 * For immediate failures (eventsBeforeFailure = 0), throws synchronously like
 * real providers do for auth errors. This allows the router's try/catch to catch
 * the error and potentially fall back to another provider.
 *
 * For mid-stream failures, pushes error events to the stream. Note that the current
 * router implementation only catches synchronous throws, not error events.
 *
 * @param getConfig - Function that returns the current config (allows dynamic config changes)
 */
function createMockStreamFunction(
	getConfig: () => MockStreamConfig,
): (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream {
	return (_model: Model<Api>, _context: Context, _options?: StreamOptions) => {
		const config = getConfig();
		const baseMessage = createBaseMessage(config.api);

		// For immediate failures, throw synchronously (like real providers do for auth errors)
		if (config.shouldFail && config.eventsBeforeFailure === 0) {
			throw new Error(config.errorMessage);
		}

		const stream = new AssistantMessageEventStream();

		// For success or mid-stream failure, use async IIFE to push events
		(async () => {
			stream.push({ type: "start", partial: { ...baseMessage } });

			for (let i = 0; i < config.eventsBeforeFailure; i++) {
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: `${config.textPrefix}-event-${i}`,
					partial: { ...baseMessage },
				});
			}

			if (config.shouldFail) {
				stream.push({
					type: "error",
					reason: "error",
					error: { ...baseMessage, stopReason: "error", errorMessage: config.errorMessage },
				});
				stream.end();
				return;
			}

			stream.push({
				type: "done",
				reason: "stop",
				message: { ...baseMessage, content: [{ type: "text", text: `${config.textPrefix}-complete` }] },
			});
			stream.end();
		})();

		return stream;
	};
}

/**
 * Creates a mock Model object for testing.
 */
function createMockModel(api: Api): Model<Api> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "test",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

/**
 * Registers a mock provider with the API registry.
 *
 * @param api - API identifier for this provider
 * @param getConfig - Function that returns the current config for this provider
 */
function registerMockProvider(api: Api, getConfig: () => MockStreamConfig): void {
	registerApiProvider({
		api,
		stream: createMockStreamFunction(getConfig),
		streamSimple: createMockStreamFunction(getConfig),
	});
}

/**
 * Testable ModelRouter that allows injecting mock models.
 * Overrides resolveModel to return registered mock models instead of
 * querying the @draht/ai model registry.
 */
class TestableModelRouter extends ModelRouter {
	private mockModels: Map<string, Model<Api>> = new Map();

	/**
	 * Register a mock model for a given provider/model reference.
	 */
	registerMockModel(ref: ModelRef, model: Model<Api>): void {
		this.mockModels.set(`${ref.provider}/${ref.model}`, model);
	}

	override resolveModel(ref: ModelRef): Model<Api> | null {
		const key = `${ref.provider}/${ref.model}`;
		return this.mockModels.get(key) ?? null;
	}
}

describe("ModelRouter Fallback Chain", () => {
	let router: TestableModelRouter;
	let primaryConfig: MockStreamConfig;
	let fallbackConfig: MockStreamConfig;

	const testConfig: RouterConfig = {
		"test-role": {
			primary: { provider: "test-primary-provider", model: "primary-model" },
			fallbacks: [{ provider: "test-fallback-provider", model: "fallback-model" }],
		},
	};

	beforeEach(() => {
		clearApiProviders();

		// Reset configs - use retryable error (429) for fallback to trigger
		primaryConfig = {
			eventsBeforeFailure: 0,
			errorMessage: "429 rate limit exceeded",
			shouldFail: true,
			textPrefix: "primary",
			api: "test-primary" as Api,
		};

		fallbackConfig = {
			eventsBeforeFailure: 3,
			errorMessage: "",
			shouldFail: false,
			textPrefix: "fallback",
			api: "test-fallback" as Api,
		};

		// Register mock providers with getter functions to pick up config changes
		registerMockProvider("test-primary" as Api, () => primaryConfig);
		registerMockProvider("test-fallback" as Api, () => fallbackConfig);

		// Create router with test config and mock models
		router = new TestableModelRouter(testConfig);
		router.registerMockModel(
			{ provider: "test-primary-provider", model: "primary-model" },
			createMockModel("test-primary" as Api),
		);
		router.registerMockModel(
			{ provider: "test-fallback-provider", model: "fallback-model" },
			createMockModel("test-fallback" as Api),
		);
	});

	afterEach(() => {
		clearApiProviders();
	});

	describe("immediate fallback", () => {
		it("should fall back to secondary when primary fails immediately with stream()", async () => {
			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			const events: AssistantMessageEvent[] = [];
			const stream = router.stream("test-role", context);

			for await (const event of stream) {
				events.push(event);
			}

			// Should have events from fallback provider, not primary
			const textDeltas = events.filter((e) => e.type === "text_delta");
			expect(textDeltas.length).toBeGreaterThan(0);

			// All text deltas should be from fallback
			for (const delta of textDeltas) {
				if (delta.type === "text_delta") {
					expect(delta.delta).toContain("fallback");
				}
			}

			// Should have a done event
			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
		});

		it("should fall back to secondary when primary fails immediately with streamSimple()", async () => {
			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			const events: AssistantMessageEvent[] = [];
			const stream = router.streamSimple("test-role", context);

			for await (const event of stream) {
				events.push(event);
			}

			// Should have events from fallback provider, not primary
			const textDeltas = events.filter((e) => e.type === "text_delta");
			expect(textDeltas.length).toBeGreaterThan(0);

			// All text deltas should be from fallback
			for (const delta of textDeltas) {
				if (delta.type === "text_delta") {
					expect(delta.delta).toContain("fallback");
				}
			}

			// Should have a done event
			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
		});
	});

	describe("mid-stream fallback", () => {
		it("should fall back when primary emits events then fails, with no primary events leaking", async () => {
			// Configure primary to emit 3 events then fail with retryable error
			primaryConfig.eventsBeforeFailure = 3;
			primaryConfig.errorMessage = "503 service unavailable";

			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			const events: AssistantMessageEvent[] = [];
			const stream = router.stream("test-role", context);

			for await (const event of stream) {
				events.push(event);
			}

			// Should only have events from fallback, not primary
			const textDeltas = events.filter((e) => e.type === "text_delta");
			expect(textDeltas.length).toBeGreaterThan(0);

			// No primary events should leak through
			for (const delta of textDeltas) {
				if (delta.type === "text_delta") {
					expect(delta.delta).not.toContain("primary");
					expect(delta.delta).toContain("fallback");
				}
			}

			// Should have a done event from fallback
			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
		});

		it("should throw last error when all providers fail mid-stream", async () => {
			// Configure primary to emit 2 events then fail
			primaryConfig.eventsBeforeFailure = 2;
			primaryConfig.errorMessage = "503 service unavailable";

			// Configure fallback to emit 1 event then fail
			fallbackConfig.eventsBeforeFailure = 1;
			fallbackConfig.errorMessage = "429 rate limit exceeded";
			fallbackConfig.shouldFail = true;

			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			let thrownError: Error | null = null;
			try {
				const stream = router.stream("test-role", context);
				for await (const _event of stream) {
					// consume events
				}
			} catch (error) {
				thrownError = error as Error;
			}

			// Should throw the last error (from fallback)
			expect(thrownError).not.toBeNull();
			expect(thrownError?.message).toContain("429");
		});
	});

	describe("stream method parity", () => {
		it("should handle fallback identically in stream() and streamSimple()", async () => {
			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			// Collect events from stream()
			const streamEvents: AssistantMessageEvent[] = [];
			for await (const event of router.stream("test-role", context)) {
				streamEvents.push(event);
			}

			// Collect events from streamSimple()
			const streamSimpleEvents: AssistantMessageEvent[] = [];
			for await (const event of router.streamSimple("test-role", context)) {
				streamSimpleEvents.push(event);
			}

			// Both should have same number of text_delta events
			const streamTextDeltas = streamEvents.filter((e) => e.type === "text_delta");
			const streamSimpleTextDeltas = streamSimpleEvents.filter((e) => e.type === "text_delta");
			expect(streamTextDeltas.length).toBe(streamSimpleTextDeltas.length);

			// Both should have events from fallback only
			for (const delta of streamTextDeltas) {
				if (delta.type === "text_delta") {
					expect(delta.delta).toContain("fallback");
				}
			}
			for (const delta of streamSimpleTextDeltas) {
				if (delta.type === "text_delta") {
					expect(delta.delta).toContain("fallback");
				}
			}
		});
	});

	describe("error classification", () => {
		it("should NOT trigger fallback for non-retryable auth errors", async () => {
			// Configure primary to fail with non-retryable auth error
			primaryConfig.eventsBeforeFailure = 0;
			primaryConfig.errorMessage = "invalid API key";

			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			let thrownError: Error | null = null;
			try {
				const stream = router.stream("test-role", context);
				for await (const _event of stream) {
					// consume events
				}
			} catch (error) {
				thrownError = error as Error;
			}

			// Should throw immediately with original error, NOT "No available model"
			expect(thrownError).not.toBeNull();
			expect(thrownError?.message).toContain("invalid API key");
			expect(thrownError?.message).not.toContain("No available model");
		});

		it("should throw last error when all providers fail with retryable errors", async () => {
			// Configure primary to fail with 429
			primaryConfig.eventsBeforeFailure = 0;
			primaryConfig.errorMessage = "429 rate limit exceeded";

			// Configure fallback to fail with 503
			fallbackConfig.eventsBeforeFailure = 0;
			fallbackConfig.errorMessage = "503 service unavailable";
			fallbackConfig.shouldFail = true;

			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			let thrownError: Error | null = null;
			try {
				const stream = router.stream("test-role", context);
				for await (const _event of stream) {
					// consume events
				}
			} catch (error) {
				thrownError = error as Error;
			}

			// Should throw the last error (503 from fallback)
			expect(thrownError).not.toBeNull();
			expect(thrownError?.message).toContain("503");
		});

		it("should throw immediately on non-retryable error from fallback", async () => {
			// Configure primary to fail with retryable 429
			primaryConfig.eventsBeforeFailure = 0;
			primaryConfig.errorMessage = "429 rate limit exceeded";

			// Configure fallback to fail with non-retryable auth error
			fallbackConfig.eventsBeforeFailure = 0;
			fallbackConfig.errorMessage = "401 Unauthorized";
			fallbackConfig.shouldFail = true;

			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			let thrownError: Error | null = null;
			try {
				const stream = router.stream("test-role", context);
				for await (const _event of stream) {
					// consume events
				}
			} catch (error) {
				thrownError = error as Error;
			}

			// Should throw the non-retryable error immediately
			expect(thrownError).not.toBeNull();
			expect(thrownError?.message).toContain("401");
		});
	});

	describe("empty fallback chain", () => {
		it("should throw original error when no fallbacks are configured", async () => {
			// Create router with role that has no fallbacks
			const noFallbackConfig: RouterConfig = {
				"no-fallback-role": {
					primary: { provider: "test-primary-provider", model: "primary-model" },
					fallbacks: [],
				},
			};

			const noFallbackRouter = new TestableModelRouter(noFallbackConfig);
			noFallbackRouter.registerMockModel(
				{ provider: "test-primary-provider", model: "primary-model" },
				createMockModel("test-primary" as Api),
			);

			// Configure primary to fail with retryable error
			primaryConfig.eventsBeforeFailure = 0;
			primaryConfig.errorMessage = "429 rate limit exceeded";

			const context: Context = {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			};

			let thrownError: Error | null = null;
			try {
				const stream = noFallbackRouter.stream("no-fallback-role", context);
				for await (const _event of stream) {
					// consume events
				}
			} catch (error) {
				thrownError = error as Error;
			}

			// Should throw the original error from primary
			expect(thrownError).not.toBeNull();
			expect(thrownError?.message).toContain("429");
		});
	});
});
