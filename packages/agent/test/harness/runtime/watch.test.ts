import { type AssistantMessageFrame, createModels, fauxAssistantMessage, fauxProvider } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HarnessEvent, HarnessFault, type WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context, createContextKey, withContextValue } from "../../../src/harness/context.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime/harness.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import * as sessionWrites from "../../../src/harness/session/commit.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	OperationMeta,
	RunPhase,
	RunState,
	Session,
	StorageBranchScan,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const configuration = {
	model: { provider: "configured", modelId: "model" },
	thinkingLevel: "off" as const,
	activeToolNames: [],
};

async function createSession(storage: MemoryStorage = new MemoryStorage()): Promise<Session> {
	const session = new StorageBackedSession(
		{ id: `watch-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	await session.mutate(
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.branchTip("main"), null),
					storedValues.setValue(storedValues.laneConfig("main"), configuration),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: null,
						pendingNextRun: [],
					}),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	return session;
}

async function commit(session: Session, writes: Write[]): Promise<void> {
	await session.mutate((mutator) => mutator.commit(writes, BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);
}

function runState(phase: RunPhase, control: RunState["control"] = { status: "running" }): RunState {
	return {
		kind: "run",
		control,
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

async function attach(
	session: Session,
): Promise<Lane<object | undefined> & Pick<Harness<object | undefined>, "events">> {
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	const { harness } = await createAgentHarness({ session, models, model: provider.getModel() }, BACKGROUND_CONTEXT);
	if (!(harness instanceof Harness)) throw new Error("Expected runtime Harness");
	const lane = await harness.lane("main", BACKGROUND_CONTEXT);
	if (!(lane instanceof Lane)) throw new Error("Expected runtime Lane");
	return Object.assign(lane, { events: harness.events });
}

class BlockingScanStorage extends MemoryStorage {
	block = false;
	readonly started = deferred();
	readonly release = deferred();

	override async scanBranch(query: StorageBranchScan, context: Context) {
		if (this.block) {
			this.started.resolve();
			await this.release.promise;
		}
		return super.scanBranch(query, context);
	}
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime lane watch", () => {
	it("captures a compaction-bounded transcript and isolates the returned snapshot", async () => {
		const session = await createSession();
		await commit(session, [
			sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
			sessionWrites.insertEntry({
				id: "compact",
				parentId: "root",
				type: "compaction",
				summary: "summary",
				retainedTail: [],
				tokensBefore: 10,
				fromHook: false,
			}),
			sessionWrites.insertEntry({
				id: "after",
				parentId: "compact",
				type: "message",
				message: { role: "user", content: "after", timestamp: 2 },
			}),
			storedValues.setValue(storedValues.branchTip("main"), "after"),
		]);
		const harness = await attach(session);

		const first = await harness.watch(BACKGROUND_CONTEXT);
		expect(first.snapshot.transcript.map(({ id }) => id)).toEqual(["compact", "after"]);
		expect(first.snapshot).toMatchObject({
			lane: "main",
			tipId: "after",
			operation: null,
			queues: { steer: [], followUp: [], nextRun: [] },
			pendingWrites: [],
			faulted: false,
		});
		first.snapshot.transcript.length = 0;
		first.snapshot.tipId = null;
		const second = await harness.watch(BACKGROUND_CONTEXT);
		expect(second.snapshot.transcript.map(({ id }) => id)).toEqual(["compact", "after"]);
		expect(second.snapshot.tipId).toBe("after");
		first.unsubscribe();
		second.unsubscribe();
	});

	it("dereferences queues, pending writes, deferred handles, and abort drains", async () => {
		const session = await createSession();
		const handle = { provider: "provider", modelId: "model", api: "test", id: "deferred" };
		const sourceMessage = fauxAssistantMessage([], { stopReason: "deferred", deferred: handle });
		const ids = {
			next: "next",
			steer: "steer",
			follow: "follow",
			write: "write",
			drainedSteer: "drained-steer",
			drainedFollow: "drained-follow",
		};
		const payload = (content: string) => ({
			type: "message" as const,
			payload: { role: "user" as const, content, timestamp: 1 },
		});
		const operationId = session.idGenerator.next();
		const state = runState(
			{
				kind: "deferred",
				deferred: {
					status: "suspended",
					stepId: "step",
					sourceEntryId: "source",
					poll: 3,
					configuration,
					streamOptions: {},
				},
			},
			{
				status: "cancel_requested",
				requestedAt: 2,
				drainedSteer: [ids.drainedSteer],
				drainedFollowUp: [ids.drainedFollow],
			},
		);
		state.inbox = { steer: [ids.steer], followUp: [ids.follow], writes: [ids.write] };
		const meta: OperationMeta = {
			operationId,
			lane: "main",
			sourceTipId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		await commit(session, [
			sessionWrites.insertEntry({ id: "source", parentId: null, type: "message", message: sourceMessage }),
			...Object.values(ids).map((id) =>
				storedValues.setValue(
					storedValues.pendingEntry(id),
					id === ids.write ? { type: "custom", customType: "note", payload: { id } } : payload(id),
				),
			),
			storedValues.setValue(storedValues.operationMeta(operationId), meta),
			storedValues.setValue(storedValues.operationState(operationId), state),
			storedValues.setValue(storedValues.branchTip("main"), "source"),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: operationId,
				pendingNextRun: [ids.next],
			}),
		]);
		const harness = await attach(session);

		const watch = await harness.watch(BACKGROUND_CONTEXT);

		expect(watch.snapshot.queues.steer).toMatchObject([{ entryId: ids.steer, message: { content: ids.steer } }]);
		expect(watch.snapshot.queues.followUp).toMatchObject([{ entryId: ids.follow, message: { content: ids.follow } }]);
		expect(watch.snapshot.queues.nextRun).toMatchObject([{ entryId: ids.next, message: { content: ids.next } }]);
		expect(watch.snapshot.pendingWrites).toEqual([
			{ entryId: ids.write, type: "custom", customType: "note", data: { id: ids.write } },
		]);
		expect(watch.snapshot.operation).toMatchObject({
			id: operationId,
			status: "aborting",
			deferred: { handle, poll: 3 },
			drained: {
				steer: [{ entryId: ids.drainedSteer }],
				followUp: [{ entryId: ids.drainedFollow }],
			},
			runningTools: [],
		});
		watch.unsubscribe();
	});

	it("omits streaming presentation when an effect-pending response has no frames", async () => {
		const session = await createSession();
		const operationId = session.idGenerator.next();
		await commit(session, [
			storedValues.setValue(storedValues.operationMeta(operationId), {
				operationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			}),
			storedValues.setValue(
				storedValues.operationState(operationId),
				runState({
					kind: "assistant",
					generation: {
						status: "effect_pending",
						context: {
							stepId: "step",
							triggerEntryId: "trigger",
							configuration,
							streamOptions: {},
							retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
							overflowRecoveryUsed: false,
						},
						attempt: 1,
						responseEntryId: "response-without-frames",
						usageId: "usage",
						intendedOutputLimit: 100,
						contextWindow: 1000,
					},
				}),
			),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: operationId,
				pendingNextRun: [],
			}),
		]);
		const harness = await attach(session);

		const watch = await harness.watch(BACKGROUND_CONTEXT);

		expect(watch.snapshot.operation).not.toHaveProperty("streamingMessage");
		watch.unsubscribe();
	});

	it("reduces assistant frames and renders only effect-pending tools with full-content indexes", async () => {
		const frameSession = await createSession();
		const partial = fauxAssistantMessage([], { stopReason: "pending" });
		const frames: AssistantMessageFrame[] = [
			{ type: "start", partial },
			{ type: "text_start", contentIndex: 0, content: { type: "text", text: "" } },
			{ type: "text_delta", contentIndex: 0, delta: "partial" },
		];
		const frameOperationId = frameSession.idGenerator.next();
		await commit(frameSession, [
			storedValues.setValue(storedValues.operationMeta(frameOperationId), {
				operationId: frameOperationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			}),
			storedValues.setValue(
				storedValues.operationState(frameOperationId),
				runState({
					kind: "assistant",
					generation: {
						status: "effect_pending",
						context: {
							stepId: "step",
							triggerEntryId: "trigger",
							configuration,
							streamOptions: {},
							retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
							overflowRecoveryUsed: false,
						},
						attempt: 1,
						responseEntryId: "response",
						usageId: "usage",
						intendedOutputLimit: 100,
						contextWindow: 1000,
					},
				}),
			),
			...frames.map((frame) =>
				storedValues.appendList(storedValues.pendingAssistantFrames(frameOperationId, "response"), frame),
			),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: frameOperationId,
				pendingNextRun: [],
			}),
		]);
		const frameHarness = await attach(frameSession);
		const frameWatch = await frameHarness.watch(BACKGROUND_CONTEXT);
		expect(frameWatch.snapshot.operation?.streamingMessage?.content).toEqual([{ type: "text", text: "partial" }]);
		frameWatch.unsubscribe();

		const toolSession = await createSession();
		const assistant = fauxAssistantMessage([
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "call", name: "read", arguments: { live: false } },
			{ type: "toolCall", id: "call-without-checkpoint", name: "write", arguments: { live: false } },
		]);
		const toolOperationId = toolSession.idGenerator.next();
		await commit(toolSession, [
			sessionWrites.insertEntry({ id: "assistant", parentId: null, type: "message", message: assistant }),
			storedValues.setValue(storedValues.operationMeta(toolOperationId), {
				operationId: toolOperationId,
				lane: "main",
				sourceTipId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			}),
			storedValues.setValue(
				storedValues.operationState(toolOperationId),
				runState({
					kind: "tools",
					batch: {
						assistantEntryId: "assistant",
						configuration,
						turnId: "turn",
						calls: [
							{ status: "planned", sourceIndex: 1, resultEntryId: "planned" },
							{ status: "effect_pending", sourceIndex: 1, resultEntryId: "result", replay: "safe" },
							{
								status: "effect_pending",
								sourceIndex: 2,
								resultEntryId: "without-checkpoint",
								replay: "never",
							},
							{ status: "outcome_ready", sourceIndex: 1, resultEntryId: "ready", terminate: false },
						],
					},
				}),
			),
			storedValues.setValue(storedValues.operationToolArgs(toolOperationId, "turn", 1), { path: "file" }),
			storedValues.setValue(storedValues.operationToolArgs(toolOperationId, "turn", 2), { path: "output" }),
			storedValues.setValue(storedValues.pendingToolOutput(toolOperationId, "result"), {
				content: [{ type: "text", text: "partial" }],
				details: { bytes: 1 },
			}),
			storedValues.setValue(storedValues.branchTip("main"), "assistant"),
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: toolOperationId,
				pendingNextRun: [],
			}),
		]);
		const toolHarness = await attach(toolSession);
		const toolWatch = await toolHarness.watch(BACKGROUND_CONTEXT);
		expect(toolWatch.snapshot.operation?.runningTools).toEqual([
			{
				toolCallId: "call",
				toolName: "read",
				args: { path: "file" },
				partialResult: { content: [{ type: "text", text: "partial" }], details: { bytes: 1 } },
			},
			{
				toolCallId: "call-without-checkpoint",
				toolName: "write",
				args: { path: "output" },
			},
		]);
		expect(toolWatch.snapshot.operation?.runningTools[1]).not.toHaveProperty("partialResult");
		toolWatch.unsubscribe();
	});

	it("faults required payload corruption and unsubscribes the incomplete watcher", async () => {
		const session = await createSession();
		await commit(session, [
			storedValues.setValue(storedValues.laneState("main"), {
				currentOperationId: null,
				pendingNextRun: ["missing"],
			}),
		]);
		const harness = await attach(session);
		let unsubscribed = false;
		const originalWatch = harness.events.watch.bind(harness.events);
		vi.spyOn(harness.events, "watch").mockImplementation(
			<T>(snapshot: T, filter: (event: HarnessEvent) => boolean, context: Context): WatchHandle<T> => {
				const handle = originalWatch(snapshot, filter, context);
				return {
					...handle,
					unsubscribe: () => {
						unsubscribed = true;
						handle.unsubscribe();
					},
				};
			},
		);

		await expect(harness.watch(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
		expect(unsubscribed).toBe(true);
	});

	it("returns snapshot-before plus buffered events when watch wins the lane line", async () => {
		const storage = new BlockingScanStorage();
		const session = await createSession(storage);
		await commit(session, [
			sessionWrites.insertEntry({ id: "root", parentId: null, type: "custom", customType: "root" }),
			storedValues.setValue(storedValues.branchTip("main"), "root"),
		]);
		const harness = await attach(session);
		storage.block = true;
		const watchPromise = harness.watch(BACKGROUND_CONTEXT);
		await storage.started.promise;
		const sourceKey = createContextKey<string>("watch.event.source");
		const sourceContext = withContextValue(sourceKey, "append", BACKGROUND_CONTEXT);
		const append = harness.appendMessage({ role: "user", content: "later", timestamp: 2 }, sourceContext);
		storage.release.resolve();
		const watch = await watchPromise;
		expect(watch.snapshot.transcript.map(({ id }) => id)).toEqual(["root"]);
		const seen: Array<{ type: string; sameContext: boolean }> = [];
		watch.start((event, eventContext) => {
			seen.push({ type: event.type, sameContext: eventContext === sourceContext });
		});
		await append;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen.map(({ type }) => type)).toEqual(["message_start", "message_end", "entry_added"]);
		expect(seen.every(({ sameContext }) => sameContext)).toBe(true);
		watch.unsubscribe();
	});

	it("returns snapshot-after without replay when publication wins", async () => {
		const session = await createSession();
		const harness = await attach(session);
		const entryId = await harness.appendMessage(
			{ role: "user", content: "existing", timestamp: 1 },
			BACKGROUND_CONTEXT,
		);

		const watch = await harness.watch(BACKGROUND_CONTEXT);
		const seen = vi.fn();
		watch.start(seen);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(watch.snapshot.transcript.map(({ id }) => id)).toEqual([entryId]);
		expect(seen).not.toHaveBeenCalled();
		watch.unsubscribe();
	});
});
