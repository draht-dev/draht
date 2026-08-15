import type { LaneConfiguration, LaneLastResult, Operation } from "../session/types.ts";

/** The current durable state owned by one lane. */
export interface LaneState {
	readonly leafId: string | null;
	readonly configuration: LaneConfiguration;
	readonly pendingNextRun: string[];
	readonly lastResult?: LaneLastResult;
	readonly operation: Operation | null;
}
