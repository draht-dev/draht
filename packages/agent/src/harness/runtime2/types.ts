import type { Models, RetryPolicy } from "@draht/ai";
import type { QueueMode } from "../../types.ts";
import type {
	AgentHarnessOptions,
	DriveOutcome,
	HarnessEvent,
	OperationMismatch,
	Resources,
	TerminalOperationOutcome,
} from "../agent-harness.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";
import type { Context } from "../context.ts";
import { createGate, type Gate, type GateControl } from "../execution/effect-gate.ts";
import type { HookRegistry } from "../hooks.ts";
import type {
	CommitResult,
	LaneConfiguration,
	LaneLastResult,
	Operation,
	Session,
	SessionReader,
	Write,
} from "../session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessTool } from "../types.ts";

export class SliceNotImplemented extends Error {
	constructor(operation: string) {
		super(`${operation} is not implemented until its later AgentHarness slice`);
		this.name = "SliceNotImplemented";
	}
}

/** Current process-local harness configuration. */
export interface Config<TContext extends object | undefined> {
	readonly tools: AgentHarnessTool<TContext>[];
	readonly resources: Resources;
	readonly streamOptions: AgentHarnessStreamOptions;
	readonly retryPolicy: RetryPolicy;
	readonly compaction: CompactionSettings;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	readonly toolExecution: "sequential" | "parallel";
	readonly toolContext: AgentHarnessOptions<TContext>["toolContext"];
	readonly systemPrompt: AgentHarnessOptions<TContext>["systemPrompt"];
	readonly toProviderMessages: NonNullable<AgentHarnessOptions<TContext>["toProviderMessages"]>;
	readonly entryProjectors: Readonly<NonNullable<AgentHarnessOptions<TContext>["entryProjectors"]>>;
}

/** Harness-global settings captured by an accepted run. */
export interface AcceptanceConfig {
	readonly resources: Resources;
	readonly compaction: CompactionSettings;
	readonly steeringMode: QueueMode;
	readonly followUpMode: QueueMode;
	readonly toolExecution: "sequential" | "parallel";
}

/** The current durable state owned by one lane. */
export interface LaneState {
	readonly leafId: string | null;
	readonly configuration: LaneConfiguration;
	readonly pendingNextRun: string[];
	readonly lastResult?: LaneLastResult;
	readonly operation: Operation | null;
}

type Synchronous<TResult> = TResult extends PromiseLike<unknown> ? never : TResult;

/** One effect-free decision made on a lane's serialized mutation line. */
export type LaneCommand<TResult> =
	| {
			kind: "commit";
			writes: Write[];
			next: LaneState;
			materialize(commit: CommitResult): Synchronous<TResult>;
			events?(commit: CommitResult): HarnessEvent[];
	  }
	| { kind: "return"; result: TResult }
	| { kind: "reject"; error: Error };

export type CompletionResult = { kind: "ok"; outcome: DriveOutcome } | { kind: "error"; error: unknown };

export interface DriveSupervisor {
	settleCompletion(result: CompletionResult): void;
	retainOwner(): void;
	removeOwner(): void;
}

/** Process-local ownership record for one drive pass. */
export interface ActiveDrive {
	readonly operationId: string;
	readonly completion: Promise<DriveOutcome>;
	readonly gate: Gate;
	readonly control: GateControl;
	finalizedOutcome?: DriveOutcome;
	supervisor?: DriveSupervisor;
}

export interface ActiveDriveHandle {
	readonly active: ActiveDrive;
	settle(outcome: DriveOutcome): void;
	fail(error: unknown): void;
}

export function createActiveDrive(operationId: string): ActiveDriveHandle {
	let settle!: (outcome: DriveOutcome) => void;
	let fail!: (error: unknown) => void;
	const completion = new Promise<DriveOutcome>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	void completion.catch(() => {});
	const { gate, control } = createGate();
	return { active: { operationId, completion, gate, control }, settle, fail };
}

export interface PassPolicy {
	waitForRetry: boolean;
	deferredPermits: number;
}

export interface DriveScope<TContext extends object | undefined> {
	readonly lane: LaneDriveCapabilities<TContext>;
	readonly operationId: string;
	readonly owner: ActiveDrive;
	readonly context: Context;
	readonly pass: PassPolicy;
}

export type StepResult =
	| { kind: "advance" }
	| { kind: "reload" }
	| { kind: "waiting"; outcome: DriveOutcome }
	| { kind: "settled"; outcome: TerminalOperationOutcome }
	| { kind: "lost_ownership" };

/** Package-internal capability surface available to direct drive procedures. */
export interface LaneDriveCapabilities<TContext extends object | undefined> {
	readonly name: string;
	readonly session: Session;
	readonly models: Models;
	readonly hooks: HookRegistry;
	command<TResult>(
		plan: (projection: LaneState, reader: SessionReader) => LaneCommand<TResult> | Promise<LaneCommand<TResult>>,
		context: Context,
	): Promise<TResult>;
	emitBatch(events: readonly HarnessEvent[], context: Context): Promise<void>;
	readConfig(): Config<TContext>;
	ownsDrive(scope: DriveScope<TContext>): boolean;
	mismatch(expected: string, currentOperationId: string | null, last: LaneLastResult | undefined): OperationMismatch;
}
