import type { AssistantMessageFrame } from "@draht/ai";
import type { AgentToolResult } from "../../types.ts";
import type { Write } from "../session/types.ts";
import {
	appendList,
	deleteList,
	deleteValue,
	pendingAssistantFrames,
	pendingToolOutput,
	setValue,
} from "../session/values.ts";
import type { Lane } from "./lane.ts";
import type { Drive, LaneState } from "./types.ts";

export interface ProgressChannel<T> {
	write(item: T): void;
	seal(): void;
	drain(): Promise<void>;
	clearWrite(): Write;
}

function openProgress<TContext extends object | undefined, T>(
	lane: Lane<TContext>,
	drive: Drive,
	commitWrite: (item: T) => Write,
	clear: () => Write,
	stillOwns: (state: LaneState) => boolean,
): ProgressChannel<T> {
	let sealed = false;
	let latest: Promise<void> = Promise.resolve();
	return {
		write(item) {
			if (sealed) return;
			const write = lane
				.commandDriveOwned(
					drive,
					(projection) => {
						if (!stillOwns(projection)) return { kind: "return", result: undefined };
						return {
							kind: "commit",
							writes: [commitWrite(item)],
							next: projection,
							materialize: () => undefined,
						};
					},
					drive.context,
				)
				.then(() => undefined);
			latest = write;
			void write.catch(() => {});
		},
		seal() {
			sealed = true;
		},
		async drain() {
			await latest;
		},
		clearWrite: clear,
	};
}

export function openFrameProgress<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	responseEntryId: string,
): ProgressChannel<AssistantMessageFrame> {
	const address = pendingAssistantFrames(drive.operationId, responseEntryId);
	return openProgress(
		lane,
		drive,
		(frame) => appendList(address, frame),
		() => deleteList(address),
		(state) => {
			const operation = state.operation;
			if (operation?.meta.operationId !== drive.operationId || operation.state.kind !== "run") return false;
			const run = operation.state;
			if (run.phase.kind === "assistant") {
				const generation = run.phase.generation;
				return generation.status === "effect_pending" && generation.responseEntryId === responseEntryId;
			}
			if (run.phase.kind === "deferred") {
				const deferred = run.phase.deferred;
				return deferred.status === "effect_pending" && deferred.responseEntryId === responseEntryId;
			}
			return false;
		},
	);
}

export function openToolProgress<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	turnId: string,
	sourceIndex: number,
	invocationId: string,
): ProgressChannel<AgentToolResult<unknown>> {
	const address = pendingToolOutput(drive.operationId, invocationId);
	return openProgress(
		lane,
		drive,
		(snapshot) => setValue(address, snapshot),
		() => deleteValue(address),
		(state) => {
			const operation = state.operation;
			if (
				operation?.meta.operationId !== drive.operationId ||
				operation.state.kind !== "run" ||
				operation.state.phase.kind !== "tools"
			) {
				return false;
			}
			const batch = operation.state.phase.batch;
			return (
				batch.turnId === turnId &&
				batch.calls.some(
					(call) =>
						call.sourceIndex === sourceIndex &&
						call.resultEntryId === invocationId &&
						call.status === "effect_pending",
				)
			);
		},
	);
}
