import { type AssistantMessageFrame, reduceAssistantMessageFrames } from "@draht/ai";
import { SessionInvariantError } from "../../session/session.ts";
import type { Generation, RunState } from "../../session/types.ts";
import { pendingAssistantFrames } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { interruptedAssistantMessage, settleAssistant } from "./generation.ts";

/** Settle an orphaned assistant request from its bounded committed frame prefix without another provider call. */
export async function recoverAssistantGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	run: RunState,
	generation: Extract<Generation, { status: "effect_pending" }>,
): Promise<ProcedureResult> {
	if (
		run.phase.kind !== "assistant" ||
		run.phase.generation.status !== "effect_pending" ||
		run.phase.generation.responseEntryId !== generation.responseEntryId
	) {
		throw new SessionInvariantError("Assistant recovery requires its current effect-pending generation");
	}
	const read = await lane.commandDriveOwned<{ kind: "frames"; frames: AssistantMessageFrame[] }>(
		drive,
		async (state, reader) => {
			const operation = state.operation;
			if (
				operation === null ||
				operation.state.kind !== "run" ||
				operation.state.phase.kind !== "assistant" ||
				operation.state.phase.generation.status !== "effect_pending" ||
				operation.state.phase.generation.responseEntryId !== generation.responseEntryId
			) {
				throw new SessionInvariantError("Assistant recovery lost its effect-pending generation");
			}
			const frames: AssistantMessageFrame[] = [];
			let cursor: { seq: number } | undefined;
			for (;;) {
				const page = await reader.readList(
					pendingAssistantFrames(drive.operationId, generation.responseEntryId),
					{ order: "asc", limit: 1_000, ...(cursor === undefined ? {} : { cursor }) },
					drive.context,
				);
				frames.push(...page.map(({ value }) => value));
				if (page.length < 1_000) break;
				cursor = { seq: page[page.length - 1]!.seq };
			}
			return { kind: "return", result: { kind: "frames", frames } as const };
		},
		drive.context,
	);
	if (read.kind === "lost_ownership") return read;
	const frames = read.frames;
	const current = lane.state.operation;
	if (current?.meta.operationId !== drive.operationId || !lane.isDriveActive(drive)) {
		return { kind: "lost_ownership" };
	}
	if (
		current.state.kind !== "run" ||
		current.state.phase.kind !== "assistant" ||
		current.state.phase.generation.status !== "effect_pending" ||
		current.state.phase.generation.responseEntryId !== generation.responseEntryId
	) {
		throw new SessionInvariantError("Assistant recovery lost its effect-pending generation");
	}
	const message = interruptedAssistantMessage(generation, reduceAssistantMessageFrames(frames));
	await lane.emitBatch(
		[
			{
				type: "message_start",
				lane: lane.name,
				runId: drive.operationId,
				message,
				recovery: true,
			},
			{
				type: "message_end",
				lane: lane.name,
				runId: drive.operationId,
				message,
				entryId: generation.responseEntryId,
				recovery: true,
			},
		],
		drive.context,
	);
	return settleAssistant(
		lane,
		drive,
		{
			responseEntryId: generation.responseEntryId,
			usageId: generation.usageId,
			stepId: generation.context.stepId,
		},
		message,
		{ recovery: true },
	);
}
