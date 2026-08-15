import { createModels, fauxProvider } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { createRuntime } from "../../../src/harness/runtime2/runtime.ts";
import { MemorySessionRepo } from "../../../src/harness/session/memory.ts";
import type { LaneConfiguration, OperationMeta, RunState, Session } from "../../../src/harness/session/types.ts";

const repos: MemorySessionRepo[] = [];
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
});

describe("runtime2 shell", () => {
	it("seeds an unconfigured main before restoring it", async () => {
		const session = await createSession();

		const runtime = await createRuntime({
			...modelOptions(session),
			thinkingLevel: "high",
			activeToolNames: ["read"],
		});

		const expected: LaneConfiguration = {
			model: {
				provider: runtime.seed.model.provider,
				modelId: runtime.seed.model.modelId,
			},
			thinkingLevel: "high",
			activeToolNames: ["read"],
		};
		expect((await session.getRegister("lane.config", "main"))?.value).toEqual(expected);
		expect(runtime.lanes.get("main")?.state).toMatchObject({
			configuration: expected,
			operation: null,
		});
	});

	it("does not overwrite configured lanes with the seed", async () => {
		const session = await createSession();
		const worker: LaneConfiguration = {
			model: { provider: "configured", modelId: "worker" },
			thinkingLevel: "medium",
			activeToolNames: [],
		};
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuredMain }],
			}),
		);
		await session.createLane("worker", null, worker);
		const before = await session.listRegisters("lane.config");

		const runtime = await createRuntime({
			...modelOptions(session),
			thinkingLevel: "high",
			activeToolNames: ["seed-only"],
		});

		expect(await session.listRegisters("lane.config")).toEqual(before);
		expect(runtime.lanes.get("main")?.state.configuration).toEqual(configuredMain);
		expect(runtime.lanes.get("worker")?.state.configuration).toEqual(worker);
	});

	it("owns restored idle and open lanes without activating them", async () => {
		const session = await createSession();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuredMain },
					{
						kind: "register",
						op: "set",
						namespace: "lane.lastResult",
						key: "main",
						value: {
							operationId: session.idGenerator.next(),
							kind: "navigation",
							outcome: "completed",
							oldLeafId: null,
							leafId: null,
						},
					},
				],
			}),
		);
		await session.createLane("worker", null, configuredMain);
		const operationId = session.idGenerator.next();
		const meta: OperationMeta = {
			operationId,
			lane: "worker",
			sourceLeafId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		const state = runState(session.idGenerator.next());
		await session.mutate("worker", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: meta },
					{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: state },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "worker",
						value: { currentOperationId: operationId, pendingNextRun: [] },
					},
				],
			}),
		);

		const runtime = await createRuntime(modelOptions(session));

		expect([...runtime.lanes.keys()].sort()).toEqual(["main", "worker"]);
		expect(runtime.lanes.get("main")?.state.lastResult?.outcome).toBe("completed");
		expect(runtime.lanes.get("worker")?.state.operation).toEqual({ meta, state });
	});

	it("does not invoke effectful options or restore again after construction", async () => {
		const session = await createSession();
		const forbidden = vi.fn(() => {
			throw new Error("effect started");
		});
		const runtime = await createRuntime({
			...modelOptions(session),
			toolContext: forbidden,
			systemPrompt: forbidden,
			toProviderMessages: forbidden,
			entryProjectors: { forbidden },
		});
		const mutate = vi.spyOn(session, "mutate");
		const listRegisters = vi.spyOn(session, "listRegisters");

		for (const lane of runtime.lanes.values()) void lane.state;

		expect(forbidden).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
		expect(listRegisters).not.toHaveBeenCalled();
	});

	it("rejects historical or active main state without configuration", async () => {
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

		await expect(createRuntime(modelOptions(session))).rejects.toThrow(
			"Configured or active main lane is missing lane.config",
		);
	});
});
