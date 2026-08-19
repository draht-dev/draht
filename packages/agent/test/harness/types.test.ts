import type { AssistantMessage, AssistantMessageFrame, Usage } from "@draht/ai";
import { expectTypeOf, it } from "vitest";
import * as storedValues from "../../src/harness/session/values.ts";
import type {
	AgentHarnessOptions,
	AgentHarnessStreamOptions,
	AgentHarnessTool,
	AgentHarnessToolInvocation,
	AgentLane,
	AgentMessage,
	AgentTool,
	BranchScan,
	CancelQueuedResult,
	CheckpointPhase,
	CompactionState,
	Context,
	Control,
	CustomEntry,
	Deferred,
	DriveOptions,
	DriveOutcome,
	DriveResult,
	Entry,
	EntryProjector,
	EntryWrite,
	Generation,
	GenerationContext,
	HarnessEvent,
	HookHandler,
	HookMap,
	HookName,
	IdGenerator,
	LaneConfiguration,
	LaneExecutionInfo,
	LaneLastResult,
	LaneSnapshot,
	NavigationState,
	NewEntry,
	OperationAdmissionResult,
	OperationMeta,
	OperationRequest,
	OperationState,
	RunPhase,
	RunResult,
	RunState,
	SearchQuery,
	Session,
	SessionCreateOptions,
	SessionMetadata,
	SessionMutator,
	SessionReader,
	SessionRepo,
	SessionSearchHit,
	SessionSearchService,
	SessionSnapshot,
	SessionTree,
	SettledAssistantMessage,
	Storage,
	StorageBranchScan,
	StructuralDecision,
	SummaryContext,
	SummaryGeneration,
	ToolCall,
	UsageRow,
	UsageWrite,
	ValueSetWrite,
	Write,
} from "../../src/index.ts";
import { insertEntry, insertUsage } from "../../src/index.ts";

const configuration = {
	model: { provider: "provider", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: ["read"],
} satisfies LaneConfiguration;

const retryPolicy = { maxAttempts: 3, baseDelayMs: 100 } as const;
const generationContext = {
	stepId: "step",
	triggerEntryId: "trigger",
	configuration,
	streamOptions: { deferred: { window: "1h" } },
	retryPolicy,
	overflowRecoveryUsed: false,
} satisfies GenerationContext;
const summaryContext = {
	taskId: "task",
	resultEntryId: "summary",
	kind: "compaction",
	configuration,
	streamOptions: {},
	retryPolicy,
	reason: "manual",
} satisfies SummaryContext;
const checkpoint = {
	kind: "checkpoint",
	continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
	triggerEntryId: "trigger",
} satisfies CheckpointPhase;

const runningControl = { status: "running" } satisfies Control;
const generations = [
	{ status: "ready", context: generationContext, nextAttempt: 1 },
	{
		status: "effect_pending",
		context: generationContext,
		attempt: 1,
		responseEntryId: "response",
		usageId: "usage",
		intendedOutputLimit: 4096,
		contextWindow: 128000,
	},
	{ status: "retry_wait", context: generationContext, nextAttempt: 2, notBefore: 10, errorMessage: "retry" },
] satisfies Generation[];
const toolCalls = [
	{ status: "planned", sourceIndex: 0, resultEntryId: "result-0" },
	{ status: "effect_pending", sourceIndex: 1, resultEntryId: "result-1", replay: "safe" },
	{ status: "outcome_ready", sourceIndex: 2, resultEntryId: "result-2", terminate: true },
	{ status: "completed", sourceIndex: 3, resultEntryId: "result-3", terminate: false },
] satisfies ToolCall[];
const deferredStates = [
	{
		status: "suspended",
		stepId: "step",
		sourceEntryId: "source",
		poll: 0,
		configuration,
		streamOptions: {},
	},
	{
		status: "effect_pending",
		stepId: "step",
		sourceEntryId: "source",
		poll: 1,
		responseEntryId: "response",
		usageId: "usage",
		configuration,
		streamOptions: {},
	},
] satisfies Deferred[];
const summaryGenerations = [
	{ status: "ready", context: summaryContext, nextAttempt: 1 },
	{
		status: "effect_pending",
		context: summaryContext,
		attempt: 1,
		request: { index: 0, usageId: "usage" },
		usageIds: [],
	},
	{ status: "retry_wait", context: summaryContext, nextAttempt: 2, notBefore: 10, errorMessage: "retry" },
] satisfies SummaryGeneration[];
const structuralDecisions = [
	{ status: "deciding", taskId: "task" },
	{ status: "generating", taskId: "task", generation: summaryGenerations[0] },
] satisfies StructuralDecision[];

const runPhases: RunPhase[] = [
	{ kind: "starting" },
	checkpoint,
	{ kind: "assistant", generation: generations[0] },
	{
		kind: "tools",
		batch: { assistantEntryId: "assistant", configuration, turnId: "turn", calls: toolCalls },
	},
	{
		kind: "compaction",
		reason: "threshold",
		structural: structuralDecisions[0],
		resumeAfter: checkpoint,
	},
	{ kind: "deferred", deferred: deferredStates[0] },
	{
		kind: "failure_drain",
		error: { code: "provider", message: "failed" },
		provenance: { kind: "response", entryId: "response" },
	},
	{
		kind: "failure_drain",
		error: {
			code: "model_unavailable",
			message: "Model is unavailable",
			details: { provider: "provider", modelId: "model" },
		},
		provenance: { kind: "configuration" },
	},
	{
		kind: "failure_drain",
		error: {
			code: "configured_tools_unavailable",
			message: "Configured tools are unavailable",
			details: { tools: ["read"] },
		},
		provenance: { kind: "configuration" },
	},
];

const runState = {
	kind: "run",
	control: runningControl,
	settings: {
		compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		toolExecution: "parallel",
	},
	phase: runPhases[0]!,
	inbox: { steer: [], followUp: [], writes: [] },
	latestAssistantEntryId: null,
} satisfies RunState;
const compactionState = {
	kind: "compaction",
	control: runningControl,
	customInstructions: "compact",
	structural: structuralDecisions[0],
} satisfies CompactionState;
const navigationStates = [
	{
		kind: "navigation",
		control: runningControl,
		targetId: null,
		summarize: false,
		phase: { kind: "ready_to_commit" },
	},
	{
		kind: "navigation",
		control: runningControl,
		targetId: "target",
		summarize: true,
		phase: { kind: "summary", structural: structuralDecisions[0] },
	},
] satisfies NavigationState[];
const operationStates = [runState, compactionState, ...navigationStates] satisfies OperationState[];
const operations = [
	{
		operationId: "run",
		lane: "main",
		sourceLeafId: null,
		startedAt: 1,
		intent: { kind: "run", promptEntryIds: ["prompt"] },
	},
	{
		operationId: "compaction",
		lane: "main",
		sourceLeafId: "source",
		startedAt: 2,
		intent: { kind: "compaction", customInstructions: "compact" },
	},
	{
		operationId: "navigation",
		lane: "main",
		sourceLeafId: "source",
		startedAt: 3,
		intent: { kind: "navigation", targetId: "target", summarize: true, label: "target" },
	},
] satisfies OperationMeta[];

const lastResult = {
	operationId: "run",
	kind: "run",
	leafId: "leaf",
	finalAssistantEntryId: "assistant",
	outcome: "completed",
	runCompletion: "assistant",
} satisfies LaneLastResult;
const valueWrites: ValueSetWrite[] = [
	storedValues.setValue(storedValues.laneLeaf("main"), "leaf"),
	storedValues.setValue(storedValues.laneConfig("main"), configuration),
	storedValues.setValue(storedValues.laneState("main"), { currentOperationId: "run", pendingNextRun: [] }),
	storedValues.setValue(storedValues.laneLastResult("main"), lastResult),
	storedValues.setValue(storedValues.operationMeta("run"), operations[0]),
	storedValues.setValue(storedValues.operationState("run"), runState),
	storedValues.setValue(storedValues.operationToolArgs("run", "step", 0), { path: "file" }),
	storedValues.setValue(storedValues.operationPreparation("run", "task"), {
		kind: "compaction",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		retainedTail: [],
		isSplitTurn: false,
		tokensBefore: 100,
		fileOps: { read: [], written: [], edited: [] },
		settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
	}),
	storedValues.setValue(storedValues.pendingEntry("pending"), {
		type: "custom",
		customType: "note",
		payload: { text: "pending" },
	}),
	storedValues.setValue(storedValues.sessionName, "session"),
	storedValues.setValue(storedValues.entryLabel("entry"), "label"),
	storedValues.setValue(storedValues.value<unknown>("test.value", "state"), null),
];

const usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies Usage;
const usageRow = {
	id: "usage",
	seq: 2,
	usage,
	entryId: "entry",
	adjustment: false,
	details: { attempt: 1 },
} satisfies UsageRow;
const entryWrite = insertEntry({
	id: "entry",
	parentId: null,
	type: "message",
	message: { role: "user", content: "hello", timestamp: 1 },
});
const usageWrite = insertUsage({
	id: usageRow.id,
	usage,
	adjustment: false,
	entryId: "entry",
});
const writes = [
	entryWrite,
	usageWrite,
	valueWrites[0]!,
	storedValues.deleteValue(storedValues.entryLabel("entry")),
] satisfies Write[];
const transaction = writes satisfies Write[];

it("covers the complete durable storage and Part 3 discriminants", () => {
	expectTypeOf(entryWrite).toEqualTypeOf<EntryWrite>();
	expectTypeOf(usageWrite).toEqualTypeOf<UsageWrite>();
	expectTypeOf(storedValues.laneConfig("main")).toEqualTypeOf<storedValues.Value<LaneConfiguration>>();
	expectTypeOf(storedValues.pendingAssistantFrames("operation", "response")).toEqualTypeOf<
		storedValues.ValueList<AssistantMessageFrame>
	>();
	expectTypeOf<OperationMeta["intent"]["kind"]>().toEqualTypeOf<"run" | "compaction" | "navigation">();
	expectTypeOf<Control["status"]>().toEqualTypeOf<"running" | "cancel_requested">();
	expectTypeOf<Generation["status"]>().toEqualTypeOf<"ready" | "effect_pending" | "retry_wait">();
	expectTypeOf<ToolCall["status"]>().toEqualTypeOf<"planned" | "effect_pending" | "outcome_ready" | "completed">();
	expectTypeOf<Deferred["status"]>().toEqualTypeOf<"suspended" | "effect_pending">();
	expectTypeOf<SummaryGeneration["status"]>().toEqualTypeOf<"ready" | "effect_pending" | "retry_wait">();
	expectTypeOf<StructuralDecision["status"]>().toEqualTypeOf<"deciding" | "generating">();
	expectTypeOf<RunPhase["kind"]>().toEqualTypeOf<
		"starting" | "checkpoint" | "assistant" | "tools" | "compaction" | "deferred" | "failure_drain"
	>();
	expectTypeOf<OperationState["kind"]>().toEqualTypeOf<"run" | "compaction" | "navigation">();
	expectTypeOf<NavigationState["summarize"]>().toEqualTypeOf<boolean>();
	expectTypeOf<NewEntry["type"]>().toEqualTypeOf<"message" | "compaction" | "branch_summary" | "custom">();
	void transaction;
	void generations;
	void deferredStates;
	void summaryGenerations;
	void operationStates;

	const compileTimeFailures = () => {
		// @ts-expect-error lane.config requires a complete LaneConfiguration
		const invalidValue: ValueSetWrite = storedValues.setValue(storedValues.laneConfig("main"), "model");
		// @ts-expect-error response entries require settled assistant content at runtime, not a pending settlement type
		const invalidSettled: SettledAssistantMessage = { stopReason: "pending" } as AssistantMessage;
		void invalidValue;
		void invalidSettled;
	};
	expectTypeOf(compileTimeFailures).toBeFunction();
});

it("covers storage, session, repository, search, and identity signatures", () => {
	expectTypeOf<SessionMetadata["storageVersion"]>().toEqualTypeOf<number>();
	expectTypeOf<IdGenerator["next"]>().toEqualTypeOf<(timestampMs?: number) => string>();
	expectTypeOf<Parameters<Storage["scanBranch"]>[0]["start"]>().toEqualTypeOf<string>();
	expectTypeOf<BranchScan["start"]>().toEqualTypeOf<string | undefined>();
	expectTypeOf<Storage["commit"]>().toEqualTypeOf<
		(
			transactionToCommit: Write[],
			context: Context,
		) => Promise<{ firstSeq: number; seqs: number[]; timestamp: number }>
	>();
	expectTypeOf<Session["mutate"]>().toEqualTypeOf<
		<T>(
			lane: string,
			mutation: (mutator: SessionMutator, context: Context) => T | Promise<T>,
			context: Context,
		) => Promise<T>
	>();
	expectTypeOf<SessionMutator["commit"]>().toEqualTypeOf<
		(
			transactionToCommit: Write[],
			context: Context,
		) => Promise<{ firstSeq: number; seqs: number[]; timestamp: number }>
	>();
	expectTypeOf<SessionReader["scanBranch"]>().toEqualTypeOf<
		(query: StorageBranchScan, context: Context) => Promise<Entry[]>
	>();
	expectTypeOf<Session["createLane"]>().toEqualTypeOf<
		(name: string, at: string | null, laneConfiguration: LaneConfiguration, context: Context) => Promise<SessionTree>
	>();
	expectTypeOf<SessionRepo["create"]>().toEqualTypeOf<
		(options: SessionCreateOptions, context: Context) => Promise<Session>
	>();
	expectTypeOf<SessionSearchService["searchSessions"]>().toEqualTypeOf<
		(query: SearchQuery) => Promise<SessionSearchHit[]>
	>();
	expectTypeOf<SessionSearchService["notify"]>().toEqualTypeOf<(sessionId: string) => void>();
});

it("covers Part 5 results, events, hooks, snapshots, tools, and stream options", () => {
	type RunErrorTag = Extract<RunResult, { ok: false }>["error"]["_tag"];
	type CancelKind = Extract<CancelQueuedResult, { ok: true }>["value"]["kind"];
	expectTypeOf<RunErrorTag>().toEqualTypeOf<
		"LaneBusy" | "InvalidMessage" | "UnknownSkill" | "UnknownTemplate" | "Closed"
	>();
	expectTypeOf<CancelKind>().toEqualTypeOf<"cancelled" | "already_consumed" | "not_found">();
	expectTypeOf<HarnessEvent["type"]>().toEqualTypeOf<
		| "run_start"
		| "run_resume"
		| "run_suspend"
		| "run_abort"
		| "run_end"
		| "fault"
		| "handler_error"
		| "turn_start"
		| "turn_end"
		| "retry_scheduled"
		| "retry_start"
		| "retry_end"
		| "message_start"
		| "message_update"
		| "message_end"
		| "tool_start"
		| "tool_update"
		| "tool_end"
		| "entry_added"
		| "write_pending"
		| "queue_update"
		| "value_update"
		| "config_update"
		| "compaction_start"
		| "compaction_end"
		| "navigation_start"
		| "navigation_end"
		| "lane_created"
		| "usage"
	>();
	expectTypeOf<HookName>().toEqualTypeOf<
		| "before_run"
		| "before_drive"
		| "before_run_end"
		| "transform_context"
		| "before_request"
		| "before_payload"
		| "after_response"
		| "before_tool"
		| "after_tool"
		| "before_compaction"
		| "before_navigation"
	>();
	expectTypeOf<HookMap["before_drive"]["result"]>().toEqualTypeOf<void>();
	expectTypeOf<HookHandler<"before_drive">>().returns.toEqualTypeOf<void | Promise<void>>();
	expectTypeOf<HookMap["transform_context"]["event"]>().toEqualTypeOf<{
		messages: AgentMessage[];
		systemPrompt: string;
	}>();
	expectTypeOf<LaneSnapshot["operation"]>().not.toEqualTypeOf<SessionSnapshot>();
	expectTypeOf<AgentLane["getLastResult"]>().returns.toEqualTypeOf<Promise<LaneLastResult | undefined>>();
	expectTypeOf<AgentLane["accept"]>().returns.toEqualTypeOf<Promise<OperationAdmissionResult>>();
	expectTypeOf<AgentLane["drive"]>().returns.toEqualTypeOf<Promise<DriveResult>>();
	expectTypeOf<keyof DriveOptions>().toEqualTypeOf<"operationId" | "waitForRetry" | "pollDeferred">();
	expectTypeOf<DriveOutcome["kind"]>().toEqualTypeOf<"settled" | "waiting" | "action_required">();
	expectTypeOf<AgentLane["inspectExecution"]>().returns.toEqualTypeOf<Promise<LaneExecutionInfo>>();
	expectTypeOf<OperationRequest["kind"]>().toEqualTypeOf<
		"prompt" | "skill" | "prompt_template" | "compaction" | "navigation"
	>();
	expectTypeOf<Parameters<AgentHarnessTool<object>["execute"]>[4]>().toEqualTypeOf<AgentHarnessToolInvocation>();
	expectTypeOf<Parameters<AgentHarnessTool<object>["execute"]>[5]>().toEqualTypeOf<Context>();
	expectTypeOf<AgentTool["replay"]>().toEqualTypeOf<"never" | "safe" | undefined>();
	expectTypeOf<AgentHarnessStreamOptions["deferred"]>().toEqualTypeOf<
		boolean | { window?: "15m" | "1h" | "24h" } | undefined
	>();
	expectTypeOf<EntryProjector>().toEqualTypeOf<
		(entry: CustomEntry, context: Context) => AgentMessage[] | undefined | Promise<AgentMessage[] | undefined>
	>();
	expectTypeOf<NonNullable<AgentHarnessOptions["entryProjectors"]>>().toEqualTypeOf<Record<string, EntryProjector>>();

	const compileTimeFailures = () => {
		// @ts-expect-error callers cannot supply the harness-owned abort signal
		const invalidOptions: AgentHarnessStreamOptions = { signal: new AbortController().signal };
		const invalidDriveOptions: DriveOptions = {
			operationId: "run",
			// @ts-expect-error drive has no wall-clock deadline
			deadline: Date.now(),
		};
		const invalidValueEvent: Extract<HarnessEvent, { type: "value_update" }> = {
			type: "value_update",
			value: "session_name",
			name: "session",
			// @ts-expect-error value events are harness-global and cannot carry a lane
			lane: "main",
		};
		void invalidOptions;
		void invalidDriveOptions;
		void invalidValueEvent;
	};
	expectTypeOf(compileTimeFailures).toBeFunction();
});
