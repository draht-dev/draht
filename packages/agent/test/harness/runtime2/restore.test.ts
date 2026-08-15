import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { restoreLane, restoreSession } from "../../../src/harness/runtime2/restore.ts";
import { MemorySessionRepo } from "../../../src/harness/session/memory.ts";
import type { LaneConfiguration, OperationMeta, RunState, Session } from "../../../src/harness/session/types.ts";

const repos: MemorySessionRepo[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function createSession(): Promise<Session> {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	const session = await repo.create({});
	await session.mutate("main", (mutator) =>
		mutator.commit({
			writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration }],
		}),
	);
	return session;
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

describe("runtime2 lane restore", () => {
	it("restores an idle lane and its latest terminal result", async () => {
		const session = await createSession();
		const result = {
			operationId: session.idGenerator.next(),
			kind: "navigation" as const,
			outcome: "completed" as const,
			oldLeafId: null,
			leafId: null,
		};
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.lastResult",
						key: "main",
						value: result,
					},
				],
			}),
		);

		const lane = await restoreLane(session, "main");

		expect(lane.name).toBe("main");
		expect(lane.state).toEqual({
			leafId: null,
			configuration,
			pendingNextRun: [],
			lastResult: result,
			operation: null,
		});
	});

	it("restores an open operation without interpreting its referenced payloads", async () => {
		const session = await createSession();
		const operationId = session.idGenerator.next();
		const missingTriggerId = session.idGenerator.next();
		const meta: OperationMeta = {
			operationId,
			lane: "main",
			sourceLeafId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		const state = runState(missingTriggerId);
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

		const lane = await restoreLane(session, "main");

		expect(lane.state.operation).toEqual({ meta, state });
	});

	it.each(["lane.leaf", "lane.config", "lane.state"] as const)("requires %s", async (namespace) => {
		const session = await createSession();
		await session.mutate("main", (mutator) =>
			mutator.commit({ writes: [{ kind: "register", op: "delete", namespace, key: "main" }] }),
		);

		await expect(restoreLane(session, "main")).rejects.toThrow(`missing ${namespace}`);
	});

	it.each(["op.meta", "op.state"] as const)("requires %s for the current operation", async (namespace) => {
		const session = await createSession();
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
					...(namespace === "op.meta"
						? []
						: [
								{
									kind: "register" as const,
									op: "set" as const,
									namespace: "op.meta" as const,
									key: operationId,
									value: meta,
								},
							]),
					...(namespace === "op.state"
						? []
						: [
								{
									kind: "register" as const,
									op: "set" as const,
									namespace: "op.state" as const,
									key: operationId,
									value: state,
								},
							]),
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

		await expect(restoreLane(session, "main")).rejects.toThrow(`missing ${namespace}`);
	});

	it("restores every configured lane exactly once without writing", async () => {
		const session = await createSession();
		const workerConfiguration: LaneConfiguration = {
			model: { provider: "test", modelId: "worker" },
			thinkingLevel: "high",
			activeToolNames: ["read"],
		};
		await session.createLane("worker", null, workerConfiguration);
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
		const before = {
			leaves: await session.listRegisters("lane.leaf"),
			configurations: await session.listRegisters("lane.config"),
			states: await session.listRegisters("lane.state"),
		};
		const mutate = vi.spyOn(session, "mutate");

		const lanes = await restoreSession(session);

		expect([...lanes.keys()].sort()).toEqual(["main", "worker"]);
		expect(lanes.get("main")?.state.configuration).toEqual(configuration);
		expect(lanes.get("worker")?.state).toMatchObject({
			configuration: workerConfiguration,
			operation: { meta, state },
		});
		expect(mutate.mock.calls.map(([lane]) => lane).sort()).toEqual(["main", "worker"]);
		expect({
			leaves: await session.listRegisters("lane.leaf"),
			configurations: await session.listRegisters("lane.config"),
			states: await session.listRegisters("lane.state"),
		}).toEqual(before);
	});

	it("requires main in the trusted lane inventory", async () => {
		const session = await createSession();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [{ kind: "register", op: "delete", namespace: "lane.leaf", key: "main" }],
			}),
		);

		await expect(restoreSession(session)).rejects.toThrow("Session is missing main lane");
	});
});
