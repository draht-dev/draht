import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
} from "@draht/ai";
import type { TelemetryContext } from "@draht/telemetry";
import type { AgentMessage, AgentTool, ThinkingLevel } from "../../types.ts";
import type { SettledAssistantMessage } from "../session/types.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import { AbortRequested } from "./effect-gate.ts";

/** HTTP response metadata captured before the provider response body is consumed. */
export interface AssistantResponseMetadata {
	status?: number;
	headers?: Record<string, string>;
}

/** Process-local lifecycle observer for one assistant stream. */
export interface AssistantStreamObserver {
	start(message: AssistantMessage): void | Promise<void>;
	update(message: AssistantMessage, event: AssistantMessageEvent): void | Promise<void>;
	end(message: SettledAssistantMessage): void | Promise<void>;
}

/** Executable inputs for one already-approved assistant provider request. */
export interface HarnessAssistantStreamConfig {
	model: Model<Api>;
	systemPrompt: string;
	tools?: AgentTool[];
	thinkingLevel: ThinkingLevel;
	streamOptions: AgentHarnessStreamOptions;
	transformContext?: (
		context: { messages: AgentMessage[]; systemPrompt: string },
		signal: AbortSignal,
	) => Promise<{ messages: AgentMessage[]; systemPrompt: string }>;
	toProviderMessages: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	beforePayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
	afterResponse?: (
		message: SettledAssistantMessage,
		metadata: AssistantResponseMetadata,
	) => Promise<SettledAssistantMessage>;
	request(
		context: Context,
		options: SimpleStreamOptions,
	): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
	observer: AssistantStreamObserver;
	telemetryContext: TelemetryContext;
	signal: AbortSignal;
}

function createRequestOptions(
	config: HarnessAssistantStreamConfig,
	captureMetadata: (metadata: AssistantResponseMetadata) => void,
): SimpleStreamOptions {
	const options = config.streamOptions;
	return {
		transport: options.transport,
		timeoutMs: options.timeoutMs,
		maxRetries: options.maxRetries,
		maxRetryDelayMs: options.maxRetryDelayMs,
		headers: options.headers,
		metadata: options.metadata,
		cacheRetention: options.cacheRetention,
		deferred: options.deferred,
		...(config.thinkingLevel === "off" ? {} : { reasoning: config.thinkingLevel }),
		signal: config.signal,
		telemetryContext: config.telemetryContext,
		onPayload: config.beforePayload,
		onResponse: (response) => {
			captureMetadata({ status: response.status, headers: response.headers });
		},
	};
}

function isUpdateEvent(
	event: AssistantMessageEvent,
): event is Exclude<AssistantMessageEvent, { type: "start" | "done" | "error" }> {
	return event.type !== "start" && event.type !== "done" && event.type !== "error";
}

/** Stream one assistant response without mutating the caller's message list. */
export async function streamHarnessAssistant(
	messages: AgentMessage[],
	config: HarnessAssistantStreamConfig,
): Promise<SettledAssistantMessage> {
	let requestContext = { messages: messages.slice(), systemPrompt: config.systemPrompt };
	if (config.transformContext) {
		requestContext = await config.transformContext(requestContext, config.signal);
	}

	const providerMessages = await config.toProviderMessages(requestContext.messages);
	const context: Context = {
		systemPrompt: requestContext.systemPrompt,
		messages: providerMessages,
		tools: config.tools,
	};

	let metadata: AssistantResponseMetadata = {};
	const stream = await config.request(
		context,
		createRequestOptions(config, (nextMetadata) => {
			metadata = nextMetadata;
		}),
	);

	let started = false;
	for await (const event of stream) {
		if (event.type === "start") {
			started = true;
			await config.observer.start({ ...event.partial });
		} else if (isUpdateEvent(event)) {
			await config.observer.update({ ...event.partial }, event);
		}
	}

	const settled = (await stream.result()) as SettledAssistantMessage;
	if (!started) {
		await config.observer.start({ ...settled });
	}
	let finalMessage = settled;
	if (config.afterResponse) {
		try {
			finalMessage = await config.afterResponse(settled, metadata);
		} catch (error) {
			if (!(error instanceof AbortRequested)) throw error;
			await error.cancellation;
		}
	}
	await config.observer.end(finalMessage);
	return finalMessage;
}
