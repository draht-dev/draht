import { createModels, fauxAssistantMessage, fauxProvider } from "@draht/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HarnessEvent, HarnessFault, type OperationRequest } from "../../../src/harness/agent-harness.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/harness/compaction/compaction.ts";
import { BACKGROUND_CONTEXT, createContextKey, withContextValue } from "../../../src/harness/context.ts";
import type { Result } from "../../../src/harness/result.ts";
import { createAgentHarness, Harness } from "../../../src/harness/runtime2/harness.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../../src/harness/session/testing/index.ts";
import * as storedValues from "../../../src/harness/session/values.ts";
import type { AgentMessage, Session } from "../../../src/index.ts";
import { ControlledMemoryStorage, deferred, FailingMemoryStorage } from "./test-utils.ts";

const sessions: Session[] = [];

async function createSession(storage = new InstrumentedStorage(new MemoryStorage())): Promise<{
	session: Session;
	storage: InstrumentedStorage;
}> {
	const session = new StorageBackedSession(
		{ id: `accept-${sessions.length}`, createdAt: 1, storageVersion: 1 },
		storage,
	);
	sessions.push(session);
	await session.mutate(
		"main",
		(mutator) =>
			mutator.commit(
				[
					storedValues.setValue(storedValues.laneLeaf("main"), null),
					storedValues.setValue(storedValues.laneState("main"), {
						currentOperationId: null,
						pendingNextRun: [],
					}),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	return { session, storage };
}

function options(session: Session) {
	const provider = fauxProvider();
	const models = createModels();
	models.setProvider(provider.provider);
	return { session, models, model: provider.getModel() };
}

async function createHarness(
	beforeCreate?: (session: Session) => Promise<void>,
	resources: Parameters<typeof createAgentHarness>[0]["resources"] = {},
): Promise<{
	harness: Harness<object | undefined>;
	session: Session;
	storage: InstrumentedStorage;
	models: ReturnType<typeof createModels>;
}> {
	const created = await createSession();
	await beforeCreate?.(created.session);
	const harnessOptions = { ...options(created.session), resources };
	const { harness } = await createAgentHarness(harnessOptions, BACKGROUND_CONTEXT);
	if (!(harness instanceof Harness)) throw new Error("Expected runtime2 Harness");
	created.storage.clearCommitAttempts();
	return { harness, ...created, models: harnessOptions.models };
}

function unwrap<T>(result: Result<T, unknown>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.close(BACKGROUND_CONTEXT);
});

describe("runtime2 atomic run acceptance", () => {
	it.each([
		["text", { kind: "prompt", prompt: "hello" } satisfies OperationRequest, [{ type: "text", text: "hello" }]],
		[
			"images",
			{
				kind: "prompt",
				prompt: "",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			} satisfies OperationRequest,
			[{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		],
		[
			"text and images",
			{
				kind: "prompt",
				prompt: "hello",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			} satisfies OperationRequest,
			[
				{ type: "text", text: "hello" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		],
	] as const)("accepts normalized %s prompts into starting", async (_name, request, expectedContent) => {
		const { harness, session } = await createHarness();

		const admission = unwrap(await harness.accept(request, BACKGROUND_CONTEXT));
		const operation = harness.state.operation;
		if (operation?.state.kind !== "run") throw new Error("Expected accepted run");
		const entryId = operation.meta.intent.kind === "run" ? operation.meta.intent.promptEntryIds[0] : undefined;
		if (entryId === undefined) throw new Error("Expected prompt entry");
		const entry = await session.getEntry(entryId, BACKGROUND_CONTEXT);

		expect(admission).toMatchObject({ operationId: operation.meta.operationId, kind: "run" });
		expect(entry).toMatchObject({ type: "message", message: { role: "user", content: expectedContent } });
		expect(operation.state.phase).toEqual({ kind: "starting" });
		expect(operation.state.settings).toEqual({
			compaction: DEFAULT_COMPACTION_SETTINGS,
			steeringMode: "all",
			followUpMode: "all",
			toolExecution: "parallel",
		});
	});

	it("preserves supplied message arrays and commits the exact acceptance write families once", async () => {
		const { harness, session, storage, models } = await createHarness();
		const messages: AgentMessage[] = [
			{ role: "user", content: "one", timestamp: 10 },
			{ role: "user", content: "two", timestamp: 11 },
		];
		const getModel = vi.spyOn(models, "getModel");
		const contextKey = createContextKey<string>("accept.context");
		const context = withContextValue(contextKey, "source", BACKGROUND_CONTEXT);
		const seen: Array<{ event: HarnessEvent; sameContext: boolean }> = [];
		for (const type of ["run_start", "message_start", "message_end", "entry_added"] as const) {
			harness.events.on(type, (event, eventContext) => {
				seen.push({ event, sameContext: eventContext === context });
			});
		}

		const admission = unwrap(
			await harness.accept({ kind: "prompt", operationId: "operation", prompt: messages }, context),
		);

		expect(admission).toEqual({ operationId: "operation", kind: "run", startedAt: expect.any(Number) });
		expect(storage.getCommitAttempts()).toHaveLength(1);
		expect(
			storage
				.getCommitAttempts()[0]
				?.map((write) => (write.kind === "value" ? `${write.kind}:${write.op}` : write.kind)),
		).toEqual(["entry", "entry", "value:set", "value:set", "value:set", "value:set"]);
		const operation = harness.state.operation;
		if (operation?.meta.intent.kind !== "run") throw new Error("Expected run metadata");
		expect(operation.meta).toMatchObject({
			operationId: "operation",
			lane: "main",
			sourceLeafId: null,
			intent: { promptEntryIds: expect.any(Array) },
		});
		expect(operation.meta.intent.promptEntryIds).toHaveLength(2);
		expect(await session.getLeafId(BACKGROUND_CONTEXT)).toBe(operation.meta.intent.promptEntryIds[1]);
		expect(seen.map(({ event }) => event.type)).toEqual([
			"run_start",
			"message_start",
			"message_end",
			"entry_added",
			"message_start",
			"message_end",
			"entry_added",
		]);
		expect(seen.every(({ sameContext }) => sameContext)).toBe(true);
		expect(getModel).not.toHaveBeenCalled();
	});

	it("captures next-run messages before request messages and accepts an otherwise empty request", async () => {
		const first = "pending-first";
		const second = "pending-second";
		const firstMessage = { role: "user" as const, content: "first", timestamp: 1 };
		const secondMessage = { role: "user" as const, content: "second", timestamp: 2 };
		const { harness, session, storage } = await createHarness(async (source) => {
			await source.mutate(
				"main",
				(mutator) =>
					mutator.commit(
						[
							storedValues.setValue(storedValues.pendingEntry(first), {
								type: "message",
								payload: firstMessage,
							}),
							storedValues.setValue(storedValues.pendingEntry(second), {
								type: "message",
								payload: secondMessage,
							}),
							storedValues.setValue(storedValues.laneState("main"), {
								currentOperationId: null,
								pendingNextRun: [first, second],
							}),
						],
						BACKGROUND_CONTEXT,
					),
				BACKGROUND_CONTEXT,
			);
		});
		const events: string[] = [];
		harness.events.on("queue_update", (event) => {
			events.push(event.type);
		});

		unwrap(await harness.accept({ kind: "prompt", prompt: "" }, BACKGROUND_CONTEXT));

		const operation = harness.state.operation;
		if (operation?.meta.intent.kind !== "run" || operation.state.kind !== "run") {
			throw new Error("Expected accepted run");
		}
		expect(operation.meta.intent.promptEntryIds).toEqual([]);
		expect(operation.meta.sourceLeafId).toBeNull();
		expect(operation.state.inbox).toEqual({ steer: [], followUp: [], writes: [] });
		expect(
			(await session.scanBranch({ start: second, order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(({ id }) => id),
		).toEqual([first, second]);
		expect(await session.getValue(storedValues.pendingEntry(first), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(storedValues.pendingEntry(second), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(
			storage
				.getCommitAttempts()[0]
				?.map((write) => (write.kind === "value" ? `${write.kind}:${write.op}` : write.kind)),
		).toEqual(["entry", "entry", "value:delete", "value:delete", "value:set", "value:set", "value:set", "value:set"]);
		expect(events).toEqual(["queue_update"]);
	});

	it("formats skills and templates before acceptance", async () => {
		const resources = {
			skills: [
				{ name: "review", description: "Review", content: "Inspect it", filePath: "/skills/review/SKILL.md" },
			],
			promptTemplates: [{ name: "fix", content: "Fix $1 then $@" }],
		};
		const skill = await createHarness(undefined, resources);
		unwrap(
			await skill.harness.accept(
				{ kind: "skill", name: "review", additionalInstructions: "Be strict" },
				BACKGROUND_CONTEXT,
			),
		);
		const skillEntry = await skill.session.getEntry(skill.harness.state.leafId!, BACKGROUND_CONTEXT);
		expect(skillEntry).toMatchObject({
			type: "message",
			message: { content: [{ type: "text", text: expect.stringContaining('<skill name="review"') }] },
		});

		const template = await createHarness(undefined, resources);
		unwrap(
			await template.harness.accept({ kind: "prompt_template", name: "fix", args: ["A", "B"] }, BACKGROUND_CONTEXT),
		);
		const templateEntry = await template.session.getEntry(template.harness.state.leafId!, BACKGROUND_CONTEXT);
		expect(templateEntry).toMatchObject({
			type: "message",
			message: { content: [{ type: "text", text: "Fix A then A B" }] },
		});
	});

	it("returns expected pre-acceptance errors without writing", async () => {
		const { harness, storage } = await createHarness();
		const pending = fauxAssistantMessage([], { stopReason: "pending" });

		expect(await harness.accept({ kind: "prompt", prompt: "" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "InvalidMessage", reason: "empty" },
		});
		expect(await harness.accept({ kind: "prompt", prompt: pending }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "InvalidMessage", reason: "pending_assistant" },
		});
		expect(await harness.accept({ kind: "skill", name: "missing" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "UnknownSkill" },
		});
		expect(await harness.accept({ kind: "prompt_template", name: "missing" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "UnknownTemplate" },
		});
		expect(storage.getCommitAttempts()).toEqual([]);
	});

	it("serializes concurrent accepts so exactly one wins", async () => {
		const { harness, storage } = await createHarness();

		const results = await Promise.all([
			harness.accept({ kind: "prompt", prompt: "first" }, BACKGROUND_CONTEXT),
			harness.accept({ kind: "prompt", prompt: "second" }, BACKGROUND_CONTEXT),
		]);

		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toMatchObject([{ error: { _tag: "LaneBusy" } }]);
		expect(storage.getCommitAttempts()).toHaveLength(1);
	});

	it("faults on commit failure without publishing acceptance", async () => {
		const storage = new FailingMemoryStorage();
		const session = new StorageBackedSession({ id: "failing", createdAt: 1, storageVersion: 1 }, storage);
		sessions.push(session);
		await session.mutate(
			"main",
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.laneLeaf("main"), null),
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: null,
							pendingNextRun: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const { harness } = await createAgentHarness(options(session), BACKGROUND_CONTEXT);
		if (!(harness instanceof Harness)) throw new Error("Expected runtime2 Harness");
		storage.failure = new Error("accept failed");

		await expect(harness.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT)).rejects.toBeInstanceOf(
			HarnessFault,
		);
		expect(harness.state.operation).toBeNull();
	});

	it("delivers acceptance listeners after publishing state and permits serialized reads", async () => {
		const { harness } = await createHarness();
		let inspected = false;
		harness.events.on("run_start", async () => {
			inspected = (await harness.inspectExecution(BACKGROUND_CONTEXT)).current?.status === "open";
		});

		unwrap(await harness.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT));

		expect(inspected).toBe(true);
	});

	it("does not resolve acceptance before its direct listeners settle", async () => {
		const { harness } = await createHarness();
		const started = deferred();
		const release = deferred();
		harness.events.on("run_start", async () => {
			started.resolve();
			await release.promise;
		});

		const acceptance = harness.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT);
		await started.promise;
		let resolved = false;
		void acceptance.then(() => {
			resolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(resolved).toBe(false);
		release.resolve();
		unwrap(await acceptance);
		expect(resolved).toBe(true);
	});

	it("returns Closed when acceptance starts after close", async () => {
		const { harness, storage } = await createHarness();
		await harness.close(BACKGROUND_CONTEXT);

		expect(await harness.accept({ kind: "prompt", prompt: "late" }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { _tag: "Closed" },
		});
		expect(storage.getCommitAttempts()).toEqual([]);
	});

	it("publishes an acceptance admitted before close", async () => {
		const storage = new ControlledMemoryStorage();
		const session = new StorageBackedSession({ id: "closing", createdAt: 1, storageVersion: 1 }, storage);
		sessions.push(session);
		await session.mutate(
			"main",
			(mutator) =>
				mutator.commit(
					[
						storedValues.setValue(storedValues.laneLeaf("main"), null),
						storedValues.setValue(storedValues.laneState("main"), {
							currentOperationId: null,
							pendingNextRun: [],
						}),
					],
					BACKGROUND_CONTEXT,
				),
			BACKGROUND_CONTEXT,
		);
		const { harness } = await createAgentHarness(options(session), BACKGROUND_CONTEXT);
		const started = deferred();
		const release = deferred();
		storage.beforeNextCommit = async () => {
			started.resolve();
			await release.promise;
		};
		const acceptance = harness.accept({ kind: "prompt", prompt: "hello" }, BACKGROUND_CONTEXT);
		await started.promise;
		const closing = harness.close(BACKGROUND_CONTEXT);
		release.resolve();

		expect((await acceptance).ok).toBe(true);
		await closing;
	});
});
