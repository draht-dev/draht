import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type MutableModels,
} from "@draht/ai";
import { InMemoryTelemetryContext, type TelemetryContext } from "@draht/telemetry";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreakpointBarrier } from "../../src/harness/execution/breakpoint.ts";
import { MemoryStorage } from "../../src/harness/session/memory.ts";
import { StorageBackedSession } from "../../src/harness/session/session.ts";
import { InstrumentedStorage } from "../../src/harness/session/testing/index.ts";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type AgentHarnessTool,
	type HarnessEvent,
	HarnessFault,
	MemorySessionRepo,
	type Session,
} from "../../src/index.ts";
import { waitForTick } from "../utils/wait-for-tick.ts";

interface Fixture {
	harness: AgentHarnessInstance;
	session: Session;
	repo: MemorySessionRepo;
	faux: FauxProviderHandle;
	models: MutableModels;
	tools: AgentHarnessTool<undefined>[];
}

const fixtures: Fixture[] = [];

function testTool(name = "echo"): AgentHarnessTool<undefined> {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

async function createFixture(
	options: {
		drive?: "automatic" | "manual";
		retry?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
		tools?: AgentHarnessTool<undefined>[];
		activeToolNames?: string[];
		streamOptions?: { deferred?: boolean; headers?: Record<string, string> };
		telemetryContext?: TelemetryContext;
	} = {},
): Promise<Fixture> {
	const repo = new MemorySessionRepo();
	const session = await repo.create({});
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const tools = options.tools ?? [];
	const { harness } = await AgentHarness.create({
		session,
		models,
		model: faux.getModel(),
		tools,
		activeToolNames: options.activeToolNames ?? [],
		drive: options.drive,
		retry: options.retry,
		streamOptions: options.streamOptions,
		telemetryContext: options.telemetryContext,
	});
	const fixture = { harness, session, repo, faux, models, tools };
	fixtures.push(fixture);
	return fixture;
}

async function reopenFixture(
	fixture: Fixture,
	options: {
		registerProvider?: boolean;
		tools?: AgentHarnessTool<undefined>[];
		drive?: "automatic" | "manual";
		telemetryContext?: TelemetryContext;
	} = {},
) {
	await fixture.harness.close();
	fixtures.splice(fixtures.indexOf(fixture), 1);
	const session = await fixture.repo.open(fixture.session.metadata);
	const models = createModels();
	if (options.registerProvider !== false) models.setProvider(fixture.faux.provider);
	const tools = options.tools ?? fixture.tools;
	const created = await AgentHarness.create({
		session,
		models,
		model: fixture.faux.getModel(),
		tools,
		activeToolNames: [],
		drive: options.drive,
		telemetryContext: options.telemetryContext,
	});
	const reopened: Fixture = {
		harness: created.harness,
		session,
		repo: fixture.repo,
		faux: fixture.faux,
		models,
		tools,
	};
	fixtures.push(reopened);
	return { ...created, fixture: reopened };
}

async function waitForAction(harness: AgentHarnessInstance): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await harness.peekAction()) !== undefined) return;
		await waitForTick();
	}
	throw new Error("action did not park");
}

async function advanceToProviderBoundary(
	harness: AgentHarnessInstance,
	operationId: string,
): Promise<{ drive: Promise<unknown> }> {
	const drive = harness.drive({ operationId });
	for (const expected of ["runtime.dispatch", "run.generation_ready", "assistant.intent"] as const) {
		await waitForAction(harness);
		expect((await harness.executeAction())?.kind).toBe(expected);
	}
	await waitForAction(harness);
	expect(await harness.peekAction()).toMatchObject({ kind: "assistant.request" });
	return { drive };
}

function captureEvents(harness: AgentHarnessInstance): HarnessEvent[] {
	const events: HarnessEvent[] = [];
	for (const type of [
		"run_resume",
		"run_suspend",
		"turn_start",
		"message_start",
		"message_end",
		"entry_added",
		"usage",
		"turn_end",
		"retry_scheduled",
		"retry_start",
		"retry_end",
		"run_end",
	] as const) {
		harness.events.on(type, (event) => {
			events.push(event);
		});
	}
	return events;
}

async function closeAtAutomaticBreakpoint(
	fixture: Fixture,
	operationId: string,
	kind: string,
	startDrive: () => Promise<unknown>,
): Promise<unknown> {
	const originalHit = BreakpointBarrier.prototype.hit;
	let closePromise: Promise<void> | undefined;
	vi.spyOn(BreakpointBarrier.prototype, "hit").mockImplementation(function (this: BreakpointBarrier, info, options) {
		const hit = originalHit.call(this, info, options);
		if (info.kind === kind && closePromise === undefined) {
			queueMicrotask(() => {
				closePromise ??= fixture.harness.close();
			});
		}
		return hit;
	});
	const drive = startDrive();
	const rejected = expect(drive).rejects.toMatchObject({ name: "HarnessClosed" });
	for (let attempt = 0; attempt < 100 && closePromise === undefined; attempt++) await waitForTick();
	if (closePromise === undefined) throw new Error(`automatic breakpoint ${kind} was not reached`);
	await closePromise;
	await rejected;
	const fixtureIndex = fixtures.indexOf(fixture);
	if (fixtureIndex !== -1) fixtures.splice(fixtureIndex, 1);
	const reopened = await fixture.repo.open(fixture.session.metadata);
	const state = (await reopened.getRegister("op.state", operationId))?.value;
	await reopened.close();
	await fixture.repo.close();
	return state;
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) {
		await fixture.harness.close();
		await fixture.repo.close();
	}
});

describe("AgentHarness R3 generation recovery and retry", () => {
	it.each([
		{ target: "run.generation_ready", phase: { kind: "checkpoint" } },
		{ target: "assistant.intent", phase: { kind: "assistant", generation: { status: "ready" } } },
		{ target: "assistant.settlement", phase: { kind: "assistant", generation: { status: "effect_pending" } } },
		{ target: "run.finish", phase: { kind: "checkpoint", continuation: { kind: "may_finish" } } },
	] as const)("automatic close at $target preserves the durable prefix", async ({ target, phase }) => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("boundary")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;

		const after = await closeAtAutomaticBreakpoint(fixture, accepted.value.operationId, target, () =>
			fixture.harness.drive({ operationId: accepted.value.operationId }),
		);
		expect(after).toMatchObject({ kind: "run", phase });
	});

	it("persists a retry wait, returns it without a timer, then drives a due retry", async () => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
			(context) => {
				expect(context.messages).toHaveLength(1);
				expect(context.messages[0]).toMatchObject({ role: "user" });
				return fauxAssistantMessage("recovered");
			},
		]);
		const events = captureEvents(fixture.harness);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const timer = vi.spyOn(globalThis, "setTimeout");
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;

		const waiting = await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		expect(waiting).toEqual({
			ok: true,
			value: { kind: "waiting", operationId: accepted.value.operationId, reason: "retry", notBefore: 1_100 },
		});
		expect(timer).not.toHaveBeenCalled();
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			latestAssistantEntryId: expect.any(String),
			phase: {
				kind: "assistant",
				generation: { status: "retry_wait", nextAttempt: 2, notBefore: 1_100 },
			},
		});

		now.mockReturnValue(1_100);
		const completed = await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		expect(completed).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed", finalMessage: { content: [{ text: "recovered" }] } } },
		});
		expect(fixture.faux.state.callCount).toBe(2);
		expect(
			events
				.filter((event) => event.type.startsWith("retry_"))
				.map((event) => ({ type: event.type, ...("attempt" in event ? { attempt: event.attempt } : {}) })),
		).toEqual([
			{ type: "retry_scheduled", attempt: 2 },
			{ type: "retry_start", attempt: 2 },
			{ type: "retry_end", attempt: 2 },
		]);
	});

	it("returns a future retry when the drive deadline precedes it without creating a timer", async () => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		const timer = vi.spyOn(globalThis, "setTimeout");

		expect(
			await fixture.harness.drive({
				operationId: accepted.value.operationId,
				waitForRetry: true,
				deadline: 1_050,
			}),
		).toEqual({
			ok: true,
			value: { kind: "waiting", operationId: accepted.value.operationId, reason: "retry", notBefore: 1_100 },
		});
		expect(timer).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"returns a future retry when the drive deadline is already reached (wait=%s)",
		async (waitForRetry) => {
			const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
			fixture.faux.setResponses([
				fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
			]);
			const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
			const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
			if (!accepted.ok) throw accepted.error;
			await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
			now.mockReturnValue(1_050);
			const timer = vi.spyOn(globalThis, "setTimeout");

			expect(
				await fixture.harness.drive({
					operationId: accepted.value.operationId,
					waitForRetry,
					deadline: 1_050,
				}),
			).toEqual({
				ok: true,
				value: {
					kind: "waiting",
					operationId: accepted.value.operationId,
					reason: "retry",
					notBefore: 1_100,
				},
			});
			expect(timer).not.toHaveBeenCalled();
		},
	);

	it("does not admit a retry timer after the deadline expires at its breakpoint", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const first = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		while (true) {
			await waitForAction(fixture.harness);
			const action = await fixture.harness.executeAction();
			if (action?.kind === "assistant.settlement") break;
		}
		expect(await first).toMatchObject({ ok: true, value: { kind: "waiting", notBefore: 1_100 } });
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;

		const second = fixture.harness.drive({
			operationId: accepted.value.operationId,
			waitForRetry: true,
			deadline: 1_200,
		});
		await waitForAction(fixture.harness);
		expect((await fixture.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({ kind: "assistant.retry_wait" });
		now.mockReturnValue(1_300);
		const timer = vi.spyOn(globalThis, "setTimeout");
		expect((await fixture.harness.executeAction())?.kind).toBe("assistant.retry_wait");
		expect(await second).toMatchObject({ ok: true, value: { kind: "yielded" } });
		expect(timer).not.toHaveBeenCalled();
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
	});

	it("yields a due retry when the drive deadline is already reached without erasing the wait", async () => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		now.mockReturnValue(1_100);

		expect(
			await fixture.harness.drive({
				operationId: accepted.value.operationId,
				waitForRetry: false,
				deadline: 1_100,
			}),
		).toEqual({
			ok: true,
			value: { kind: "yielded", operationId: accepted.value.operationId },
		});
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
	});

	it("lets convenience prompting own the local retry timer", async () => {
		vi.useFakeTimers({ now: 1_000 });
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("ok"),
		]);
		const result = fixture.harness.prompt("go");
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(fixture.faux.state.callCount).toBe(2);
	});

	it("commits ready after an admitted retry timer reaches the caller deadline", async () => {
		vi.useFakeTimers({ now: 1_000 });
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });

		const driven = fixture.harness.drive({
			operationId: accepted.value.operationId,
			waitForRetry: true,
			deadline: 1_100,
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(await driven).toEqual({
			ok: true,
			value: { kind: "yielded", operationId: accepted.value.operationId },
		});
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			phase: { kind: "assistant", generation: { status: "ready", nextAttempt: 2 } },
		});
		expect(fixture.faux.state.callCount).toBe(1);
	});

	it("saturates retry delay and notBefore arithmetic", async () => {
		const fixture = await createFixture({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: Number.MAX_SAFE_INTEGER },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);
		const events = captureEvents(fixture.harness);
		vi.spyOn(Date, "now").mockReturnValue(100);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const waiting = await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		expect(waiting).toMatchObject({
			ok: true,
			value: { kind: "waiting", notBefore: Number.MAX_SAFE_INTEGER },
		});
		expect(events.find((event) => event.type === "retry_scheduled")).toMatchObject({
			delayMs: Number.MAX_SAFE_INTEGER,
		});
	});

	it("saturates exponential retry multiplication on a later attempt", async () => {
		const baseDelayMs = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 2, baseDelayMs } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 first" }),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 second" }),
		]);
		const events = captureEvents(fixture.harness);
		vi.spyOn(Date, "now").mockReturnValue(100);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		expect(
			await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false }),
		).toMatchObject({ ok: true, value: { kind: "waiting" } });
		const stored = await fixture.session.getRegister("op.state", accepted.value.operationId);
		if (
			stored?.value.kind !== "run" ||
			stored.value.phase.kind !== "assistant" ||
			stored.value.phase.generation.status !== "retry_wait"
		) {
			throw new Error("missing retry wait");
		}
		const retryGeneration = stored.value.phase.generation;
		const retryState = stored.value;
		await fixture.session.mutate("main", (mutator) =>
			mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: accepted.value.operationId,
						value: {
							...retryState,
							phase: {
								kind: "assistant",
								generation: { ...retryGeneration, notBefore: 100 },
							},
						},
					},
				],
			}),
		);

		expect(
			await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false }),
		).toMatchObject({
			ok: true,
			value: { kind: "waiting", notBefore: Number.MAX_SAFE_INTEGER },
		});
		expect(events.filter((event) => event.type === "retry_scheduled").map((event) => event.delayMs)).toEqual([
			baseDelayMs,
			Number.MAX_SAFE_INTEGER,
		]);
	});

	it("emits retry_start only after the later attempt intent commits", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 first" }),
			fauxAssistantMessage("ok"),
		]);
		const events = captureEvents(fixture.harness);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const first = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		while (true) {
			await waitForAction(fixture.harness);
			const action = await fixture.harness.executeAction();
			if (action?.kind === "assistant.settlement") break;
		}
		expect(await first).toMatchObject({ ok: true, value: { kind: "waiting", notBefore: 1_100 } });

		now.mockReturnValue(1_100);
		const yielded = fixture.harness.drive({
			operationId: accepted.value.operationId,
			waitForRetry: false,
			deadline: 1_150,
		});
		await waitForAction(fixture.harness);
		expect((await fixture.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(fixture.harness);
		expect((await fixture.harness.executeAction())?.kind).toBe("assistant.retry_ready");
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({ kind: "assistant.intent" });
		now.mockReturnValue(1_200);
		expect((await fixture.harness.executeAction())?.kind).toBe("assistant.intent");
		expect(await yielded).toMatchObject({ ok: true, value: { kind: "yielded" } });
		expect(events.filter((event) => event.type === "retry_start")).toHaveLength(0);

		now.mockReturnValue(1_100);
		const admitted = fixture.harness.drive({ operationId: accepted.value.operationId });
		await waitForAction(fixture.harness);
		expect((await fixture.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(fixture.harness);
		expect((await fixture.harness.executeAction())?.kind).toBe("assistant.intent");
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({ kind: "assistant.request" });
		expect(events.filter((event) => event.type === "retry_start")).toHaveLength(1);
		await fixture.harness.close();
		await expect(admitted).rejects.toMatchObject({ name: "HarnessClosed" });
	});

	it("does not repeat before_resume after its completed hook yields to the drive deadline", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("ok")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const reopened = await reopenFixture(fixture);
		const now = vi.spyOn(Date, "now").mockReturnValue(100);
		let resumes = 0;
		const events = captureEvents(reopened.harness);
		reopened.harness.hooks.on(
			"before_resume",
			() => {
				resumes++;
				now.mockReturnValue(200);
			},
			{ id: "resume-once" },
		);

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId, deadline: 150 })).toEqual({
			ok: true,
			value: { kind: "yielded", operationId: accepted.value.operationId },
		});
		now.mockReturnValue(100);
		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
		expect(resumes).toBe(1);
		expect(events.filter((event) => event.type === "run_resume")).toHaveLength(1);
		expect(events.find((event) => event.type === "turn_start")).not.toHaveProperty("recovery");
		expect(events.find((event) => event.type === "run_end")).not.toHaveProperty("recovery");
	});

	it("does not repeat run_resume when a deadline yields before the resume hook", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("ok")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const reopened = await reopenFixture(fixture, { drive: "manual" });
		const now = vi.spyOn(Date, "now").mockReturnValue(100);
		const events = captureEvents(reopened.harness);
		let resumes = 0;
		reopened.harness.hooks.on(
			"before_resume",
			() => {
				resumes++;
			},
			{ id: "resume-once" },
		);

		const first = reopened.harness.drive({ operationId: accepted.value.operationId, deadline: 150 });
		await waitForAction(reopened.harness);
		expect((await reopened.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(reopened.harness);
		expect(await reopened.harness.peekAction()).toMatchObject({ kind: "hook.before_resume" });
		now.mockReturnValue(200);
		expect((await reopened.harness.executeAction())?.kind).toBe("hook.before_resume");
		expect(await first).toMatchObject({ ok: true, value: { kind: "yielded" } });
		expect(resumes).toBe(0);

		now.mockReturnValue(100);
		const second = reopened.harness.drive({ operationId: accepted.value.operationId });
		await waitForAction(reopened.harness);
		await reopened.harness.runToCompletion();
		expect(await second).toMatchObject({ ok: true, value: { kind: "settled", outcome: { kind: "completed" } } });
		expect(resumes).toBe(1);
		expect(events.filter((event) => event.type === "run_resume")).toHaveLength(1);
		expect(events.find((event) => event.type === "turn_start")).not.toHaveProperty("recovery");
	});

	it("reopens both future and due retry waits without repeating the failed request", async () => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
			fauxAssistantMessage("ok"),
		]);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		const reopened = await reopenFixture(fixture);

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false })).toEqual({
			ok: true,
			value: { kind: "waiting", operationId: accepted.value.operationId, reason: "retry", notBefore: 1_100 },
		});
		const execution = await reopened.harness.inspectExecution();
		expect(execution.current).toMatchObject({ status: "suspended" });
		expect(execution.current).not.toHaveProperty("suspended");
		expect(fixture.faux.state.callCount).toBe(1);
		now.mockReturnValue(1_100);
		expect(
			await reopened.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false }),
		).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
		expect(fixture.faux.state.callCount).toBe(2);
	});

	it("recovers an orphaned request below the cap with a later attempt and abandons old ids", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		fixture.faux.setResponses([fauxAssistantMessage("second attempt")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const pending = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		if (
			pending?.kind !== "run" ||
			pending.phase.kind !== "assistant" ||
			pending.phase.generation.status !== "effect_pending"
		) {
			throw new Error("missing pending assistant request");
		}
		const abandoned = pending.phase.generation;
		const reopened = await reopenFixture(fixture);
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const events = captureEvents(reopened.harness);

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
		expect(fixture.faux.state.callCount).toBe(1);
		expect(await reopened.fixture.session.getEntries([abandoned.responseEntryId, abandoned.usageId])).toEqual(
			new Map(),
		);
		expect(events.map((event) => event.type)).toEqual([
			"run_resume",
			"retry_start",
			"turn_start",
			"message_start",
			"message_end",
			"entry_added",
			"usage",
			"turn_end",
			"retry_end",
			"run_end",
		]);
		for (const event of events) {
			if (event.type === "entry_added" || event.type === "usage") {
				expect(event).not.toHaveProperty("recovery");
			} else {
				expect(event).toMatchObject({ recovery: true });
			}
		}
	});

	it("synthetically settles an orphaned final attempt under its reserved ids", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		fixture.faux.setResponses([fauxAssistantMessage("must not run")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const pending = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		if (
			pending?.kind !== "run" ||
			pending.phase.kind !== "assistant" ||
			pending.phase.generation.status !== "effect_pending"
		) {
			throw new Error("missing pending assistant request");
		}
		const reserved = pending.phase.generation;
		const telemetry = new InMemoryTelemetryContext();
		const reopened = await reopenFixture(fixture, { telemetryContext: telemetry });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const events = captureEvents(reopened.harness);

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: {
				kind: "settled",
				outcome: { kind: "failed", error: { code: "assistant_error" }, finalEntryId: reserved.responseEntryId },
			},
		});
		expect(fixture.faux.state.callCount).toBe(0);
		expect(await reopened.fixture.session.getEntries([reserved.responseEntryId])).toMatchObject(
			new Map([
				[
					reserved.responseEntryId,
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({ stopReason: "error", usage: ZERO_USAGE_FOR_TEST }),
					}),
				],
			]),
		);
		expect(events.find((event) => event.type === "usage")).toMatchObject({ row: { id: reserved.usageId } });
		expect(events.filter((event) => event.type === "message_start")).toMatchObject([{ recovery: true }]);
		const runSpan = telemetry.getSpans().find((span) => span.name === "pi.harness.run");
		expect(runSpan?.attributes).toMatchObject({
			"pi.operation.recovery": true,
			"pi.operation.outcome": "failed",
		});
		expect(runSpan?.status).toEqual({ status: "error" });
		const stepSpan = telemetry.getSpans().find((span) => span.name === "pi.harness.step");
		expect(stepSpan?.attributes).toMatchObject({ "pi.step.outcome": "failed" });
		expect(stepSpan?.status).toEqual({ status: "error" });
	});

	it("suspends ready work for missing model and tool identities, then succeeds on a later drive", async () => {
		const tool = testTool();
		const fixture = await createFixture({ tools: [tool], activeToolNames: [tool.name] });
		fixture.faux.setResponses([fauxAssistantMessage("ok")]);
		const events = captureEvents(fixture.harness);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		fixture.models.deleteProvider(fixture.faux.provider.id);
		await fixture.harness.setTools([]);

		const waiting = await fixture.harness.drive({ operationId: accepted.value.operationId });
		expect(waiting).toMatchObject({
			ok: true,
			value: {
				kind: "waiting",
				reason: "missing_identities",
				missing: { model: expect.stringContaining("faux-1"), tools: ["echo"] },
			},
		});
		expect(fixture.faux.state.callCount).toBe(0);
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			phase: { kind: "assistant", generation: { status: "ready", nextAttempt: 1 } },
		});
		expect(events.find((event) => event.type === "run_suspend")).toMatchObject({
			reason: "missing_identities",
		});
		expect((await fixture.harness.inspectExecution()).current).toMatchObject({
			status: "suspended",
			suspended: { reason: "missing_identities" },
		});

		fixture.models.setProvider(fixture.faux.provider);
		await fixture.harness.setTools([tool]);
		expect(await fixture.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
	});

	it("recovers an orphan before applying missing-identity preflight", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const reopened = await reopenFixture(fixture, { registerProvider: false });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "failed", error: { code: "assistant_error" } } },
		});
	});

	it("advances an orphan below the cap before suspending for a missing model", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const reopened = await reopenFixture(fixture, { registerProvider: false });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const events = captureEvents(reopened.harness);

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "missing_identities" },
		});
		expect((await reopened.fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject(
			{
				phase: { kind: "assistant", generation: { status: "ready", nextAttempt: 2 } },
			},
		);
		expect(events.some((event) => event.type === "retry_start")).toBe(false);
	});

	it("persists a valid deferred response and returns semantic suspension", async () => {
		const fixture = await createFixture({ streamOptions: { headers: { captured: "yes" } } });
		const handle = {
			provider: fixture.faux.provider.id,
			modelId: fixture.faux.getModel().id,
			api: fixture.faux.api,
			id: "deferred-1",
		};
		fixture.harness.hooks.on("after_response", ({ message }) => ({
			message: { ...message, model: "display-model" },
		}));
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "deferred", deferred: handle })]);
		const events = captureEvents(fixture.harness);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;

		expect(await fixture.harness.drive({ operationId: accepted.value.operationId })).toEqual({
			ok: true,
			value: { kind: "waiting", operationId: accepted.value.operationId, reason: "deferred", deferred: handle },
		});
		const state = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		expect(state).toMatchObject({
			latestAssistantEntryId: expect.any(String),
			phase: {
				kind: "deferred",
				deferred: {
					status: "suspended",
					poll: 0,
					configuration: { model: { provider: fixture.faux.provider.id, modelId: fixture.faux.getModel().id } },
					streamOptions: { headers: { captured: "yes" } },
				},
			},
		});
		expect(events.map((event) => event.type).slice(-5)).toEqual([
			"message_end",
			"entry_added",
			"usage",
			"turn_end",
			"run_suspend",
		]);

		const reopened = await reopenFixture(fixture);
		expect(reopened.suspended).toMatchObject([
			{ operationId: accepted.value.operationId, reason: "deferred", deferred: handle },
		]);
		expect(await reopened.harness.drive({ operationId: accepted.value.operationId, pollDeferred: true })).toEqual({
			ok: true,
			value: {
				kind: "waiting",
				operationId: accepted.value.operationId,
				reason: "deferred",
				deferred: handle,
			},
		});
		expect(fixture.faux.state.deferredFetchCount).toBe(0);
	});

	it("returns deferred suspension from convenience prompting without polling", async () => {
		const fixture = await createFixture();
		const handle = {
			provider: fixture.faux.provider.id,
			modelId: fixture.faux.getModel().id,
			api: fixture.faux.api,
			id: "convenience-deferred",
		};
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "deferred", deferred: handle })]);
		expect(await fixture.harness.prompt("go")).toMatchObject({
			ok: true,
			value: {
				kind: "suspended",
				reason: "deferred",
				finalEntryId: expect.any(String),
				deferred: handle,
			},
		});
		expect(fixture.faux.state.deferredFetchCount).toBe(0);
	});

	it("returns an existing deferred suspension even when the drive deadline has expired", async () => {
		const fixture = await createFixture();
		const handle = {
			provider: fixture.faux.provider.id,
			modelId: fixture.faux.getModel().id,
			api: fixture.faux.api,
			id: "deadline-deferred",
		};
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "deferred", deferred: handle })]);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await fixture.harness.drive({ operationId: accepted.value.operationId });

		now.mockReturnValue(1_100);
		expect(await fixture.harness.drive({ operationId: accepted.value.operationId, deadline: 1_100 })).toEqual({
			ok: true,
			value: { kind: "waiting", operationId: accepted.value.operationId, reason: "deferred", deferred: handle },
		});
	});

	it("normalizes a deferred response with no handle before message_end", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "deferred" })]);
		const events = captureEvents(fixture.harness);
		expect(await fixture.harness.prompt("go")).toMatchObject({
			ok: true,
			value: { kind: "failed", error: { message: expect.stringContaining("Invalid deferred") } },
		});
		const messageEnd = events.find(
			(event) => event.type === "message_end" && "role" in event.message && event.message.role === "assistant",
		);
		const entryAdded = events.find(
			(event) =>
				event.type === "entry_added" &&
				event.entry.type === "message" &&
				"role" in event.entry.message &&
				event.entry.message.role === "assistant",
		);
		const turnEnd = events.find((event) => event.type === "turn_end");
		expect(messageEnd).toMatchObject({ message: { stopReason: "error" } });
		expect(entryAdded).toMatchObject({ entry: { type: "message", message: { stopReason: "error" } } });
		expect(turnEnd).toMatchObject({ message: { stopReason: "error" } });
		if (messageEnd?.type !== "message_end" || entryAdded?.type !== "entry_added" || turnEnd?.type !== "turn_end") {
			throw new Error("missing assistant settlement events");
		}
		if (entryAdded.entry.type !== "message") throw new Error("assistant entry is not a message");
		expect(messageEnd.message).toEqual(entryAdded.entry.message);
		expect(turnEnd.message).toEqual(entryAdded.entry.message);
	});

	it.each([
		{ id: "", provider: "faux", modelId: "faux-1", api: "faux" },
		{ id: "deferred", provider: "other", modelId: "faux-1", api: "faux" },
	] as const)("normalizes invalid deferred handle %# to a durable error", async (bad) => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "deferred",
				deferred: { ...bad, api: bad.api === "faux" ? fixture.faux.api : bad.api },
			}),
		]);
		const result = await fixture.harness.prompt("go");
		expect(result).toMatchObject({
			ok: true,
			value: { kind: "failed", error: { message: expect.stringContaining("Invalid deferred") } },
		});
		const leaf = await fixture.harness.getLeafId();
		if (leaf === null) throw new Error("missing failed response");
		expect(await fixture.harness.sessionTree.getEntry(leaf)).toMatchObject({
			message: { stopReason: "error", errorMessage: expect.stringContaining("Invalid deferred") },
		});
	});

	it("retains a genuine output-limit length response as the completed final assistant", async () => {
		const fixture = await createFixture();
		fixture.harness.hooks.on("after_response", ({ message }) => ({
			message: {
				...message,
				usage: { ...message.usage, output: fixture.faux.getModel().maxTokens },
			},
		}));
		fixture.faux.setResponses([fauxAssistantMessage("truncated", { stopReason: "length" })]);
		expect(await fixture.harness.prompt("go")).toMatchObject({
			ok: true,
			value: { kind: "completed", finalMessage: { stopReason: "length" } },
		});
	});

	it("leaves overflow settlement as the direct R9 runtime stub", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long for this model" }),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await expect(fixture.harness.drive({ operationId: accepted.value.operationId })).rejects.toThrow(
			/assistant settlement\(overflow\).*later AgentHarness runtime slice/,
		);
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			phase: { kind: "assistant", generation: { status: "effect_pending" } },
		});
	});

	it("fails an attempt in-band when the request-time model registration was swapped", async () => {
		const fixture = await createFixture({ drive: "manual" });
		fixture.faux.setResponses([fauxAssistantMessage("original must not run")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const replacement = fauxProvider({
			api: fixture.faux.api,
			provider: fixture.faux.provider.id,
			models: [{ id: fixture.faux.getModel().id }],
		});
		replacement.setResponses([fauxAssistantMessage("replacement must not run")]);
		fixture.models.setProvider(replacement.provider);

		expect((await fixture.harness.executeAction())?.kind).toBe("assistant.request");
		await fixture.harness.runToCompletion();
		expect(await drive).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "failed", error: { code: "assistant_error" } } },
		});
		expect(fixture.faux.state.callCount).toBe(0);
		expect(replacement.state.callCount).toBe(0);
	});

	it("treats provider aborted under running control as corruption", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "aborted" })]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await expect(fixture.harness.drive({ operationId: accepted.value.operationId })).rejects.toBeInstanceOf(
			HarnessFault,
		);
	});

	it("keeps convenience and explicit retry writes and events equivalent", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const createInstrumented = async (id: string) => {
			const storage = new InstrumentedStorage(new MemoryStorage({ now: () => 1_000 }));
			const session = new StorageBackedSession({ id, createdAt: 1_000, storageVersion: 1 }, storage);
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
			const faux = fauxProvider({ api: "faux-equivalence", tokenSize: { min: 1, max: 1 } });
			const models = createModels();
			models.setProvider(faux.provider);
			const { harness } = await AgentHarness.create({
				session,
				models,
				model: faux.getModel(),
				activeToolNames: [],
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			});
			storage.clearCommitAttempts();
			faux.setResponses([
				fauxAssistantMessage([], {
					stopReason: "error",
					errorMessage: "503 service unavailable",
					timestamp: 2,
				}),
				fauxAssistantMessage("ok", { timestamp: 3 }),
			]);
			const events: HarnessEvent[] = [];
			for (const type of [
				"run_start",
				"turn_start",
				"message_start",
				"message_update",
				"message_end",
				"entry_added",
				"usage",
				"turn_end",
				"retry_scheduled",
				"retry_start",
				"retry_end",
				"run_end",
			] as const) {
				harness.events.on(type, (event) => {
					events.push(event);
				});
			}
			return { harness, session, storage, events };
		};
		const explicit = await createInstrumented("explicit");
		const convenience = await createInstrumented("convenience");
		try {
			const accepted = await explicit.harness.accept({ kind: "prompt", prompt: "go" });
			if (!accepted.ok) throw accepted.error;
			expect(
				await explicit.harness.drive({ operationId: accepted.value.operationId, waitForRetry: true }),
			).toMatchObject({ ok: true, value: { kind: "settled", outcome: { kind: "completed" } } });
			expect(await convenience.harness.prompt("go")).toMatchObject({ ok: true, value: { kind: "completed" } });

			const normalize = (value: unknown): unknown => {
				const ids = new Map<string, string>();
				const visit = (item: unknown): unknown => {
					if (typeof item === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(item)) {
						let normalized = ids.get(item);
						if (normalized === undefined) {
							normalized = `id-${ids.size + 1}`;
							ids.set(item, normalized);
						}
						return normalized;
					}
					if (Array.isArray(item)) return item.map(visit);
					if (item === null || typeof item !== "object") return item;
					const object: Record<string, unknown> = {};
					for (const [key, child] of Object.entries(item)) object[key] = visit(child);
					return object;
				};
				return visit(value);
			};
			expect(normalize({ writes: explicit.storage.getCommitAttempts(), events: explicit.events })).toEqual(
				normalize({ writes: convenience.storage.getCommitAttempts(), events: convenience.events }),
			);
			expect(await explicit.session.getStats()).toEqual(await convenience.session.getStats());
		} finally {
			await explicit.harness.close();
			await convenience.harness.close();
		}
	});

	it("records content-free retry and completion telemetry outcomes", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const fixture = await createFixture({
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			telemetryContext: telemetry,
		});
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 secret failure" }),
			fauxAssistantMessage("secret completion"),
		]);
		expect(await fixture.harness.prompt("secret prompt")).toMatchObject({
			ok: true,
			value: { kind: "completed" },
		});
		const spans = telemetry.getSpans();
		const stepSpans = spans.filter((span) => span.name === "pi.harness.step");
		expect(stepSpans.map((span) => span.attributes["pi.step.outcome"])).toEqual(["retry", "succeeded"]);
		expect(stepSpans.map((span) => span.status.status)).toEqual(["error", "ok"]);
		const runSpan = spans.filter((span) => span.name === "pi.harness.run").at(-1);
		expect(runSpan?.attributes).toMatchObject({ "pi.operation.outcome": "completed" });
		expect(runSpan?.status).toEqual({ status: "ok" });
		const serialized = JSON.stringify(spans);
		expect(serialized).not.toContain("secret prompt");
		expect(serialized).not.toContain("secret failure");
		expect(serialized).not.toContain("secret completion");
	});

	it("records failed and deferred telemetry outcomes", async () => {
		const failedTelemetry = new InMemoryTelemetryContext();
		const failed = await createFixture({ telemetryContext: failedTelemetry });
		failed.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "deterministic failure" }),
		]);
		expect(await failed.harness.prompt("fail")).toMatchObject({ ok: true, value: { kind: "failed" } });
		const failedStep = failedTelemetry.getSpans().find((span) => span.name === "pi.harness.step");
		expect(failedStep?.attributes).toMatchObject({ "pi.step.outcome": "failed" });
		expect(failedStep?.status).toEqual({ status: "error" });
		const failedRun = failedTelemetry.getSpans().find((span) => span.name === "pi.harness.run");
		expect(failedRun?.attributes).toMatchObject({ "pi.operation.outcome": "failed" });
		expect(failedRun?.status).toEqual({ status: "error" });
		const failureCheckpoint = failedTelemetry
			.getSpans()
			.find(
				(span) =>
					span.name === "pi.harness.checkpoint" && span.attributes["pi.checkpoint.kind"] === "failure_drain",
			);
		expect(failureCheckpoint).toMatchObject({ parentId: failedRun?.id, status: { status: "ok" } });

		const deferredTelemetry = new InMemoryTelemetryContext();
		const deferredFixture = await createFixture({ telemetryContext: deferredTelemetry });
		deferredFixture.faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "deferred",
				deferred: {
					provider: deferredFixture.faux.provider.id,
					modelId: deferredFixture.faux.getModel().id,
					api: deferredFixture.faux.api,
					id: "telemetry-deferred",
				},
			}),
		]);
		const accepted = await deferredFixture.harness.accept({ kind: "prompt", prompt: "defer" });
		if (!accepted.ok) throw accepted.error;
		expect(await deferredFixture.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "deferred" },
		});
		const deferredStep = deferredTelemetry.getSpans().find((span) => span.name === "pi.harness.step");
		expect(deferredStep?.attributes).toMatchObject({ "pi.step.outcome": "deferred" });
		expect(deferredStep?.status).toEqual({ status: "ok" });
		const deferredRun = deferredTelemetry.getSpans().find((span) => span.name === "pi.harness.run");
		expect(deferredRun?.attributes).toMatchObject({ "pi.operation.outcome": "suspended" });
		expect(deferredRun?.status).toEqual({ status: "ok" });
	});

	it("emits a failed retry end when the later attempt exhausts the policy", async () => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 first" }),
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 second" }),
		]);
		const events = captureEvents(fixture.harness);
		expect(await fixture.harness.prompt("go")).toMatchObject({
			ok: true,
			value: { kind: "failed", error: { message: "503 second" } },
		});
		expect(events.find((event) => event.type === "retry_end")).toMatchObject({
			attempt: 2,
			success: false,
			finalError: "503 second",
		});
	});

	it.each([false, true])("advances an already-due retry without creating a timer (wait=%s)", async (waitForRetry) => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 } });
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 first" }),
			fauxAssistantMessage("ok"),
		]);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		now.mockReturnValue(1_010);
		const timer = vi.spyOn(globalThis, "setTimeout");
		expect(await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
		expect(timer).not.toHaveBeenCalled();
	});

	it("aborts a started local retry timer on close without advancing durable state", async () => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 } });
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 first" })]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		const timer = vi.spyOn(globalThis, "setTimeout");
		const waiting = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: true });
		for (
			let attempt = 0;
			attempt < 100 && !timer.mock.calls.some(([, delay]) => typeof delay === "number" && delay > 1_000);
			attempt++
		) {
			await waitForTick();
		}
		expect(timer.mock.calls.some(([, delay]) => typeof delay === "number" && delay > 1_000)).toBe(true);
		await fixture.harness.close();
		await expect(waiting).rejects.toMatchObject({ name: "HarnessClosed" });
		fixtures.splice(fixtures.indexOf(fixture), 1);
		const session = await fixture.repo.open(fixture.session.metadata);
		expect((await session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
		await session.close();
		await fixture.repo.close();
	});

	it("keeps retry_wait durable when close wins after the timer but before retry-ready commit", async () => {
		vi.useFakeTimers({ now: 1_000 });
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
		});
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 first" })]);
		const waitForFakeAction = async () => {
			for (let attempt = 0; attempt < 100; attempt++) {
				if ((await fixture.harness.peekAction()) !== undefined) return;
				await vi.advanceTimersByTimeAsync(0);
			}
			throw new Error("action did not park");
		};
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const first = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		while (true) {
			await waitForFakeAction();
			const action = await fixture.harness.executeAction();
			if (action?.kind === "assistant.settlement") break;
		}
		expect(await first).toMatchObject({ ok: true, value: { kind: "waiting", notBefore: 1_100 } });
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;

		const second = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: true });
		await waitForFakeAction();
		expect((await fixture.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForFakeAction();
		expect((await fixture.harness.executeAction())?.kind).toBe("assistant.retry_wait");
		await vi.advanceTimersByTimeAsync(100);
		await waitForFakeAction();
		expect(await fixture.harness.peekAction()).toMatchObject({ kind: "assistant.retry_ready" });
		await fixture.harness.close();
		await expect(second).rejects.toMatchObject({ name: "HarnessClosed" });
		fixtures.splice(fixtures.indexOf(fixture), 1);
		const session = await fixture.repo.open(fixture.session.metadata);
		expect((await session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
		await session.close();
		await fixture.repo.close();
	});

	it("automatic close before orphan-retry mutation preserves the pending effect", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		const reopened = await reopenFixture(fixture);
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		const after = await closeAtAutomaticBreakpoint(
			reopened.fixture,
			accepted.value.operationId,
			"assistant.recover_retry",
			() => reopened.harness.drive({ operationId: accepted.value.operationId }),
		);
		expect(after).toEqual(before);
	});

	it("automatic close before orphan settlement preserves the pending effect", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		const reopened = await reopenFixture(fixture);
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		const after = await closeAtAutomaticBreakpoint(
			reopened.fixture,
			accepted.value.operationId,
			"assistant.recover_settlement",
			() => reopened.harness.drive({ operationId: accepted.value.operationId }),
		);
		expect(after).toEqual(before);
	});

	it("automatic close before retry-ready mutation preserves the durable wait", async () => {
		const fixture = await createFixture({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 } });
		fixture.faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 first" })]);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		expect(
			await fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false }),
		).toMatchObject({ ok: true, value: { kind: "waiting", notBefore: 1_100 } });
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		now.mockReturnValue(1_100);

		const after = await closeAtAutomaticBreakpoint(fixture, accepted.value.operationId, "assistant.retry_ready", () =>
			fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false }),
		);
		expect(after).toEqual(before);
	});

	it("parks before an orphan recovery commit and close preserves the pending effect", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		});
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		const reopened = await reopenFixture(fixture, { drive: "manual" });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const drive = reopened.harness.drive({ operationId: accepted.value.operationId });
		await waitForAction(reopened.harness);
		expect((await reopened.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(reopened.harness);
		expect(await reopened.harness.peekAction()).toMatchObject({
			kind: "assistant.recover_retry",
			details: { operationId: accepted.value.operationId, attempt: 1, nextAttempt: 2 },
		});
		await reopened.harness.close();
		await expect(drive).rejects.toMatchObject({ name: "HarnessClosed" });
		fixtures.splice(fixtures.indexOf(reopened.fixture), 1);
		const session = await fixture.repo.open(fixture.session.metadata);
		expect((await session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
		await session.close();
		await fixture.repo.close();
	});

	it("rechecks the deadline after the retry-ready breakpoint before committing", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 100 },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const first = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		while (true) {
			await waitForAction(fixture.harness);
			const action = await fixture.harness.executeAction();
			if (action?.kind === "assistant.settlement") break;
		}
		expect(await first).toMatchObject({ ok: true, value: { kind: "waiting", notBefore: 1_100 } });
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		now.mockReturnValue(1_100);

		const second = fixture.harness.drive({
			operationId: accepted.value.operationId,
			waitForRetry: false,
			deadline: 1_150,
		});
		await waitForAction(fixture.harness);
		expect((await fixture.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({
			kind: "assistant.retry_ready",
			details: { operationId: accepted.value.operationId, attempt: 2 },
		});
		now.mockReturnValue(1_200);
		expect((await fixture.harness.executeAction())?.kind).toBe("assistant.retry_ready");
		expect(await second).toEqual({
			ok: true,
			value: { kind: "yielded", operationId: accepted.value.operationId },
		});
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
	});

	it("parks before the orphan-cap synthetic settlement and close preserves the pending effect", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
		});
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const { drive: firstDrive } = await advanceToProviderBoundary(fixture.harness, accepted.value.operationId);
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		const reopened = await reopenFixture(fixture, { drive: "manual" });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const events = captureEvents(reopened.harness);
		const drive = reopened.harness.drive({ operationId: accepted.value.operationId });
		await waitForAction(reopened.harness);
		expect((await reopened.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(reopened.harness);
		expect(await reopened.harness.peekAction()).toMatchObject({
			kind: "assistant.recover_settlement",
			details: { operationId: accepted.value.operationId, attempt: 1 },
		});
		expect(events.map((event) => event.type)).toEqual(["run_resume", "turn_start", "message_start", "message_end"]);
		await reopened.harness.close();
		await expect(drive).rejects.toMatchObject({ name: "HarnessClosed" });
		fixtures.splice(fixtures.indexOf(reopened.fixture), 1);
		const session = await fixture.repo.open(fixture.session.metadata);
		expect((await session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
		await session.close();
		await fixture.repo.close();
	});

	it("parks at stable retry breakpoints and close leaves the durable wait unchanged", async () => {
		const fixture = await createFixture({
			drive: "manual",
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 10_000 },
		});
		fixture.faux.setResponses([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 service unavailable" }),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "go" });
		if (!accepted.ok) throw accepted.error;
		const first = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: false });
		while (true) {
			await waitForAction(fixture.harness);
			const action = await fixture.harness.executeAction();
			if (action?.kind === "assistant.settlement") break;
		}
		expect(await first).toMatchObject({ ok: true, value: { kind: "waiting", reason: "retry" } });
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;

		const second = fixture.harness.drive({ operationId: accepted.value.operationId, waitForRetry: true });
		await waitForAction(fixture.harness);
		expect((await fixture.harness.executeAction())?.kind).toBe("runtime.dispatch");
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({
			kind: "assistant.retry_wait",
			details: { operationId: accepted.value.operationId, attempt: 2, notBefore: expect.any(Number) },
		});
		await fixture.harness.close();
		await expect(second).rejects.toMatchObject({ name: "HarnessClosed" });
		fixtures.splice(fixtures.indexOf(fixture), 1);
		const session = await fixture.repo.open(fixture.session.metadata);
		expect((await session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(before);
		await session.close();
		await fixture.repo.close();
	});
});

const ZERO_USAGE_FOR_TEST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
