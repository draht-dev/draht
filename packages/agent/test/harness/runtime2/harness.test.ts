import { createModels, fauxProvider } from "@draht/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessClosed, HarnessFault } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import type { Result } from "../../../src/harness/result.ts";
import { RuntimeSliceNotImplemented } from "../../../src/harness/runtime/types.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime2/harness.ts";
import { Lane } from "../../../src/harness/runtime2/lane.ts";
import { MemorySessionRepo, MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	LaneConfiguration,
	NavigationState,
	OperationMeta,
	RunState,
	Session,
	Transaction,
} from "../../../src/harness/session/types.ts";
import type { AgentHarnessTool } from "../../../src/harness/types.ts";
import { ControlledMemoryStorage, deferred } from "./test-utils.ts";

class FailingMemoryStorage extends MemoryStorage {
	failure: Error | undefined;

	override commit(transaction: Transaction) {
		const failure = this.failure;
		this.failure = undefined;
		return failure === undefined ? super.commit(transaction) : Promise.reject(failure);
	}
}

const repos: MemorySessionRepo[] = [];
const standaloneSessions: Session[] = [];
const configuredMain: LaneConfiguration = {
	model: { provider: "configured", modelId: "main" },
	thinkingLevel: "low",
	activeToolNames: ["configured-tool"],
};

async function createSession(): Promise<Session> {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	return repo.create({});
}

async function createStorageSession(storage: MemoryStorage): Promise<Session> {
	const session = new StorageBackedSession(
		{ id: `runtime2-storage-${standaloneSessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	standaloneSessions.push(session);
	await session.mutate("main", (mutator) =>
		mutator.commit({
			writes: [
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: null },
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { currentOperationId: null, pendingNextRun: [] },
				},
			],
		}),
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
	for (const repo of repos.splice(0)) await repo.close();
	for (const session of standaloneSessions.splice(0)) await session.close();
});

describe("runtime2 AgentHarness", () => {
	it("rejects duplicate tool names as caller input", async () => {
		const session = await createSession();
		const parameters = Type.Object({});
		const tool: AgentHarnessTool<undefined, typeof parameters> = {
			name: "duplicate",
			label: "Duplicate",
			description: "Duplicate",
			parameters,
			replay: "safe",
			execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
		};

		await expect(createAgentHarness({ ...modelOptions(session), tools: [tool, tool] })).rejects.toBeInstanceOf(
			TypeError,
		);
	});

	it("seeds main and returns the concrete harness as its main lane", async () => {
		const session = await createSession();
		const options = modelOptions(session);

		const { harness, suspended } = await createAgentHarness({
			...options,
			thinkingLevel: "high",
			activeToolNames: ["read"],
		});

		expect(harness).toBeInstanceOf(Harness);
		expect(await harness.lane("main")).toBe(harness);
		expect(await harness.getLeafId()).toBeNull();
		expect(suspended).toEqual([]);
		expect((await session.getRegister("lane.config", "main"))?.value).toEqual({
			model: { provider: options.model.provider, modelId: options.model.id },
			thinkingLevel: "high",
			activeToolNames: ["read"],
		});
	});

	it("appends idle entries through owned lane state", async () => {
		const session = await createSession();
		const { harness } = await createAgentHarness(modelOptions(session));

		const entryId = await harness.sessionTree.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		expect(await harness.getLeafId()).toBe(entryId);
		expect((await session.getRegister("lane.leaf", "main"))?.value).toBe(entryId);
		expect(await harness.sessionTree.findEntriesOnBranch({ order: "oldestFirst" })).toMatchObject([
			{ id: entryId, parentId: null, message: { role: "user", content: "hello" } },
		]);
	});

	it("restores every configured lane without replacing its configuration", async () => {
		const session = await createSession();
		const workerConfiguration: LaneConfiguration = {
			model: { provider: "configured", modelId: "worker" },
			thinkingLevel: "medium",
			activeToolNames: [],
		};
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuredMain }],
			}),
		);
		await session.createLane("worker", null, workerConfiguration);
		const before = await session.listRegisters("lane.config");

		const { harness } = await createAgentHarness(modelOptions(session));
		const worker = await harness.lane("worker");

		expect(worker).toBeInstanceOf(Lane);
		expect(await worker?.getLeafId()).toBeNull();
		expect((await harness.lanes()).map((lane) => lane.name).sort()).toEqual(["main", "worker"]);
		expect(await session.listRegisters("lane.config")).toEqual(before);
	});

	it("creates a lane from the captured seed and publishes it after commit", async () => {
		const session = await createSession();
		const options = modelOptions(session);
		const { harness } = await createAgentHarness({
			...options,
			thinkingLevel: "high",
			activeToolNames: ["read"],
		});
		const anchor = await harness.sessionTree.appendCustomEntry("anchor");
		await harness.setThinkingLevel("low");
		let durableConfigurationAtEvent: LaneConfiguration | undefined;
		let laneVisibleAtEvent = false;
		harness.events.on("lane_created", async () => {
			durableConfigurationAtEvent = (await session.getRegister("lane.config", "worker"))?.value;
			laneVisibleAtEvent = (await harness.lane("worker")) !== undefined;
		});

		const worker = unwrap(await harness.createLane("worker", anchor));

		expect(await harness.lane("worker")).toBe(worker);
		expect(await worker.getLeafId()).toBe(anchor);
		expect(await worker.getThinkingLevel()).toBe("high");
		expect(await worker.getActiveTools()).toEqual(["read"]);
		expect(durableConfigurationAtEvent).toEqual({
			model: { provider: options.model.provider, modelId: options.model.id },
			thinkingLevel: "high",
			activeToolNames: ["read"],
		});
		expect(laneVisibleAtEvent).toBe(true);
		expect((await session.getRegister("lane.state", "worker"))?.value).toEqual({
			currentOperationId: null,
			pendingNextRun: [],
		});
	});

	it("maps expected lane creation failures without faulting", async () => {
		const session = await createSession();
		const { harness } = await createAgentHarness(modelOptions(session));
		unwrap(await harness.createLane("worker", null));

		expect(await harness.createLane("worker", null)).toMatchObject({
			ok: false,
			error: { _tag: "LaneExists", lane: "worker" },
		});
		expect(await harness.createLane("", null)).toMatchObject({
			ok: false,
			error: { _tag: "InvalidLane", lane: "", reason: "lane name must not be empty" },
		});
		expect(await harness.createLane("missing", "unknown-entry")).toMatchObject({
			ok: false,
			error: { _tag: "UnknownTarget", targetId: "unknown-entry" },
		});
		expect((await harness.lanes()).map((lane) => lane.name).sort()).toEqual(["main", "worker"]);
	});

	it("faults without publishing a lane when creation commit fails", async () => {
		const { session, storage } = await createFailingSession();
		const { harness } = await createAgentHarness(modelOptions(session));
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		const failure = new Error("create lane failed");
		storage.failure = failure;

		let rejected: unknown;
		try {
			await harness.createLane("worker", null);
		} catch (error) {
			rejected = error;
		}

		expect(rejected).toBeInstanceOf(HarnessFault);
		if (!(rejected instanceof HarnessFault)) throw new Error("missing harness fault");
		expect(rejected.cause).toBe(failure);
		await expect(harness.createLane("later", null)).rejects.toBe(rejected);
		expect(harness.lanesByName.has("worker")).toBe(false);
		expect(await session.getRegister("lane.config", "worker")).toBeUndefined();
		expect(await session.getRegister("lane.leaf", "worker")).toBeUndefined();
		expect(await session.getRegister("lane.state", "worker")).toBeUndefined();
	});

	it("returns Closed when lane creation starts after close", async () => {
		const session = await createSession();
		const { harness } = await createAgentHarness(modelOptions(session));
		await harness.close();

		expect(await harness.createLane("late", null)).toMatchObject({
			ok: false,
			error: { _tag: "Closed" },
		});
	});

	it("publishes an admitted lane creation before close finishes", async () => {
		const storage = new ControlledMemoryStorage();
		const session = await createStorageSession(storage);
		const { harness } = await createAgentHarness(modelOptions(session));
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		const commitStarted = deferred();
		const releaseCommit = deferred();
		storage.beforeNextCommit = async () => {
			commitStarted.resolve();
			await releaseCommit.promise;
		};
		const creating = harness.createLane("worker", null);
		await commitStarted.promise;
		const closing = harness.close();
		releaseCommit.resolve();

		const worker = unwrap(await creating);
		await closing;

		expect(harness.lanesByName.get("worker")).toBe(worker);
		await expect(worker.getLeafId()).rejects.toBeInstanceOf(HarnessClosed);
	});

	it("reports restored open operations without activating them", async () => {
		const repo = new MemorySessionRepo();
		repos.push(repo);
		const session = await repo.create({});
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuredMain }],
			}),
		);
		const operationId = session.idGenerator.next();
		const meta: OperationMeta = {
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		const state = runState(session.idGenerator.next());
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: meta },
					{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: operationId, pendingNextRun: [] },
					},
				],
			}),
		);

		const { harness, suspended } = await createAgentHarness(modelOptions(session));

		expect(suspended).toEqual([{ lane: "main", operationId, kind: "run", startedAt: 1, reason: "crash" }]);
		expect(await harness.lanes()).toEqual([
			{ name: "main", leafId: null, operation: { id: operationId, kind: "run", status: "suspended" } },
		]);
		const pendingId = await harness.sessionTree.appendCustomEntry("note", { text: "queued" });
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		const updatedState = harness.state.operation?.state;
		if (updatedState?.kind !== "run") throw new Error("missing updated run state");
		expect(updatedState.inbox.writes).toEqual([pendingId]);
		expect((await session.getRegister("pending.entry", pendingId))?.value).toEqual({
			type: "custom",
			customType: "note",
			payload: { text: "queued" },
		});
		expect((await session.getRegister("lane.leaf", "main"))?.value).toBeNull();
		await expect(harness.inspectExecution()).rejects.toBeInstanceOf(RuntimeSliceNotImplemented);

		const closing = harness.close();
		expect(harness.close()).toBe(closing);
		await closing;
		await expect(harness.lanes()).rejects.toBeInstanceOf(HarnessClosed);
		const reopened = await repo.open(session.metadata);
		expect((await reopened.getRegister("lane.state", "main"))?.value.currentOperationId).toBe(operationId);
		expect((await reopened.getRegister("op.meta", operationId))?.value).toEqual(meta);
		expect((await reopened.getRegister("op.state", operationId))?.value).toEqual(updatedState);
	});

	it("uses owned state after creation and starts no option callbacks", async () => {
		const session = await createSession();
		const forbidden = vi.fn(() => {
			throw new Error("effect started");
		});
		const { harness } = await createAgentHarness({
			...modelOptions(session),
			toolContext: forbidden,
			systemPrompt: forbidden,
			toProviderMessages: forbidden,
			entryProjectors: { forbidden },
		});
		const mutate = vi.spyOn(session, "mutate");
		const getRegister = vi.spyOn(session, "getRegister");
		const listRegisters = vi.spyOn(session, "listRegisters");

		expect(await harness.lane("main")).toBe(harness);
		expect(await harness.lanes()).toHaveLength(1);
		expect(await harness.getLeafId()).toBeNull();
		expect(await harness.getLastResult()).toBeUndefined();
		expect(forbidden).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
		expect(getRegister).not.toHaveBeenCalled();
		expect(listRegisters).not.toHaveBeenCalled();
		await expect(harness.getTools()).rejects.toBeInstanceOf(RuntimeSliceNotImplemented);
	});

	it("rejects append during a structural operation without faulting", async () => {
		const session = await createSession();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuredMain }],
			}),
		);
		const operationId = session.idGenerator.next();
		const meta: OperationMeta = {
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: 1,
			intent: { kind: "navigation", targetId: null, summarize: false },
		};
		const state: NavigationState = {
			kind: "navigation",
			control: { status: "running" },
			targetId: null,
			summarize: false,
			phase: { kind: "ready_to_commit" },
		};
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: meta },
					{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: operationId, pendingNextRun: [] },
					},
				],
			}),
		);
		const { harness } = await createAgentHarness(modelOptions(session));

		await expect(harness.sessionTree.appendMessage({ role: "user", content: "later", timestamp: 2 })).rejects.toThrow(
			`Cannot append while structural operation ${operationId} is active`,
		);
		expect(await harness.lanes()).toHaveLength(1);
		await harness.setThinkingLevel("high");
	});

	it("faults queued lane work before releasing a failed mutation", async () => {
		const { session, storage } = await createFailingSession();
		const { harness } = await createAgentHarness(modelOptions(session));
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		unwrap(await harness.createLane("worker", null));
		const worker = harness.lanesByName.get("worker");
		if (worker === undefined) throw new Error("missing runtime2 worker lane");
		const initialConfiguration = worker.state.configuration;
		const faultEvent = new Promise<unknown>((resolve) => harness.events.on("fault", resolve));
		const failure = new Error("commit failed");
		storage.failure = failure;
		const failed = worker.setThinkingLevel("high");
		const queued = worker.setActiveTools(["read"]);

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
		await expect(queued).rejects.toBe(rejected);
		await expect(harness.getLeafId()).rejects.toBe(rejected);
		await expect(worker.getThinkingLevel()).rejects.toBe(rejected);
		expect(harness.fault(new Error("later"))).toBe(rejected);
		expect(worker.state.configuration).toBe(initialConfiguration);
		expect((await session.getRegister("lane.config", "worker"))?.value).toEqual(initialConfiguration);
		await harness.close();
	});

	it("wraps initialization invariant failures as harness faults", async () => {
		const session = await createSession();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: session.idGenerator.next(), pendingNextRun: [] },
					},
				],
			}),
		);

		await expect(createAgentHarness(modelOptions(session))).rejects.toBeInstanceOf(HarnessFault);
	});
});
