import type { AssistantMessageFrame } from "@draht/ai";
import type { AgentToolResult } from "../../types.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { RunState, SessionReader, Write } from "../session/types.ts";
import {
	appendList,
	deleteList,
	deleteValue,
	laneState as laneStateValue,
	operationState as operationStateValue,
	pendingAssistantFrames,
	pendingToolOutput,
	setValue,
} from "../session/values.ts";
import type { Lane } from "./lane.ts";
import type { Drive } from "./types.ts";

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
	stillOwns: (reader: SessionReader) => Promise<boolean>,
): ProgressChannel<T> {
	let sealed = false;
	let latest: Promise<void> = Promise.resolve();
	return {
		write(item) {
			if (sealed) return;
			const write = lane.command(async (projection, reader) => {
				if (!(await stillOwns(reader))) return { kind: "return", result: undefined };
				return {
					kind: "commit",
					writes: [commitWrite(item)],
					next: projection,
					materialize: () => undefined,
				};
			}, drive.context);
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

async function readOwnedRun<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	reader: SessionReader,
): Promise<RunState | undefined> {
	const durableLane = await reader.getValue(laneStateValue(lane.name), drive.context);
	if (durableLane === undefined) {
		throw new SessionInvariantError(`Lane ${JSON.stringify(lane.name)} has no lane state`);
	}
	if (durableLane.value.currentOperationId !== drive.operationId) return undefined;
	const durableState = await reader.getValue(operationStateValue(drive.operationId), drive.context);
	if (durableState === undefined) {
		throw new SessionInvariantError(`Operation ${drive.operationId} has no operation state`);
	}
	if (durableState.value.kind !== "run") {
		throw new SessionInvariantError(`Operation ${drive.operationId} is ${durableState.value.kind}, expected run`);
	}
	if (!lane.isDriveActive(drive)) return undefined;
	return durableState.value;
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
		async (reader) => {
			const state = await readOwnedRun(lane, drive, reader);
			if (state === undefined) return false;
			if (state.phase.kind === "assistant") {
				const generation = state.phase.generation;
				return generation.status === "effect_pending" && generation.responseEntryId === responseEntryId;
			}
			if (state.phase.kind === "deferred") {
				const deferred = state.phase.deferred;
				return deferred.status === "effect_pending" && deferred.responseEntryId === responseEntryId;
			}
			return false;
		},
	);
}

export function openToolProgress<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	invocationId: string,
): ProgressChannel<AgentToolResult<unknown>> {
	const address = pendingToolOutput(drive.operationId, invocationId);
	return openProgress(
		lane,
		drive,
		(snapshot) => setValue(address, snapshot),
		() => deleteValue(address),
		async (reader) => {
			const state = await readOwnedRun(lane, drive, reader);
			if (state?.phase.kind !== "tools") return false;
			return state.phase.batch.calls.some(
				(call) => call.resultEntryId === invocationId && call.status === "effect_pending",
			);
		},
	);
}
