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

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

	it("validates R3 retry waits and their settled error relationship", async () => {
		const session = await createConfiguredSession();
		const { operationId, promptEntryId, state } = await installRun(session);
		if (state.kind !== "run") throw new Error("expected run state");
		const responseEntryId = session.idGenerator.next();
		const context = {
			stepId: session.idGenerator.next(),
			triggerEntryId: promptEntryId,
			configuration: {
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off" as const,
				activeToolNames: [],
			},
			streamOptions: {},
			retryPolicy: { maxAttempts: 2, baseDelayMs: 10 },
			overflowRecoveryUsed: false,
		};
		const response = {
			role: "assistant" as const,
			content: [],
			api: "test",
			provider: "test",
			model: "model",
			usage: zeroUsage,
			stopReason: "error" as const,
			errorMessage: "503 unavailable",
			timestamp: 2,
		};
		const retryState: OperationState = {
			...state,
			latestAssistantEntryId: responseEntryId,
			phase: {
				kind: "assistant",
				generation: {
					status: "retry_wait",
					context,
					nextAttempt: 2,
					notBefore: 100,
					errorMessage: response.errorMessage,
				},
			},
		};
		if (retryState.kind !== "run" || retryState.phase.kind !== "assistant") {
			throw new Error("expected assistant retry state");
		}
		const retryGeneration = retryState.phase.generation;
		if (retryGeneration.status !== "retry_wait") throw new Error("expected retry wait");
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: { id: responseEntryId, parentId: promptEntryId, type: "message", message: response },
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: responseEntryId },
					{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: retryState },
				],
			}),
		);
		await expect(restoreLane(session, "main")).resolves.toMatchObject({
			current: { state: { phase: { generation: { status: "retry_wait" } } } },
		});
		const writeState = (value: OperationState) =>
			session.mutate("main", (mutator) =>
				mutator.commit({
					writes: [{ kind: "register", op: "set", namespace: "op.state", key: operationId, value }],
				}),
			);

		await writeState({
			...retryState,
			phase: {
				kind: "assistant",
				generation: {
					...retryGeneration,
					context: { ...retryGeneration.context, triggerEntryId: responseEntryId },
				},
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/retry response is not later than its trigger/);

		await writeState({
			...retryState,
			phase: {
				kind: "assistant",
				generation: { ...retryGeneration, nextAttempt: 1 },
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/retry nextAttempt is not later/);

		await writeState({
			...retryState,
			phase: {
				kind: "assistant",
				generation: { ...retryGeneration, nextAttempt: 3 },
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/nextAttempt exceeds maxAttempts/);

		await writeState({
			...retryState,
			phase: {
				kind: "assistant",
				generation: { ...retryGeneration, errorMessage: "different" },
			},
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/error does not match its response/);

		const nonRetryableId = session.idGenerator.next();
		const nonRetryableMessage = "authentication failed";
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: nonRetryableId,
							parentId: responseEntryId,
							type: "message",
							message: { ...response, errorMessage: nonRetryableMessage },
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: nonRetryableId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...retryState,
							latestAssistantEntryId: nonRetryableId,
							phase: {
								kind: "assistant",
								generation: { ...retryGeneration, errorMessage: nonRetryableMessage },
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/latest assistant is not retryable/);
	});

	it("validates R3 deferred source identity and handle semantics", async () => {
		const session = await createConfiguredSession();
		const { operationId, promptEntryId, state } = await installRun(session);
		if (state.kind !== "run") throw new Error("expected run state");
		const responseEntryId = session.idGenerator.next();
		const configuration: LaneConfiguration = {
			model: { provider: "test", modelId: "model" },
			thinkingLevel: "off",
			activeToolNames: [],
		};
		const response = {
			role: "assistant" as const,
			content: [],
			api: "test-api",
			provider: "test",
			model: "model",
			usage: zeroUsage,
			stopReason: "deferred" as const,
			deferred: { provider: "test", modelId: "model", api: "test-api", id: "handle" },
			timestamp: 2,
		};
		const deferredState: OperationState = {
			...state,
			latestAssistantEntryId: responseEntryId,
			phase: {
				kind: "deferred",
				deferred: {
					status: "suspended",
					stepId: session.idGenerator.next(),
					sourceEntryId: responseEntryId,
					poll: 0,
					configuration,
					streamOptions: {},
				},
			},
		};
		if (deferredState.kind !== "run" || deferredState.phase.kind !== "deferred") {
			throw new Error("expected deferred run state");
		}
		const deferred = deferredState.phase.deferred;
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: { id: responseEntryId, parentId: promptEntryId, type: "message", message: response },
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: responseEntryId },
					{ kind: "register", op: "set", namespace: "op.state", key: operationId, value: deferredState },
				],
			}),
		);
		await expect(restoreLane(session, "main")).resolves.toMatchObject({
			current: { state: { phase: { kind: "deferred" } } },
		});

		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...deferredState,
							phase: {
								kind: "deferred",
								deferred: {
									...deferred,
									configuration: { ...configuration, model: { provider: "other", modelId: "model" } },
								},
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/identity does not match/);
	});

	it("rejects R3 reservation collisions and aborted latest assistants under running control", async () => {
		const session = await createConfiguredSession();
		const { operationId, promptEntryId, state } = await installRun(session);
		if (state.kind !== "run") throw new Error("expected run state");
		const pendingId = session.idGenerator.next();
		const context = {
			stepId: session.idGenerator.next(),
			triggerEntryId: promptEntryId,
			configuration: {
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off" as const,
				activeToolNames: [],
			},
			streamOptions: {},
			retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
			overflowRecoveryUsed: false,
		};
		await session.mutate("main", async (mutator) => {
			const laneState = await mutator.getRegister("lane.state", "main");
			if (laneState === undefined) throw new Error("missing lane state");
			await mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "pending.entry",
						key: pendingId,
						value: { type: "message", payload: { role: "user", content: "next", timestamp: 2 } },
					},
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { ...laneState.value, pendingNextRun: [pendingId] },
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...state,
							phase: {
								kind: "assistant",
								generation: {
									status: "effect_pending",
									context,
									attempt: 1,
									responseEntryId: pendingId,
									usageId: session.idGenerator.next(),
									intendedOutputLimit: 1,
									contextWindow: 1,
								},
							},
						},
					},
				],
			});
		});
		await expect(restoreLane(session, "main")).rejects.toThrow(/reserved settlement id.*pending entry/);

		const abortedId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "register", op: "delete", namespace: "pending.entry", key: pendingId },
					{
						kind: "entry",
						entry: {
							id: abortedId,
							parentId: promptEntryId,
							type: "message",
							message: {
								role: "assistant",
								content: [],
								api: "test",
								provider: "test",
								model: "model",
								usage: zeroUsage,
								stopReason: "aborted",
								timestamp: 2,
							},
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: abortedId },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { currentOperationId: operationId, pendingNextRun: [] },
					},
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...state,
							latestAssistantEntryId: abortedId,
							phase: {
								kind: "assistant",
								generation: { status: "ready", context, nextAttempt: 2 },
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/running operation references an aborted/);
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
