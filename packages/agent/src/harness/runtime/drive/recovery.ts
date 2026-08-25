import { type AssistantMessageFrame, reduceAssistantMessageFrames } from "@draht/ai";
import type { RunAssistantEffectPendingOperation } from "../../session/types.ts";
import { pendingAssistantFrames } from "../../session/values.ts";
import type { Lane } from "../lane.ts";
import type { Drive, ProcedureResult } from "../types.ts";
import { interruptedAssistantMessage } from "./generation.ts";
import { settleResponse } from "./response.ts";

/** Settle an orphaned assistant request from its bounded committed frame prefix without another provider call. */
export async function recoverAssistantGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: RunAssistantEffectPendingOperation,
): Promise<ProcedureResult> {
	const frames = await lane.continueOperation(
		generation,
		async (_state, _current, _meta, reader) => {
			const result: AssistantMessageFrame[] = [];
			let cursor: { seq: number } | undefined;
			for (;;) {
				const page = await reader.readList(
					pendingAssistantFrames(drive.operationId, generation.responseEntryId),
					{ order: "asc", limit: 1_000, ...(cursor === undefined ? {} : { cursor }) },
					drive.context,
				);
				result.push(...page.map(({ value }) => value));
				if (page.length < 1_000) break;
				cursor = { seq: page[page.length - 1]!.seq };
			}
			return { kind: "return", result };
		},
		drive.context,
	);
	if (frames === undefined) return { kind: "continue" };

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
	return settleResponse(lane, drive, generation, message, { recovery: true });
}
