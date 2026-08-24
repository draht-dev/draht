import type { RetryPolicy } from "@draht/ai";
import type { QueueMode } from "../../types.ts";
import type {
	AgentHarnessOptions,
	DriveOptions,
	DriveOutcome,
	HarnessEvent,
	Resources,
	TerminalOperationOutcome,
} from "../agent-harness.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";
import { type Context, withoutAbortSignal } from "../context.ts";
import { createGate, type Gate, type GateControl } from "../execution/effect-gate.ts";
import type { CommitResult, LaneConfiguration, LaneLastResult, Operation, Write } from "../session/types.ts";
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

/** One installed process-local drive pass. */
export class Drive {
	readonly operationId: string;
	readonly completion: Promise<DriveOutcome>;
	readonly gate: Gate;
	readonly context: Context;
	readonly installerSignal: AbortSignal | undefined;
	readonly waitForRetry: boolean;
	deferredPermits: number;
	finalizedOutcome: DriveOutcome | undefined;

	private readonly control: GateControl;
	private readonly resolveCompletion: (outcome: DriveOutcome) => void;
	private readonly rejectCompletion: (error: unknown) => void;
	private settled = false;

	constructor(options: DriveOptions, context: Context) {
		this.operationId = options.operationId;
		this.installerSignal = context.abortSignal;
		this.context = withoutAbortSignal(context);
		this.waitForRetry = options.waitForRetry ?? false;
		this.deferredPermits = options.pollDeferred === true ? 1 : 0;
		let resolveCompletion!: (outcome: DriveOutcome) => void;
		let rejectCompletion!: (error: unknown) => void;
		this.completion = new Promise<DriveOutcome>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		this.resolveCompletion = resolveCompletion;
		this.rejectCompletion = rejectCompletion;
		void this.completion.catch(() => {});
		const { gate, control } = createGate();
		this.gate = gate;
		this.control = control;
	}

	settle(outcome: DriveOutcome): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveCompletion(outcome);
	}

	fail(error: unknown): void {
		if (this.settled) return;
		this.settled = true;
		this.rejectCompletion(error);
	}

	beginAbort(cancellation: Promise<void>): void {
		this.control.beginAbort(cancellation);
	}

	signalAbort(): void {
		this.control.signalAbort();
	}

	closeGate(error: Error): void {
		this.control.close(error);
	}
}

export type LostOwnership = { kind: "lost_ownership" };

export type ProcedureResult =
	| { kind: "continue" }
	| { kind: "waiting"; outcome: DriveOutcome }
	| { kind: "settled"; outcome: TerminalOperationOutcome }
	| LostOwnership;
