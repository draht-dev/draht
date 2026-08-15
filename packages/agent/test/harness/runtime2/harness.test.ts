import { createModels, fauxProvider } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessClosed, HarnessFault } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { RuntimeSliceNotImplemented } from "../../../src/harness/runtime/types.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime2/harness.ts";
import { Lane } from "../../../src/harness/runtime2/lane.ts";
import { MemorySessionRepo, MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import type {
	LaneConfiguration,
	OperationMeta,
	RunState,
	Session,
	Transaction,
} from "../../../src/harness/session/types.ts";

class FailingMemoryStorage extends MemoryStorage {
	failure: Error | undefined;

	override commit(transaction: Transaction) {
		return this.failure === undefined ? super.commit(transaction) : Promise.reject(this.failure);
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

async function createFailingSession(): Promise<{ session: Session; storage: FailingMemoryStorage }> {
	const storage = new FailingMemoryStorage();
	const session = new StorageBackedSession(
		{ id: `runtime2-fault-${standaloneSessions.length}`, createdAt: 1, storageVersion: 1 },
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
	return { session, storage };
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
		await expect(harness.inspectExecution()).rejects.toBeInstanceOf(RuntimeSliceNotImplemented);

		const closing = harness.close();
		expect(harness.close()).toBe(closing);
		await closing;
		await expect(harness.lanes()).rejects.toBeInstanceOf(HarnessClosed);
		const reopened = await repo.open(session.metadata);
		expect((await reopened.getRegister("lane.state", "main"))?.value.currentOperationId).toBe(operationId);
		expect((await reopened.getRegister("op.meta", operationId))?.value).toEqual(meta);
		expect((await reopened.getRegister("op.state", operationId))?.value).toEqual(state);
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

	it("faults every lane when an admitted commit fails", async () => {
		const { session, storage } = await createFailingSession();
		await session.createLane("worker", null, configuredMain);
		const { harness } = await createAgentHarness(modelOptions(session));
		if (!(harness instanceof Harness)) throw new Error("missing runtime2 harness");
		const worker = await harness.lane("worker");
		if (!(worker instanceof Lane)) throw new Error("missing runtime2 worker lane");
		const failure = new Error("commit failed");
		storage.failure = failure;

		let rejected: unknown;
		try {
			await worker.setThinkingLevel("high");
		} catch (error) {
			rejected = error;
		}

		expect(rejected).toBeInstanceOf(HarnessFault);
		if (!(rejected instanceof HarnessFault)) throw new Error("missing harness fault");
		expect(rejected.cause).toBe(failure);
		await expect(harness.getLeafId()).rejects.toBe(rejected);
		await expect(worker.getThinkingLevel()).rejects.toBe(rejected);
		expect(harness.fault(new Error("later"))).toBe(rejected);
		expect(worker.state.configuration).toEqual(configuredMain);
		expect((await session.getRegister("lane.config", "worker"))?.value).toEqual(configuredMain);
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
