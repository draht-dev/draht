import {
	type AgentLane,
	type HarnessEvent,
	type LaneSnapshot,
	type LaneWatchEvent,
	reduceLaneSnapshot,
	type WatchHandle,
} from "@draht/agent-core";
import { cloneJsonValue, defineFacet, type Facet, type MutableReplicatedState } from "@draht/chord";
import { BACKGROUND_CONTEXT } from "@draht/chord/context";
import { Transcript, type Transcript as TranscriptService, type TranscriptUpdate } from "./transcript.ts";

type PendingTranscriptUpdate =
	| Omit<Extract<TranscriptUpdate, { type: "event" }>, "revision">
	| Omit<Extract<TranscriptUpdate, { type: "snapshot" }>, "revision">;

interface TranscriptRuntime {
	readonly service: TranscriptService;
	activate(): Promise<void>;
	dispose(): Promise<void>;
}

export function createTranscriptService(
	lane: AgentLane,
	createState: (initial: TranscriptUpdate | null) => MutableReplicatedState<TranscriptUpdate | null>,
): TranscriptRuntime {
	const updates = createState(null);
	let watch: WatchHandle<LaneSnapshot> | undefined;
	let snapshot: LaneSnapshot | undefined;
	let revision = 0;
	let rebase: Promise<void> | undefined;
	let rebaseError: Error | undefined;

	const publish = (update: PendingTranscriptUpdate, context: Parameters<typeof updates.set>[1]): void => {
		revision += 1;
		updates.set(
			update.type === "event"
				? { type: "event", revision, event: update.event }
				: { type: "snapshot", revision, snapshot: update.snapshot },
			context,
		);
	};

	const scheduleRebase = (context: Parameters<typeof updates.set>[1]): void => {
		if (rebase !== undefined) return;
		const activeWatch = watch;
		if (activeWatch === undefined) return;
		const pending = (async () => {
			const refreshed = await activeWatch.resnapshot(context);
			snapshot = refreshed;
			publish({ type: "snapshot", snapshot: cloneJsonValue(refreshed) }, context);
		})();
		rebase = pending;
		void pending.then(
			() => {
				if (rebase === pending) rebase = undefined;
			},
			(error: unknown) => {
				rebaseError = error instanceof Error ? error : new Error(String(error));
				if (rebase === pending) rebase = undefined;
			},
		);
	};

	const onEvent = (event: HarnessEvent, context: Parameters<typeof updates.set>[1]): void => {
		const forwarded = toLaneWatchEvent(event);
		if (forwarded === undefined) return;
		const current = snapshot;
		if (current === undefined) throw new Error("Transcript service is not active");
		const reduced = reduceLaneSnapshot(current, event);
		if ("rebase" in reduced) scheduleRebase(context);
		else snapshot = reduced;
		publish({ type: "event", event: forwarded }, context);
	};

	return {
		service: {
			updates,
			async snapshot(_context) {
				await rebase;
				if (rebaseError !== undefined) throw rebaseError;
				if (snapshot === undefined) throw new Error("Transcript service is not active");
				return { revision, snapshot: cloneJsonValue(snapshot) };
			},
		},
		async activate() {
			if (watch !== undefined) throw new Error("Transcript service is already active");
			const opened = await lane.watch(BACKGROUND_CONTEXT);
			watch = opened;
			snapshot = opened.snapshot;
			opened.start(onEvent);
		},
		async dispose() {
			let failure: unknown;
			try {
				await rebase;
			} catch (error) {
				failure = error;
			}
			watch?.unsubscribe();
			watch = undefined;
			snapshot = undefined;
			if (failure !== undefined) throw failure;
		},
	};
}

export function createTranscriptServiceFacet(lane: AgentLane): Facet {
	return defineFacet({
		id: "@pi/transcript",
		setup(env) {
			const runtime = createTranscriptService(lane, env.replicatedState);
			env.provide(Transcript, runtime.service);
			env.onActivate(() => runtime.activate());
			env.own(() => runtime.dispose());
		},
	});
}

function toLaneWatchEvent(event: HarnessEvent): LaneWatchEvent | undefined {
	switch (event.type) {
		case "handler_error":
		case "turn_start":
		case "turn_end":
		case "value_update":
		case "lane_created":
			return undefined;
		case "config_update":
			if (event.property !== "model" && event.property !== "thinkingLevel" && event.property !== "activeTools") {
				return undefined;
			}
			return cloneJsonValue(event);
		case "message_update": {
			if (event.message.role !== "assistant") {
				throw new TypeError("Harness message_update did not carry an assistant message");
			}
			const { event: _providerEvent, ...update } = event;
			return cloneJsonValue(update);
		}
		default:
			return cloneJsonValue(event);
	}
}
