import type { DeferredHandle, Message, Models, RetryPolicy, ToolResultMessage, Usage } from "@draht/ai";
import type { TelemetryContext } from "@draht/telemetry";
import type { AgentMessage, QueueMode } from "../../types.ts";
import type {
	AgentHarnessOptions,
	Closed,
	DriveResult,
	HarnessClosed,
	HarnessFault,
	Resources,
	SuspendedOperation,
} from "../agent-harness.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";
import type { HarnessEventBus } from "../events.ts";
import type { BreakpointBarrier } from "../execution/breakpoint.ts";
import type { OperationEffectGate } from "../execution/effect-gate.ts";
import type { ClearedToolCall, ExecutedToolCall, FinalizedToolCall } from "../execution/tools.ts";
import type { HookRegistry } from "../hooks.ts";
import type {
	Entry,
	EntryProjector,
	OperationError,
	RunState,
	Session,
	SessionTree,
	SettledAssistantMessage,
	UsageRow,
} from "../session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessTool, AgentHarnessToolContextSource } from "../types.ts";

export class RuntimeSliceNotImplemented extends Error {
	constructor(operation: string) {
		super(`${operation} is not implemented until its later AgentHarness runtime slice`);
		this.name = "RuntimeSliceNotImplemented";
	}
}

export interface RuntimeSettings<TContext extends object | undefined> {
	tools: AgentHarnessTool<TContext>[];
	resources: Resources;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: RetryPolicy;
	compaction: CompactionSettings;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	toolExecution: "sequential" | "parallel";
}

export interface DeferredValue<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

export interface ActiveOperation {
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	completion: Promise<DriveResult>;
	resolve: (result: DriveResult) => void;
	reject: (error: unknown) => void;
	effectGate: OperationEffectGate;
	task?: Promise<void>;
}

export interface AdmissionReservation {
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	completion: Promise<void>;
	resolve(): void;
}

export type DriveArbitration =
	| { kind: "result"; result: DriveResult }
	| { kind: "join"; completion: Promise<DriveResult> }
	| { kind: "installed"; active: ActiveOperation };

export interface NormalizedRunRequest {
	operationId: string;
	startedAt: number;
	messages: AgentMessage[];
	resources: Resources;
}

export interface AcceptancePublication {
	admission: { operationId: string; kind: "run"; startedAt: number };
	entries: Entry[];
	capturedNextRun: boolean;
}

export type AssistantSettlementOutcome =
	| { kind: "completed" }
	| { kind: "aborted" }
	| { kind: "deferred"; handle: DeferredHandle }
	| { kind: "tools"; genuineLength: boolean }
	| { kind: "retry"; nextAttempt: number; delayMs: number; notBefore: number; errorMessage: string }
	| { kind: "failed"; error: OperationError };

export interface AssistantSettlementDecision {
	message: SettledAssistantMessage;
	phase: RunState["phase"];
	outcome: AssistantSettlementOutcome;
}

export interface CommittedAssistantSettlement {
	entry: Entry;
	row: { id: string; seq: number; usage: Usage; entryId: string; adjustment: false };
	totals: Usage;
	message: SettledAssistantMessage;
	outcome: AssistantSettlementOutcome;
}

export type AssistantExecutionResult =
	| { kind: "advanced" }
	| { kind: "yielded" }
	| { kind: "missing_identities"; missing: { tools: string[]; models: string[] } };

export type ToolBatchExecutionResult = AssistantExecutionResult;

export type StartedToolCall =
	| {
			kind: "immediate";
			sourceIndex: number;
			finalized: FinalizedToolCall;
			recovery: boolean;
			durableStatus: "planned" | "effect_pending";
	  }
	| {
			kind: "running";
			sourceIndex: number;
			cleared: ClearedToolCall;
			execution: Promise<ExecutedToolCall>;
			recovery: boolean;
	  };

export interface CommittedToolSettlement {
	entry: Entry;
	message: ToolResultMessage;
	row?: UsageRow;
	totals?: Usage;
	batchCompleted: boolean;
}

export interface RuntimeLane {
	readonly name: string;
	readonly session: SessionTree;
	readonly breakpoint: BreakpointBarrier;
}

export interface RuntimeProcedureContext<TContext extends object | undefined> {
	readonly sessionStorage: Session;
	readonly models: Models;
	readonly hooks: HookRegistry;
	readonly events: HarnessEventBus;
	readonly telemetryContext: TelemetryContext;
	readonly toolContext: AgentHarnessToolContextSource<TContext> | undefined;
	readonly systemPromptSource: AgentHarnessOptions<TContext>["systemPrompt"];
	readonly toProviderMessages: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	readonly entryProjectors: Readonly<Record<string, EntryProjector>>;
	readonly attachedOperationIds: Set<string>;
	readonly resumedOperationIds: Set<string>;
	readonly resumeEventOperationIds: Set<string>;
	readonly restoredSuspensions: Map<string, SuspendedOperation>;
	readSettings<Result>(read: (settings: RuntimeSettings<TContext>) => Result): Promise<Result>;
	snapshotSettings(): Promise<RuntimeSettings<TContext>>;
	assertOpen(): void;
	isOpen(): boolean;
	fault(cause: unknown): HarnessFault | HarnessClosed;
}

export interface OperationTaskContext<TContext extends object | undefined> extends RuntimeProcedureContext<TContext> {
	readonly activeOperations: Map<string, ActiveOperation>;
	readonly admissionReservations: Map<string, AdmissionReservation>;
	readonly state: "open" | "faulted" | "closing" | "closed";
	resultClosedError(): Closed | undefined;
}

export interface LaneRuntimeContext<TContext extends object | undefined> extends OperationTaskContext<TContext> {
	readonly driveMode: "automatic" | "manual";
	closedError(): Closed;
}

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
