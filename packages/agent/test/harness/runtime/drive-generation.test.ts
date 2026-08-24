import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	type MutableModels,
	type Provider,
} from "@draht/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessEvent, WatchHandle } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, type Context } from "../../../src/harness/context.ts";
import { HookRegistry } from "../../../src/harness/hooks.ts";
import { runCheckpoint, startRun } from "../../../src/harness/runtime/drive/checkpoint.ts";
import { runGeneration } from "../../../src/harness/runtime/drive/generation.ts";
import { recoverAssistantGeneration } from "../../../src/harness/runtime/drive/recovery.ts";
import { Lane } from "../../../src/harness/runtime/lane.ts";
import { restoreLane } from "../../../src/harness/runtime/restore.ts";
import { type Config, Drive } from "../../../src/harness/runtime/types.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../../src/harness/session/testing/instrumented-storage.ts";
import type {
	Generation,
	LaneConfiguration,
	MessageEntry,
	RunState,
	Session,
	Write,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import { deferred } from "./test-utils.ts";

const sessions: Session[] = [];
const operationId = "01950000-0000-7000-8000-000000000001";

class FrameBlockingMemoryStorage extends MemoryStorage {
	blockNextFrame = false;
	readonly frameStarted = deferred();
	readonly releaseFrame = deferred();

	override async commit(writes: Write[], context: Context) {
		if (
			this.blockNextFrame &&
			writes.some(
				(write) =>
					write.kind === "list" && write.op === "append" && write.namespace === "pi.pending.assistant_frame",
			)
		) {
			this.blockNextFrame = false;
			this.frameStarted.resolve();
			await this.releaseFrame.promise;
		}
		return super.commit(writes, context);
	}
}

interface Fixture {
	lane: Lane<undefined>;
	drive: Drive;
	session: Session;
	storage: InstrumentedStorage;
	models: MutableModels;
	faux: ReturnType<typeof fauxProvider>;
	hooks: HookRegistry;
	events: HarnessEvent[];
	config: Config<undefined>;
}

function unusedWatch<T>(): WatchHandle<T> {
	throw new Error("watch is not used by generation tests");
}

async function createFixture(backend: MemoryStorage = new MemoryStorage({ now: () => 100 })): Promise<Fixture> {
	const storage = new InstrumentedStorage(backend);
	const session = new StorageBackedSession(
		{ id: `generation-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
	const model = faux.getModel();
	const configuration: LaneConfiguration = {
		model: { provider: model.provider, modelId: model.id },
		thinkingLevel: "off",
		activeToolNames: [],
	};
	await session.mutate(
		"main",
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.laneLeaf("main"), null),
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
	const models = createModels();
	models.setProvider(faux.provider);
	const hooks = new HookRegistry(() => {});
	const events: HarnessEvent[] = [];
	const config: Config<undefined> = {
		tools: [],
		resources: {},
		streamOptions: {},
		retryPolicy: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
		compaction: DEFAULT_COMPACTION_SETTINGS,
		steeringMode: "all",
		followUpMode: "all",
		toolExecution: "parallel",
		toolContext: undefined,
		systemPrompt: undefined,
		toProviderMessages: (messages) =>
			messages.filter(
				(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
		entryProjectors: {},
	};
	const lane = new Lane<undefined>(
		"main",
		session,
		models,
		hooks,
		await restoreLane(session, "main", BACKGROUND_CONTEXT),
		(cause) => (cause instanceof Error ? cause : new Error(String(cause))),
		(batch) => {
			events.push(...structuredClone(batch));
			return Promise.resolve();
		},
		unusedWatch,
		() => config,
	);
	const admission = await lane.accept({ kind: "prompt", operationId, prompt: "question" }, BACKGROUND_CONTEXT);
	if (!admission.ok) throw admission.error;
	const drive = new Drive({ operationId }, BACKGROUND_CONTEXT);
	lane.activeDrive = drive;
	storage.clearCommitAttempts();
	return { lane, drive, session, storage, models, faux, hooks, events, config };
}

function currentRun(lane: Lane<undefined>): RunState {
	const operation = lane.state.operation;
	if (operation?.state.kind !== "run") throw new Error("fixture has no run");
	return operation.state;
}

function readyGeneration(lane: Lane<undefined>): Extract<Generation, { status: "ready" }> {
	const run = currentRun(lane);
	if (run.phase.kind !== "assistant" || run.phase.generation.status !== "ready") {
		throw new Error("fixture has no ready generation");
	}
	return run.phase.generation;
}

async function advanceToReady(fixture: Fixture): Promise<Extract<Generation, { status: "ready" }>> {
	let run = currentRun(fixture.lane);
	await startRun(fixture.lane, fixture.drive, run);
	run = currentRun(fixture.lane);
	if (run.phase.kind !== "checkpoint") throw new Error("run did not reach checkpoint");
	await runCheckpoint(fixture.lane, fixture.drive, run, run.phase);
	return readyGeneration(fixture.lane);
}

async function expectProjectionRestores(fixture: Fixture): Promise<void> {
	expect(fixture.lane.state).toEqual(await restoreLane(fixture.session, "main", BACKGROUND_CONTEXT));
}

function writesOperationState(writes: readonly Write[], status: string): boolean {
	return writes.some(
		(write) =>
			write.kind === "value" &&
			write.op === "set" &&
			write.namespace === "pi.op.state" &&
			typeof write.value === "object" &&
			write.value !== null &&
			"phase" in write.value &&
			typeof write.value.phase === "object" &&
			write.value.phase !== null &&
			"kind" in write.value.phase &&
			write.value.phase.kind === "assistant" &&
			"generation" in write.value.phase &&
			typeof write.value.phase.generation === "object" &&
			write.value.phase.generation !== null &&
			"status" in write.value.phase.generation &&
			write.value.phase.generation.status === status,
	);
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime generation checkpoint", () => {
	it("consumes before_run and snapshots a ready generation", async () => {
		const fixture = await createFixture();
		fixture.hooks.on("before_run", () => ({
			messages: [{ role: "user", content: "injected", timestamp: 2 }],
		}));
		const starting = currentRun(fixture.lane);

		expect(await startRun(fixture.lane, fixture.drive, starting)).toEqual({ kind: "continue" });
		let run = currentRun(fixture.lane);
		if (run.phase.kind !== "checkpoint") throw new Error("missing checkpoint");
		expect(run.phase.triggerEntryId).toBe(fixture.lane.state.leafId);
		expect(fixture.events.map((event) => event.type)).toContain("entry_added");
		await expectProjectionRestores(fixture);

		expect(await runCheckpoint(fixture.lane, fixture.drive, run, run.phase)).toEqual({ kind: "continue" });
		run = currentRun(fixture.lane);
		if (run.phase.kind !== "assistant" || run.phase.generation.status !== "ready") {
			throw new Error("missing ready generation");
		}
		expect(run.phase.generation.context).toMatchObject({
			configuration: fixture.lane.state.configuration,
			streamOptions: {},
			retryPolicy: { maxAttempts: 4, baseDelayMs: 1 },
			overflowRecoveryUsed: false,
		});
		await expectProjectionRestores(fixture);
	});

	it("drains mixed pending writes while separating leaf and generation trigger", async () => {
		const fixture = await createFixture();
		await startRun(fixture.lane, fixture.drive, currentRun(fixture.lane));
		const messageId = "01950000-0000-7000-8000-000000000010";
		const customId = "01950000-0000-7000-8000-000000000011";
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation?.state.kind !== "run") throw new Error("missing run");
			const nextState: RunState = {
				...operation.state,
				inbox: { ...operation.state.inbox, writes: [messageId, customId] },
			};
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry(messageId), {
						type: "message",
						payload: { role: "user", content: "projecting", timestamp: 3 },
					}),
					storedValues.setValue(storedValues.pendingEntry(customId), {
						type: "custom",
						customType: "display-only",
						payload: { value: true },
					}),
					storedValues.setValue(storedValues.operationState(operationId), nextState),
				],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		const run = currentRun(fixture.lane);
		if (run.phase.kind !== "checkpoint") throw new Error("missing checkpoint");

		await runCheckpoint(fixture.lane, fixture.drive, run, run.phase);

		const drained = currentRun(fixture.lane);
		if (drained.phase.kind !== "checkpoint") throw new Error("missing drained checkpoint");
		expect(fixture.lane.state.leafId).toBe(customId);
		expect(drained.phase.triggerEntryId).toBe(messageId);
		expect(drained.phase).toMatchObject({
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			skipInboxOnce: true,
		});
		expect(drained.inbox.writes).toEqual([]);
		await expectProjectionRestores(fixture);
	});
});

describe("runtime assistant generation", () => {
	it("commits intent before provider admission, preserves queued inbox state, and settles reserved ids", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		const hookStarted = deferred();
		const releaseHook = deferred();
		fixture.hooks.on("before_request", async () => {
			hookStarted.resolve();
			await releaseHook.promise;
			return undefined;
		});
		let effectPendingAtProvider = false;
		fixture.faux.setResponses([
			async () => {
				const state = await fixture.session.getValue(storedValues.operationState(operationId), BACKGROUND_CONTEXT);
				effectPendingAtProvider =
					state?.value.kind === "run" &&
					state.value.phase.kind === "assistant" &&
					state.value.phase.generation.status === "effect_pending";
				return fauxAssistantMessage("answer", { timestamp: 5 });
			},
		]);
		fixture.storage.clearCommitAttempts();
		const generating = runGeneration(fixture.lane, fixture.drive, currentRun(fixture.lane), ready);
		await hookStarted.promise;
		const steerId = "01950000-0000-7000-8000-000000000020";
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation?.state.kind !== "run") throw new Error("missing run");
			const nextState: RunState = {
				...operation.state,
				inbox: { ...operation.state.inbox, steer: [steerId] },
			};
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.pendingEntry(steerId), {
						type: "message",
						payload: { role: "user", content: "late steer", timestamp: 4 },
					}),
					storedValues.setValue(storedValues.operationState(operationId), nextState),
				],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		releaseHook.resolve();

		expect(await generating).toEqual({ kind: "continue" });
		expect(effectPendingAtProvider).toBe(true);
		const settled = currentRun(fixture.lane);
		expect(settled.inbox.steer).toEqual([steerId]);
		if (settled.phase.kind !== "checkpoint") throw new Error("response did not reach checkpoint");
		const responseId = settled.latestAssistantEntryId;
		if (responseId === null) throw new Error("missing response id");
		const entry = await fixture.session.getEntry(responseId, BACKGROUND_CONTEXT);
		expect(entry).toMatchObject({ id: responseId, type: "message", message: { content: [{ text: "answer" }] } });
		expect(
			await fixture.session.readList(
				storedValues.pendingAssistantFrames(operationId, responseId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		const attempts = fixture.storage.getCommitAttempts();
		expect(attempts.some((writes) => writesOperationState(writes, "effect_pending"))).toBe(true);
		const settlement = attempts.find((writes) => writes.some((write) => write.kind === "entry"));
		expect(
			settlement?.map((write) =>
				write.kind === "value" || write.kind === "list"
					? `${write.kind}:${write.op}:${write.namespace}`
					: write.kind,
			),
		).toEqual([
			"entry",
			"usage",
			"value:set:pi.lane.leaf",
			"list:delete:pi.pending.assistant_frame",
			"value:set:pi.op.state",
		]);
		expect(fixture.events.map((event) => event.type)).toEqual(
			expect.arrayContaining([
				"turn_start",
				"message_start",
				"message_update",
				"message_end",
				"entry_added",
				"usage",
				"turn_end",
			]),
		);
		await expectProjectionRestores(fixture);
	});

	it("does not await frame storage inside the provider event loop and persists frames in order", async () => {
		const backend = new FrameBlockingMemoryStorage({ now: () => 100 });
		const fixture = await createFixture(backend);
		const ready = await advanceToReady(fixture);
		const base = fixture.faux.provider;
		const provider: Provider = {
			id: base.id,
			name: base.name,
			auth: base.auth,
			getModels: () => base.getModels(),
			stream: (model, context, options) => base.stream(model, context, options),
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				const partial: AssistantMessage = {
					...fauxAssistantMessage([], { timestamp: 5 }),
					stopReason: "pending",
				};
				const text = { type: "text" as const, text: "" };
				queueMicrotask(() => {
					stream.push({ type: "start", partial });
					partial.content.push(text);
					stream.push({ type: "text_start", contentIndex: 0, partial });
					text.text = "ab";
					stream.push({ type: "text_delta", contentIndex: 0, delta: "ab", partial });
					stream.push({ type: "text_end", contentIndex: 0, content: "ab", partial });
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ab", { timestamp: 5 }) });
				});
				return stream;
			},
		};
		fixture.models.setProvider(provider);
		backend.blockNextFrame = true;
		fixture.storage.clearCommitAttempts();

		const generating = runGeneration(fixture.lane, fixture.drive, currentRun(fixture.lane), ready);
		await backend.frameStarted.promise;
		await expect
			.poll(() => fixture.events.filter((event) => event.type === "message_update").length)
			.toBeGreaterThan(1);
		backend.releaseFrame.resolve();
		await generating;

		const frames = fixture.storage
			.getCommitAttempts()
			.flatMap((writes) =>
				writes.flatMap((write) =>
					write.kind === "list" && write.op === "append" && write.namespace === "pi.pending.assistant_frame"
						? [write.value]
						: [],
				),
			);
		expect(
			frames.map((frame) =>
				typeof frame === "object" && frame !== null && "type" in frame ? frame.type : undefined,
			),
		).toEqual(["start", "text_start", "text_end"]);
		expect(frames[0]).toMatchObject({ partial: { content: [] } });
		expect(frames[1]).toMatchObject({ content: { text: "ab" } });
	});

	it("enters configuration failure without reserving response ids or calling the provider", async () => {
		const fixture = await createFixture();
		await fixture.lane.setActiveTools(["missing"], BACKGROUND_CONTEXT);
		const ready = await advanceToReady(fixture);
		fixture.storage.clearCommitAttempts();

		expect(await runGeneration(fixture.lane, fixture.drive, currentRun(fixture.lane), ready)).toEqual({
			kind: "continue",
		});

		const run = currentRun(fixture.lane);
		expect(run.phase).toMatchObject({
			kind: "failure_drain",
			error: { code: "configured_tools_unavailable", details: { tools: ["missing"] } },
			provenance: { kind: "configuration" },
		});
		expect(fixture.faux.state.callCount).toBe(0);
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.some((write) => write.kind === "entry" || write.kind === "usage"),
		).toBe(false);
		await expectProjectionRestores(fixture);
	});

	it("fails a missing captured model before reserving ids", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		fixture.models.deleteProvider(fixture.faux.provider.id);
		fixture.storage.clearCommitAttempts();

		expect(await runGeneration(fixture.lane, fixture.drive, currentRun(fixture.lane), ready)).toEqual({
			kind: "continue",
		});

		expect(currentRun(fixture.lane).phase).toMatchObject({
			kind: "failure_drain",
			error: { code: "model_unavailable" },
			provenance: { kind: "configuration" },
		});
		expect(fixture.faux.state.callCount).toBe(0);
		expect(
			fixture.storage
				.getCommitAttempts()
				.flat()
				.some((write) => write.kind === "entry" || write.kind === "usage"),
		).toBe(false);
		await expectProjectionRestores(fixture);
	});

	it("declines intent when cancellation or exact-owner replacement wins preparation", async () => {
		const cancelled = await createFixture();
		const cancelledReady = await advanceToReady(cancelled);
		const cancelHookStarted = deferred();
		const releaseCancelHook = deferred();
		cancelled.hooks.on("before_request", async () => {
			cancelHookStarted.resolve();
			await releaseCancelHook.promise;
			return undefined;
		});
		cancelled.storage.clearCommitAttempts();
		const cancelling = runGeneration(cancelled.lane, cancelled.drive, currentRun(cancelled.lane), cancelledReady);
		await cancelHookStarted.promise;
		await cancelled.lane.command((state) => {
			const operation = state.operation;
			if (operation?.state.kind !== "run") throw new Error("missing run");
			const nextState: RunState = {
				...operation.state,
				control: { status: "cancel_requested", requestedAt: 10, drainedSteer: [], drainedFollowUp: [] },
			};
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(operationId), nextState)],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		releaseCancelHook.resolve();
		expect(await cancelling).toEqual({ kind: "continue" });
		expect(cancelled.faux.state.callCount).toBe(0);
		expect(
			cancelled.storage.getCommitAttempts().some((writes) => writesOperationState(writes, "effect_pending")),
		).toBe(false);

		const replaced = await createFixture();
		const replacedReady = await advanceToReady(replaced);
		const ownerHookStarted = deferred();
		const releaseOwnerHook = deferred();
		replaced.hooks.on("before_request", async () => {
			ownerHookStarted.resolve();
			await releaseOwnerHook.promise;
			return undefined;
		});
		replaced.storage.clearCommitAttempts();
		const losing = runGeneration(replaced.lane, replaced.drive, currentRun(replaced.lane), replacedReady);
		await ownerHookStarted.promise;
		replaced.lane.activeDrive = new Drive({ operationId }, BACKGROUND_CONTEXT);
		releaseOwnerHook.resolve();
		expect(await losing).toEqual({ kind: "lost_ownership" });
		expect(replaced.faux.state.callCount).toBe(0);
		expect(replaced.storage.getCommitAttempts()).toEqual([]);
	});

	it("recovers an orphan with no frames into a zero-usage retry wait", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		const responseEntryId = "01950000-0000-7000-8000-000000000028";
		const usageId = "01950000-0000-7000-8000-000000000029";
		const pending: Extract<Generation, { status: "effect_pending" }> = {
			status: "effect_pending",
			context: { ...ready.context, retryPolicy: { maxAttempts: 2, baseDelayMs: 1 } },
			attempt: 1,
			responseEntryId,
			usageId,
			intendedOutputLimit: 100,
			contextWindow: 1_000,
		};
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation?.state.kind !== "run") throw new Error("missing run");
			const nextState: RunState = {
				...operation.state,
				phase: { kind: "assistant", generation: pending },
			};
			return {
				kind: "commit",
				writes: [storedValues.setValue(storedValues.operationState(operationId), nextState)],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);

		await recoverAssistantGeneration(fixture.lane, fixture.drive, currentRun(fixture.lane), pending);

		const entry = (await fixture.session.getEntry(responseEntryId, BACKGROUND_CONTEXT)) as MessageEntry;
		expect(entry.message).toMatchObject({
			api: "unknown",
			provider: ready.context.configuration.model.provider,
			model: ready.context.configuration.model.modelId,
			content: [],
			stopReason: "error",
			usage: { totalTokens: 0 },
		});
		expect(currentRun(fixture.lane).phase).toMatchObject({
			kind: "assistant",
			generation: { status: "retry_wait", nextAttempt: 2 },
		});
		expect(fixture.faux.state.callCount).toBe(0);
		await expectProjectionRestores(fixture);
	});

	it("recovers an orphan from committed frames without a provider or response hook", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		const responseEntryId = "01950000-0000-7000-8000-000000000030";
		const usageId = "01950000-0000-7000-8000-000000000031";
		const partial: AssistantMessage = {
			...fauxAssistantMessage([], { timestamp: 6 }),
			stopReason: "pending",
		};
		const pending: Extract<Generation, { status: "effect_pending" }> = {
			status: "effect_pending",
			context: { ...ready.context, retryPolicy: { maxAttempts: 1, baseDelayMs: 1 } },
			attempt: 1,
			responseEntryId,
			usageId,
			intendedOutputLimit: 100,
			contextWindow: 1_000,
		};
		await fixture.lane.command((state) => {
			const operation = state.operation;
			if (operation?.state.kind !== "run") throw new Error("missing run");
			const nextState: RunState = {
				...operation.state,
				phase: { kind: "assistant", generation: pending },
			};
			return {
				kind: "commit",
				writes: [
					storedValues.setValue(storedValues.operationState(operationId), nextState),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "start",
						partial,
					}),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "text_start",
						contentIndex: 0,
						content: { type: "text", text: "" },
					}),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "text_delta",
						contentIndex: 0,
						delta: "draft",
					}),
					storedValues.appendList(storedValues.pendingAssistantFrames(operationId, responseEntryId), {
						type: "text_end",
						contentIndex: 0,
						content: "corrected",
					}),
				],
				next: { ...state, operation: { meta: operation.meta, state: nextState } },
				materialize: () => undefined,
			};
		}, BACKGROUND_CONTEXT);
		let afterResponseCalls = 0;
		fixture.hooks.on("after_response", () => {
			afterResponseCalls++;
			return undefined;
		});

		expect(await recoverAssistantGeneration(fixture.lane, fixture.drive, currentRun(fixture.lane), pending)).toEqual({
			kind: "continue",
		});

		expect(fixture.faux.state.callCount).toBe(0);
		expect(afterResponseCalls).toBe(0);
		const entry = (await fixture.session.getEntry(responseEntryId, BACKGROUND_CONTEXT)) as MessageEntry;
		expect(entry.message).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "corrected" }],
			stopReason: "error",
			usage: { input: 0, output: 0 },
		});
		expect(currentRun(fixture.lane).phase).toMatchObject({ kind: "failure_drain" });
		expect(
			await fixture.session.readList(
				storedValues.pendingAssistantFrames(operationId, responseEntryId),
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toEqual([]);
		expect(
			fixture.events.filter((event) => "recovery" in event && event.recovery).map((event) => event.type),
		).toEqual(["message_start", "message_end", "entry_added"]);
		await expectProjectionRestores(fixture);
	});

	it("finishes the no-tool run with terminal cleanup and a hydratable final assistant", async () => {
		const fixture = await createFixture();
		const ready = await advanceToReady(fixture);
		fixture.faux.setResponses([fauxAssistantMessage("done", { timestamp: 7 })]);
		await runGeneration(fixture.lane, fixture.drive, currentRun(fixture.lane), ready);
		const run = currentRun(fixture.lane);
		if (run.phase.kind !== "checkpoint") throw new Error("missing terminal checkpoint");

		const result = await runCheckpoint(fixture.lane, fixture.drive, run, run.phase);

		expect(result).toMatchObject({
			kind: "settled",
			outcome: { operation: "run", runId: operationId, kind: "completed", finalMessage: { role: "assistant" } },
		});
		expect(fixture.lane.state.operation).toBeNull();
		expect(fixture.lane.state.lastResult).toMatchObject({
			operationId,
			kind: "run",
			outcome: "completed",
			runCompletion: "assistant",
		});
		expect(
			await fixture.session.getValue(storedValues.operationMeta(operationId), BACKGROUND_CONTEXT),
		).toBeUndefined();
		expect(
			await fixture.session.getValue(storedValues.operationState(operationId), BACKGROUND_CONTEXT),
		).toBeUndefined();
		expect(fixture.events.filter((event) => event.type === "run_end")).toHaveLength(1);
		await expectProjectionRestores(fixture);
	});
});
