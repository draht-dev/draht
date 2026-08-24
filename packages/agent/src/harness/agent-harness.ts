import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	ToolResultMessage,
	Usage,
} from "@draht/ai";
import type { AgentMessage, AgentToolResult, QueueMode, ThinkingLevel } from "../types.ts";
import type { BranchPreparation, BranchSummaryResult } from "./compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings, CompactResult } from "./compaction/compaction.ts";
import type { Context } from "./context.ts";
import type {
	Closed,
	InvalidLane,
	InvalidMessage,
	InvalidNavigation,
	LaneBusy,
	LaneExists,
	NoActiveOperation,
	NoActiveRun,
	NothingToCompact,
	NothingToResume,
	OperationMismatch,
	Result,
	UnknownSkill,
	UnknownTarget,
	UnknownTemplate,
} from "./result.ts";

export {
	Closed,
	HarnessClosed,
	HarnessFault,
	InvalidLane,
	InvalidMessage,
	InvalidNavigation,
	LaneBusy,
	LaneExists,
	NoActiveOperation,
	NoActiveRun,
	NothingToCompact,
	NothingToResume,
	OperationMismatch,
	UnknownSkill,
	UnknownTarget,
	UnknownTemplate,
} from "./result.ts";

import { createAgentHarness } from "./runtime2/harness.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	EntryProjector,
	EntryType,
	JsonValue,
	LaneLastResult,
	OperationError,
	Session,
	SessionTree,
	SettledAssistantMessage,
	UsageRow,
} from "./session/types.ts";
import type {
	AgentHarnessResources,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	AgentHarnessTool,
	PromptTemplate,
	Skill,
} from "./types.ts";

export type OptionalFinalAssistant =
	| { finalEntryId: string; finalMessage: AssistantMessage }
	| { finalEntryId?: never; finalMessage?: never };

export type RunOutcome =
	| ({ kind: "completed"; leafId: string } & OptionalFinalAssistant)
	| ({ kind: "aborted"; leafId: string } & OptionalFinalAssistant)
	| ({ kind: "failed"; leafId: string; error: OperationError } & OptionalFinalAssistant)
	| {
			kind: "suspended";
			reason: "deferred";
			leafId: string;
			finalEntryId: string;
			deferred: DeferredHandle;
	  };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

export type NavigationOutcome =
	| {
			kind: "completed";
			oldLeafId: string | null;
			newLeafId: string | null;
			summaryEntry?: BranchSummaryEntry;
	  }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

export type RunOperationOutcome = { operation: "run"; runId: string } & RunOutcome;
export type CompactionOperationOutcome = { operation: "compaction"; runId: string } & CompactionOutcome;
export type NavigationOperationOutcome = { operation: "navigation"; runId: string } & NavigationOutcome;
export type ResumeOutcome = RunOperationOutcome | CompactionOperationOutcome | NavigationOperationOutcome;

export type RunResult = Result<
	RunOperationOutcome,
	LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed
>;
export type CompactionResult = Result<CompactionOperationOutcome, LaneBusy | NothingToCompact | Closed>;
export type NavigationResult = Result<
	NavigationOperationOutcome,
	LaneBusy | InvalidNavigation | UnknownTarget | Closed
>;
export type ResumeResult = Result<ResumeOutcome, NothingToResume | Closed>;
export type QueueResult = Result<{ entryId: string }, NoActiveRun | InvalidMessage | Closed>;
export type NextRunResult = Result<{ entryId: string }, InvalidMessage | Closed>;
export type CancelQueuedResult = Result<{ kind: "cancelled" | "already_consumed" | "not_found" }, Closed>;
export type AbortResult = Result<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	NoActiveOperation | Closed
>;
export type RecordUsageResult = Result<{ usageId: string }, Closed>;
export type CreateLaneResult = Result<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	label?: string;
	customInstructions?: string;
}

export type OperationRequest =
	| { kind: "prompt"; operationId?: string; prompt: string; images?: ImageContent[] }
	| { kind: "prompt"; operationId?: string; prompt: AgentMessage | AgentMessage[]; images?: never }
	| { kind: "skill"; operationId?: string; name: string; additionalInstructions?: string }
	| { kind: "prompt_template"; operationId?: string; name: string; args?: string[] }
	| { kind: "compaction"; operationId?: string; customInstructions?: string }
	| { kind: "navigation"; operationId?: string; targetId: string | null; options?: NavigateOptions };

export interface OperationAdmission {
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	startedAt: number;
}

export type OperationAdmissionError =
	| LaneBusy
	| InvalidMessage
	| UnknownSkill
	| UnknownTemplate
	| NothingToCompact
	| InvalidNavigation
	| UnknownTarget
	| Closed;
export type OperationAdmissionResult = Result<OperationAdmission, OperationAdmissionError>;

export interface DriveOptions {
	operationId: string;
	waitForRetry?: boolean;
	pollDeferred?: boolean;
}

export interface ModelIdentity {
	provider: string;
	modelId: string;
}

export type OperationStatus = "running" | "open" | "aborting";

export interface CurrentOperationInfo {
	id: string;
	kind: "run" | "compaction" | "navigation";
	startedAt: number;
	status: OperationStatus;
	capturedModel?: ModelIdentity;
}

export interface LaneExecutionInfo {
	lane: string;
	leafId: string | null;
	configuredModel: ModelIdentity;
	current: CurrentOperationInfo | null;
	lastResult?: LaneLastResult;
}

export type TerminalOperationOutcome =
	| ({ operation: "run"; runId: string } & Exclude<RunOutcome, { kind: "suspended" }>)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);

export type DriveOutcome =
	| { kind: "settled"; operationId: string; outcome: TerminalOperationOutcome }
	| { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number }
	| { kind: "waiting"; operationId: string; reason: "deferred"; deferred: DeferredHandle };
export type DriveResult = Result<DriveOutcome, OperationMismatch | Closed>;

export type AbortRequestResult = Result<
	{
		operationId: string;
		newlyRequested: boolean;
		steer: AgentMessage[];
		followUp: AgentMessage[];
	},
	OperationMismatch | Closed
>;

export interface WatchHandle<T> {
	snapshot: T;
	start(listener: EventListener): void;
	unsubscribe(): void;
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: CurrentOperationInfo | null;
}

export interface OpenOperation {
	lane: string;
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	startedAt: number;
	aborting?: true;
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	lastResult?: LaneLastResult;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		startedAt: number;
		status: OperationStatus;
		retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
		deferred?: { handle: DeferredHandle; poll: number };
		drained?: { steer: QueuedItem[]; followUp: QueuedItem[] };
		streamingMessage?: AssistantMessage;
		runningTools: {
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult?: AgentToolResult<unknown>;
		}[];
	};
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: {
		entryId: string;
		type: EntryType;
		customType?: string;
		message?: AgentMessage;
		data?: JsonValue;
	}[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: LaneInfo[];
	faulted: boolean;
}

export type HarnessEventPayload =
	| { type: "run_start"; runId: string }
	| { type: "run_resume"; runId: string }
	| { type: "run_suspend"; runId: string; reason: "deferred"; deferred: DeferredHandle }
	| { type: "run_abort"; runId: string; steer: AgentMessage[]; followUp: AgentMessage[] }
	| ({ type: "run_end"; runId: string; leafId: string | null } & (
			| ({ outcome: "completed" | "aborted" } & OptionalFinalAssistant)
			| ({ outcome: "failed"; error: OperationError } & OptionalFinalAssistant)
	  ))
	| { type: "fault"; code: string; message: string }
	| ({ type: "handler_error"; error: string; stack?: string } & (
			| { kind: "hook"; hook: string }
			| { kind: "event"; event: string }
	  ))
	| { type: "turn_start"; runId: string; turnId: string }
	| {
			type: "turn_end";
			runId: string;
			turnId: string;
			message: AssistantMessage;
			toolResults: ToolResultMessage[];
	  }
	| {
			type: "retry_scheduled";
			runId: string;
			step: string;
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "retry_start"; runId: string; step: string; attempt: number }
	| {
			type: "retry_end";
			runId: string;
			step: string;
			attempt: number;
			success: boolean;
			finalError?: string;
	  }
	| { type: "message_start"; runId?: string; message: AgentMessage }
	| {
			type: "message_update";
			runId: string;
			message: AgentMessage;
			event: AssistantMessageEvent;
	  }
	| { type: "message_end"; runId?: string; message: AgentMessage; entryId?: string }
	| {
			type: "tool_start";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_update";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			partialResult: AgentToolResult<unknown>;
	  }
	| {
			type: "tool_end";
			runId: string;
			turnId: string;
			toolCallId: string;
			toolName: string;
			result: AgentToolResult<unknown>;
			isError: boolean;
			terminate: boolean;
	  }
	| { type: "entry_added"; entry: Entry }
	| { type: "write_pending"; runId: string; entryId: string; entryType: EntryType }
	| { type: "queue_update"; steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] }
	| ({ type: "value_update" } & (
			| { value: "session_name"; name: string | undefined }
			| { value: "entry_label"; targetId: string; label: string | undefined }
	  ))
	| ({ type: "config_update" } & (
			| {
					property: "model";
					value: { provider: string; modelId: string };
					previous: unknown;
			  }
			| { property: "thinkingLevel"; value: ThinkingLevel; previous: ThinkingLevel }
			| { property: "activeTools"; value: string[]; previous: string[] }
			| {
					property:
						| "tools"
						| "resources"
						| "streamOptions"
						| "retryPolicy"
						| "compactionSettings"
						| "steeringMode"
						| "followUpMode";
			  }
	  ))
	| { type: "compaction_start"; runId: string; reason: "manual" | "threshold" | "overflow" }
	| ({ type: "compaction_end"; runId: string; reason: "manual" | "threshold" | "overflow" } & (
			| { outcome: "completed"; entry: CompactionEntry; fromHook: boolean }
			| { outcome: "declined" | "aborted" }
			| { outcome: "failed"; error: OperationError }
	  ))
	| { type: "navigation_start"; runId: string; targetId: string | null }
	| ({
			type: "navigation_end";
			runId: string;
			oldLeafId: string | null;
			newLeafId: string | null;
	  } & (
			| { outcome: "completed"; summaryEntry?: BranchSummaryEntry }
			| { outcome: "declined" | "aborted"; summaryEntry?: never; error?: never }
			| { outcome: "failed"; error: OperationError; summaryEntry?: never }
	  ))
	| { type: "lane_created"; at: string | null }
	| { type: "usage"; lane: string; row: UsageRow; totals: Usage };

export type SpecialEventPayload = Extract<
	HarnessEventPayload,
	{ type: "fault" | "value_update" | "usage" | "config_update" | "handler_error" }
>;
export type LaneEventPayload = Exclude<HarnessEventPayload, SpecialEventPayload>;
export type ConfigEventPayload = Extract<HarnessEventPayload, { type: "config_update" }>;
export type LaneConfigEventPayload = Extract<
	ConfigEventPayload,
	{ property: "model" | "thinkingLevel" | "activeTools" }
>;
export type GlobalConfigEventPayload = Exclude<ConfigEventPayload, LaneConfigEventPayload>;
export type HandlerErrorPayload = Extract<HarnessEventPayload, { type: "handler_error" }>;

export type HarnessEvent =
	| (LaneEventPayload & { lane: string; recovery?: true })
	| (LaneConfigEventPayload & { lane: string; recovery?: true })
	| (Extract<HarnessEventPayload, { type: "fault" | "value_update" }> & {
			lane?: never;
			recovery?: never;
	  })
	| (Extract<HarnessEventPayload, { type: "usage" }> & { recovery?: never })
	| (GlobalConfigEventPayload & { lane?: never; recovery?: never })
	| (HandlerErrorPayload & ({ lane: string; recovery?: true } | { lane?: never; recovery?: never }));

export type HarnessEventType = HarnessEvent["type"];
export type EventListener<TEvent extends HarnessEvent = HarnessEvent> = (
	event: TEvent,
	context: Context,
) => void | Promise<void>;

export interface Events {
	on<TType extends HarnessEventType>(
		type: TType,
		listener: EventListener<Extract<HarnessEvent, { type: TType }>>,
	): () => void;
}

export type Resources = AgentHarnessResources<Skill, PromptTemplate>;

type VoidHookResult = ReturnType<() => void>;

export interface HookMap {
	before_run: {
		event: { prompt: AgentMessage[]; resources: Resources };
		result: { messages?: AgentMessage[] } | undefined;
	};
	before_drive: {
		event: { operation: "run" | "compaction" | "navigation" };
		result: VoidHookResult;
	};
	before_run_end: {
		event: { runId: string; messages: AgentMessage[] };
		result: { followUp?: string } | undefined;
	};
	transform_context: {
		event: { messages: AgentMessage[]; systemPrompt: string };
		result: { messages?: AgentMessage[]; systemPrompt?: string } | undefined;
	};
	before_request: {
		event: {
			model: Model<Api>;
			step: "assistant" | "deferred" | "compaction" | "branch_summary";
			attempt: number;
			streamOptions: AgentHarnessStreamOptions;
		};
		result: { streamOptions?: AgentHarnessStreamOptionsPatch } | undefined;
	};
	before_payload: {
		event: { model: Model<Api>; payload: unknown };
		result: { payload: unknown } | undefined;
	};
	after_response: {
		event: { status?: number; headers?: Record<string, string>; message: SettledAssistantMessage };
		result: { message?: SettledAssistantMessage } | undefined;
	};
	before_tool: {
		event: { toolCallId: string; toolName: string; args: Record<string, JsonValue> };
		result: { args?: Record<string, JsonValue>; block?: { reason: string; terminate?: boolean } } | undefined;
	};
	after_tool: {
		event: {
			toolCallId: string;
			toolName: string;
			args: Record<string, JsonValue>;
			content: AgentToolResult<unknown>["content"];
			details?: JsonValue;
			isError: boolean;
			usage?: Usage;
		};
		result:
			| {
					content?: AgentToolResult<unknown>["content"];
					details?: JsonValue;
					isError?: boolean;
					usage?: Usage;
					terminate?: boolean;
			  }
			| undefined;
	};
	before_compaction: {
		event: {
			reason: "manual" | "threshold" | "overflow";
			preparation: CompactionPreparation;
			customInstructions?: string;
		};
		result: { decline?: boolean; compaction?: CompactResult } | undefined;
	};
	before_navigation: {
		event: { targetId: string; preparation: BranchPreparation; customInstructions?: string };
		result: { decline?: boolean; summary?: BranchSummaryResult } | undefined;
	};
}

export type HookName = keyof HookMap;
export type HookInvocation<TName extends HookName> = HookMap[TName]["event"] & {
	lane: string;
	runId: string;
};
export type HookHandler<TName extends HookName> = (
	event: HookInvocation<TName>,
	context: Context,
) => Promise<HookMap[TName]["result"]> | HookMap[TName]["result"];

export interface Hooks {
	on<TName extends HookName>(name: TName, handler: HookHandler<TName>, options?: { id?: string }): () => void;
}

export type { EntryProjector } from "./session/types.ts";

export interface AgentHarnessOptions<TContext extends object | undefined = object | undefined> {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: AgentHarnessTool<TContext>[];
	toolContext?: TContext | ((context: Context) => TContext | Promise<TContext>);
	systemPrompt?: string | ((toolContext: TContext, context: Context) => string | Promise<string>);
	resources?: Resources;
	streamOptions?: AgentHarnessStreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	toProviderMessages?: (messages: AgentMessage[], context: Context) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(context: Context): Promise<string | null>;
	getLastResult(context: Context): Promise<LaneLastResult | undefined>;
	accept(request: OperationRequest, context: Context): Promise<OperationAdmissionResult>;
	drive(options: DriveOptions, context: Context): Promise<DriveResult>;
	requestAbort(operationId: string, context: Context): Promise<AbortRequestResult>;
	inspectExecution(context: Context): Promise<LaneExecutionInfo>;
	prompt(text: string, images: ImageContent[] | undefined, context: Context): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[], context: Context): Promise<RunResult>;
	skill(name: string, additionalInstructions: string | undefined, context: Context): Promise<RunResult>;
	promptFromTemplate(name: string, args: string[] | undefined, context: Context): Promise<RunResult>;
	compact(options: { customInstructions?: string } | undefined, context: Context): Promise<CompactionResult>;
	navigateTree(
		targetId: string | null,
		options: NavigateOptions | undefined,
		context: Context,
	): Promise<NavigationResult>;
	resume(context: Context): Promise<ResumeResult>;
	abort(context: Context): Promise<AbortResult>;
	steer(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<QueueResult>;
	followUp(message: string | AgentMessage, images: ImageContent[] | undefined, context: Context): Promise<QueueResult>;
	nextRun(
		message: string | AgentMessage,
		images: ImageContent[] | undefined,
		context: Context,
	): Promise<NextRunResult>;
	cancelQueued(entryId: string, context: Context): Promise<CancelQueuedResult>;
	recordUsage(
		usage: Usage,
		options: { entryId?: string; details?: JsonValue } | undefined,
		context: Context,
	): Promise<RecordUsageResult>;
	waitForIdle(context: Context): Promise<void>;
	runWhenIdle(callback: (context: Context) => void | Promise<void>, context: Context): Promise<void>;
	getModel(context: Context): Promise<Model<Api> | undefined>;
	setModel(model: Model<Api>, context: Context): Promise<void>;
	getThinkingLevel(context: Context): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel, context: Context): Promise<void>;
	getActiveTools(context: Context): Promise<string[]>;
	setActiveTools(names: string[], context: Context): Promise<void>;
	readonly sessionTree: SessionTree;
	watch(context: Context): Promise<WatchHandle<LaneSnapshot>>;
}

export interface AgentHarness<TContext extends object | undefined = object | undefined> extends AgentLane {
	lane(name: string, context: Context): Promise<AgentLane | undefined>;
	createLane(name: string, at: string | null, context: Context): Promise<CreateLaneResult>;
	lanes(context: Context): Promise<LaneInfo[]>;
	getTools(context: Context): Promise<AgentHarnessTool<TContext>[]>;
	setTools(tools: AgentHarnessTool<TContext>[], context: Context): Promise<void>;
	getResources(context: Context): Promise<Resources>;
	setResources(resources: Resources, context: Context): Promise<void>;
	getStreamOptions(context: Context): Promise<AgentHarnessStreamOptions>;
	setStreamOptions(options: AgentHarnessStreamOptions, context: Context): Promise<void>;
	getRetryPolicy(context: Context): Promise<RetryPolicy>;
	setRetryPolicy(policy: RetryPolicy, context: Context): Promise<void>;
	getCompactionSettings(context: Context): Promise<CompactionSettings>;
	setCompactionSettings(settings: CompactionSettings, context: Context): Promise<void>;
	getSteeringMode(context: Context): Promise<QueueMode>;
	setSteeringMode(mode: QueueMode, context: Context): Promise<void>;
	getFollowUpMode(context: Context): Promise<QueueMode>;
	setFollowUpMode(mode: QueueMode, context: Context): Promise<void>;
	watchSession(context: Context): Promise<WatchHandle<SessionSnapshot>>;
	readonly hooks: Hooks;
	readonly events: Events;
	close(context: Context): Promise<void>;
}

export interface AgentHarnessConstructor {
	create<TContext extends object | undefined = object | undefined>(
		options: AgentHarnessOptions<TContext>,
		context: Context,
	): Promise<{ harness: AgentHarness<TContext>; open: OpenOperation[] }>;
}

/** Runtime constructor for attaching the durable harness to one open session. */
export const AgentHarness = { create: createAgentHarness } satisfies AgentHarnessConstructor;
