import type { AssistantMessage, StopReason, Usage } from "@draht/ai";
import type { TSchema } from "typebox";
import type { AgentMessage, QueueMode, ThinkingLevel } from "../../types.ts";
import type { BranchPreparation } from "../compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactionSettings } from "../compaction/compaction.ts";
import type { AgentHarnessStreamOptions } from "../types.ts";

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
	fromId: string;
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

export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

/** Entry supplied to a transaction before storage assigns sequence and timestamp. */
export type NewEntry<TEntry extends Entry = Entry> = TEntry extends Entry ? Omit<TEntry, "seq" | "timestamp"> : never;

export interface LaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface Operation {
	operationId: string;
	lane: string;
	sourceLeafId: string | null;
	startedAt: number;
	intent:
		| {
				kind: "run";
				promptEntryIds: string[];
				systemPromptOverride?: string;
				resumeData?: Record<string, JsonValue>;
		  }
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

export interface CheckpointPhase {
	kind: "checkpoint";
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

export type Generation =
	| { status: "ready"; context: GenerationContext; nextAttempt: number }
	| {
			status: "effect_pending";
			context: GenerationContext;
			attempt: number;
			responseEntryId: string;
			usageId: string;
			intendedOutputLimit: number;
			contextWindow: number;
	  }
	| {
			status: "retry_wait";
			context: GenerationContext;
			nextAttempt: number;
			notBefore: number;
			errorMessage: string;
	  };

export type ToolCall =
	| { status: "planned"; sourceIndex: number; resultEntryId: string }
	| {
			status: "effect_pending";
			sourceIndex: number;
			resultEntryId: string;
			replay: "never" | "safe";
	  }
	| {
			status: "completed";
			sourceIndex: number;
			resultEntryId: string;
			terminate: boolean;
	  };

export interface ToolBatch {
	assistantEntryId: string;
	configuration: LaneConfiguration;
	turnId: string;
	calls: ToolCall[];
}

export type Deferred =
	| {
			status: "suspended";
			stepId: string;
			sourceEntryId: string;
			poll: number;
			configuration: LaneConfiguration;
			streamOptions: AgentHarnessStreamOptions;
	  }
	| {
			status: "effect_pending";
			stepId: string;
			sourceEntryId: string;
			poll: number;
			responseEntryId: string;
			usageId: string;
			configuration: LaneConfiguration;
			streamOptions: AgentHarnessStreamOptions;
	  };

export interface SummaryContext {
	taskId: string;
	resultEntryId: string;
	kind: "compaction" | "branch_summary";
	configuration: LaneConfiguration;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: NormalizedRetryPolicy;
	reason?: "manual" | "threshold" | "overflow";
}

export type SummaryGeneration =
	| { status: "ready"; context: SummaryContext; nextAttempt: number }
	| {
			status: "effect_pending";
			context: SummaryContext;
			attempt: number;
			request?: { index: number; usageId: string };
			usageIds: string[];
	  }
	| {
			status: "retry_wait";
			context: SummaryContext;
			nextAttempt: number;
			notBefore: number;
			errorMessage: string;
	  };

export type StructuralDecision = { taskId: string } & (
	| { status: "deciding" }
	| { status: "generating"; generation: SummaryGeneration }
);

export type RunPhase =
	| CheckpointPhase
	| { kind: "assistant"; generation: Generation }
	| { kind: "tools"; batch: ToolBatch }
	| {
			kind: "compaction";
			reason: "threshold" | "overflow";
			structural: StructuralDecision;
			resumeAfter: CheckpointPhase;
	  }
	| { kind: "deferred"; deferred: Deferred }
	| {
			kind: "failure_drain";
			error: OperationError;
			provenance: { kind: "response"; entryId: string } | { kind: "structural"; taskId: string };
	  };

export interface RunState {
	kind: "run";
	control: Control;
	settings: {
		compaction: CompactionSettings;
		steeringMode: QueueMode;
		followUpMode: QueueMode;
		toolExecution: "sequential" | "parallel";
	};
	phase: RunPhase;
	inbox: Inbox;
	latestAssistantEntryId: string | null;
}

export interface CompactionState {
	kind: "compaction";
	control: Control;
	customInstructions?: string;
	structural: StructuralDecision;
}

export type NavigationState =
	| {
			kind: "navigation";
			control: Control;
			targetId: string | null;
			label?: string;
			summarize: false;
			phase: { kind: "ready_to_commit" };
	  }
	| {
			kind: "navigation";
			control: Control;
			targetId: string;
			label?: string;
			customInstructions?: string;
			summarize: true;
			phase: { kind: "summary"; structural: StructuralDecision };
	  };

export type OperationState = RunState | CompactionState | NavigationState;

export interface LaneState {
	currentOperationId: string | null;
	pendingNextRun: string[];
}

export type LaneLastResult = {
	operationId: string;
	kind: "run" | "compaction" | "navigation";
	leafId: string | null;
	finalAssistantEntryId?: string;
} & (
	| { outcome: "failed"; error: OperationError; runCompletion?: never }
	| {
			outcome: "completed";
			error?: never;
			runCompletion?: "assistant" | "terminated_tools";
	  }
	| { outcome: "declined" | "aborted"; error?: never; runCompletion?: never }
);

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

export interface RegisterValues {
	"lane.leaf": string | null;
	"lane.config": LaneConfiguration;
	"lane.state": LaneState;
	"lane.lastResult": LaneLastResult;
	"op.meta": Operation;
	"op.state": OperationState;
	"op.tool_args": Record<string, JsonValue>;
	"op.preparation": DurableStructuralPreparation;
	"pending.entry": PendingEntry;
	"fact.name": string;
	"fact.label": string;
	"fact.custom": JsonValue;
}

export type RegisterNamespace = keyof RegisterValues;

export interface Register<TNamespace extends RegisterNamespace = RegisterNamespace> {
	namespace: TNamespace;
	key: string;
	value: RegisterValues[TNamespace];
	seq: number;
}

export interface UsageRow {
	id: string;
	seq: number;
	usage: Usage;
	entryId?: string;
	adjustment: boolean;
	details?: JsonValue;
}

export type RegisterSetWrite = {
	[TNamespace in RegisterNamespace]: {
		kind: "register";
		op: "set";
		namespace: TNamespace;
		key: string;
		value: RegisterValues[TNamespace];
	};
}[RegisterNamespace];

export type Write =
	| { kind: "entry"; entry: NewEntry }
	| { kind: "usage"; row: Omit<UsageRow, "seq"> }
	| RegisterSetWrite
	| { kind: "register"; op: "delete"; namespace: RegisterNamespace; key: string };

export interface Transaction {
	writes: Write[];
}

export interface CommitResult {
	firstSeq: number;
	seqs: number[];
	timestamp: number;
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
	commit(transaction: Transaction): Promise<CommitResult>;
	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>>;
	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined>;
	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]>;
	scanBranch(query: StorageBranchScan): Promise<Entry[]>;
	scanBranchStructure(query: StorageBranchScan): Promise<EntryStructure[]>;
	scanEntries(query: EntryScan): Promise<Entry[]>;
	scanUsage(query: UsageScan): Promise<UsageRow[]>;
	getStats(): Promise<SessionStats>;
	close(): Promise<void>;
}

export interface SessionMetadata {
	id: string;
	createdAt: number;
	storageVersion: number;
	cwd?: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
}

export interface SessionCodecOptions {
	customMessageSchemas?: Record<string, TSchema>;
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

export interface SessionTree {
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<Entry | undefined>;
	getStats(): Promise<SessionStats>;
	getName(): Promise<string | undefined>;
	setName(name: string | undefined): Promise<void>;
	getLabel(targetId: string): Promise<string | undefined>;
	setLabel(targetId: string, label: string | undefined): Promise<void>;
	getCustomFact(key: string): Promise<JsonValue | undefined>;
	setCustomFact(key: string, value: JsonValue | undefined): Promise<void>;
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	findEntry(query?: EntryQuery): Promise<Entry | undefined>;
	findEntriesOnBranch(query?: BranchScan): Promise<Entry[]>;
	findEntryOnBranch(query?: BranchScan): Promise<Entry | undefined>;
	appendMessage(message: AgentMessage): Promise<string>;
	appendCustomEntry(customType: string, data?: JsonValue): Promise<string>;
}

export interface Session<TMetadata extends SessionMetadata = SessionMetadata> extends SessionTree {
	readonly metadata: TMetadata;
	readonly idGenerator: IdGenerator;
	view(lane: string): SessionTree;
	createLane(name: string, at: string | null, configuration: LaneConfiguration): Promise<SessionTree>;
	commit(transaction: Transaction): Promise<CommitResult>;
	getEntries(ids: string[]): Promise<ReadonlyMap<string, Entry>>;
	getRegister<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		key: string,
	): Promise<Register<TNamespace> | undefined>;
	listRegisters<TNamespace extends RegisterNamespace>(
		namespace: TNamespace,
		keyPrefix?: string,
	): Promise<Register<TNamespace>[]>;
	close(): Promise<void>;
}

export interface SessionCreateOptions {
	id?: string;
	parentSessionId?: string;
}

export type ForkOptions = { scope?: "branch"; entryId?: string; position?: "before" | "at" } | { scope: "tree" };

export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends { id?: string; parentSessionId?: string } = SessionCreateOptions,
	TListOptions = void,
> {
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	list(options?: TListOptions): Promise<TMetadata[]>;
	delete(metadata: TMetadata): Promise<void>;
	fork(source: TMetadata, options: ForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}
