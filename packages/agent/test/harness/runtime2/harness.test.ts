import { createModels, fauxAssistantMessage, fauxProvider } from "@draht/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness, HarnessClosed, HarnessFault } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import type { Result } from "../../../src/harness/result.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime2/harness.ts";
import { Lane } from "../../../src/harness/runtime2/lane.ts";
import { MemorySessionRepo, type MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	LaneConfiguration,
	NavigationState,
	OperationMeta,
	OperationState,
	RunState,
	Session,
} from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import type { AgentHarnessTool } from "../../../src/harness/types.ts";
import { ControlledMemoryStorage, deferred, FailingMemoryStorage } from "./test-utils.ts";

const repos: MemorySessionRepo[] = [];
const standaloneSessions: Session[] = [];
const configuredMain: LaneConfiguration = {
	model: { provider: "configured", modelId: "main" },
	thinkingLevel: "low",
	activeToolNames: ["configured-tool"],
};
const toolParameters = Type.Object({});
const applicationValue = storedValues.value<{ durable: boolean }>("test.application.value");

function tool(name: string): AgentHarnessTool<undefined, typeof toolParameters> {
	return {
		name,
		label: name,
		description: name,
		parameters: toolParameters,
		replay: "safe",
		execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
	};
}

async function createSession(): Promise<Session> {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	return repo.create({}, BACKGROUND_CONTEXT);
}

async function configureMain(session: Session, configuration: LaneConfiguration = configuredMain): Promise<void> {
	await session.mutate(
		"main",
		(mutator) =>
			mutator.commit([storedValues.setValue(storedValues.laneConfig("main"), configuration)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
	);
}

async function createStorageSession(storage: MemoryStorage): Promise<Session> {
	const session = new StorageBackedSession(
		{ id: `runtime2-storage-${standaloneSessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	standaloneSessions.push(session);
	await session.mutate(
		"main",
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.laneLeaf("main"), null),
					storedValues.setValue(storedValues.laneState("main"), { currentOperationId: null, pendingNextRun: [] }),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	return session;
}

async function createFailingSession(): Promise<{ session: Session; storage: FailingMemoryStorage }> {
	const storage = new FailingMemoryStorage();
	return { session: await createStorageSession(storage), storage };
}

function unwrap<T>(result: Result<T, unknown>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

function modelOptions(session: Session) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	return { session, models, model: faux.getModel() };
}

function operationMeta(session: Session, intent: OperationMeta["intent"], startedAt = 1, lane = "main"): OperationMeta {
	return { operationId: session.idGenerator.next(), lane, sourceLeafId: null, startedAt, intent };
}

async function installOperation(session: Session, meta: OperationMeta, state: OperationState): Promise<void> {
	await session.mutate(
		meta.lane,
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.operationMeta(meta.operationId), meta),
					storedValues.setValue(storedValues.operationState(meta.operationId), state),
					storedValues.setValue(storedValues.laneState(meta.lane), {
						currentOperationId: meta.operationId,
						pendingNextRun: [],
					}),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
}

function runState(triggerEntryId: string): RunState {
	return {
		kind: "run",
		control: { status: "running" },
		settings: {
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		},
		phase: {
			kind: "checkpoint",
			continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
			triggerEntryId,
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
}

afterEach(async () => {
	for (const repo of repos.splice(0)) await repo.close(BACKGROUND_CONTEXT);
	for (const session of standaloneSessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime2 AgentHarness", () => {
	it("is selected by the public AgentHarness constructor", async () => {
		const session = await createSession();

		const { harness } = await AgentHarness.create(modelOptions(session), BACKGROUND_CONTEXT);

		expect(harness).toBeInstanceOf(Harness);
	});

	it("rejects duplicate tool names as caller input", async () => {
		const session = await createSession();
		const duplicate = tool("duplicate");

		await expect(
			createAgentHarness({ ...modelOptions(session), tools: [duplicate, duplicate] }, BACKGROUND_CONTEXT),
		).rejects.toBeInstanceOf(TypeError);
	});

	it("owns initial config and publishes replacements before ordered events", async () => {
		const session = await createSession();
		const initialTools = [tool("initial")];
		const initialResources = { skills: [] };
		const initialStreamOptions = { timeoutMs: 10 };
		const initialRetry = { enabled: true, maxRetries: 2, baseDelayMs: 20 };
		const initialCompaction = { enabled: false, reserveTokens: 100, keepRecentTokens: 200 };
		const { harness } = await createAgentHarness(
			{
				...modelOptions(session),
				tools: initialTools,
				resources: initialResources,
				streamOptions: initialStreamOptions,
				retry: initialRetry,
				compaction: initialCompaction,
				steeringMode: "one-at-a-time",
				followUpMode: "one-at-a-time",
				toolExecution: "sequential",
			},
			BACKGROUND_CONTEXT,
		);

		expect(await harness.getTools(BACKGROUND_CONTEXT)).toBe(initialTools);
		expect(await harness.getResources(BACKGROUND_CONTEXT)).toBe(initialResources);
		expect(await harness.getStreamOptions(BACKGROUND_CONTEXT)).toBe(initialStreamOptions);
		expect(await harness.getRetryPolicy(BACKGROUND_CONTEXT)).toBe(initialRetry);
		expect(await harness.getCompactionSettings(BACKGROUND_CONTEXT)).toBe(initialCompaction);
		expect(await harness.getSteeringMode(BACKGROUND_CONTEXT)).toBe("one-at-a-time");
		expect(await harness.getFollowUpMode(BACKGROUND_CONTEXT)).toBe("one-at-a-time");

		const events: string[] = [];
		let retryAtEvent: typeof initialRetry | undefined;
		harness.events.on("config_update", async (event) => {
			events.push(event.property);
			if (event.property === "retryPolicy") retryAtEvent = await harness.getRetryPolicy(BACKGROUND_CONTEXT);
		});
		const nextTools = [tool("next")];
		const nextResources = { promptTemplates: [] };
		const nextStreamOptions = { maxRetries: 4 };
		const nextRetry = { enabled: false, maxRetries: 0, baseDelayMs: 0 };
		const nextCompaction = { enabled: true, reserveTokens: 300, keepRecentTokens: 400 };

		await harness.setTools(nextTools, BACKGROUND_CONTEXT);
		await harness.setResources(nextResources, BACKGROUND_CONTEXT);
		await harness.setStreamOptions(nextStreamOptions, BACKGROUND_CONTEXT);
		await harness.setRetryPolicy(nextRetry, BACKGROUND_CONTEXT);
		await harness.setCompactionSettings(nextCompaction, BACKGROUND_CONTEXT);
		await harness.setSteeringMode("all", BACKGROUND_CONTEXT);
		await harness.setFollowUpMode("all", BACKGROUND_CONTEXT);

		expect(await harness.getTools(BACKGROUND_CONTEXT)).toBe(nextTools);
		expect(await harness.getResources(BACKGROUND_CONTEXT)).toBe(nextResources);
		expect(await harness.getStreamOptions(BACKGROUND_CONTEXT)).toBe(nextStreamOptions);
		expect(await harness.getRetryPolicy(BACKGROUND_CONTEXT)).toBe(nextRetry);
		expect(await harness.getCompactionSettings(BACKGROUND_CONTEXT)).toBe(nextCompaction);
		expect(await harness.getSteeringMode(BACKGROUND_CONTEXT)).toBe("all");
		expect(await harness.getFollowUpMode(BACKGROUND_CONTEXT)).toBe("all");
		expect(retryAtEvent).toBe(nextRetry);
		expect(events).toEqual([
			"tools",
			"resources",
			"streamOptions",
			"retryPolicy",
			"compactionSettings",
			"steeringMode",
			"followUpMode",
		]);

		const penultimateResources = { skills: [] };
		const finalResources = { promptTemplates: [] };
		await Promise.all([
			harness.setResources(penultimateResources, BACKGROUND_CONTEXT),
			harness.setResources(finalResources, BACKGROUND_CONTEXT),
		]);
		expect(await harness.getResources(BACKGROUND_CONTEXT)).toBe(finalResources);
		expect(events.slice(-2)).toEqual(["resources", "resources"]);
	});

	it("emits lane config changes after committed memory publication", async () => {
		const session = await createSession();
		const options = modelOptions(session);
		const { harness } = await createAgentHarness(options, BACKGROUND_CONTEXT);
		const events: unknown[] = [];
		let thinkingAtEvent: string | undefined;
		harness.events.on("config_update", async (event) => {
			events.push(event);
			if (event.property === "thinkingLevel") thinkingAtEvent = await harness.getThinkingLevel(BACKGROUND_CONTEXT);
		});

		await harness.setModel(options.model, BACKGROUND_CONTEXT);
		await harness.setThinkingLevel("high", BACKGROUND_CONTEXT);
		await harness.setActiveTools(["read"], BACKGROUND_CONTEXT);

		const model = { provider: options.model.provider, modelId: options.model.id };
		expect(events).toEqual([
			{ type: "config_update", property: "model", previous: model, value: model, lane: "main" },
			{ type: "config_update", property: "thinkingLevel", previous: "off", value: "high", lane: "main" },
			{ type: "config_update", property: "activeTools", previous: [], value: ["read"], lane: "main" },
		]);
		expect(thinkingAtEvent).toBe("high");
	});

	it("rejects invalid config without publication or fault", async () => {
		const session = await createSession();
		const initialTools = [tool("initial")];
		const { harness } = await createAgentHarness(
			{ ...modelOptions(session), tools: initialTools },
			BACKGROUND_CONTEXT,
		);
		const events: string[] = [];
		harness.events.on("config_update", (event) => {
			events.push(event.property);
		});
		const duplicate = tool("duplicate");

		expect(() => harness.setTools([duplicate, duplicate], BACKGROUND_CONTEXT)).toThrow(TypeError);
		expect(() =>
			harness.setRetryPolicy({ enabled: true, maxRetries: -1, baseDelayMs: 0 }, BACKGROUND_CONTEXT),
		).toThrow(RangeError);
		expect(() =>
			harness.setCompactionSettings({ enabled: true, reserveTokens: -1, keepRecentTokens: 0 }, BACKGROUND_CONTEXT),
		).toThrow(RangeError);

		expect(await harness.getTools(BACKGROUND_CONTEXT)).toBe(initialTools);
		expect(await harness.getRetryPolicy(BACKGROUND_CONTEXT)).toEqual({
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 1_000,
		});
		expect(await harness.getCompactionSettings(BACKGROUND_CONTEXT)).toBe(DEFAULT_COMPACTION_SETTINGS);
		expect(events).toEqual([]);
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toHaveLength(1);
	});

	it("validates initial config before writing durable state", async () => {
		const invalidRetrySession = await createSession();
		await expect(
			createAgentHarness(
				{
					...modelOptions(invalidRetrySession),
					retry: { enabled: true, maxRetries: -1, baseDelayMs: 0 },
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toBeInstanceOf(RangeError);
		expect(await invalidRetrySession.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();

		const invalidCompactionSession = await createSession();
		await expect(
			createAgentHarness(
				{
					...modelOptions(invalidCompactionSession),
					compaction: { enabled: true, reserveTokens: -1, keepRecentTokens: 0 },
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toBeInstanceOf(RangeError);
		expect(
			await invalidCompactionSession.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT),
		).toBeUndefined();
	});

	it("seeds main and returns the concrete harness as its main lane", async () => {
		const session = await createSession();
		const options = modelOptions(session);

		const { harness, suspended } = await createAgentHarness(
			{
				...options,
				thinkingLevel: "high",
				activeToolNames: ["read"],
			},
			BACKGROUND_CONTEXT,
		);

		expect(harness).toBeInstanceOf(Harness);
		expect(await harness.lane("main", BACKGROUND_CONTEXT)).toBe(harness);
		expect(await harness.getLeafId(BACKGROUND_CONTEXT)).toBeNull();
		expect(suspended).toEqual([]);
		expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value).toEqual({
			model: { provider: options.model.provider, modelId: options.model.id },
			thinkingLevel: "high",
			activeToolNames: ["read"],
		});
	});

	it("appends idle entries through owned lane state", async () => {
		const session = await createSession();
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);

		const entryId = await harness.sessionTree.appendMessage(
			{ role: "user", content: "hello", timestamp: 1 },
			BACKGROUND_CONTEXT,
		);

		expect(await harness.getLeafId(BACKGROUND_CONTEXT)).toBe(entryId);
		expect((await session.getValue(storedValues.laneLeaf("main"), BACKGROUND_CONTEXT))?.value).toBe(entryId);
		expect(await harness.sessionTree.findEntriesOnBranch({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).toMatchObject(
			[{ id: entryId, parentId: null, message: { role: "user", content: "hello" } }],
		);
	});

	it("restores every configured lane without replacing its configuration", async () => {
		const session = await createSession();
		const workerConfiguration: LaneConfiguration = {
			model: { provider: "configured", modelId: "worker" },
			thinkingLevel: "medium",
			activeToolNames: [],
		};
		await session.mutate(
			"main",
			(mutator) =>
				mutator.commit(
					[storedValues.setValue(storedValues.laneConfig("main"), configuredMain)],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		await session.createLane("worker", null, workerConfiguration, BACKGROUND_CONTEXT);
		const before = await Promise.all([
			session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT),
			session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT),
		]);

		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);
		const worker = await harness.lane("worker", BACKGROUND_CONTEXT);

		expect(worker).toBeInstanceOf(Lane);
		expect(await worker?.getLeafId(BACKGROUND_CONTEXT)).toBeNull();
		expect((await harness.lanes(BACKGROUND_CONTEXT)).map((lane) => lane.name).sort()).toEqual(["main", "worker"]);
		expect(
			await Promise.all([
				session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT),
				session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT),
			]),
		).toEqual(before);
	});

	it("creates a lane from the captured seed and publishes it after commit", async () => {
		const session = await createSession();
		const options = modelOptions(session);
		const { harness } = await createAgentHarness(
			{
				...options,
				thinkingLevel: "high",
				activeToolNames: ["read"],
			},
			BACKGROUND_CONTEXT,
		);
		const anchor = await harness.sessionTree.appendCustomEntry("anchor", undefined, BACKGROUND_CONTEXT);
		await harness.setThinkingLevel("low", BACKGROUND_CONTEXT);
		let durableConfigurationAtEvent: LaneConfiguration | undefined;
		let laneVisibleAtEvent = false;
		harness.events.on("lane_created", async () => {
			durableConfigurationAtEvent = (await session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT))
				?.value;
			laneVisibleAtEvent = (await harness.lane("worker", BACKGROUND_CONTEXT)) !== undefined;
		});

		const worker = unwrap(await harness.createLane("worker", anchor, BACKGROUND_CONTEXT));

		expect(await harness.lane("worker", BACKGROUND_CONTEXT)).toBe(worker);
		expect(await worker.getLeafId(BACKGROUND_CONTEXT)).toBe(anchor);
		expect(await worker.getThinkingLevel(BACKGROUND_CONTEXT)).toBe("high");
		expect(await worker.getActiveTools(BACKGROUND_CONTEXT)).toEqual(["read"]);
		expect(durableConfigurationAtEvent).toEqual({
			model: { provider: options.model.provider, modelId: options.model.id },
			thinkingLevel: "high",
			activeToolNames: ["read"],
		});
		expect(laneVisibleAtEvent).toBe(true);
		expect((await session.getValue(storedValues.laneState("worker"), BACKGROUND_CONTEXT))?.value).toEqual({
			currentOperationId: null,
			pendingNextRun: [],
		});
	});

	it("maps expected lane creation failures without faulting", async () => {
		const session = await createSession();
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);
		unwrap(await harness.createLane("worker", null, BACKGROUND_CONTEXT));

		expect(await harness.createLane("worker", null, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "LaneExists", lane: "worker" },
		});
		expect(await harness.createLane("", null, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "InvalidLane", lane: "", reason: "lane name must not be empty" },
		});
		expect(await harness.createLane("missing", "unknown-entry", BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "UnknownTarget", targetId: "unknown-entry" },
		});
		expect((await harness.lanes(BACKGROUND_CONTEXT)).map((lane) => lane.name).sort()).toEqual(["main", "worker"]);
	});

	it("faults without publishing a lane when creation commit fails", async () => {
		const { session, storage } = await createFailingSession();
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		const failure = new Error("create lane failed");
		storage.failure = failure;

		let rejected: unknown;
		try {
			await harness.createLane("worker", null, BACKGROUND_CONTEXT);
		} catch (error) {
			rejected = error;
		}

		expect(rejected).toBeInstanceOf(HarnessFault);
		if (!(rejected instanceof HarnessFault)) throw new Error("missing harness fault");
		expect(rejected.cause).toBe(failure);
		await expect(harness.createLane("later", null, BACKGROUND_CONTEXT)).rejects.toBe(rejected);
		expect(harness.lanesByName.has("worker")).toBe(false);
		expect(await session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(storedValues.laneLeaf("worker"), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(storedValues.laneState("worker"), BACKGROUND_CONTEXT)).toBeUndefined();
	});

	it("returns Closed when lane creation starts after close", async () => {
		const session = await createSession();
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);

		expect(await harness.createLane("late", null, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "Closed" },
		});
		await expect(harness.getTools(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
		await expect(harness.setResources({}, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
	});

	it("publishes an admitted lane creation before close finishes", async () => {
		const storage = new ControlledMemoryStorage();
		const session = await createStorageSession(storage);
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};
		const creating = harness.createLane("worker", null, BACKGROUND_CONTEXT);
		await commitStarted.promise;
		const closing = harness.close(BACKGROUND_CONTEXT);
		releaseCommit.resolve();

		const worker = unwrap(await creating);
		await closing;

		expect(harness.lanesByName.get("worker")).toBe(worker);
		await expect(worker.getLeafId(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
	});

	it("classifies assistant-ready suspensions from captured identities", async () => {
		const session = await createSession();
		const options = modelOptions(session);
		await configureMain(session);
		const prompt = { role: "user" as const, content: "hello", timestamp: 1 };
		const promptId = await session.appendMessage(prompt, BACKGROUND_CONTEXT);
		const meta = operationMeta(session, { kind: "run", promptEntryIds: [promptId] }, 2);
		const { operationId } = meta;
		const captured: LaneConfiguration = {
			model: { provider: "missing-provider", modelId: "missing-model" },
			thinkingLevel: "off",
			activeToolNames: ["missing-tool"],
		};
		await installOperation(session, meta, {
			...runState(promptId),
			phase: {
				kind: "assistant",
				generation: {
					status: "ready",
					context: {
						stepId: session.idGenerator.next(),
						triggerEntryId: promptId,
						configuration: captured,
						streamOptions: {},
						retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
						overflowRecoveryUsed: false,
					},
					nextAttempt: 1,
				},
			},
		});

		const { harness, suspended } = await createAgentHarness(
			{ ...options, tools: [tool("available")] },
			BACKGROUND_CONTEXT,
		);
		const expected = {
			lane: "main",
			operationId,
			kind: "run" as const,
			startedAt: 2,
			prompt: [prompt],
			reason: "crash" as const,
			missing: { tools: ["missing-tool"], model: "missing-provider/missing-model" },
		};

		expect(suspended).toEqual([expected]);
		expect((await harness.inspectExecution(BACKGROUND_CONTEXT)).current?.suspended).toBe(suspended[0]);
		const getEntries = vi.spyOn(session, "getEntries");
		await harness.inspectExecution(BACKGROUND_CONTEXT);
		await harness.lanes(BACKGROUND_CONTEXT);
		expect(getEntries).not.toHaveBeenCalled();
	});

	it("classifies tool-phase suspensions from captured tools", async () => {
		const session = await createSession();
		const options = modelOptions(session);
		await configureMain(session);
		const meta = operationMeta(session, { kind: "run", promptEntryIds: [] });
		const { operationId } = meta;
		await installOperation(session, meta, {
			...runState(session.idGenerator.next()),
			phase: {
				kind: "tools",
				batch: {
					assistantEntryId: session.idGenerator.next(),
					configuration: { ...configuredMain, activeToolNames: ["missing-tool"] },
					turnId: session.idGenerator.next(),
					calls: [],
				},
			},
		});

		const { harness, suspended } = await createAgentHarness(options, BACKGROUND_CONTEXT);

		expect(suspended).toEqual([
			{
				lane: "main",
				operationId,
				kind: "run",
				startedAt: 1,
				prompt: [],
				reason: "crash",
				missing: { tools: ["missing-tool"] },
			},
		]);
		expect((await harness.inspectExecution(BACKGROUND_CONTEXT)).current?.suspended).toBe(suspended[0]);
	});

	it("restores deferred suspension handles from their source entries", async () => {
		const session = await createSession();
		const options = modelOptions(session);
		await configureMain(session);
		const prompt = { role: "user" as const, content: "defer", timestamp: 1 };
		const promptId = await session.appendMessage(prompt, BACKGROUND_CONTEXT);
		const handle = {
			provider: options.model.provider,
			modelId: options.model.id,
			api: options.model.api,
			id: "deferred-1",
		};
		const sourceId = await session.appendMessage(
			fauxAssistantMessage([], { stopReason: "deferred", deferred: handle }),
			BACKGROUND_CONTEXT,
		);
		const meta = operationMeta(session, { kind: "run", promptEntryIds: [promptId] }, 2);
		const { operationId } = meta;
		await installOperation(session, meta, {
			...runState(promptId),
			phase: {
				kind: "deferred",
				deferred: {
					status: "suspended",
					stepId: session.idGenerator.next(),
					sourceEntryId: sourceId,
					poll: 0,
					configuration: configuredMain,
					streamOptions: {},
				},
			},
		});

		const { harness, suspended } = await createAgentHarness(options, BACKGROUND_CONTEXT);

		expect(suspended).toEqual([
			{
				lane: "main",
				operationId,
				kind: "run",
				startedAt: 2,
				prompt: [prompt],
				reason: "deferred",
				deferred: handle,
			},
		]);
		expect((await harness.inspectExecution(BACKGROUND_CONTEXT)).current?.suspended).toBe(suspended[0]);
	});

	it("faults harness creation when restored suspension payloads are invalid", async () => {
		const session = await createSession();
		await configureMain(session);
		const meta = operationMeta(session, { kind: "run", promptEntryIds: [] });
		await installOperation(session, meta, {
			...runState(session.idGenerator.next()),
			phase: {
				kind: "deferred",
				deferred: {
					status: "suspended",
					stepId: session.idGenerator.next(),
					sourceEntryId: "missing-source",
					poll: 0,
					configuration: configuredMain,
					streamOptions: {},
				},
			},
		});

		await expect(createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT)).rejects.toMatchObject({
			name: "HarnessFault",
			cause: { name: "SessionInvariantError", message: "Deferred suspension source is invalid" },
		});

		const missingPromptSession = await createSession();
		await configureMain(missingPromptSession);
		await installOperation(
			missingPromptSession,
			operationMeta(missingPromptSession, { kind: "run", promptEntryIds: ["missing-prompt"] }),
			runState(missingPromptSession.idGenerator.next()),
		);
		await expect(createAgentHarness(modelOptions(missingPromptSession), BACKGROUND_CONTEXT)).rejects.toMatchObject({
			name: "HarnessFault",
			cause: { name: "SessionInvariantError", message: "Prompt entry missing-prompt is missing" },
		});
	});

	it("reports restored cancellation as aborting without a suspension descriptor", async () => {
		const session = await createSession();
		await configureMain(session);
		const meta = operationMeta(session, { kind: "run", promptEntryIds: [] });
		const { operationId } = meta;
		await installOperation(session, meta, {
			...runState(session.idGenerator.next()),
			control: { status: "cancel_requested", requestedAt: 2, drainedSteer: [], drainedFollowUp: [] },
		});

		const { harness, suspended } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);

		expect(suspended).toHaveLength(1);
		expect(await harness.inspectExecution(BACKGROUND_CONTEXT)).toEqual({
			lane: "main",
			leafId: null,
			current: { id: operationId, kind: "run", status: "aborting", startedAt: 1 },
		});
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toEqual([
			{ name: "main", leafId: null, operation: { id: operationId, kind: "run", status: "aborting" } },
		]);
	});

	it("inspects idle last results from owned state", async () => {
		const session = await createSession();
		const operationId = session.idGenerator.next();
		const lastResult = {
			operationId,
			kind: "navigation" as const,
			outcome: "completed" as const,
			oldLeafId: null,
			leafId: null,
		};
		await session.mutate(
			"main",
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.laneConfig("main"), configuredMain),
						storedValues.setValue(storedValues.laneLastResult("main"), lastResult),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);

		expect(await harness.inspectExecution(BACKGROUND_CONTEXT)).toEqual({
			lane: "main",
			leafId: null,
			current: null,
			lastResult,
		});
	});

	it("persists application values through idle and active lane facades", async () => {
		const session = await createSession();
		await configureMain(session);
		const meta = operationMeta(session, { kind: "run", promptEntryIds: [] });
		const { operationId } = meta;
		await installOperation(session, meta, runState(session.idGenerator.next()));
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);
		const worker = unwrap(await harness.createLane("worker", null, BACKGROUND_CONTEXT));
		const updates: unknown[] = [];
		harness.events.on("value_update", (event) => {
			updates.push(event);
		});

		await worker.sessionTree.setName("idle-worker", BACKGROUND_CONTEXT);
		await harness.sessionTree.setName("active-main", BACKGROUND_CONTEXT);
		await harness.sessionTree.setLabel("target", "label", BACKGROUND_CONTEXT);
		await harness.sessionTree.setValue(applicationValue, { durable: true }, BACKGROUND_CONTEXT);

		expect(await session.getName(BACKGROUND_CONTEXT)).toBe("active-main");
		expect(await session.getLabel("target", BACKGROUND_CONTEXT)).toBe("label");
		expect((await session.getValue(applicationValue, BACKGROUND_CONTEXT))?.value).toEqual({ durable: true });
		expect(updates).toEqual([
			{ type: "value_update", value: "session_name", name: "idle-worker" },
			{ type: "value_update", value: "session_name", name: "active-main" },
			{ type: "value_update", value: "entry_label", targetId: "target", label: "label" },
		]);
		expect((await harness.inspectExecution(BACKGROUND_CONTEXT)).current?.id).toBe(operationId);
	});

	it("reports restored open operations without activating them", async () => {
		const repo = new MemorySessionRepo();
		repos.push(repo);
		const session = await repo.create({}, BACKGROUND_CONTEXT);
		await configureMain(session);
		const meta = operationMeta(session, { kind: "run", promptEntryIds: [] });
		const { operationId } = meta;
		const state = runState(session.idGenerator.next());
		await installOperation(session, meta, state);

		const { harness, suspended } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);

		expect(suspended).toEqual([
			{ lane: "main", operationId, kind: "run", startedAt: 1, prompt: [], reason: "crash" },
		]);
		expect(await harness.inspectExecution(BACKGROUND_CONTEXT)).toEqual({
			lane: "main",
			leafId: null,
			current: { id: operationId, kind: "run", status: "suspended", startedAt: 1, suspended: suspended[0] },
		});
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toEqual([
			{ name: "main", leafId: null, operation: { id: operationId, kind: "run", status: "suspended" } },
		]);
		const pendingId = await harness.sessionTree.appendCustomEntry("note", { text: "queued" }, BACKGROUND_CONTEXT);
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		const updatedState = harness.state.operation?.state;
		if (updatedState?.kind !== "run") throw new Error("missing updated run state");
		expect(updatedState.inbox.writes).toEqual([pendingId]);
		expect((await session.getValue(storedValues.pendingEntry(pendingId), BACKGROUND_CONTEXT))?.value).toEqual({
			type: "custom",
			customType: "note",
			payload: { text: "queued" },
		});
		expect((await session.getValue(storedValues.laneLeaf("main"), BACKGROUND_CONTEXT))?.value).toBeNull();

		const closing = harness.close(BACKGROUND_CONTEXT);
		expect(harness.close(BACKGROUND_CONTEXT)).toBe(closing);
		await closing;
		await expect(harness.lanes(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
		await expect(harness.inspectExecution(BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessClosed);
		const reopened = await repo.open(session.metadata, BACKGROUND_CONTEXT);
		expect(
			(await reopened.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value.currentOperationId,
		).toBe(operationId);
		expect((await reopened.getValue(storedValues.operationMeta(operationId), BACKGROUND_CONTEXT))?.value).toEqual(
			meta,
		);
		expect((await reopened.getValue(storedValues.operationState(operationId), BACKGROUND_CONTEXT))?.value).toEqual(
			updatedState,
		);
	});

	it("uses owned state after creation and starts no option callbacks", async () => {
		const session = await createSession();
		const forbidden = vi.fn(() => {
			throw new Error("effect started");
		});
		const { harness } = await createAgentHarness(
			{
				...modelOptions(session),
				toolContext: forbidden,
				systemPrompt: forbidden,
				toProviderMessages: forbidden,
				entryProjectors: { forbidden },
			},
			BACKGROUND_CONTEXT,
		);
		const mutate = vi.spyOn(session, "mutate");
		const getValue = vi.spyOn(session, "getValue");
		const scanValues = vi.spyOn(session, "scanValues");
		const readList = vi.spyOn(session, "readList");

		expect(await harness.lane("main", BACKGROUND_CONTEXT)).toBe(harness);
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toHaveLength(1);
		expect(await harness.getLeafId(BACKGROUND_CONTEXT)).toBeNull();
		expect(await harness.getLastResult(BACKGROUND_CONTEXT)).toBeUndefined();
		expect(forbidden).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
		expect(getValue).not.toHaveBeenCalled();
		expect(scanValues).not.toHaveBeenCalled();
		expect(readList).not.toHaveBeenCalled();
		expect(await harness.getTools(BACKGROUND_CONTEXT)).toEqual([]);
		expect(await harness.getResources(BACKGROUND_CONTEXT)).toEqual({});
		expect(await harness.getStreamOptions(BACKGROUND_CONTEXT)).toEqual({});
		expect(await harness.getRetryPolicy(BACKGROUND_CONTEXT)).toEqual({
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 1_000,
		});
		expect(await harness.getCompactionSettings(BACKGROUND_CONTEXT)).toBe(DEFAULT_COMPACTION_SETTINGS);
		expect(await harness.getSteeringMode(BACKGROUND_CONTEXT)).toBe("all");
		expect(await harness.getFollowUpMode(BACKGROUND_CONTEXT)).toBe("all");
	});

	it("rejects append during a structural operation without faulting", async () => {
		const session = await createSession();
		await configureMain(session);
		const meta = operationMeta(session, { kind: "navigation", targetId: null, summarize: false });
		const { operationId } = meta;
		const state: NavigationState = {
			kind: "navigation",
			control: { status: "running" },
			targetId: null,
			summarize: false,
			phase: { kind: "ready_to_commit" },
		};
		await installOperation(session, meta, state);
		const { harness, suspended } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);

		expect(suspended).toEqual([{ lane: "main", operationId, kind: "navigation", startedAt: 1, reason: "crash" }]);
		await expect(
			harness.sessionTree.appendMessage({ role: "user", content: "later", timestamp: 2 }, BACKGROUND_CONTEXT),
		).rejects.toThrow(`Cannot append while structural operation ${operationId} is active`);
		expect(await harness.lanes(BACKGROUND_CONTEXT)).toHaveLength(1);
		await harness.setThinkingLevel("high", BACKGROUND_CONTEXT);
	});

	it("faults queued lane work before releasing a failed mutation", async () => {
		const { session, storage } = await createFailingSession();
		const { harness } = await createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT);
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		unwrap(await harness.createLane("worker", null, BACKGROUND_CONTEXT));
		const worker = harness.lanesByName.get("worker");
		if (worker === undefined) throw new Error("missing runtime2 worker lane");
		const initialConfiguration = worker.state.configuration;
		const faultEvent = new Promise<unknown>((resolve) => harness.events.on("fault", resolve));
		const configUpdate = vi.fn();
		harness.events.on("config_update", configUpdate);
		const failure = new Error("commit failed");
		storage.failure = failure;
		const failed = worker.setThinkingLevel("high", BACKGROUND_CONTEXT);
		const queued = worker.setActiveTools(["read"], BACKGROUND_CONTEXT);

		let rejected: unknown;
		try {
			await failed;
		} catch (error) {
			rejected = error;
		}

		expect(rejected).toBeInstanceOf(HarnessFault);
		if (!(rejected instanceof HarnessFault)) throw new Error("missing harness fault");
		expect(rejected.cause).toBe(failure);
		expect(await faultEvent).toMatchObject({ type: "fault", code: "harness_fault" });
		expect(configUpdate).not.toHaveBeenCalled();
		await expect(queued).rejects.toBe(rejected);
		await expect(harness.getLeafId(BACKGROUND_CONTEXT)).rejects.toBe(rejected);
		await expect(worker.getThinkingLevel(BACKGROUND_CONTEXT)).rejects.toBe(rejected);
		await expect(worker.inspectExecution(BACKGROUND_CONTEXT)).rejects.toBe(rejected);
		await expect(harness.getTools(BACKGROUND_CONTEXT)).rejects.toBe(rejected);
		await expect(harness.setResources({}, BACKGROUND_CONTEXT)).rejects.toBe(rejected);
		expect(harness.fault(new Error("later"), BACKGROUND_CONTEXT)).toBe(rejected);
		expect(worker.state.configuration).toBe(initialConfiguration);
		expect((await session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT))?.value).toEqual(
			initialConfiguration,
		);
		await harness.close(BACKGROUND_CONTEXT);
	});

	it("wraps initialization invariant failures as harness faults", async () => {
		const session = await createSession();
		await session.mutate(
			"main",
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: session.idGenerator.next(),
							pendingNextRun: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		await expect(createAgentHarness(modelOptions(session), BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(HarnessFault);
	});
});
