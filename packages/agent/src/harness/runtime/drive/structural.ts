import {
	type Api,
	type AssistantMessage,
	isRetryableAssistantError,
	type Model,
	type SimpleStreamOptions,
} from "@draht/ai";
import type { HarnessEvent, TerminalOperationOutcome } from "../../agent-harness.ts";
import type { BranchPreparation, BranchSummaryResult } from "../../compaction/branch-summarization.ts";
import { generateBranchSummaryWithRequest } from "../../compaction/branch-summarization.ts";
import type { CompactionPreparation, CompactResult, SummaryRequest } from "../../compaction/compaction.ts";
import { compactWithRequest, prepareCompaction, shouldCompact } from "../../compaction/compaction.ts";
import { type Context, withAbortSignal } from "../../context.ts";
import { AbortRequested } from "../../execution/effect-gate.ts";
import { applyStreamOptionsPatch } from "../../hooks.ts";
import { insertEntry, insertUsage } from "../../session/commit.ts";
import { SessionInvariantError } from "../../session/session.ts";
import {
	type BranchSummaryEntry,
	type CommitResult,
	type CompactionDecidingOperation,
	type CompactionEffectPendingOperation,
	type CompactionEntry,
	type CompactionReadyOperation,
	type CompactionRetryWaitOperation,
	type DurableFileOperations,
	type DurableStructuralPreparation,
	type JsonValue,
	type LaneConfiguration,
	type LaneLastResult,
	type NavigationReadyToCommitOperation,
	type NavigationSummaryDecidingOperation,
	type NavigationSummaryEffectPendingOperation,
	type NavigationSummaryReadyOperation,
	type NavigationSummaryRetryWaitOperation,
	type NewEntry,
	type NormalizedRetryPolicy,
	type OperationError,
	type RunAssistantEffectPendingOperation,
	type RunCheckpointOperation,
	type RunCompactionDecidingOperation,
	type RunCompactionEffectPendingOperation,
	type RunCompactionReadyOperation,
	type RunCompactionRetryWaitOperation,
	type RunFailureDrainOperation,
	runScopeOf,
	type SummaryContext,
	type UsageRow,
	type Write,
} from "../../session/types.ts";
import { branchTip, entryLabel, operationPreparation, setValue } from "../../session/values.ts";
import type { AgentHarnessStreamOptions } from "../../types.ts";
import type { Lane } from "../lane.ts";
import { committedEntryEvents, readBoundedEntries } from "../transcript.ts";
import type { ContinueOperationResult, Drive, ProcedureResult } from "../types.ts";
import { retryDelay, retryNotBefore, waitUntil } from "./retry.ts";
import { operationCleanupWrites } from "./terminal.ts";

type StructuralDeciding =
	| RunCompactionDecidingOperation
	| CompactionDecidingOperation
	| NavigationSummaryDecidingOperation;
type StructuralReady = RunCompactionReadyOperation | CompactionReadyOperation | NavigationSummaryReadyOperation;
type StructuralEffectPending =
	| RunCompactionEffectPendingOperation
	| CompactionEffectPendingOperation
	| NavigationSummaryEffectPendingOperation;
type StructuralRetryWait =
	| RunCompactionRetryWaitOperation
	| CompactionRetryWaitOperation
	| NavigationSummaryRetryWaitOperation;
type CompactionStructural =
	| RunCompactionDecidingOperation
	| RunCompactionReadyOperation
	| RunCompactionEffectPendingOperation
	| RunCompactionRetryWaitOperation
	| CompactionDecidingOperation
	| CompactionReadyOperation
	| CompactionEffectPendingOperation
	| CompactionRetryWaitOperation;
type NavigationSummaryStructural =
	| NavigationSummaryDecidingOperation
	| NavigationSummaryReadyOperation
	| NavigationSummaryEffectPendingOperation
	| NavigationSummaryRetryWaitOperation;
type RunCompactionStructural = Extract<CompactionStructural, { at: `run.compaction.${string}` }>;
type StandaloneCompactionStructural = Extract<CompactionStructural, { at: `compaction.${string}` }>;
type GeneratedStructural = StructuralReady | StructuralEffectPending;
type RunGeneratedCompaction = Extract<GeneratedStructural, { at: `run.compaction.${string}` }>;
type StandaloneGeneratedCompaction = Extract<GeneratedStructural, { at: `compaction.${string}` }>;

function isRunGeneratedCompaction(state: GeneratedStructural): state is RunGeneratedCompaction {
	return state.at.startsWith("run.compaction.");
}

function isStandaloneGeneratedCompaction(state: GeneratedStructural): state is StandaloneGeneratedCompaction {
	return state.at.startsWith("compaction.");
}

function isRunCompaction(state: CompactionStructural): state is RunCompactionStructural {
	return state.at.startsWith("run.compaction.");
}

function isStandaloneCompaction(state: CompactionStructural): state is StandaloneCompactionStructural {
	return state.at.startsWith("compaction.");
}

class StructuralCancelled extends Error {
	constructor() {
		super("Structural generation was cancelled");
		this.name = "StructuralCancelled";
	}
}

function normalizedRetryPolicy<TContext extends object | undefined>(lane: Lane<TContext>): NormalizedRetryPolicy {
	const retry = lane.readConfig().retryPolicy;
	return retry.enabled
		? { maxAttempts: retry.maxRetries + 1, baseDelayMs: retry.baseDelayMs }
		: { maxAttempts: 1, baseDelayMs: retry.baseDelayMs };
}

function durableFileOperations(fileOps: CompactionPreparation["fileOps"]): DurableFileOperations {
	return {
		read: [...fileOps.read],
		written: [...fileOps.written],
		edited: [...fileOps.edited],
	};
}

export function durableCompactionPreparation(
	preparation: CompactionPreparation,
): Extract<DurableStructuralPreparation, { kind: "compaction" }> {
	return {
		kind: "compaction",
		messagesToSummarize: preparation.messagesToSummarize,
		turnPrefixMessages: preparation.turnPrefixMessages,
		retainedTail: preparation.retainedTail,
		isSplitTurn: preparation.isSplitTurn,
		tokensBefore: preparation.tokensBefore,
		...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
		fileOps: durableFileOperations(preparation.fileOps),
		settings: preparation.settings,
	};
}

function fileOperations(fileOps: DurableFileOperations): CompactionPreparation["fileOps"] {
	return {
		read: new Set(fileOps.read),
		written: new Set(fileOps.written),
		edited: new Set(fileOps.edited),
	};
}

function compactionPreparation(
	preparation: Extract<DurableStructuralPreparation, { kind: "compaction" }>,
): CompactionPreparation {
	return {
		messagesToSummarize: preparation.messagesToSummarize,
		turnPrefixMessages: preparation.turnPrefixMessages,
		retainedTail: preparation.retainedTail,
		isSplitTurn: preparation.isSplitTurn,
		tokensBefore: preparation.tokensBefore,
		...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
		fileOps: fileOperations(preparation.fileOps),
		settings: preparation.settings,
	};
}

function branchPreparation(
	preparation: Extract<DurableStructuralPreparation, { kind: "branch_summary" }>,
): BranchPreparation {
	return {
		messages: preparation.messages,
		fileOps: fileOperations(preparation.fileOps),
		totalTokens: preparation.totalTokens,
	};
}

async function readCompactionPreparation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deciding: RunCompactionDecidingOperation | CompactionDecidingOperation,
): Promise<ContinueOperationResult<CompactionPreparation>> {
	return lane.continueOperation(
		deciding,
		async (_state, current, _meta, reader) => {
			const stored = await reader.getValue(operationPreparation(drive.operationId, current.taskId), drive.context);
			if (stored?.value.kind !== "compaction") {
				throw new SessionInvariantError(`Structural task ${current.taskId} is missing its compaction preparation`);
			}
			return { kind: "return", result: compactionPreparation(stored.value) };
		},
		drive.context,
	);
}

async function readBranchPreparation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deciding: NavigationSummaryDecidingOperation,
): Promise<ContinueOperationResult<BranchPreparation>> {
	return lane.continueOperation(
		deciding,
		async (_state, current, _meta, reader) => {
			const [stored, target] = await Promise.all([
				reader.getValue(operationPreparation(drive.operationId, current.taskId), drive.context),
				reader.getEntries([current.targetId], drive.context),
			]);
			if (!target.has(current.targetId)) {
				throw new SessionInvariantError(`Navigation target ${current.targetId} is missing`);
			}
			if (stored?.value.kind !== "branch_summary") {
				throw new SessionInvariantError(`Structural task ${current.taskId} is missing its branch preparation`);
			}
			return { kind: "return", result: branchPreparation(stored.value) };
		},
		drive.context,
	);
}

function summaryContext<TContext extends object | undefined>(
	lane: Lane<TContext>,
	taskId: string,
	resultEntryId: string,
	kind: SummaryContext["kind"],
	configuration: LaneConfiguration,
	reason?: SummaryContext["reason"],
): SummaryContext {
	return {
		taskId,
		resultEntryId,
		kind,
		configuration,
		streamOptions: { ...lane.readConfig().streamOptions, deferred: false },
		retryPolicy: normalizedRetryPolicy(lane),
		...(reason === undefined ? {} : { reason }),
	};
}

function structuralEntryEvents(
	entry: NewEntry,
	entryWriteIndex: number,
	commit: CommitResult,
	lane: string,
	runId: string,
): HarnessEvent[] {
	return committedEntryEvents([entry], commit, lane, runId, entryWriteIndex);
}

function usageEvent(row: Omit<UsageRow, "seq">, writeIndex: number, commit: CommitResult, lane: string): HarnessEvent {
	return {
		type: "usage",
		lane,
		row: { ...row, seq: commit.seqs[writeIndex]! },
		totals: commit.stats.usage,
	};
}

function compactionReason(state: CompactionStructural): "manual" | "threshold" | "overflow" {
	return isRunCompaction(state) ? state.reason : "manual";
}

function compactionCustomInstructions(state: CompactionStructural): string | undefined {
	return isStandaloneCompaction(state) ? state.customInstructions : undefined;
}

function operationError(code: string, message: string, details?: JsonValue): OperationError {
	return { code, message, ...(details === undefined ? {} : { details }) };
}

async function publishCompactionResult<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: CompactionStructural,
	resultEntryId: string,
	result: CompactResult,
	fromHook: boolean,
): Promise<ProcedureResult> {
	const hookUsageId = fromHook && result.usage !== undefined ? lane.session.idGenerator.next() : undefined;
	const published = await lane.continueOperation<CompactionStructural, ProcedureResult>(
		capability,
		async (state, current, _meta, reader) => {
			const entry: NewEntry<CompactionEntry> = {
				id: resultEntryId,
				parentId: state.tipId,
				type: "compaction",
				summary: result.summary,
				retainedTail: result.retainedTail,
				tokensBefore: result.tokensBefore,
				...(result.details === undefined ? {} : { details: result.details }),
				...(result.usage === undefined ? {} : { usage: result.usage }),
				fromHook,
			};
			const writes: Write[] = [];
			let hookUsage: { row: Omit<UsageRow, "seq">; writeIndex: number } | undefined;
			if (hookUsageId !== undefined && result.usage !== undefined) {
				const row: Omit<UsageRow, "seq"> = { id: hookUsageId, usage: result.usage, adjustment: false };
				hookUsage = { row, writeIndex: writes.length };
				writes.push(insertUsage(row));
			}
			const entryWriteIndex = writes.length;
			writes.push(insertEntry(entry), setValue(branchTip(lane.name), resultEntryId));
			const events = (commit: CommitResult): HarnessEvent[] => [
				...(hookUsage === undefined ? [] : [usageEvent(hookUsage.row, hookUsage.writeIndex, commit, lane.name)]),
				...structuralEntryEvents(entry, entryWriteIndex, commit, lane.name, drive.operationId),
				{
					type: "compaction_end",
					lane: lane.name,
					runId: drive.operationId,
					reason: compactionReason(current),
					outcome: "completed",
					entry: { ...entry, seq: commit.seqs[entryWriteIndex]!, timestamp: commit.timestamp },
					fromHook,
				},
			];

			if (isRunCompaction(current)) {
				const checkpoint: RunCheckpointOperation = {
					...runScopeOf(current),
					at: "run.checkpoint",
					...current.resumeAfter,
				};
				return {
					kind: "commit",
					writes,
					operationState: checkpoint,
					lane: { tipId: resultEntryId },
					materialize: () => ({ kind: "continue" }) as const,
					events,
				};
			}

			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			const lastResult: LaneLastResult = {
				operationId: drive.operationId,
				kind: "compaction",
				outcome: "completed",
				tipId: resultEntryId,
			};
			return {
				kind: "finish",
				writes: [...writes, ...cleanup],
				lastResult,
				lane: { tipId: resultEntryId },
				materialize: (commit) =>
					({
						kind: "settled",
						outcome: {
							operation: "compaction",
							runId: drive.operationId,
							kind: "completed",
							tipId: resultEntryId,
							entry: { ...entry, seq: commit.seqs[entryWriteIndex]!, timestamp: commit.timestamp },
						},
					}) as const,
				events,
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

async function publishNavigationSummary<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: NavigationSummaryStructural,
	resultEntryId: string,
	result: BranchSummaryResult,
	fromHook: boolean,
): Promise<ProcedureResult> {
	const hookUsageId = fromHook && result.usage !== undefined ? lane.session.idGenerator.next() : undefined;
	const published = await lane.continueOperation<NavigationSummaryStructural, ProcedureResult>(
		capability,
		async (_state, current, meta, reader) => {
			const entry: NewEntry<BranchSummaryEntry> = {
				id: resultEntryId,
				parentId: current.targetId,
				type: "branch_summary",
				fromId: meta.sourceTipId,
				summary: result.summary,
				details: { readFiles: result.readFiles, modifiedFiles: result.modifiedFiles },
				...(result.usage === undefined ? {} : { usage: result.usage }),
				fromHook,
			};
			const writes: Write[] = [];
			let hookUsage: { row: Omit<UsageRow, "seq">; writeIndex: number } | undefined;
			if (hookUsageId !== undefined && result.usage !== undefined) {
				const row: Omit<UsageRow, "seq"> = { id: hookUsageId, usage: result.usage, adjustment: false };
				hookUsage = { row, writeIndex: writes.length };
				writes.push(insertUsage(row));
			}
			writes.push(setValue(branchTip(lane.name), current.targetId));
			const entryWriteIndex = writes.length;
			writes.push(insertEntry(entry), setValue(branchTip(lane.name), resultEntryId));
			if (current.label !== undefined) writes.push(setValue(entryLabel(current.targetId), current.label));
			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			const lastResult: LaneLastResult = {
				operationId: drive.operationId,
				kind: "navigation",
				outcome: "completed",
				oldTipId: meta.sourceTipId,
				tipId: resultEntryId,
				summaryEntryId: resultEntryId,
			};
			const events = (commit: CommitResult): HarnessEvent[] => {
				const committed = { ...entry, seq: commit.seqs[entryWriteIndex]!, timestamp: commit.timestamp };
				return [
					...(hookUsage === undefined ? [] : [usageEvent(hookUsage.row, hookUsage.writeIndex, commit, lane.name)]),
					...structuralEntryEvents(entry, entryWriteIndex, commit, lane.name, drive.operationId),
					{
						type: "navigation_end",
						lane: lane.name,
						runId: drive.operationId,
						oldTipId: meta.sourceTipId,
						newTipId: resultEntryId,
						outcome: "completed",
						summaryEntry: committed,
					},
				];
			};
			return {
				kind: "finish",
				writes: [...writes, ...cleanup],
				lastResult,
				lane: { tipId: resultEntryId },
				materialize: (commit) => {
					const summaryEntry: BranchSummaryEntry = {
						...entry,
						seq: commit.seqs[entryWriteIndex]!,
						timestamp: commit.timestamp,
					};
					return {
						kind: "settled",
						outcome: {
							operation: "navigation",
							runId: drive.operationId,
							kind: "completed",
							oldTipId: meta.sourceTipId,
							newTipId: resultEntryId,
							summaryEntry,
						},
					} as const;
				},
				events,
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

async function publishStructuralDecline<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: StructuralDeciding,
): Promise<ProcedureResult> {
	const published = await lane.continueOperation<StructuralDeciding, ProcedureResult>(
		capability,
		async (state, current, meta, reader) => {
			if (current.at === "run.compaction.deciding") {
				const operationState: RunCheckpointOperation | RunFailureDrainOperation =
					current.reason === "threshold"
						? { ...runScopeOf(current), at: "run.checkpoint", ...current.resumeAfter }
						: {
								...runScopeOf(current),
								at: "run.failure_drain",
								error: operationError("compaction_declined", "Overflow compaction was declined"),
								provenance: { kind: "structural", taskId: current.taskId },
							};
				return {
					kind: "commit",
					writes: [],
					operationState,
					materialize: () => ({ kind: "continue" }) as const,
					events: () => [
						{
							type: "compaction_end",
							lane: lane.name,
							runId: drive.operationId,
							reason: current.reason,
							outcome: "declined",
						},
					],
				};
			}

			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			if (current.at === "compaction.deciding") {
				if (state.tipId === null) throw new SessionInvariantError("Standalone compaction has no Branch tip");
				const lastResult: LaneLastResult = {
					operationId: drive.operationId,
					kind: "compaction",
					outcome: "declined",
					tipId: state.tipId,
				};
				return {
					kind: "finish",
					writes: cleanup,
					lastResult,
					materialize: () =>
						({
							kind: "settled",
							outcome: {
								operation: "compaction",
								runId: drive.operationId,
								kind: "declined",
								tipId: state.tipId!,
							},
						}) as const,
					events: () => [
						{
							type: "compaction_end",
							lane: lane.name,
							runId: drive.operationId,
							reason: "manual",
							outcome: "declined",
						},
					],
				};
			}

			const lastResult: LaneLastResult = {
				operationId: drive.operationId,
				kind: "navigation",
				outcome: "declined",
				oldTipId: meta.sourceTipId,
				tipId: state.tipId,
			};
			return {
				kind: "finish",
				writes: cleanup,
				lastResult,
				materialize: () =>
					({
						kind: "settled",
						outcome: {
							operation: "navigation",
							runId: drive.operationId,
							kind: "declined",
							tipId: state.tipId,
						},
					}) as const,
				events: () => [
					{
						type: "navigation_end",
						lane: lane.name,
						runId: drive.operationId,
						oldTipId: meta.sourceTipId,
						newTipId: state.tipId,
						outcome: "declined",
					},
				],
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

async function publishStructuralReady<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deciding: StructuralDeciding,
): Promise<ProcedureResult> {
	const taskId = deciding.taskId;
	const resultEntryId = lane.session.idGenerator.next();
	const published = await lane.continueOperation<StructuralDeciding, ProcedureResult>(
		deciding,
		(state, current) => {
			let operationState: StructuralReady;
			if (current.at === "run.compaction.deciding") {
				operationState = {
					...runScopeOf(current),
					at: "run.compaction.ready",
					reason: current.reason,
					resumeAfter: current.resumeAfter,
					summaryContext: summaryContext(
						lane,
						taskId,
						resultEntryId,
						"compaction",
						state.configuration,
						current.reason,
					),
					nextAttempt: 1,
				};
			} else if (current.at === "compaction.deciding") {
				operationState = {
					at: "compaction.ready",
					control: current.control,
					...(current.customInstructions === undefined ? {} : { customInstructions: current.customInstructions }),
					summaryContext: summaryContext(lane, taskId, resultEntryId, "compaction", state.configuration, "manual"),
					nextAttempt: 1,
				};
			} else {
				operationState = {
					at: "navigation.summary.ready",
					control: current.control,
					targetId: current.targetId,
					...(current.label === undefined ? {} : { label: current.label }),
					...(current.customInstructions === undefined ? {} : { customInstructions: current.customInstructions }),
					summaryContext: summaryContext(lane, taskId, resultEntryId, "branch_summary", state.configuration),
					nextAttempt: 1,
				};
			}
			return {
				kind: "commit",
				writes: [],
				operationState,
				materialize: () => ({ kind: "continue" }) as const,
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

/** Consume one durable structural preparation and decision hook. */
export async function runStructuralDecision<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	deciding: StructuralDeciding,
): Promise<ProcedureResult> {
	if (deciding.at === "navigation.summary.deciding") {
		const preparation = await readBranchPreparation(lane, drive, deciding);
		if (preparation.kind === "cancel_requested") return { kind: "continue" };
		const hook = await lane.hooks.runWithGate(
			"before_navigation",
			{
				lane: lane.name,
				runId: drive.operationId,
				targetId: deciding.targetId,
				preparation: preparation.value,
				...(deciding.customInstructions === undefined ? {} : { customInstructions: deciding.customInstructions }),
			},
			drive.gate,
			drive.context,
		);
		if (hook?.decline === true) return publishStructuralDecline(lane, drive, deciding);
		if (hook?.summary !== undefined) {
			return publishNavigationSummary(lane, drive, deciding, lane.session.idGenerator.next(), hook.summary, true);
		}
		return publishStructuralReady(lane, drive, deciding);
	}

	const preparation = await readCompactionPreparation(lane, drive, deciding);
	if (preparation.kind === "cancel_requested") return { kind: "continue" };
	const reason = deciding.at === "run.compaction.deciding" ? deciding.reason : "manual";
	const customInstructions = deciding.at === "compaction.deciding" ? deciding.customInstructions : undefined;
	const hook = await lane.hooks.runWithGate(
		"before_compaction",
		{
			lane: lane.name,
			runId: drive.operationId,
			reason,
			preparation: preparation.value,
			...(customInstructions === undefined ? {} : { customInstructions }),
		},
		drive.gate,
		drive.context,
	);
	if (hook?.decline === true) return publishStructuralDecline(lane, drive, deciding);
	if (hook?.compaction !== undefined) {
		return publishCompactionResult(lane, drive, deciding, lane.session.idGenerator.next(), hook.compaction, true);
	}
	return publishStructuralReady(lane, drive, deciding);
}

function effectPendingFromReady(ready: StructuralReady): StructuralEffectPending {
	switch (ready.at) {
		case "run.compaction.ready":
			return {
				...runScopeOf(ready),
				at: "run.compaction.effect_pending",
				reason: ready.reason,
				resumeAfter: ready.resumeAfter,
				summaryContext: ready.summaryContext,
				attempt: ready.nextAttempt,
				usageIds: [],
			};
		case "compaction.ready":
			return {
				at: "compaction.effect_pending",
				control: ready.control,
				...(ready.customInstructions === undefined ? {} : { customInstructions: ready.customInstructions }),
				summaryContext: ready.summaryContext,
				attempt: ready.nextAttempt,
				usageIds: [],
			};
		case "navigation.summary.ready":
			return {
				at: "navigation.summary.effect_pending",
				control: ready.control,
				targetId: ready.targetId,
				...(ready.label === undefined ? {} : { label: ready.label }),
				...(ready.customInstructions === undefined ? {} : { customInstructions: ready.customInstructions }),
				summaryContext: ready.summaryContext,
				attempt: ready.nextAttempt,
				usageIds: [],
			};
	}
}

function retryWaitFromEffect(effect: StructuralEffectPending, errorMessage: string): StructuralRetryWait {
	const nextAttempt = effect.attempt + 1;
	const notBefore = retryNotBefore(effect.summaryContext.retryPolicy.baseDelayMs, effect.attempt);
	switch (effect.at) {
		case "run.compaction.effect_pending":
			return {
				...runScopeOf(effect),
				at: "run.compaction.retry_wait",
				reason: effect.reason,
				resumeAfter: effect.resumeAfter,
				summaryContext: effect.summaryContext,
				nextAttempt,
				notBefore,
				errorMessage,
			};
		case "compaction.effect_pending":
			return {
				at: "compaction.retry_wait",
				control: effect.control,
				...(effect.customInstructions === undefined ? {} : { customInstructions: effect.customInstructions }),
				summaryContext: effect.summaryContext,
				nextAttempt,
				notBefore,
				errorMessage,
			};
		case "navigation.summary.effect_pending":
			return {
				at: "navigation.summary.retry_wait",
				control: effect.control,
				targetId: effect.targetId,
				...(effect.label === undefined ? {} : { label: effect.label }),
				...(effect.customInstructions === undefined ? {} : { customInstructions: effect.customInstructions }),
				summaryContext: effect.summaryContext,
				nextAttempt,
				notBefore,
				errorMessage,
			};
	}
}

function readyFromRetryWait(retry: StructuralRetryWait): StructuralReady {
	switch (retry.at) {
		case "run.compaction.retry_wait":
			return {
				...runScopeOf(retry),
				at: "run.compaction.ready",
				reason: retry.reason,
				resumeAfter: retry.resumeAfter,
				summaryContext: retry.summaryContext,
				nextAttempt: retry.nextAttempt,
			};
		case "compaction.retry_wait":
			return {
				at: "compaction.ready",
				control: retry.control,
				...(retry.customInstructions === undefined ? {} : { customInstructions: retry.customInstructions }),
				summaryContext: retry.summaryContext,
				nextAttempt: retry.nextAttempt,
			};
		case "navigation.summary.retry_wait":
			return {
				at: "navigation.summary.ready",
				control: retry.control,
				targetId: retry.targetId,
				...(retry.label === undefined ? {} : { label: retry.label }),
				...(retry.customInstructions === undefined ? {} : { customInstructions: retry.customInstructions }),
				summaryContext: retry.summaryContext,
				nextAttempt: retry.nextAttempt,
			};
	}
}

async function publishAttemptIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: StructuralReady,
): Promise<ContinueOperationResult<StructuralEffectPending>> {
	return lane.continueOperation(
		ready,
		(_state, current) => {
			const effectPending = effectPendingFromReady(current);
			return {
				kind: "commit",
				writes: [],
				operationState: effectPending,
				materialize: () => effectPending,
			};
		},
		drive.context,
	);
}

async function publishNestedRequestIntent<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: StructuralEffectPending,
	index: number,
	usageId: string,
): Promise<ContinueOperationResult<StructuralEffectPending>> {
	return lane.continueOperation(
		effect,
		(_state, current) => {
			const next = { ...current, request: { index, usageId } };
			return {
				kind: "commit",
				writes: [],
				operationState: next,
				materialize: () => next,
			};
		},
		drive.context,
	);
}

async function publishNestedRequestOutcome<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: StructuralEffectPending,
	usageId: string,
	response: AssistantMessage,
): Promise<void> {
	await lane.settleOperation(
		effect,
		(_state, current) => {
			const next = { ...current, usageIds: [...current.usageIds, usageId] };
			delete next.request;
			const row: Omit<UsageRow, "seq"> = { id: usageId, usage: response.usage, adjustment: false };
			return {
				kind: "commit",
				writes: [insertUsage(row)],
				operationState: next,
				materialize: () => undefined,
				events: (commit) => [usageEvent(row, 0, commit, lane.name)],
			};
		},
		drive.context,
	);
}

function requestStreamOptions(
	options: SimpleStreamOptions,
	streamOptions: AgentHarnessStreamOptions,
	context: Context,
	onPayload: NonNullable<SimpleStreamOptions["onPayload"]>,
): SimpleStreamOptions {
	return {
		...options,
		transport: streamOptions.transport,
		timeoutMs: streamOptions.timeoutMs,
		maxRetries: streamOptions.maxRetries,
		maxRetryDelayMs: streamOptions.maxRetryDelayMs,
		headers: streamOptions.headers,
		metadata: streamOptions.metadata,
		cacheRetention: "none",
		deferred: false,
		signal: context.abortSignal,
		telemetryContext: context.telemetryContext,
		onPayload,
	};
}

async function performStructuralAttempt<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: StructuralEffectPending,
	model: Model<Api>,
	preparation: CompactionPreparation | BranchPreparation,
): Promise<
	| { kind: "compaction"; result: CompactResult; retryable: boolean }
	| { kind: "branch_summary"; result: BranchSummaryResult; retryable: boolean }
	| { kind: "error"; error: OperationError; retryable: boolean }
	| { kind: "cancel_requested" }
> {
	let requestIndex = 0;
	let lastResponse: AssistantMessage | undefined;
	const request: SummaryRequest = async (aiContext, options, requestContext) => {
		const baseOptions: AgentHarnessStreamOptions = { ...effect.summaryContext.streamOptions, deferred: false };
		const beforeRequest = await lane.hooks
			.runWithGate(
				"before_request",
				{
					lane: lane.name,
					runId: drive.operationId,
					model,
					step: effect.summaryContext.kind,
					attempt: effect.attempt,
					streamOptions: baseOptions,
				},
				drive.gate,
				requestContext,
			)
			.catch(async (error: unknown) => {
				if (!(error instanceof AbortRequested)) throw error;
				await error.cancellation;
				throw new StructuralCancelled();
			});
		const streamOptions = {
			...(beforeRequest?.streamOptions === undefined
				? baseOptions
				: applyStreamOptionsPatch(baseOptions, beforeRequest.streamOptions)),
			deferred: false as const,
		};
		const usageId = lane.session.idGenerator.next();
		const intent = await publishNestedRequestIntent(lane, drive, effect, requestIndex, usageId);
		requestIndex += 1;
		if (intent.kind === "cancel_requested") throw new StructuralCancelled();
		const admittedContext = withAbortSignal(drive.gate.signal, requestContext);
		let response: AssistantMessage;
		try {
			response = await drive.gate.admit(() =>
				lane.models.completeSimple(
					model,
					aiContext,
					requestStreamOptions(options, streamOptions, admittedContext, async (payload, requestModel) => {
						const hook = await lane.hooks.runWithGate(
							"before_payload",
							{ lane: lane.name, runId: drive.operationId, model: requestModel, payload },
							drive.gate,
							admittedContext,
						);
						return hook?.payload;
					}),
				),
			);
		} catch (error) {
			if (!(error instanceof AbortRequested)) throw error;
			await error.cancellation;
			throw new StructuralCancelled();
		}
		lastResponse = response;
		await publishNestedRequestOutcome(lane, drive, intent.value, usageId, response);
		return response;
	};

	try {
		if (effect.summaryContext.kind === "compaction") {
			if (effect.at === "navigation.summary.effect_pending") {
				throw new SessionInvariantError("Compaction summary has a navigation operation state");
			}
			if (!("messagesToSummarize" in preparation)) {
				throw new SessionInvariantError("Compaction summary has invalid durable preparation");
			}
			const result = await compactWithRequest(
				preparation,
				{
					model,
					customInstructions: compactionCustomInstructions(effect),
					thinkingLevel: effect.summaryContext.configuration.thinkingLevel,
				},
				request,
				drive.context,
			);
			if (!result.ok) {
				return {
					kind: "error",
					error: operationError(result.error.code, result.error.message),
					retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
				};
			}
			return {
				kind: "compaction",
				result: result.value,
				retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
			};
		}

		if (effect.at !== "navigation.summary.effect_pending") {
			throw new SessionInvariantError("Branch summary has a compaction operation state");
		}
		if (!("messages" in preparation)) {
			throw new SessionInvariantError("Branch summary has invalid durable preparation");
		}
		const result = await generateBranchSummaryWithRequest(
			preparation,
			{
				customInstructions: effect.customInstructions,
			},
			request,
			drive.context,
		);
		if (!result.ok) {
			return {
				kind: "error",
				error: operationError(result.error.code, result.error.message),
				retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
			};
		}
		return {
			kind: "branch_summary",
			result: result.value,
			retryable: lastResponse !== undefined && isRetryableAssistantError(lastResponse),
		};
	} catch (error) {
		if (error instanceof StructuralCancelled) return { kind: "cancel_requested" };
		throw error;
	}
}

async function readAttemptPreparation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: StructuralReady,
): Promise<ContinueOperationResult<CompactionPreparation | BranchPreparation>> {
	return lane.continueOperation(
		ready,
		async (_state, current, _meta, reader) => {
			const stored = await reader.getValue(
				operationPreparation(drive.operationId, current.summaryContext.taskId),
				drive.context,
			);
			if (stored === undefined || stored.value.kind !== current.summaryContext.kind) {
				throw new SessionInvariantError(
					`Structural task ${current.summaryContext.taskId} has invalid durable preparation`,
				);
			}
			return {
				kind: "return",
				result:
					stored.value.kind === "compaction"
						? compactionPreparation(stored.value)
						: branchPreparation(stored.value),
			};
		},
		drive.context,
	);
}

async function publishStructuralFailure<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	capability: StructuralReady | StructuralEffectPending,
	error: OperationError,
	provenance: "structural" | "configuration" = "structural",
): Promise<ProcedureResult> {
	const published = await lane.continueOperation<StructuralReady | StructuralEffectPending, ProcedureResult>(
		capability,
		async (state, current, meta, reader) => {
			if (isRunGeneratedCompaction(current)) {
				const failure: RunFailureDrainOperation = {
					...runScopeOf(current),
					at: "run.failure_drain",
					error,
					provenance:
						provenance === "configuration"
							? { kind: "configuration" }
							: { kind: "structural", taskId: current.summaryContext.taskId },
				};
				return {
					kind: "commit",
					writes: [],
					operationState: failure,
					materialize: () => ({ kind: "continue" }) as const,
					events: () => [
						{
							type: "compaction_end",
							lane: lane.name,
							runId: drive.operationId,
							reason: current.reason,
							outcome: "failed",
							error,
						},
					],
				};
			}

			const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
			if (isStandaloneGeneratedCompaction(current)) {
				if (state.tipId === null) throw new SessionInvariantError("Standalone compaction has no Branch tip");
				const lastResult: LaneLastResult = {
					operationId: drive.operationId,
					kind: "compaction",
					outcome: "failed",
					tipId: state.tipId,
					error,
				};
				return {
					kind: "finish",
					writes: cleanup,
					lastResult,
					materialize: () =>
						({
							kind: "settled",
							outcome: {
								operation: "compaction",
								runId: drive.operationId,
								kind: "failed",
								tipId: state.tipId!,
								error,
							},
						}) as const,
					events: () => [
						{
							type: "compaction_end",
							lane: lane.name,
							runId: drive.operationId,
							reason: "manual",
							outcome: "failed",
							error,
						},
					],
				};
			}

			const lastResult: LaneLastResult = {
				operationId: drive.operationId,
				kind: "navigation",
				outcome: "failed",
				oldTipId: meta.sourceTipId,
				tipId: state.tipId,
				error,
			};
			return {
				kind: "finish",
				writes: cleanup,
				lastResult,
				materialize: () =>
					({
						kind: "settled",
						outcome: {
							operation: "navigation",
							runId: drive.operationId,
							kind: "failed",
							tipId: state.tipId,
							error,
						},
					}) as const,
				events: () => [
					{
						type: "navigation_end",
						lane: lane.name,
						runId: drive.operationId,
						oldTipId: meta.sourceTipId,
						newTipId: state.tipId,
						outcome: "failed",
						error,
					},
				],
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

async function publishAttemptResult<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: StructuralEffectPending,
	result: Awaited<ReturnType<typeof performStructuralAttempt<TContext>>>,
): Promise<ProcedureResult> {
	if (result.kind === "cancel_requested") return { kind: "continue" };
	if (result.kind === "compaction") {
		if (effect.at === "navigation.summary.effect_pending") {
			throw new SessionInvariantError("Compaction result has a navigation operation state");
		}
		return publishCompactionResult(lane, drive, effect, effect.summaryContext.resultEntryId, result.result, false);
	}
	if (result.kind === "branch_summary") {
		if (effect.at !== "navigation.summary.effect_pending") {
			throw new SessionInvariantError("Branch summary result has a compaction operation state");
		}
		return publishNavigationSummary(lane, drive, effect, effect.summaryContext.resultEntryId, result.result, false);
	}
	if (result.error.code === "aborted" && lane.state.operation!.state.control.status === "running") {
		throw new SessionInvariantError("Structural provider response is aborted while durable control is running");
	}
	if (result.retryable && effect.attempt < effect.summaryContext.retryPolicy.maxAttempts) {
		const retryWait = retryWaitFromEffect(effect, result.error.message);
		const published = await lane.continueOperation(
			effect,
			() => ({
				kind: "commit",
				writes: [],
				operationState: retryWait,
				materialize: () => ({ kind: "continue" }) as const,
				events: () => [
					{
						type: "retry_scheduled",
						lane: lane.name,
						runId: drive.operationId,
						step: effect.summaryContext.taskId,
						attempt: retryWait.nextAttempt,
						maxAttempts: effect.summaryContext.retryPolicy.maxAttempts,
						delayMs: retryDelay(effect.summaryContext.retryPolicy.baseDelayMs, effect.attempt),
						errorMessage: result.error.message,
					},
				],
			}),
			drive.context,
		);
		return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
	}
	return publishStructuralFailure(lane, drive, effect, result.error);
}

/** Execute one ready structural generation attempt. */
export async function runStructuralGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	ready: StructuralReady,
): Promise<ProcedureResult> {
	const preparation = await readAttemptPreparation(lane, drive, ready);
	if (preparation.kind === "cancel_requested") return { kind: "continue" };
	const identity = ready.summaryContext.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	if (model === undefined) {
		return publishStructuralFailure(
			lane,
			drive,
			ready,
			operationError("model_unavailable", "The configured model is unavailable in this process", identity),
			"configuration",
		);
	}
	const intent = await publishAttemptIntent(lane, drive, ready);
	if (intent.kind === "cancel_requested") return { kind: "continue" };
	const result = await performStructuralAttempt(lane, drive, intent.value, model, preparation.value);
	return publishAttemptResult(lane, drive, intent.value, result);
}

/** Consume one structural retry wait without starting a provider effect. */
export async function runStructuralRetryWait<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	retry: StructuralRetryWait,
): Promise<ProcedureResult> {
	if (Date.now() < retry.notBefore) {
		if (!drive.waitForRetry) {
			return {
				kind: "waiting",
				outcome: {
					kind: "waiting",
					operationId: drive.operationId,
					reason: "retry",
					notBefore: retry.notBefore,
				},
			};
		}
		await drive.gate.admit(() => waitUntil(retry.notBefore, drive.gate.signal));
	}
	const published = await lane.continueOperation(
		retry,
		(_state, current) => {
			const ready = readyFromRetryWait(current);
			return {
				kind: "commit",
				writes: [],
				operationState: ready,
				materialize: () => ({ kind: "continue" }) as const,
				events: () => [
					{
						type: "retry_start",
						lane: lane.name,
						runId: drive.operationId,
						step: current.summaryContext.taskId,
						attempt: current.nextAttempt,
					},
				],
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

/** Convert an orphaned structural attempt into a fresh numbered attempt or terminal failure. */
export async function recoverStructuralGeneration<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	effect: StructuralEffectPending,
): Promise<ProcedureResult> {
	const error = operationError(
		"structural_interrupted",
		"Structural summary attempt was interrupted and its external outcome is unknown",
	);
	if (effect.attempt >= effect.summaryContext.retryPolicy.maxAttempts) {
		return publishStructuralFailure(lane, drive, effect, error);
	}
	const retryWait = retryWaitFromEffect(effect, error.message);
	const published = await lane.continueOperation(
		effect,
		() => ({
			kind: "commit",
			writes: [],
			operationState: retryWait,
			materialize: () => ({ kind: "continue" }) as const,
			events: () => [
				{
					type: "retry_scheduled",
					lane: lane.name,
					runId: drive.operationId,
					step: effect.summaryContext.taskId,
					attempt: retryWait.nextAttempt,
					maxAttempts: effect.summaryContext.retryPolicy.maxAttempts,
					delayMs: retryDelay(effect.summaryContext.retryPolicy.baseDelayMs, effect.attempt),
					errorMessage: error.message,
					recovery: true,
				},
			],
		}),
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

/** Check and durably mark one run checkpoint's threshold boundary. */
export async function runCompactionThreshold<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	checkpoint: RunCheckpointOperation,
): Promise<ProcedureResult> {
	const settings = checkpoint.settings.compaction;
	const identity = lane.state.configuration.model;
	const model = lane.models.getModel(identity.provider, identity.modelId);
	let preparation: CompactionPreparation | undefined;
	if (settings.enabled && model !== undefined) {
		const entries = await readBoundedEntries(lane, drive, checkpoint);
		if (entries.kind === "cancel_requested") return { kind: "continue" };
		const prepared = prepareCompaction(entries.value, settings);
		if (!prepared.ok) throw prepared.error;
		if (prepared.value !== undefined && shouldCompact(prepared.value.tokensBefore, model.contextWindow, settings)) {
			preparation = prepared.value;
		}
	}
	const taskId = preparation === undefined ? undefined : lane.session.idGenerator.next();
	const published = await lane.continueOperation(
		checkpoint,
		(_state, current) => {
			const marked: RunCheckpointOperation = {
				...current,
				thresholdCheckedTriggerEntryId: current.triggerEntryId,
			};
			if (preparation === undefined || taskId === undefined) {
				return {
					kind: "commit",
					writes: [],
					operationState: marked,
					materialize: () => ({ kind: "continue" }) as const,
				};
			}
			const resumeAfter = {
				continuation: marked.continuation,
				triggerEntryId: marked.triggerEntryId,
				thresholdCheckedTriggerEntryId: marked.thresholdCheckedTriggerEntryId,
				...(marked.skipInboxOnce === undefined ? {} : { skipInboxOnce: marked.skipInboxOnce }),
			};
			const deciding: RunCompactionDecidingOperation = {
				...runScopeOf(current),
				at: "run.compaction.deciding",
				reason: "threshold",
				resumeAfter,
				taskId,
			};
			return {
				kind: "commit",
				writes: [
					setValue(operationPreparation(drive.operationId, taskId), durableCompactionPreparation(preparation)),
				],
				operationState: deciding,
				materialize: () => ({ kind: "continue" }) as const,
				events: () => [
					{
						type: "compaction_start",
						lane: lane.name,
						runId: drive.operationId,
						reason: "threshold",
					},
				],
			};
		},
		drive.context,
	);
	return published.kind === "cancel_requested" ? { kind: "continue" } : published.value;
}

/** Prepare one overflow compaction before the response settlement transaction. */
export async function prepareOverflowCompaction<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	generation: RunAssistantEffectPendingOperation,
): Promise<{ taskId: string; preparation: DurableStructuralPreparation } | undefined> {
	if (generation.generationContext.overflowRecoveryUsed) return undefined;
	const path = await readBoundedEntries(lane, drive, generation);
	if (path.kind === "cancel_requested") return undefined;
	const prepared = prepareCompaction(path.value, generation.settings.compaction);
	if (!prepared.ok) throw prepared.error;
	if (prepared.value === undefined) return undefined;
	return {
		taskId: lane.session.idGenerator.next(),
		preparation: durableCompactionPreparation(prepared.value),
	};
}

/** Atomically move an unsummarized navigation and finish its operation. */
export function commitNavigation<TContext extends object | undefined>(
	lane: Lane<TContext>,
	drive: Drive,
	navigation: NavigationReadyToCommitOperation,
): Promise<ProcedureResult> {
	return lane
		.continueOperation(
			navigation,
			async (_state, current, meta, reader) => {
				if (
					current.targetId !== null &&
					!(await reader.getEntries([current.targetId], drive.context)).has(current.targetId)
				) {
					throw new SessionInvariantError(`Navigation target ${current.targetId} is missing`);
				}
				if (current.targetId === meta.sourceTipId) {
					throw new SessionInvariantError("Navigation target must differ from its source tip");
				}
				if (current.targetId === null && current.label !== undefined) {
					throw new SessionInvariantError("Root navigation cannot set a label");
				}
				const writes: Write[] = [setValue(branchTip(lane.name), current.targetId)];
				if (current.label !== undefined && current.targetId !== null) {
					writes.push(setValue(entryLabel(current.targetId), current.label));
				}
				const cleanup = await operationCleanupWrites(reader, drive.operationId, current, drive.context);
				const lastResult: LaneLastResult = {
					operationId: drive.operationId,
					kind: "navigation",
					outcome: "completed",
					oldTipId: meta.sourceTipId,
					tipId: current.targetId,
				};
				const outcome: TerminalOperationOutcome = {
					operation: "navigation",
					runId: drive.operationId,
					kind: "completed",
					oldTipId: meta.sourceTipId,
					newTipId: current.targetId,
				};
				return {
					kind: "finish",
					writes: [...writes, ...cleanup],
					lastResult,
					lane: { tipId: current.targetId },
					materialize: () => ({ kind: "settled", outcome }) as const,
					events: () => [
						{
							type: "navigation_end",
							lane: lane.name,
							runId: drive.operationId,
							oldTipId: meta.sourceTipId,
							newTipId: current.targetId,
							outcome: "completed",
						},
					],
				};
			},
			drive.context,
		)
		.then((result) => (result.kind === "cancel_requested" ? { kind: "continue" } : result.value));
}
