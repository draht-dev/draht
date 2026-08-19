import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT } from "../../../src/harness/context.ts";
import { restoreLane, restoreSession } from "../../../src/harness/runtime2/restore.ts";
import { MemorySessionRepo, MemoryStorage } from "../../../src/harness/session/memory.ts";
import type { LaneConfiguration, OperationMeta, RunState, Session } from "../../../src/harness/session/types.ts";
import * as storedValues from "../../../src/harness/session/values.ts";

const repos: MemorySessionRepo[] = [];
const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

async function createSession(): Promise<Session> {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	await session.mutate(
		"main",
		(mutator) =>
			mutator.commit([storedValues.setValue(storedValues.laneConfig("main"), configuration)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
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
	for (const repo of repos.splice(0)) await repo.close(BACKGROUND_CONTEXT);
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
		await session.mutate(
			"main",
			(mutator) =>
				mutator.commit([storedValues.setValue(storedValues.laneLastResult("main"), result)], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);

		const state = await restoreLane(session, "main", BACKGROUND_CONTEXT);

		expect(state).toEqual({
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
		await session.mutate(
			"main",
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.operationMeta(operationId), meta),
						storedValues.setValue(storedValues.operationState(operationId), state),
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: operationId,
							pendingNextRun: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);

		const restored = await restoreLane(session, "main", BACKGROUND_CONTEXT);

		expect(restored.operation).toEqual({ meta, state });
	});

	it("validates current-operation identity, lane ownership, and intent/state compatibility", async () => {
		for (const corruption of ["identity", "lane", "kind"] as const) {
			const session = await createSession();
			const operationId = session.idGenerator.next();
			const base: OperationMeta = {
				operationId,
				lane: "main",
				sourceLeafId: null,
				startedAt: 1,
				intent: { kind: "run", promptEntryIds: [] },
			};
			const meta: OperationMeta =
				corruption === "identity"
					? { ...base, operationId: "different-operation" }
					: corruption === "lane"
						? { ...base, lane: "worker" }
						: { ...base, intent: { kind: "navigation", targetId: null, summarize: false } };
			await session.mutate(
				"main",
				(mutator) =>
					mutator.commit(
						[
							storedValues.setValue(storedValues.operationMeta(operationId), meta),
							storedValues.setValue(storedValues.operationState(operationId), runState("trigger")),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: operationId,
								pendingNextRun: [],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			await expect(restoreLane(session, "main", BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(Error);
		}
	});

	it.each([
		[storedValues.laneLeaf("main").namespace, storedValues.deleteValue(storedValues.laneLeaf("main"))],
		[storedValues.laneConfig("main").namespace, storedValues.deleteValue(storedValues.laneConfig("main"))],
		[storedValues.laneState("main").namespace, storedValues.deleteValue(storedValues.laneState("main"))],
	] as const)("requires %s", async (namespace, write) => {
		const session = await createSession();
		await session.mutate("main", (mutator) => mutator.commit([write], BACKGROUND_CONTEXT), BACKGROUND_CONTEXT);

		await expect(restoreLane(session, "main", BACKGROUND_CONTEXT)).rejects.toThrow(`missing ${namespace.slice(3)}`);
	});

	it.each([storedValues.operationMeta("").namespace, storedValues.operationState("").namespace] as const)(
		"requires %s for the current operation",
		async (namespace) => {
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
			await session.mutate(
				"main",
				(mutator) =>
					mutator.commit(
						[
							...(namespace === storedValues.operationMeta(operationId).namespace
								? []
								: [storedValues.setValue(storedValues.operationMeta(operationId), meta)]),
							...(namespace === storedValues.operationState(operationId).namespace
								? []
								: [storedValues.setValue(storedValues.operationState(operationId), state)]),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: operationId,
								pendingNextRun: [],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);

			await expect(restoreLane(session, "main", BACKGROUND_CONTEXT)).rejects.toThrow(
				`missing ${namespace.slice(3)}`,
			);
		},
	);

	it("restores every configured lane exactly once without writing", async () => {
		const session = await createSession();
		const workerConfiguration: LaneConfiguration = {
			model: { provider: "test", modelId: "worker" },
			thinkingLevel: "high",
			activeToolNames: ["read"],
		};
		await session.createLane("worker", null, workerConfiguration, undefined, BACKGROUND_CONTEXT);
		const operationId = session.idGenerator.next();
		const meta: OperationMeta = {
			operationId,
			lane: "worker",
			sourceLeafId: null,
			startedAt: 1,
			intent: { kind: "run", promptEntryIds: [] },
		};
		const state = runState(session.idGenerator.next());
		await session.mutate(
			"worker",
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.operationMeta(operationId), meta),
						storedValues.setValue(storedValues.operationState(operationId), state),
						storedValues.setValue(storedValues.laneState("worker"), {
							currentOperationId: operationId,
							pendingNextRun: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const before = {
			leaves: await session.scanValues(storedValues.laneLeafInventoryPrefix(), BACKGROUND_CONTEXT),
			mainConfiguration: await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT),
			workerConfiguration: await session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT),
			mainState: await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT),
			workerState: await session.getValue(storedValues.laneState("worker"), BACKGROUND_CONTEXT),
		};
		const mutate = vi.spyOn(session, "mutate");
		const readList = vi.spyOn(MemoryStorage.prototype, "readList");

		const lanes = await restoreSession(session, BACKGROUND_CONTEXT);

		expect([...lanes.keys()].sort()).toEqual(["main", "worker"]);
		expect(lanes.get("main")?.configuration).toEqual(configuration);
		expect(lanes.get("worker")).toMatchObject({
			configuration: workerConfiguration,
			operation: { meta, state },
		});
		expect(mutate.mock.calls.map(([lane]) => lane).sort()).toEqual(["main", "worker"]);
		expect(readList).not.toHaveBeenCalled();
		expect({
			leaves: await session.scanValues(storedValues.laneLeafInventoryPrefix(), BACKGROUND_CONTEXT),
			mainConfiguration: await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT),
			workerConfiguration: await session.getValue(storedValues.laneConfig("worker"), BACKGROUND_CONTEXT),
			mainState: await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT),
			workerState: await session.getValue(storedValues.laneState("worker"), BACKGROUND_CONTEXT),
		}).toEqual(before);
		readList.mockRestore();
	});

	it("requires main in the trusted lane inventory", async () => {
		const session = await createSession();
		await session.mutate(
			"main",
			(mutator) => mutator.commit([storedValues.deleteValue(storedValues.laneLeaf("main"))], BACKGROUND_CONTEXT),
			BACKGROUND_CONTEXT,
		);

		await expect(restoreSession(session, BACKGROUND_CONTEXT)).rejects.toThrow("Session is missing main lane");
	});
});
