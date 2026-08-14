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
import type { TelemetryContext } from "@draht/telemetry";
import type { AgentMessage, AgentToolResult, QueueMode, ThinkingLevel } from "../types.ts";
import { createAgentHarness } from "./agent-harness-runtime.ts";
import type { BranchPreparation, BranchSummaryResult } from "./compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings, CompactResult } from "./compaction/compaction.ts";
import { type Result, TaggedError } from "./result.ts";
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

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class OperationMismatch extends TaggedError("OperationMismatch")<{
	lane: string;
	expectedOperationId: string;
	currentOperationId?: string;
	lastOperationId?: string;
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{
	lane: string;
	reason: string;
	message: string;
}> {}
export class InvalidNavigation extends TaggedError("InvalidNavigation")<{
	lane: string;
	reason: string;
	message: string;
}> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{
	lane: string;
	reason: string;
	message: string;
}> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export type OptionalFinalAssistant =
	| { finalEntryId: string; finalMessage: AssistantMessage }
	| { finalEntryId?: never; finalMessage?: never };

export type MissingIdentitySuspension = {
	kind: "suspended";
	reason: "missing_identities";
	missing: { tools: string[]; models: string[] };
};

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
	  }
	| (MissingIdentitySuspension & { leafId: string });

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError }
	| (MissingIdentitySuspension & { leafId: string });

export type NavigationOutcome =
	| {
			kind: "completed";
			oldLeafId: string | null;
			newLeafId: string | null;
			summaryEntry?: BranchSummaryEntry;
	  }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError }
	| (MissingIdentitySuspension & { leafId: string | null });

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);

export type RunResult = Result<
	{ runId: string } & RunOutcome,
	LaneBusy | MissingIdentities | InvalidMessage | UnknownSkill | UnknownTemplate | Closed
>;
export type CompactionResult = Result<
	{ runId: string } & CompactionOutcome,
	LaneBusy | MissingIdentities | NothingToCompact | Closed
>;
export type NavigationResult = Result<
	{ runId: string } & NavigationOutcome,
	LaneBusy | MissingIdentities | InvalidNavigation | UnknownTarget | Closed
>;
export type ResumeResult = Result<ResumeOutcome, NothingToResume | MissingIdentities | Closed>;
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
	| MissingIdentities
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
	deadline?: number;
	waitForRetry?: boolean;
	pollDeferred?: boolean;
}

export interface CurrentOperationInfo {
	id: string;
	kind: "run" | "compaction" | "navigation";
	status: "running" | "suspended" | "aborting";
	startedAt: number;
	suspended?: SuspendedOperation;
}

export interface LaneExecutionInfo {
	lane: string;
	leafId: string | null;
	current: CurrentOperationInfo | null;
	lastResult?: LaneLastResult;
}

export type TerminalOperationOutcome =
	| ({ operation: "run"; runId: string } & Exclude<RunOutcome, { kind: "suspended" }>)
	| ({ operation: "compaction"; runId: string } & Exclude<CompactionOutcome, { kind: "suspended" }>)
	| ({ operation: "navigation"; runId: string } & Exclude<NavigationOutcome, { kind: "suspended" }>);

export type DriveOutcome =
	| { kind: "settled"; operationId: string; outcome: TerminalOperationOutcome }
	| { kind: "waiting"; operationId: string; reason: "retry"; notBefore: number }
	| { kind: "waiting"; operationId: string; reason: "deferred"; deferred: DeferredHandle }
	| {
			kind: "waiting";
			operationId: string;
			reason: "missing_identities";
			missing: { tools: string[]; models: string[] };
	  }
	| { kind: "yielded"; operationId: string };
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

export interface ActionInfo {
	kind: string;
	description: string;
	details?: JsonValue;
}

export interface WatchHandle<T> {
	snapshot: T;
	start(listener: EventListener): void;
	unsubscribe(): void;
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export type SuspendedOperation = {
	lane: string;
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	startedAt: number;
	prompt?: AgentMessage[];
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
} & (
	| { reason: "deferred"; deferred: DeferredHandle; missing?: never }
	| {
			reason: "missing_identities";
			missing: { tools: string[]; models: string[] };
			deferred?: never;
	  }
	| {
			reason: "crash";
			deferred?: DeferredHandle;
			missing?: { tools: string[]; models: string[] };
	  }
);

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
		startedAt: number;
		suspended?: SuspendedOperation;
		streamingMessage?: AssistantMessage;
		runningTools: {
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult?: AgentToolResult<unknown>;
		}[];
		retry?: { attempt: number; maxAttempts: number; nextAttemptAt: number };
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
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type HarnessEventPayload =
	| { type: "run_start"; runId: string }
	| { type: "run_resume"; runId: string }
	| { type: "run_suspend"; runId: string; reason: "deferred"; deferred: DeferredHandle }
	| {
			type: "run_suspend";
			runId: string;
			reason: "missing_identities";
			missing: { tools: string[]; models: string[] };
	  }
	| {
			type: "compaction_suspend";
			runId: string;
			reason: "missing_identities";
			missing: { tools: string[]; models: string[] };
	  }
	| {
			type: "navigation_suspend";
			runId: string;
			reason: "missing_identities";
			missing: { tools: string[]; models: string[] };
	  }
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
	| ({ type: "fact_update" } & (
			| { fact: "name"; name: string | undefined }
			| { fact: "label"; targetId: string; label: string | undefined }
			| { fact: "custom"; key: string; value: JsonValue | undefined }
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
	{ type: "fault" | "fact_update" | "usage" | "config_update" | "handler_error" }
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
	| (Extract<HarnessEventPayload, { type: "fault" | "fact_update" }> & {
			lane?: never;
			recovery?: never;
	  })
	| (Extract<HarnessEventPayload, { type: "usage" }> & { recovery?: never })
	| (GlobalConfigEventPayload & { lane?: never; recovery?: never })
	| (HandlerErrorPayload & ({ lane: string; recovery?: true } | { lane?: never; recovery?: never }));

export type HarnessEventType = HarnessEvent["type"];
export type EventListener<TEvent extends HarnessEvent = HarnessEvent> = (event: TEvent) => void | Promise<void>;

export interface Events {
	on<TType extends HarnessEventType>(
		type: TType,
		listener: EventListener<Extract<HarnessEvent, { type: TType }>>,
	): () => void;
}

export type Resources = AgentHarnessResources<Skill, PromptTemplate>;

export type BeforeResumePrepared =
	| { kind: "run"; prompt: AgentMessage[]; systemPromptOverride?: string }
	| { kind: "compaction"; sourceLeafId: string | null; customInstructions?: string }
	| {
			kind: "navigation";
			sourceLeafId: string | null;
			targetId: string | null;
			summarize: boolean;
			label?: string;
			customInstructions?: string;
	  };

type VoidHookResult = ReturnType<() => void>;

export interface HookMap {
	before_run: {
		event: { prompt: AgentMessage[]; systemPrompt: string; resources: Resources };
		result: { messages?: AgentMessage[]; systemPrompt?: string; resumeData?: JsonValue } | undefined;
	};
	before_resume: {
		event: BeforeResumePrepared & { resumeData?: JsonValue };
		result: VoidHookResult;
	};
	before_run_end: {
		event: { runId: string; messages: AgentMessage[] };
		result: { followUp?: string } | undefined;
	};
	transform_context: {
		event: { messages: AgentMessage[] };
		result: { messages: AgentMessage[] } | undefined;
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
	toolContext?: TContext | (() => TContext | Promise<TContext>);
	systemPrompt?: string | ((context: TContext) => string | Promise<string>);
	resources?: Resources;
	streamOptions?: AgentHarnessStreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	telemetryContext?: TelemetryContext;
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	getLastResult(): Promise<LaneLastResult | undefined>;
	accept(request: OperationRequest): Promise<OperationAdmissionResult>;
	drive(options: DriveOptions): Promise<DriveResult>;
	requestAbort(operationId: string): Promise<AbortRequestResult>;
	inspectExecution(): Promise<LaneExecutionInfo>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: string | AgentMessage, images?: ImageContent[]): Promise<NextRunResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api> | undefined>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

export interface AgentHarness<TContext extends object | undefined = object | undefined> extends AgentLane {
	lane(name: string): Promise<AgentLane | undefined>;
	createLane(name: string, at: string | null): Promise<CreateLaneResult>;
	lanes(): Promise<LaneInfo[]>;
	getTools(): Promise<AgentHarnessTool<TContext>[]>;
	setTools(tools: AgentHarnessTool<TContext>[]): Promise<void>;
	getResources(): Promise<Resources>;
	setResources(resources: Resources): Promise<void>;
	getStreamOptions(): Promise<AgentHarnessStreamOptions>;
	setStreamOptions(options: AgentHarnessStreamOptions): Promise<void>;
	getRetryPolicy(): Promise<RetryPolicy>;
	setRetryPolicy(policy: RetryPolicy): Promise<void>;
	getCompactionSettings(): Promise<CompactionSettings>;
	setCompactionSettings(settings: CompactionSettings): Promise<void>;
	getSteeringMode(): Promise<QueueMode>;
	setSteeringMode(mode: QueueMode): Promise<void>;
	getFollowUpMode(): Promise<QueueMode>;
	setFollowUpMode(mode: QueueMode): Promise<void>;
	watchSession(): Promise<WatchHandle<SessionSnapshot>>;
	readonly hooks: Hooks;
	readonly events: Events;
	close(): Promise<void>;
}

export interface AgentHarnessConstructor {
	create<TContext extends object | undefined = object | undefined>(
		options: AgentHarnessOptions<TContext>,
	): Promise<{ harness: AgentHarness<TContext>; suspended: SuspendedOperation[] }>;
}

/** Runtime constructor for attaching the durable harness to one open session. */
export const AgentHarness: AgentHarnessConstructor = { create: createAgentHarness };
