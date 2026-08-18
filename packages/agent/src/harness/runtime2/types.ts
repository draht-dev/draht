import type { RetryPolicy } from "@draht/ai";
import type { QueueMode } from "../../types.ts";
import type { AgentHarnessOptions, Resources } from "../agent-harness.ts";
import type { CompactionSettings } from "../compaction/compaction.ts";
import type { LaneConfiguration, LaneLastResult, Operation } from "../session/types.ts";
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
	readonly drive: NonNullable<AgentHarnessOptions<TContext>["drive"]>;
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
