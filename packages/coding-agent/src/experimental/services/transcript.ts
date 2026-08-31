import type { LaneTranscriptSnapshot, LaneWatchEvent } from "@draht/agent-core";
import { type Context, defineService, type ReplicatedState } from "@draht/chord";

export type TranscriptUpdate =
	| { readonly type: "event"; readonly revision: number; readonly event: LaneWatchEvent }
	| { readonly type: "snapshot"; readonly revision: number; readonly snapshot: LaneTranscriptSnapshot };

export interface TranscriptSnapshot {
	readonly revision: number;
	readonly snapshot: LaneTranscriptSnapshot;
}

/** Coherent main-lane observation published as an ordinary Chord service. */
export interface Transcript {
	readonly updates: ReplicatedState<TranscriptUpdate | null>;
	snapshot(context: Context): Promise<TranscriptSnapshot>;
}

export const Transcript = defineService<Transcript>("pi.transcript");
