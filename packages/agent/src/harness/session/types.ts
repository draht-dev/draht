import type { AssistantMessage, StopReason, Usage } from "@draht/ai";
import type { AgentMessage, QueueMode, ThinkingLevel } from "../../types.ts";
import type { BranchPreparation } from "../compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings } from "../compaction/compaction.ts";
import type { Context } from "../context.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";
import type { ListElement, ListReadOptions, ListWrite, StoredValue, Value, ValueList, ValueWrite } from "./values.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type SettledAssistantMessage = AssistantMessage & {
	stopReason: Exclude<StopReason, "pending">;
};

export type EntryType = "message" | "compaction" | "branch_summary" | "custom";

export interface EntryBase {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
	terminate?: true;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	retainedTail: AgentMessage[];
	tokensBefore: number;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string | null;
	summary: string;
	details?: JsonValue;
	usage?: Usage;
	fromHook: boolean;
}

export interface CustomEntry extends EntryBase {
	type: "custom";
	customType: string;
	data?: JsonValue;
}

/** Convert an application-defined custom entry into model context. */
export type EntryProjector = (
	entry: CustomEntry,
	context: Context,
) => AgentMessage[] | undefined | Promise<AgentMessage[] | undefined>;

export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

/** Entry supplied to a transaction before storage assigns sequence and timestamp. */
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry ? Omit<TEntry, "seq" | "timestamp"> : never;

export interface LaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface OperationMeta {
	operationId: string;
	lane: string;
	sourceTipId: string | null;
	startedAt: number;
	intent:
		| { kind: "run"; promptEntryIds: string[] }
		| { kind: "compaction"; customInstructions?: string }
		| {
				kind: "navigation";
				targetId: string | null;
				summarize: boolean;
				label?: string;
				customInstructions?: string;
		  };
}

export type Control =
	| { status: "running" }
	| {
			status: "cancel_requested";
			requestedAt: number;
			drainedSteer: string[];
			drainedFollowUp: string[];
	  };

export interface OperationError {
	code: string;
	message: string;
	details?: JsonValue;
}

export type Continuation =
	| { kind: "need_assistant"; overflowRecoveryUsed: boolean }
	| { kind: "may_finish"; includeFinalAssistant: boolean };

/** Checkpoint payload; the flat leaf literal replaces the old nested phase tag. */
export interface CheckpointData {
	continuation: Continuation;
	triggerEntryId: string;
	thresholdCheckedTriggerEntryId?: string;
	skipInboxOnce?: boolean;
}

export interface Inbox {
	steer: string[];
	followUp: string[];
	writes: string[];
}

export interface NormalizedRetryPolicy {
	maxAttempts: number;
	baseDelayMs: number;
}

export interface GenerationContext {
	stepId: string;
	triggerEntryId: string;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
	overflowRecoveryUsed: boolean;
}

interface ToolCallSource {
	/** Zero-based index in the assistant message's complete content array, not a filtered tool-call ordinal. */
	sourceIndex: number;
	resultEntryId: string;
}

export type ToolCall = ToolCallSource &
	(
		| { status: "planned" }
		| { status: "effect_pending"; replay: "never" | "safe" }
		| { status: "outcome_ready"; terminate: boolean }
		| { status: "completed"; terminate: boolean }
	);

export interface ToolBatch {
	assistantEntryId: string;
	configuration: LaneConfiguration;
	turnId: string;
	calls: ToolCall[];
}

export interface SummaryContext {
	taskId: string;
	resultEntryId: string;
	kind: "compaction" | "branch_summary";
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
	reason?: "manual" | "threshold" | "overflow";
}

/*
 * Durable operation state is one flat union: a single `at` discriminator with one
 * namespaced literal per dispatcher leaf. There is no nested phase/status hierarchy.
 * ToolBatch/ToolCall remain the nested child collection state machine, and
 * cancellation stays orthogonal via `Control`.
 */

/** Every leaf carries the orthogonal cancellation shape. */
export interface Cancellable {
	control: Control;
}

export interface RunSettings {
	compaction: CompactionSettings;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	toolExecution: "sequential" | "parallel";
}

/** Run-wide durable data shared by every `run.*` leaf. */
export interface RunScope extends Cancellable {
	settings: RunSettings;
	inbox: Inbox;
	latestAssistantEntryId: string | null;
}

/** Failure origin. Payload datum only; never used for operation dispatch. */
export type FailureProvenance =
	| { kind: "response"; entryId: string }
	| { kind: "structural"; taskId: string }
	| { kind: "configuration" };

/** Shared backoff data for any `*.retry_wait` leaf. */
export interface RetryWait {
	nextAttempt: number;
	notBefore: number;
	errorMessage: string;
}

/** Assistant generation input shared by every `run.assistant.*` leaf. */
export interface AssistantGenerationScope {
	generationContext: GenerationContext;
}

/**
 * Summary generation input shared by every structural generating leaf. The structural
 * task id lives in `summaryContext.taskId`; only deciding leaves carry it explicitly
 * (via StructuralTask).
 */
export interface SummaryGenerationScope {
	summaryContext: SummaryContext;
}

export interface SummaryGenerationReady extends SummaryGenerationScope {
	nextAttempt: number;
}

export interface SummaryGenerationEffectPending extends SummaryGenerationScope {
	attempt: number;
	request?: { index: number; usageId: string };
	usageIds: string[];
}

export interface SummaryGenerationRetryWait extends SummaryGenerationScope, RetryWait {}

/** Explicit structural task id for deciding leaves that have no SummaryContext yet. */
export interface StructuralTask {
	taskId: string;
}

/** Deferred-suspension durable data shared by both `run.deferred.*` leaves. */
export interface DeferredScope extends RunScope {
	stepId: string;
	sourceEntryId: string;
	poll: number;
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
}

/** In-run compaction data: why it started and which checkpoint resumes after it. */
export interface RunCompactionScope extends RunScope {
	reason: "threshold" | "overflow";
	resumeAfter: CheckpointData;
}

/** Standalone compaction shared data. */
export interface CompactionScope extends Cancellable {
	customInstructions?: string;
}

/** Navigation shared data. */
export interface NavigationScope extends Cancellable {
	label?: string;
}

/** Summarized navigation requires a concrete target entry. */
export interface NavigationSummaryScope extends NavigationScope {
	targetId: string;
	customInstructions?: string;
}

export interface RunStartingOperation extends RunScope {
	at: "run.starting";
}

export interface RunCheckpointOperation extends RunScope, CheckpointData {
	at: "run.checkpoint";
}

export interface RunAssistantReadyOperation extends RunScope, AssistantGenerationScope {
	at: "run.assistant.ready";
	nextAttempt: number;
}

export interface RunAssistantEffectPendingOperation extends RunScope, AssistantGenerationScope {
	at: "run.assistant.effect_pending";
	attempt: number;
	responseEntryId: string;
	usageId: string;
	intendedOutputLimit: number;
	contextWindow: number;
}

export interface RunAssistantRetryWaitOperation extends RunScope, AssistantGenerationScope, RetryWait {
	at: "run.assistant.retry_wait";
}

export interface RunToolsOperation extends RunScope {
	at: "run.tools";
	/** Unchanged child collection state machine. */
	batch: ToolBatch;
}

export interface RunDeferredSuspendedOperation extends DeferredScope {
	at: "run.deferred.suspended";
}

export interface RunDeferredEffectPendingOperation extends DeferredScope {
	at: "run.deferred.effect_pending";
	responseEntryId: string;
	usageId: string;
}

export interface RunCompactionDecidingOperation extends RunCompactionScope, StructuralTask {
	at: "run.compaction.deciding";
}

export interface RunCompactionReadyOperation extends RunCompactionScope, SummaryGenerationReady {
	at: "run.compaction.ready";
}

export interface RunCompactionEffectPendingOperation extends RunCompactionScope, SummaryGenerationEffectPending {
	at: "run.compaction.effect_pending";
}

export interface RunCompactionRetryWaitOperation extends RunCompactionScope, SummaryGenerationRetryWait {
	at: "run.compaction.retry_wait";
}

export interface RunFailureDrainOperation extends RunScope {
	at: "run.failure_drain";
	error: OperationError;
	provenance: FailureProvenance;
}

export interface CompactionDecidingOperation extends CompactionScope, StructuralTask {
	at: "compaction.deciding";
}

export interface CompactionReadyOperation extends CompactionScope, SummaryGenerationReady {
	at: "compaction.ready";
}

export interface CompactionEffectPendingOperation extends CompactionScope, SummaryGenerationEffectPending {
	at: "compaction.effect_pending";
}

export interface CompactionRetryWaitOperation extends CompactionScope, SummaryGenerationRetryWait {
	at: "compaction.retry_wait";
}

export interface NavigationReadyToCommitOperation extends NavigationScope {
	at: "navigation.ready_to_commit";
	/** Unsummarized navigation may target the branch root (null). */
	targetId: string | null;
}

export interface NavigationSummaryDecidingOperation extends NavigationSummaryScope, StructuralTask {
	at: "navigation.summary.deciding";
}

export interface NavigationSummaryReadyOperation extends NavigationSummaryScope, SummaryGenerationReady {
	at: "navigation.summary.ready";
}

export interface NavigationSummaryEffectPendingOperation
	extends NavigationSummaryScope,
		SummaryGenerationEffectPending {
	at: "navigation.summary.effect_pending";
}

export interface NavigationSummaryRetryWaitOperation extends NavigationSummaryScope, SummaryGenerationRetryWait {
	at: "navigation.summary.retry_wait";
}

/** Flat durable operation state: exactly one leaf per dispatcher target. */
export type OperationState =
	| RunStartingOperation
	| RunCheckpointOperation
	| RunAssistantReadyOperation
	| RunAssistantEffectPendingOperation
	| RunAssistantRetryWaitOperation
	| RunToolsOperation
	| RunDeferredSuspendedOperation
	| RunDeferredEffectPendingOperation
	| RunCompactionDecidingOperation
	| RunCompactionReadyOperation
	| RunCompactionEffectPendingOperation
	| RunCompactionRetryWaitOperation
	| RunFailureDrainOperation
	| CompactionDecidingOperation
	| CompactionReadyOperation
	| CompactionEffectPendingOperation
	| CompactionRetryWaitOperation
	| NavigationReadyToCommitOperation
	| NavigationSummaryDecidingOperation
	| NavigationSummaryReadyOperation
	| NavigationSummaryEffectPendingOperation
	| NavigationSummaryRetryWaitOperation;

export type OperationAt = OperationState["at"];

export type RunOperationState = Extract<OperationState, { at: `run.${string}` }>;
export type CompactionOperationState = Extract<OperationState, { at: `compaction.${string}` }>;
export type NavigationOperationState = Extract<OperationState, { at: `navigation.${string}` }>;

export function isRunOperationState(state: OperationState): state is RunOperationState {
	return state.at.startsWith("run.");
}

/** Copy only the run-wide scope fields when constructing a successor leaf. */
export function runScopeOf(state: RunOperationState): RunScope {
	return {
		control: state.control,
		settings: state.settings,
		inbox: state.inbox,
		latestAssistantEntryId: state.latestAssistantEntryId,
	};
}

/** Copy only the checkpoint payload fields from a checkpoint-bearing state. */
export function checkpointDataOf(state: CheckpointData): CheckpointData {
	return {
		continuation: state.continuation,
		triggerEntryId: state.triggerEntryId,
		...(state.thresholdCheckedTriggerEntryId === undefined
			? {}
			: { thresholdCheckedTriggerEntryId: state.thresholdCheckedTriggerEntryId }),
		...(state.skipInboxOnce === undefined ? {} : { skipInboxOnce: state.skipInboxOnce }),
	};
}
export type Operation = { meta: OperationMeta; state: OperationState };

export interface LaneState {
	currentOperationId: string | null;
	pendingNextRun: string[];
}

type FailedLaneLastResult = {
	outcome: "failed";
	error: OperationError;
	runCompletion?: never;
};
type AbortedLaneLastResult = {
	outcome: "aborted";
	error?: never;
	runCompletion?: never;
};
type StructuralLaneLastResultOutcome =
	| FailedLaneLastResult
	| AbortedLaneLastResult
	| { outcome: "declined"; error?: never; runCompletion?: never }
	| { outcome: "completed"; error?: never; runCompletion?: never };

export type LaneLastResult =
	| ({
			operationId: string;
			kind: "run";
			tipId: string;
			finalAssistantEntryId?: string;
	  } & (
			| FailedLaneLastResult
			| AbortedLaneLastResult
			| {
					outcome: "completed";
					error?: never;
					runCompletion: "assistant" | "terminated_tools";
			  }
	  ))
	| ({
			operationId: string;
			kind: "compaction";
			tipId: string;
			finalAssistantEntryId?: never;
	  } & StructuralLaneLastResultOutcome)
	| ({
			operationId: string;
			kind: "navigation";
			tipId: string | null;
			oldTipId: string | null;
			finalAssistantEntryId?: never;
	  } & (
			| FailedLaneLastResult
			| AbortedLaneLastResult
			| {
					outcome: "declined";
					error?: never;
					runCompletion?: never;
					summaryEntryId?: never;
			  }
			| {
					outcome: "completed";
					error?: never;
					runCompletion?: never;
					summaryEntryId?: string;
			  }
	  ));

export type PendingEntry =
	| { type: "message"; payload: AgentMessage }
	| { type: "custom"; customType: string; payload?: JsonValue };

export interface DurableFileOperations {
	read: string[];
	written: string[];
	edited: string[];
}

export type DurableStructuralPreparation =
	| {
			kind: "compaction";
			messagesToSummarize: CompactionPreparation["messagesToSummarize"];
			turnPrefixMessages: CompactionPreparation["turnPrefixMessages"];
			retainedTail: CompactionPreparation["retainedTail"];
			isSplitTurn: boolean;
			tokensBefore: number;
			previousSummary?: string;
			fileOps: DurableFileOperations;
			settings: CompactionSettings;
	  }
	| {
			kind: "branch_summary";
			messages: BranchPreparation["messages"];
			fileOps: DurableFileOperations;
			totalTokens: number;
	  };

export interface UsageRow {
	id: string;
	seq: number;
	usage: Usage;
	entryId?: string;
	adjustment: boolean;
	details?: JsonValue;
}

export interface EntryWrite {
	kind: "entry";
	entry: NewEntry;
}

export interface UsageWrite {
	kind: "usage";
	row: Omit<UsageRow, "seq">;
}

export type Write = EntryWrite | UsageWrite | ValueWrite | ListWrite;

export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
	/** Session totals immediately after this commit was applied. */
	stats: SessionStats;
}

export interface EntryStructure {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
	type: EntryType;
	customType?: string;
}

export interface EntryCursor {
	seq: number;
}

export interface BranchScan {
	start?: string;
	stopAtType?: EntryType;
	stopAtId?: string;
	type?: EntryType;
	customType?: string;
	order?: "newestFirst" | "oldestFirst";
	limit?: number;
	cursor?: EntryCursor;
}

export type StorageBranchScan = BranchScan & { start: string };

export interface EntryScan {
	type?: EntryType;
	customType?: string;
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface UsageScan {
	fromSeq?: number;
	toSeq?: number;
	order?: "asc" | "desc";
	limit?: number;
}

export interface SessionStats {
	messageCount: number;
	usage: Usage;
}

export interface Storage {
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
	scanBranchStructure(query: StorageBranchScan, context: Context): Promise<EntryStructure[]>;
	scanEntries(query: EntryScan, context: Context): Promise<Entry[]>;
	scanUsage(query: UsageScan, context: Context): Promise<UsageRow[]>;
	getStats(context: Context): Promise<SessionStats>;
	close(context: Context): Promise<void>;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	storageVersion: number;
	cwd?: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
}

export interface IdGenerator {
	next(timestampMs?: number): string;
}

export interface EntryQuery {
	type?: EntryType;
	customType?: string;
	order?: "asc" | "desc";
	limit?: number;
	cursor?: EntryCursor;
}

export interface SessionReader {
	getEntries(ids: string[], context: Context): Promise<Map<string, Entry>>;
	getValue<T>(address: Value<T>, context: Context): Promise<StoredValue<T> | undefined>;
	scanValues<T>(prefix: Value<T>, context: Context): Promise<StoredValue<T>[]>;
	readList<T>(
		address: ValueList<T>,
		options: ListReadOptions | undefined,
		context: Context,
	): Promise<ListElement<T>[]>;
	/** Scan a branch from an explicit entry while this reader capability remains valid. */
	scanBranch(query: StorageBranchScan, context: Context): Promise<Entry[]>;
}

/** Exclusive keyless mutation barrier for one Session. */
export interface SessionMutation extends SessionReader {
	/** Exactly zero or one commit attempt. A second attempt rejects. */
	commit(writes: Write[], context: Context): Promise<CommitResult>;
	/** Wait for any commit attempt, invalidate the capability, and release the barrier. */
	end(context: Context): Promise<void>;
}

/** Callback-scoped mutation capability without authority to release its Session barrier. */
export type SessionMutator = Omit<SessionMutation, "end">;

export type SessionMutationCallback<T> = (mutator: SessionMutator, context: Context) => T | Promise<T>;

export interface Branch {
	readonly name: string;
	getTipId(context: Context): Promise<string | null>;
	findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]>;
	findEntry(query: BranchScan | undefined, context: Context): Promise<Entry | undefined>;
	appendMessage(message: AgentMessage, context: Context): Promise<string>;
	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string>;
}

export interface Session<TMetadata extends SessionMetadata = SessionMetadata> extends SessionReader {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator;
	getEntry(id: string, context: Context): Promise<Entry | undefined>;
	getStats(context: Context): Promise<SessionStats>;
	getName(context: Context): Promise<string | undefined>;
	getLabel(targetId: string, context: Context): Promise<string | undefined>;
	findEntries(query: EntryQuery | undefined, context: Context): Promise<Entry[]>;
	findEntry(query: EntryQuery | undefined, context: Context): Promise<Entry | undefined>;
	branch(name: string, context: Context): Promise<Branch | undefined>;
	createBranch(name: string, at: string | null, context: Context): Promise<Branch>;
	beginMutation(context: Context): Promise<SessionMutation>;
	/**
	 * Trusted exclusive callback over the Session mutation line. Calling a public Session writer from
	 * this callback queues it behind the callback; awaiting that nested writer therefore deadlocks.
	 * Use the supplied mutator for the callback's sole commit.
	 */
	mutate<T>(mutation: SessionMutationCallback<T>, context: Context): Promise<T>;
	setValue<T>(address: Value<T>, next: NoInfer<T>, context: Context): Promise<void>;
	deleteValue<T>(address: Value<T>, context: Context): Promise<void>;
	appendList<T>(address: ValueList<T>, element: NoInfer<T>, context: Context): Promise<void>;
	deleteList<T>(address: ValueList<T>, context: Context): Promise<void>;
	setName(name: string | undefined, context: Context): Promise<void>;
	setLabel(targetId: string, label: string | undefined, context: Context): Promise<void>;
	close(context: Context): Promise<void>;
}

export interface SessionCreateOptions {
	id?: string;
	parentSessionId?: string;
}

export type ForkOptions =
	| {
			/**
			 * Copy one path into destination Branch main. A configured source AgentLane
			 * copies its configuration plus fresh idle state; a data-only Branch remains
			 * data-only. Operation/pending/result/usage state is excluded.
			 */
			scope?: "branch";
			/** Entry to fork from. Defaults to the source main Branch's current tip. */
			entryId?: string;
			/**
			 * Whether the fork includes the selected entry or stops at its parent.
			 * Defaults to including the selected entry.
			 */
			position?: "before" | "at";
			/** Optional destination session id. */
			id?: string;
	  }
	| {
			/**
			 * Copy the whole conversation tree and every Branch tip. Each configured
			 * AgentLane copies configuration plus fresh idle state; data-only Branches
			 * remain data-only. Operation/pending/result/usage state is excluded.
			 */
			scope: "tree";
			/** Optional destination session id. */
			id?: string;
	  };

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends { id?: string; parentSessionId?: string } = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions, context: Context): Promise<Session<TMetadata>>;
	open(metadata: TMetadata, context: Context): Promise<Session<TMetadata>>;
	list(options: TListOptions | undefined, context: Context): Promise<TMetadata[]>;
	delete(metadata: TMetadata, context: Context): Promise<void>;
	fork(source: TMetadata, options: ForkOptions, context: Context): Promise<Session<TMetadata>>;
}
