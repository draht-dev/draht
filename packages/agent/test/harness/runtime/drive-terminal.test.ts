import { fauxAssistantMessage } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { hydrateTerminalOutcome, operationCleanupWrites } from "../../../src/harness/runtime/drive/terminal.ts";
import { insertEntry } from "../../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	CompactionDecidingOperation,
	LaneConfiguration,
	LaneLastResult,
	NavigationReadyToCommitOperation,
	OperationMeta,
	OperationState,
	RunAssistantEffectPendingOperation,
	RunScope,
	RunToolsOperation,
	Session,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";

const sessions: Session[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function runScope(): RunScope {
	return {
		control: { status: "running" },
		settings: {
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 2_000 },
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

function meta(operationId: string, state: OperationState): OperationMeta {
	const intent: OperationMeta["intent"] =
		state.at === "compaction.deciding"
			? { kind: "compaction" }
			: state.at === "navigation.ready_to_commit"
				? { kind: "navigation", targetId: state.targetId, summarize: false }
				: { kind: "run", promptEntryIds: [] };
	return { operationId, lane: "main", sourceTipId: null, startedAt: 1, intent };
}

async function createSession(): Promise<{ session: Session; storage: MemoryStorage }> {
	const storage = new MemoryStorage();
	const session = new StorageBackedSession(
		{ id: `terminal-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	return { session, storage };
}

async function commit(session: Session, writes: Write[]): Promise<void> {
	await session.mutate(async (mutator) => {
		await mutator.commit(writes, BACKGROUND_CONTEXT);
	}, BACKGROUND_CONTEXT);
}

function address(write: Write): string {
	if (write.kind === "entry") return `entry:${write.entry.id}`;
	if (write.kind === "usage") return `usage:${write.row.id}`;
	return `${write.kind}:${write.op}:${write.namespace}:${write.key}`;
}

async function seedLeftovers(session: Session, operationId: string, state: OperationState): Promise<void> {
	await commit(session, [
		storedValues.setValue(storedValues.operationMeta(operationId), meta(operationId, state)),
		storedValues.setValue(storedValues.operationState(operationId), state),
		storedValues.setValue(storedValues.operationToolArgs(operationId, "step", 0), { value: true }),
		storedValues.setValue(storedValues.operationToolMemo(operationId, "invocation", "memo"), { value: true }),
		storedValues.setValue(storedValues.operationPreparation(operationId, "task"), {
			kind: "branch_summary",
			messages: [],
			fileOps: { read: [], written: [], edited: [] },
			totalTokens: 0,
		}),
		storedValues.setValue(storedValues.pendingToolOutput(operationId, "invocation"), {
			content: [{ type: "text", text: "partial" }],
			details: {},
		}),
	]);
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime terminal cleanup mechanics", () => {
	it("deletes every run-owned family and exact live frame list but preserves pendingNextRun", async () => {
		const { session } = await createSession();
		const operationId = "run";
		const responseEntryId = "response";
		const state: RunAssistantEffectPendingOperation = {
			...runScope(),
			at: "run.assistant.effect_pending",
			generationContext: {
				stepId: "step",
				triggerEntryId: "trigger",
				configuration,
				streamOptions: {},
				retryPolicy: { maxAttempts: 2, baseDelayMs: 1 },
				overflowRecoveryUsed: false,
			},
			attempt: 1,
			responseEntryId,
			usageId: "usage",
			intendedOutputLimit: 100,
			contextWindow: 1_000,
			control: {
				status: "cancel_requested",
				requestedAt: 2,
				drainedSteer: ["drained-steer"],
				drainedFollowUp: ["drained-follow"],
			},
			inbox: { steer: ["steer"], followUp: ["follow"], writes: ["write"] },
		};
		await seedLeftovers(session, operationId, state);
		await commit(session, [
			...["steer", "follow", "write", "drained-steer", "drained-follow", "next"].map((id) =>
				storedValues.setValue(storedValues.pendingEntry(id), {
					type: "custom",
					customType: "test",
					payload: { id },
				}),
			),
			storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial",
			}),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: operationId,
				pendingNextRun: ["next"],
			}),
		]);

		const writes = await operationCleanupWrites(session, operationId, state, BACKGROUND_CONTEXT);

		expect(writes.map(address)).toEqual([
			"value:delete:pi.op.meta:run",
			"value:delete:pi.op.state:run",
			"value:delete:pi.op.tool_args:run:step:0",
			"value:delete:pi.op.tool_memo:run:invocation:memo",
			"value:delete:pi.op.preparation:run:task",
			"value:delete:pi.pending.tool_output:run:invocation",
			"list:delete:pi.pending.assistant_frame:run:response",
			"value:delete:pi.pending.entry:steer",
			"value:delete:pi.pending.entry:follow",
			"value:delete:pi.pending.entry:write",
			"value:delete:pi.pending.entry:drained-steer",
			"value:delete:pi.pending.entry:drained-follow",
		]);
		await commit(session, writes);
		expect(await session.getValue(storedValues.pendingEntry("next"), BACKGROUND_CONTEXT)).toBeDefined();
		expect(
			(await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value.pendingNextRun,
		).toEqual(["next"]);
		expect(
			await session.readList(
				storedValues.pendingAssistantFrames(operationId, responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
	});

	it("deletes staged tool outcomes and leaves completed results alone", async () => {
		const { session } = await createSession();
		const operationId = "tools";
		const state: RunToolsOperation = {
			...runScope(),
			at: "run.tools",
			batch: {
				assistantEntryId: "assistant",
				configuration,
				turnId: "step",
				calls: [
					{ status: "outcome_ready", sourceIndex: 0, resultEntryId: "staged", terminate: false },
					{ status: "completed", sourceIndex: 1, resultEntryId: "placed", terminate: false },
				],
			},
		};
		await seedLeftovers(session, operationId, state);
		await commit(session, [
			storedValues.setValue(storedValues.pendingEntry("staged"), {
				type: "message",
				payload: {
					role: "toolResult",
					toolCallId: "call",
					toolName: "tool",
					content: [],
					isError: false,
					timestamp: 1,
				},
			}),
		]);

		const writes = await operationCleanupWrites(session, operationId, state, BACKGROUND_CONTEXT);

		expect(writes.map(address)).toContain("value:delete:pi.pending.entry:staged");
		expect(writes.map(address)).not.toContain("value:delete:pi.pending.entry:placed");
	});

	it.each([
		[
			"compaction",
			{
				at: "compaction.deciding",
				control: { status: "running" },
				taskId: "task",
			} satisfies CompactionDecidingOperation,
		],
		[
			"navigation",
			{
				at: "navigation.ready_to_commit",
				control: { status: "running" },
				targetId: null,
			} satisfies NavigationReadyToCommitOperation,
		],
	] as const)("defensively deletes leftover %s operation families", async (operationId, state) => {
		const { session } = await createSession();
		await seedLeftovers(session, operationId, state);

		const writes = await operationCleanupWrites(session, operationId, state, BACKGROUND_CONTEXT);

		expect(writes.map(address)).toEqual([
			`value:delete:pi.op.meta:${operationId}`,
			`value:delete:pi.op.state:${operationId}`,
			`value:delete:pi.op.tool_args:${operationId}:step:0`,
			`value:delete:pi.op.tool_memo:${operationId}:invocation:memo`,
			`value:delete:pi.op.preparation:${operationId}:task`,
			`value:delete:pi.pending.tool_output:${operationId}:invocation`,
		]);
	});
});

describe("runtime terminal outcome hydration", () => {
	it("hydrates run, compaction, and navigation outcomes from only their direct entry references", async () => {
		const { session, storage } = await createSession();
		const assistant = fauxAssistantMessage([{ type: "text", text: "done" }]);
		await commit(session, [
			insertEntry({ id: "assistant", parentId: null, type: "message", message: assistant }),
			insertEntry({
				id: "compaction",
				parentId: null,
				type: "compaction",
				summary: "summary",
				retainedTail: [],
				tokensBefore: 10,
				fromHook: false,
			}),
			insertEntry({
				id: "summary",
				parentId: null,
				type: "branch_summary",
				fromId: "old",
				summary: "branch",
				fromHook: false,
			}),
		]);
		const getEntries = vi.spyOn(storage, "getEntries");
		const results: LaneLastResult[] = [
			{
				operationId: "run",
				kind: "run",
				outcome: "completed",
				tipId: "assistant",
				finalAssistantEntryId: "assistant",
				runCompletion: "assistant",
			},
			{ operationId: "compact", kind: "compaction", outcome: "completed", tipId: "compaction" },
			{
				operationId: "navigate",
				kind: "navigation",
				outcome: "completed",
				oldTipId: "old",
				tipId: "summary",
				summaryEntryId: "summary",
			},
		];

		const outcomes = await Promise.all(
			results.map((result) => hydrateTerminalOutcome(session, result, BACKGROUND_CONTEXT)),
		);

		expect(outcomes).toEqual([
			{
				operation: "run",
				runId: "run",
				kind: "completed",
				tipId: "assistant",
				finalEntryId: "assistant",
				finalMessage: assistant,
			},
			{
				operation: "compaction",
				runId: "compact",
				kind: "completed",
				tipId: "compaction",
				entry: expect.objectContaining({ id: "compaction", type: "compaction", summary: "summary" }),
			},
			{
				operation: "navigation",
				runId: "navigate",
				kind: "completed",
				oldTipId: "old",
				newTipId: "summary",
				summaryEntry: expect.objectContaining({ id: "summary", type: "branch_summary", summary: "branch" }),
			},
		]);
		expect(getEntries.mock.calls.map(([ids]) => ids)).toEqual([["assistant"], ["compaction"], ["summary"]]);
	});

	it("hydrates entry-free outcomes without storage reads", async () => {
		const { session, storage } = await createSession();
		const getEntries = vi.spyOn(storage, "getEntries");
		const results: LaneLastResult[] = [
			{
				operationId: "run",
				kind: "run",
				outcome: "completed",
				tipId: "tool-result",
				runCompletion: "terminated_tools",
			},
			{ operationId: "compact", kind: "compaction", outcome: "declined", tipId: "leaf" },
			{
				operationId: "navigate",
				kind: "navigation",
				outcome: "aborted",
				oldTipId: "old",
				tipId: "old",
			},
		];

		const outcomes = await Promise.all(
			results.map((result) => hydrateTerminalOutcome(session, result, BACKGROUND_CONTEXT)),
		);

		expect(outcomes).toEqual([
			{ operation: "run", runId: "run", kind: "completed", tipId: "tool-result" },
			{ operation: "compaction", runId: "compact", kind: "declined", tipId: "leaf" },
			{ operation: "navigation", runId: "navigate", kind: "aborted", tipId: "old" },
		]);
		expect(getEntries).not.toHaveBeenCalled();
	});
});
