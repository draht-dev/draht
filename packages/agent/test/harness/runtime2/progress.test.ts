import { type AssistantMessageFrame, createModels } from "@draht/ai";
import { afterEach, describe, expect, it } from "vitest";
import { OperationMismatch } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { openFrameProgress, openToolProgress } from "../../../src/harness/runtime2/progress.ts";
import {
	type ActiveDrive,
	type Config,
	createActiveDrive,
	type DriveScope,
	type LaneCommand,
	type LaneDriveCapabilities,
	type LaneState as RuntimeLaneState,
} from "../../../src/harness/runtime2/types.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type { LaneLastResult, RunState, Session, SessionReader, Write } from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { createDriveScope } from "./test-utils.ts";

const sessions: Session[] = [];
const operationId = "operation";
const configuration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off" as const,
	activeToolNames: [],
};

class FailingStorage extends MemoryStorage {
	failure: Error | undefined;

	override commit(writes: Write[], context: Context) {
		if (this.failure === undefined) return super.commit(writes, context);
		const failure = this.failure;
		this.failure = undefined;
		return Promise.reject(failure);
	}
}

class TestDriveLane implements LaneDriveCapabilities<undefined> {
	readonly name = "main";
	readonly models = createModels();
	readonly hooks = new HookRegistry(() => {});
	readonly session: Session;
	private projection: RuntimeLaneState;
	active: ActiveDrive | undefined;

	constructor(session: Session, state: RunState) {
		this.session = session;
		this.projection = {
			leafId: null,
			configuration,
			pendingNextRun: [],
			operation: {
				meta: {
					operationId,
					lane: this.name,
					sourceLeafId: null,
					startedAt: 1,
					intent: { kind: "run", promptEntryIds: [] },
				},
				state,
			},
		};
	}

	command<TResult>(
		plan: (
			projection: RuntimeLaneState,
			reader: SessionReader,
		) => LaneCommand<TResult> | Promise<LaneCommand<TResult>>,
		context: Context,
	): Promise<TResult> {
		return this.session.mutate(
			this.name,
			async (mutator) => {
				const decision = await plan(this.projection, mutator);
				switch (decision.kind) {
					case "return":
						return decision.result;
					case "reject":
						throw decision.error;
					case "commit": {
						const commit = await mutator.commit(decision.writes, context);
						this.projection = decision.next;
						return decision.materialize(commit);
					}
				}
			},
			context,
		);
	}

	emitBatch(): Promise<void> {
		return Promise.resolve();
	}

	readConfig(): Config<undefined> {
		return {
			tools: [],
			resources: {},
			streamOptions: {},
			retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 1_000 },
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
			toolContext: undefined,
			systemPrompt: undefined,
			toProviderMessages: () => [],
			entryProjectors: {},
		};
	}

	ownsDrive(scope: DriveScope<undefined>): boolean {
		return this.active === scope.owner;
	}

	mismatch(expected: string, currentOperationId: string | null, last: LaneLastResult | undefined): OperationMismatch {
		return new OperationMismatch({
			lane: this.name,
			expectedOperationId: expected,
			...(currentOperationId === null ? {} : { currentOperationId }),
			...(last === undefined ? {} : { lastOperationId: last.operationId }),
			message: "mismatch",
		});
	}
}

function runState(phase: RunState["phase"]): RunState {
	return {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		phase,
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

async function createFixture(
	state: RunState,
	storage = new FailingStorage(),
): Promise<{
	lane: TestDriveLane;
	scope: DriveScope<undefined>;
	storage: FailingStorage;
}> {
	const session = new StorageBackedSession(
		{ id: `progress-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const lane = new TestDriveLane(session, state);
	await session.mutate(
		"main",
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.laneLeaf("main"), null),
					storedValues.setValue(storedValues.laneConfig("main"), configuration),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: operationId,
						pendingNextRun: [],
					}),
					storedValues.setValue(storedValues.operationMeta(operationId), {
						operationId,
						lane: "main",
						sourceLeafId: null,
						startedAt: 1,
						intent: { kind: "run", promptEntryIds: [] },
					}),
					storedValues.setValue(storedValues.operationState(operationId), state),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	const { scope, handle } = createDriveScope(lane, { operationId });
	lane.active = handle.active;
	return { lane, scope, storage };
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime2 active drive ownership", () => {
	it("settles or rejects the shared completion without exposing owner controls through the gate", async () => {
		const settled = createActiveDrive(operationId);
		const outcome = { kind: "waiting", operationId, reason: "retry", notBefore: 10 } as const;
		settled.settle(outcome);
		await expect(settled.active.completion).resolves.toBe(outcome);

		const failed = createActiveDrive(operationId);
		const error = new Error("drive failed");
		failed.fail(error);
		await expect(failed.active.completion).rejects.toBe(error);
		expect("beginAbort" in failed.active.gate).toBe(false);
	});
});

describe("runtime2 progress channels", () => {
	it("enqueues assistant frames in order, seals admission, and exposes the settlement delete", async () => {
		const responseEntryId = "response";
		const { scope } = await createFixture(
			runState({
				kind: "assistant",
				generation: {
					status: "effect_pending",
					context: {
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
				},
			}),
		);
		const progress = openFrameProgress(scope, responseEntryId);
		const frames: AssistantMessageFrame[] = [
			{ type: "text_delta", contentIndex: 0, delta: "a" },
			{ type: "text_delta", contentIndex: 0, delta: "b" },
		];

		progress.write(frames[0]!);
		progress.write(frames[1]!);
		progress.seal();
		progress.write({ type: "text_delta", contentIndex: 0, delta: "late" });
		await progress.drain();

		expect(
			(
				await scope.lane.session.readList(
					storedValues.pendingAssistantFrames(operationId, responseEntryId),
					undefined,
					BACKGROUND_CONTEXT,
				)
			).map(({ value }) => value),
		).toEqual(frames);
		expect(progress.clearWrite()).toEqual(
			storedValues.deleteList(storedValues.pendingAssistantFrames(operationId, responseEntryId)),
		);
	});

	it("replaces tool checkpoints and fences writes after owner identity changes", async () => {
		const invocationId = "result";
		const { lane, scope } = await createFixture(
			runState({
				kind: "tools",
				batch: {
					assistantEntryId: "assistant",
					configuration,
					turnId: "turn",
					calls: [{ status: "effect_pending", sourceIndex: 0, resultEntryId: invocationId, replay: "safe" }],
				},
			}),
		);
		const progress = openToolProgress(scope, invocationId);
		progress.write({ content: [{ type: "text", text: "first" }], details: {} });
		progress.write({ content: [{ type: "text", text: "second" }], details: {} });
		await progress.drain();
		expect(
			(
				await scope.lane.session.getValue(
					storedValues.pendingToolOutput(operationId, invocationId),
					BACKGROUND_CONTEXT,
				)
			)?.value.content,
		).toEqual([{ type: "text", text: "second" }]);

		lane.active = createActiveDrive(operationId).active;
		progress.write({ content: [{ type: "text", text: "stale" }], details: {} });
		await progress.drain();
		expect(
			(
				await scope.lane.session.getValue(
					storedValues.pendingToolOutput(operationId, invocationId),
					BACKGROUND_CONTEXT,
				)
			)?.value.content,
		).toEqual([{ type: "text", text: "second" }]);
	});

	it("retains the rejecting write promise so drain propagates commit failure", async () => {
		const responseEntryId = "response";
		const { scope, storage } = await createFixture(
			runState({
				kind: "assistant",
				generation: {
					status: "effect_pending",
					context: {
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
				},
			}),
		);
		const failure = new Error("frame commit failed");
		storage.failure = failure;
		const progress = openFrameProgress(scope, responseEntryId);

		progress.write({ type: "text_delta", contentIndex: 0, delta: "lost" });

		await expect(progress.drain()).rejects.toBe(failure);
	});
});
