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

async function installToolBatch(
	session: Session,
	stopReason: "toolUse" | "stop" | "length" | "error" | "deferred" | "aborted" = "toolUse",
) {
	const installed = await installRun(session);
	if (installed.state.kind !== "run") throw new Error("expected run state");
	const assistantEntryId = session.idGenerator.next();
	const timestamp = Number.parseInt(`${assistantEntryId.slice(0, 8)}${assistantEntryId.slice(9, 13)}`, 16);
	const resultEntryIds = [session.idGenerator.next(timestamp), session.idGenerator.next(timestamp)];
	const assistant = {
		role: "assistant" as const,
		content: [
			{ type: "toolCall" as const, id: "call-one", name: "echo", arguments: { value: "one" } },
			{ type: "toolCall" as const, id: "call-two", name: "echo", arguments: { value: "two" } },
		],
		api: "test",
		provider: "test",
		model: "model",
		usage: zeroUsage,
		stopReason,
		timestamp: 2,
	};
	const state: OperationState = {
		...installed.state,
		latestAssistantEntryId: assistantEntryId,
		phase: {
			kind: "tools",
			batch: {
				assistantEntryId,
				configuration: {
					model: { provider: "test", modelId: "model" },
					thinkingLevel: "off",
					activeToolNames: ["echo"],
				},
				turnId: session.idGenerator.next(),
				calls: resultEntryIds.map((resultEntryId, sourceIndex) => ({
					status: "planned" as const,
					sourceIndex,
					resultEntryId,
				})),
			},
		},
	};
	await session.mutate("main", (mutator) =>
		mutator.commit({
			writes: [
				{
					kind: "entry",
					entry: {
						id: assistantEntryId,
						parentId: installed.promptEntryId,
						type: "message",
						message: assistant,
					},
				},
				{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: assistantEntryId },
				{ kind: "register", op: "set", namespace: "op.state", key: installed.operationId, value: state },
			],
		}),
	);
	return { ...installed, assistantEntryId, resultEntryIds, assistant, state };
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
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: false },
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

		const finalAssistantEntryId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: finalAssistantEntryId,
							parentId: promptEntryId,
							type: "message",
							message: {
								role: "assistant",
								content: [{ type: "text", text: "not a tool result" }],
								api: "test",
								provider: "test",
								model: "model",
								usage: zeroUsage,
								stopReason: "stop",
								timestamp: 2,
							},
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: finalAssistantEntryId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...state,
							latestAssistantEntryId: finalAssistantEntryId,
							phase: {
								kind: "checkpoint",
								continuation: { kind: "may_finish", includeFinalAssistant: false },
								triggerEntryId: finalAssistantEntryId,
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(
			/terminated-tools checkpoint trigger is the latest assistant/,
		);
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: promptEntryId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...state,
							latestAssistantEntryId: finalAssistantEntryId,
							phase: {
								kind: "checkpoint",
								continuation: { kind: "may_finish", includeFinalAssistant: false },
								triggerEntryId: promptEntryId,
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(`entry ${promptEntryId} is not a tool result`);

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

	it("rejects classification-incompatible active and terminated tool provenance", async () => {
		const invalidSession = await createConfiguredSession();
		await installToolBatch(invalidSession, "error");
		await expect(restoreLane(invalidSession, "main")).rejects.toThrow(/incompatible stop reason/);

		const lengthSession = await createConfiguredSession();
		const installed = await installToolBatch(lengthSession, "length");
		if (installed.state.kind !== "run") throw new Error("expected run state");
		const [firstResultId, secondResultId] = installed.resultEntryIds;
		if (firstResultId === undefined || secondResultId === undefined) throw new Error("expected result ids");
		await lengthSession.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: firstResultId,
							parentId: installed.assistantEntryId,
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-one",
								toolName: "echo",
								content: [{ type: "text", text: "one" }],
								isError: true,
								timestamp: 3,
							},
							terminate: true,
						},
					},
					{
						kind: "entry",
						entry: {
							id: secondResultId,
							parentId: firstResultId,
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-two",
								toolName: "echo",
								content: [{ type: "text", text: "two" }],
								isError: true,
								timestamp: 4,
							},
							terminate: true,
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: secondResultId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: {
							...installed.state,
							phase: {
								kind: "checkpoint",
								continuation: { kind: "may_finish", includeFinalAssistant: false },
								triggerEntryId: secondResultId,
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(lengthSession, "main")).rejects.toThrow(
			/terminated-tools checkpoint assistant has an incompatible stop reason/,
		);
	});

	it("validates the complete terminated-tools result chain", async () => {
		const session = await createConfiguredSession();
		const installed = await installToolBatch(session);
		if (installed.state.kind !== "run") throw new Error("expected run state");
		const [firstResultId, secondResultId] = installed.resultEntryIds;
		if (firstResultId === undefined || secondResultId === undefined) throw new Error("expected result ids");
		const checkpointPhase = {
			kind: "checkpoint" as const,
			continuation: { kind: "may_finish" as const, includeFinalAssistant: false },
			triggerEntryId: secondResultId,
		};
		const checkpointState: OperationState = { ...installed.state, phase: checkpointPhase };
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: firstResultId,
							parentId: installed.assistantEntryId,
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-one",
								toolName: "echo",
								content: [{ type: "text", text: "one" }],
								isError: false,
								timestamp: 3,
							},
							terminate: true,
						},
					},
					{
						kind: "entry",
						entry: {
							id: secondResultId,
							parentId: firstResultId,
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-two",
								toolName: "echo",
								content: [{ type: "text", text: "two" }],
								isError: false,
								timestamp: 4,
							},
							terminate: true,
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: secondResultId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: checkpointState,
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).resolves.toMatchObject({
			current: { state: { phase: { continuation: { includeFinalAssistant: false } } } },
		});

		const unrelatedResultId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: unrelatedResultId,
							parentId: installed.assistantEntryId,
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-two",
								toolName: "echo",
								content: [{ type: "text", text: "unrelated" }],
								isError: false,
								timestamp: 5,
							},
							terminate: true,
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: unrelatedResultId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: {
							...checkpointState,
							phase: { ...checkpointPhase, triggerEntryId: unrelatedResultId },
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/terminated-tools result 0 is invalid/);

		const nonTerminatingResultId = session.idGenerator.next();
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "entry",
						entry: {
							id: nonTerminatingResultId,
							parentId: firstResultId,
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-two",
								toolName: "echo",
								content: [{ type: "text", text: "not terminating" }],
								isError: false,
								timestamp: 6,
							},
						},
					},
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: nonTerminatingResultId },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: {
							...checkpointState,
							phase: { ...checkpointPhase, triggerEntryId: nonTerminatingResultId },
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/terminated-tools result 1 is invalid/);
	});

	it("validates planned tool batches and rejects invalid indices, ids, and materialized reservations", async () => {
		const session = await createConfiguredSession();
		const installed = await installToolBatch(session);
		if (installed.state.kind !== "run" || installed.state.phase.kind !== "tools") {
			throw new Error("expected tool state");
		}
		const batch = installed.state.phase.batch;
		const writeCalls = (calls: typeof batch.calls) =>
			session.mutate("main", (mutator) =>
				mutator.commit({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: installed.operationId,
							value: { ...installed.state, phase: { kind: "tools", batch: { ...batch, calls } } },
						},
					],
				}),
			);

		await expect(restoreLane(session, "main")).resolves.toMatchObject({
			current: { state: { phase: { kind: "tools" } } },
		});
		await writeCalls([{ ...batch.calls[0]!, sourceIndex: 1 }, batch.calls[1]!]);
		await expect(restoreLane(session, "main")).rejects.toThrow(/source indices are not complete/);
		await writeCalls([batch.calls[0]!, { ...batch.calls[1]!, resultEntryId: batch.calls[0]!.resultEntryId }]);
		await expect(restoreLane(session, "main")).rejects.toThrow(/tool result id.*duplicated/);
		await writeCalls([batch.calls[0]!, { ...batch.calls[1]!, resultEntryId: session.idGenerator.next(1) }]);
		await expect(restoreLane(session, "main")).rejects.toThrow(/not a follower/);
		await writeCalls(batch.calls);
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "pending.entry",
						key: batch.calls[0]!.resultEntryId,
						value: { type: "message", payload: { role: "user", content: "unowned", timestamp: 3 } },
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/reserved settlement id.*pending entry/);
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "delete",
						namespace: "pending.entry",
						key: batch.calls[0]!.resultEntryId,
					},
					{
						kind: "entry",
						entry: {
							id: batch.calls[0]!.resultEntryId,
							parentId: installed.assistantEntryId,
							type: "message",
							message: {
								role: "toolResult",
								toolCallId: "call-one",
								toolName: "echo",
								content: [],
								isError: true,
								timestamp: 3,
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/reserved entry.*already exists/);
	});

	it("hydrates exact pending tool arguments and validates completed result chains", async () => {
		const session = await createConfiguredSession();
		const installed = await installToolBatch(session);
		if (installed.state.kind !== "run" || installed.state.phase.kind !== "tools") {
			throw new Error("expected tool state");
		}
		const batch = installed.state.phase.batch;
		const pendingState: OperationState = {
			...installed.state,
			phase: {
				kind: "tools",
				batch: {
					...batch,
					calls: [{ ...batch.calls[0]!, status: "effect_pending", replay: "safe" }, batch.calls[1]!],
				},
			},
		};
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "op.state", key: installed.operationId, value: pendingState },
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/missing tool arguments/);
		const argsKey = `${installed.operationId}:${batch.turnId}:0`;
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.tool_args",
						key: argsKey,
						value: { value: "effective" },
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).resolves.toMatchObject({
			current: { toolArguments: expect.any(Map) },
		});

		const completedEntry = {
			id: batch.calls[0]!.resultEntryId,
			parentId: installed.assistantEntryId,
			type: "message" as const,
			message: {
				role: "toolResult" as const,
				toolCallId: "call-one",
				toolName: "echo",
				content: [],
				isError: false,
				timestamp: 3,
			},
		};
		const completedState: OperationState = {
			...installed.state,
			phase: {
				kind: "tools",
				batch: {
					...batch,
					calls: [{ ...batch.calls[0]!, status: "completed", terminate: false }, batch.calls[1]!],
				},
			},
		};
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{ kind: "entry", entry: completedEntry },
					{ kind: "register", op: "set", namespace: "lane.leaf", key: "main", value: completedEntry.id },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: completedState,
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).resolves.toMatchObject({
			current: { state: { phase: { batch: { calls: [{ status: "completed" }, { status: "planned" }] } } } },
		});
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: {
							...completedState,
							phase: {
								kind: "tools",
								batch: {
									...batch,
									calls: [{ ...batch.calls[0]!, status: "completed", terminate: true }, batch.calls[1]!],
								},
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/terminate mismatch/);
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: completedState,
					},
				],
			}),
		);
		await session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: installed.operationId,
						value: {
							...completedState,
							phase: {
								kind: "tools",
								batch: {
									...batch,
									calls: [batch.calls[0]!, { ...batch.calls[1]!, status: "completed", terminate: false }],
								},
							},
						},
					},
				],
			}),
		);
		await expect(restoreLane(session, "main")).rejects.toThrow(/completed tool calls do not form a prefix/);
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
