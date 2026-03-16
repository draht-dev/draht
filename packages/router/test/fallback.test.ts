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

/**
 * Configuration for mock stream behavior.
 */
interface MockStreamConfig {
	/** Number of text events to yield before failing (0 = fail immediately) */
	eventsBeforeFailure: number;
	/** Error message when failing */
	errorMessage: string;
	/** Whether this provider should fail */
	shouldFail: boolean;
	/** Text prefix to identify which provider produced events */
	textPrefix: string;
	/** API type for the mock stream */
	api: Api;
}

/**
 * Creates an AssistantMessage for testing.
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
 * Creates a mock stream function that throws for immediate failures
 * or returns a proper AssistantMessageEventStream for success/mid-stream failure.
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

		// For success or mid-stream failure, use async IIFE
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
 * Mock model for testing.
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
 * Testable ModelRouter that allows injecting mock models.
 */
class TestableModelRouter extends ModelRouter {
	private mockModels: Map<string, Model<Api>> = new Map();

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
		registerApiProvider({
			api: "test-primary" as Api,
			stream: createMockStreamFunction(() => primaryConfig),
			streamSimple: createMockStreamFunction(() => primaryConfig),
		});

		registerApiProvider({
			api: "test-fallback" as Api,
			stream: createMockStreamFunction(() => fallbackConfig),
			streamSimple: createMockStreamFunction(() => fallbackConfig),
		});

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
		it("should fall back to secondary when primary fails immediately", async () => {
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
	});
});
