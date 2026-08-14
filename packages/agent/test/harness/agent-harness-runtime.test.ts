import { type Api, createModels, fauxProvider, type Model } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreLane } from "../../src/harness/restore.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	DEFAULT_COMPACTION_SETTINGS,
	HarnessClosed,
	HarnessFault,
	type LaneConfiguration,
	MemorySessionRepo,
	type Session,
	type SessionReader,
	type Transaction,
} from "../../src/index.ts";

interface Fixture {
	harness: AgentHarnessInstance;
	session: Session;
	repo: MemorySessionRepo;
	model: Model<Api>;
}

const fixtures: Fixture[] = [];

class FailingMemoryStorage extends MemoryStorage {
	failCommits = false;

	override commit(transaction: Transaction) {
		return this.failCommits ? Promise.reject(new Error("commit failed")) : super.commit(transaction);
	}
}

async function createFixture(options: { drive?: "automatic" | "manual" } = {}): Promise<Fixture> {
	const repo = new MemorySessionRepo();
	const session = await repo.create({});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const { harness } = await AgentHarness.create({
		session,
		models,
		model: faux.getModel(),
		drive: options.drive,
	});
	const fixture = { harness, session, repo, model: faux.getModel() };
	fixtures.push(fixture);
	return fixture;
}

async function installCheckpointRun(
	session: Session,
	operationId = session.idGenerator.next(),
): Promise<{ operationId: string; entryId: string }> {
	const entryId = session.idGenerator.next();
	await session.mutate("main", async (mutator) => {
		const laneState = await mutator.getRegister("lane.state", "main");
		if (laneState === undefined) throw new Error("missing lane state");
		await mutator.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: entryId,
						parentId: null,
						type: "message",
						message: { role: "user", content: "hello", timestamp: 1 },
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: entryId },
				{
					kind: "register",
					op: "set",
					namespace: "op.meta",
					key: operationId,
					value: {
						operationId,
						lane: "main",
						sourceLeafId: null,
						startedAt: 1,
						intent: { kind: "run", promptEntryIds: [entryId] },
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "op.state",
					key: operationId,
					value: {
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
							triggerEntryId: entryId,
						},
						inbox: { steer: [], followUp: [], writes: [] },
						latestAssistantEntryId: null,
					},
				},
				{
					kind: "register",
					op: "set",
					namespace: "lane.state",
					key: "main",
					value: { ...laneState.value, currentOperationId: operationId },
				},
			],
		});
	});
	return { operationId, entryId };
}

async function waitForAction(harness: AgentHarnessInstance): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await harness.peekAction()) !== undefined) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("action did not park");
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.harness.close();
		await fixture.repo.close();
	}
});

describe("AgentHarness runtime shell", () => {
	it("seeds main, reads configuration, and creates independently seeded lanes", async () => {
		const { harness, model } = await createFixture();
		expect(await harness.getModel()).toEqual(model);
		expect(await harness.inspectExecution()).toMatchObject({ lane: "main", leafId: null, current: null });

		await harness.setThinkingLevel("high");
		let observedResources = false;
		harness.events.on("config_update", async (event) => {
			if (event.property !== "resources") return;
			observedResources = (await harness.getResources()).skills?.[0]?.name === "test";
		});
		await harness.setResources({
			skills: [{ name: "test", description: "test", content: "test", filePath: "/test" }],
		});
		expect(observedResources).toBe(true);
		harness.events.on("config_update", (event) => {
			if (event.property === "activeTools") event.value.push("listener-mutation");
		});
		await harness.setActiveTools(["read"]);
		expect(await harness.getActiveTools()).toEqual(["read"]);
		expect((harness as AgentHarnessInstance & { settingsRevision: number }).settingsRevision).toBe(1);
		const created = await harness.createLane("worker", null);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.value.getThinkingLevel()).toBe("off");
		expect((await harness.lanes()).map((lane) => lane.name).sort()).toEqual(["main", "worker"]);
	});

	it("fences stale drives and yields before publishing a breakpoint", async () => {
		const { harness, session } = await createFixture({ drive: "manual" });
		const current = await installCheckpointRun(session);

		const staleOperationId = session.idGenerator.next();
		const stale = await harness.drive({ operationId: staleOperationId, deadline: 0 });
		expect(stale.ok).toBe(false);
		if (!stale.ok) {
			expect(stale.error).toMatchObject({
				_tag: "OperationMismatch",
				currentOperationId: current.operationId,
			});
		}
		expect(await harness.peekAction()).toBeUndefined();

		const yielded = await harness.drive({ operationId: current.operationId, deadline: 0 });
		expect(yielded).toEqual({
			ok: true,
			value: { kind: "yielded", operationId: current.operationId },
		});
		expect(await harness.peekAction()).toBeUndefined();
		expect((await harness.inspectExecution()).current?.status).toBe("suspended");
	});
	it("installs one same-operation drive pass and joins it", async () => {
		const { harness, session } = await createFixture({ drive: "manual" });
		const current = await installCheckpointRun(session);

		const first = harness.drive({ operationId: current.operationId });
		await waitForAction(harness);
		expect(await harness.peekAction()).toMatchObject({
			kind: "runtime.dispatch",
			details: { operationId: current.operationId, operationKind: "run" },
		});
		expect((await harness.inspectExecution()).current?.status).toBe("running");
		const second = harness.drive({ operationId: current.operationId, deadline: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.close();

		const [left, right] = await Promise.allSettled([first, second]);
		expect(left.status).toBe("rejected");
		expect(right.status).toBe("rejected");
		if (left.status === "rejected" && right.status === "rejected") {
			expect(left.reason).toBe(right.reason);
			expect(left.reason).toBeInstanceOf(HarnessClosed);
		}
	});

	it("faults inspection when process and durable operation ownership disagree", async () => {
		const { harness, session } = await createFixture({ drive: "manual" });
		const current = await installCheckpointRun(session);
		const drive = harness.drive({ operationId: current.operationId });
		await waitForAction(harness);
		const [operation, state, laneState] = await Promise.all([
			session.getRegister("op.meta", current.operationId),
			session.getRegister("op.state", current.operationId),
			session.getRegister("lane.state", "main"),
		]);
		if (operation === undefined || state === undefined || laneState === undefined) {
			throw new Error("missing operation state");
		}
		const replacementId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.meta",
						key: replacementId,
						value: { ...operation.value, operationId: replacementId },
					},
					{ kind: "register", op: "set", namespace: "op.state", key: replacementId, value: state.value },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { ...laneState.value, currentOperationId: replacementId },
					},
				],
			}),
		);

		await expect(harness.inspectExecution()).rejects.toBeInstanceOf(HarnessFault);
		await expect(drive).rejects.toBeInstanceOf(HarnessFault);
	});

	it("yields after a parked boundary when the deadline expires", async () => {
		const { harness, session } = await createFixture({ drive: "manual" });
		const current = await installCheckpointRun(session);
		const now = vi.spyOn(Date, "now").mockReturnValue(100);
		try {
			const drive = harness.drive({ operationId: current.operationId, deadline: 150 });
			await waitForAction(harness);
			now.mockReturnValue(200);
			await harness.executeAction();
			await expect(drive).resolves.toEqual({
				ok: true,
				value: { kind: "yielded", operationId: current.operationId },
			});
		} finally {
			now.mockRestore();
		}
	});

	it("validates base operation ownership and intent kind", async () => {
		const { session } = await createFixture();
		const current = await installCheckpointRun(session);
		const stored = await session.getRegister("op.meta", current.operationId);
		if (stored === undefined) throw new Error("missing operation");
		const replaceOperation = (value: typeof stored.value) =>
			session.mutate("main", (mutator) =>
				mutator.commit({
					writes: [{ kind: "register", op: "set", namespace: "op.meta", key: current.operationId, value }],
				}),
			);

		await replaceOperation({ ...stored.value, lane: "worker" });
		await expect(restoreLane(session, "main")).rejects.toThrow(/belongs to lane worker/);
		await replaceOperation({
			...stored.value,
			intent: { kind: "navigation", targetId: null, summarize: false },
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/intent navigation does not match state run/);
		await replaceOperation(stored.value);
	});

	it("restores open operations without activating them", async () => {
		const repo = new MemorySessionRepo();
		const session = await repo.create({});
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const seed: LaneConfiguration = {
			model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
			thinkingLevel: "off",
			activeToolNames: [],
		};
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: seed }],
			}),
		);
		const current = await installCheckpointRun(session);

		const { harness, suspended } = await AgentHarness.create({
			session,
			models,
			model: faux.getModel(),
			drive: "manual",
		});
		fixtures.push({ harness, session, repo, model: faux.getModel() });

		expect(suspended).toEqual([
			expect.objectContaining({
				lane: "main",
				operationId: current.operationId,
				kind: "run",
				reason: "crash",
			}),
		]);
		expect((await harness.inspectExecution()).current).toMatchObject({
			id: current.operationId,
			status: "suspended",
		});
		expect(await harness.peekAction()).toBeUndefined();

		const registerReads: string[] = [];
		const entryReads: string[][] = [];
		const reader: SessionReader = {
			getEntries(ids) {
				entryReads.push(ids);
				return session.getEntries(ids);
			},
			getRegister(namespace, key) {
				registerReads.push(`${namespace}/${key}`);
				return session.getRegister(namespace, key);
			},
			listRegisters() {
				throw new Error("restore must not scan registers");
			},
		};
		await restoreLane(reader, "main");
		expect(registerReads).toEqual([
			"lane.config/main",
			"lane.state/main",
			"lane.leaf/main",
			`op.meta/${current.operationId}`,
			`op.state/${current.operationId}`,
		]);
		expect(entryReads).toEqual([[current.entryId]]);
	});

	it("returns and hydrates a matching latest terminal result", async () => {
		const { harness, session } = await createFixture();
		const current = await installCheckpointRun(session);
		await session.mutate("main", async (mutator) => {
			const laneState = await mutator.getRegister("lane.state", "main");
			if (laneState === undefined) throw new Error("missing lane state");
			await mutator.commit({
				writes: [
					{ kind: "register", op: "delete", namespace: "op.meta", key: current.operationId },
					{ kind: "register", op: "delete", namespace: "op.state", key: current.operationId },
					{
						kind: "register",
						op: "set",
						namespace: "lane.lastResult",
						key: "main",
						value: {
							operationId: current.operationId,
							kind: "run",
							outcome: "completed",
							leafId: current.entryId,
							runCompletion: "terminated_tools",
						},
					},
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { ...laneState.value, currentOperationId: null },
					},
				],
			});
		});

		const result = await harness.drive({ operationId: current.operationId });
		expect(result).toEqual({
			ok: true,
			value: {
				kind: "settled",
				operationId: current.operationId,
				outcome: {
					operation: "run",
					runId: current.operationId,
					kind: "completed",
					leafId: current.entryId,
				},
			},
		});

		const navigationId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.lastResult",
						key: "main",
						value: {
							operationId: navigationId,
							kind: "navigation",
							outcome: "completed",
							oldLeafId: null,
							leafId: current.entryId,
						},
					},
				],
			}),
		);
		const navigation = await harness.drive({ operationId: navigationId });
		expect(navigation).toMatchObject({
			ok: true,
			value: {
				kind: "settled",
				outcome: {
					operation: "navigation",
					kind: "completed",
					oldLeafId: null,
					newLeafId: current.entryId,
				},
			},
		});

		const brokenRunId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.lastResult",
						key: "main",
						value: {
							operationId: brokenRunId,
							kind: "run",
							outcome: "completed",
							leafId: current.entryId,
							finalAssistantEntryId: session.idGenerator.next(),
							runCompletion: "assistant",
						},
					},
				],
			}),
		);
		let fault: unknown;
		try {
			await harness.drive({ operationId: brokenRunId });
		} catch (error) {
			fault = error;
		}
		expect(fault).toBeInstanceOf(HarnessFault);
		expect((fault as HarnessFault).cause).toMatchObject({
			message: expect.stringMatching(/Final assistant.*missing/),
		});
	});

	it("closes a parked drive as a controlled crash", async () => {
		const { harness, session, repo } = await createFixture({ drive: "manual" });
		const current = await installCheckpointRun(session);
		const drive = harness.drive({ operationId: current.operationId });
		await waitForAction(harness);

		await harness.close();
		await expect(drive).rejects.toBeInstanceOf(HarnessClosed);
		expect(await harness.prompt("late")).toMatchObject({ ok: false, error: { _tag: "Closed" } });
		expect(() => harness.events.on("run_start", () => {})).toThrow(HarnessClosed);
		const reopened = await repo.open(session.metadata);
		expect((await reopened.getRegister("op.state", current.operationId))?.value.kind).toBe("run");
		await reopened.close();
	});

	it("normalizes initialization commit failures to HarnessFault", async () => {
		const storage = new FailingMemoryStorage();
		const session = new StorageBackedSession({ id: "init-fault-test", createdAt: 1, storageVersion: 1 }, storage);
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
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		storage.failCommits = true;

		await expect(AgentHarness.create({ session, models, model: faux.getModel() })).rejects.toBeInstanceOf(
			HarnessFault,
		);
		await session.close();
	});

	it("faults the harness after an admitted commit fails", async () => {
		const storage = new FailingMemoryStorage();
		const session = new StorageBackedSession({ id: "fault-test", createdAt: 1, storageVersion: 1 }, storage);
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
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const { harness } = await AgentHarness.create({ session, models, model: faux.getModel() });
		storage.failCommits = true;

		let fault: unknown;
		try {
			await harness.setThinkingLevel("high");
		} catch (error) {
			fault = error;
		}
		expect(fault).toBeInstanceOf(HarnessFault);
		await expect(harness.getThinkingLevel()).rejects.toBe(fault);
		await harness.close();
	});
});
