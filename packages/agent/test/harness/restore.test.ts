import { afterEach, describe, expect, it } from "vitest";
import { restoreLane } from "../../src/harness/restore.ts";
import {
	DEFAULT_COMPACTION_SETTINGS,
	type LaneConfiguration,
	MemorySessionRepo,
	type Operation,
	type OperationState,
	type Session,
} from "../../src/index.ts";

const repos: MemorySessionRepo[] = [];

async function createConfiguredSession(): Promise<Session> {
	const repo = new MemorySessionRepo();
	repos.push(repo);
	const session = await repo.create({});
	const configuration: LaneConfiguration = {
		model: { provider: "test", modelId: "model" },
		thinkingLevel: "off",
		activeToolNames: [],
	};
	await session.mutate("main", (mutator) =>
		mutator.commit({
			writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: configuration }],
		}),
	);
	return session;
}

async function installRun(session: Session): Promise<{
	operationId: string;
	promptEntryId: string;
	operation: Operation;
	state: OperationState;
}> {
	const operationId = session.idGenerator.next();
	const promptEntryId = session.idGenerator.next();
	const operation: Operation = {
		operationId,
		lane: "main",
		sourceLeafId: null,
		startedAt: 1,
		intent: { kind: "run", promptEntryIds: [promptEntryId] },
	};
	const state: OperationState = {
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
			triggerEntryId: promptEntryId,
		},
		inbox: { steer: [], followUp: [], writes: [] },
		latestAssistantEntryId: null,
	};
	await session.mutate("main", (mutator) =>
		mutator.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: promptEntryId,
						parentId: null,
						type: "message",
						message: { role: "user", content: "prompt", timestamp: 1 },
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: promptEntryId },
				{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value: operation },
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
	return { operationId, promptEntryId, operation, state };
}

afterEach(async () => {
	for (const repo of repos.splice(0)) await repo.close();
});

describe("restoreLane base validation", () => {
	it.each(["lane.config", "lane.state", "lane.leaf"] as const)("rejects a lane missing %s", async (namespace) => {
		const session = await createConfiguredSession();
		await session.mutate("main", (mutator) =>
			mutator.commit({ writes: [{ kind: "register", op: "delete", namespace, key: "main" }] }),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(`missing ${namespace}`);
	});

	it("rejects an idle lane whose leaf is missing", async () => {
		const session = await createConfiguredSession();
		const missingId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: missingId }],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(`missing entry ${missingId}`);
	});

	it("rejects missing pending-next-run payloads", async () => {
		const session = await createConfiguredSession();
		const pendingId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: null, pendingNextRun: [pendingId] },
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(`missing pending entry ${pendingId}`);
	});

	it("rejects invalid R2 checkpoint and generation relationships", async () => {
		const session = await createConfiguredSession();
		const { operationId, promptEntryId, state } = await installRun(session);
		if (state.kind !== "run") throw new Error("expected run state");
		const writeState = (value: OperationState) =>
			session.mutate("main", (mutator) =>
				mutator.commit({
					writes: [{ kind: "register", op: "set", namespace: "op.state", key: operationId, value }],
				}),
			);

		await writeState({
			...state,
			latestAssistantEntryId: null,
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: promptEntryId,
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/finish checkpoint has no latest assistant/);

		await writeState({
			...state,
			latestAssistantEntryId: promptEntryId,
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: promptEntryId,
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(`entry ${promptEntryId} is not an assistant message`);

		const responseEntryId = session.idGenerator.next();
		await writeState({
			...state,
			phase: {
				kind: "assistant",
				generation: {
					status: "effect_pending",
					context: {
						stepId: session.idGenerator.next(),
						triggerEntryId: promptEntryId,
						configuration: {
							model: { provider: "test", modelId: "model" },
							thinkingLevel: "off",
							activeToolNames: [],
						},
						streamOptions: {},
						retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
						overflowRecoveryUsed: false,
					},
					attempt: 1,
					responseEntryId,
					usageId: responseEntryId,
					intendedOutputLimit: 1,
					contextWindow: 1,
				},
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/response and usage ids collide/);

		await writeState({
			...state,
			phase: {
				kind: "assistant",
				generation: {
					status: "effect_pending",
					context: {
						stepId: session.idGenerator.next(),
						triggerEntryId: promptEntryId,
						configuration: {
							model: { provider: "test", modelId: "model" },
							thinkingLevel: "off",
							activeToolNames: [],
						},
						streamOptions: {},
						retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
						overflowRecoveryUsed: false,
					},
					attempt: 1,
					responseEntryId: promptEntryId,
					usageId: session.idGenerator.next(),
					intendedOutputLimit: 1,
					contextWindow: 1,
				},
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(`reserved entry ${promptEntryId} already exists`);
	});

	it("rejects missing operation registers and invalid base references", async () => {
		const session = await createConfiguredSession();
		const { operationId, operation, state } = await installRun(session);
		const writeOperation = (value: Operation) =>
			session.mutate("main", (mutator) =>
				mutator.commit({
					writes: [{ kind: "register", op: "set", namespace: "op.meta", key: operationId, value }],
				}),
			);
		const writeState = (value: OperationState) =>
			session.mutate("main", (mutator) =>
				mutator.commit({
					writes: [{ kind: "register", op: "set", namespace: "op.state", key: operationId, value }],
				}),
			);

		await session.mutate("main", (mutator) =>
			mutator.commit({ writes: [{ kind: "register", op: "delete", namespace: "op.meta", key: operationId }] }),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/missing op.meta/);
		await writeOperation(operation);
		await session.mutate("main", (mutator) =>
			mutator.commit({ writes: [{ kind: "register", op: "delete", namespace: "op.state", key: operationId }] }),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/missing op.state/);
		await writeState(state);

		await writeOperation({ ...operation, operationId: session.idGenerator.next() });
		await expect(restoreLane(session, "main")).rejects.toThrow(/has another operation id/);

		const missingSource = session.idGenerator.next();
		await writeOperation({ ...operation, sourceLeafId: missingSource });
		await expect(restoreLane(session, "main")).rejects.toThrow(`missing entry ${missingSource}`);

		const missingPrompt = session.idGenerator.next();
		await writeOperation({ ...operation, intent: { kind: "run", promptEntryIds: [missingPrompt] } });
		await expect(restoreLane(session, "main")).rejects.toThrow(`missing entry ${missingPrompt}`);

		const customEntryId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: { id: customEntryId, parentId: null, type: "custom", customType: "test" },
					},
				],
			}),
		);
		await writeOperation({ ...operation, intent: { kind: "run", promptEntryIds: [customEntryId] } });
		await expect(restoreLane(session, "main")).rejects.toThrow(`entry ${customEntryId} is not a message`);

		const missingTarget = session.idGenerator.next();
		await writeOperation({
			...operation,
			intent: { kind: "navigation", targetId: missingTarget, summarize: false },
		});
		await writeState({
			kind: "navigation",
			control: { status: "running" },
			targetId: missingTarget,
			summarize: false,
			phase: { kind: "ready_to_commit" },
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(`missing entry ${missingTarget}`);
	});
});
