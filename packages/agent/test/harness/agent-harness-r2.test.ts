import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	type MutableModels,
} from "@draht/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type HarnessEvent,
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
}

const fixtures: Fixture[] = [];

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
		activeToolNames: [],
		drive: options.drive,
	});
	const fixture = { harness, session, repo, faux, models };
	fixtures.push(fixture);
	return fixture;
}

function captureLifecycle(harness: AgentHarnessInstance): HarnessEvent[] {
	const events: HarnessEvent[] = [];
	for (const type of [
		"run_start",
		"run_resume",
		"turn_start",
		"message_start",
		"message_update",
		"message_end",
		"entry_added",
		"usage",
		"turn_end",
		"run_end",
	] as const) {
		harness.events.on(type, (event) => {
			events.push(event);
		});
	}
	return events;
}

async function waitForAction(harness: AgentHarnessInstance): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await harness.peekAction()) !== undefined) return;
		await waitForTick();
	}
	throw new Error("action did not park");
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.harness.close();
		await fixture.repo.close();
	}
});

describe("AgentHarness R2 minimal run", () => {
	it("accepts durably without starting the provider, then completes one no-tool generation", async () => {
		const { harness, session, faux } = await createFixture();
		faux.setResponses([fauxAssistantMessage("answer", { timestamp: 20 })]);
		const events = captureLifecycle(harness);
		const operationId = session.idGenerator.next();

		const admission = await harness.accept({ kind: "prompt", operationId, prompt: "question" });
		expect(admission).toMatchObject({ ok: true, value: { operationId, kind: "run" } });
		expect(faux.state.callCount).toBe(0);
		expect((await harness.inspectExecution()).current).toMatchObject({ id: operationId, status: "suspended" });
		expect((await session.getRegister("op.meta", operationId))?.value.operationId).toBe(operationId);
		expect(events.map((event) => event.type)).toEqual(["run_start", "message_start", "message_end", "entry_added"]);

		const driven = await harness.drive({ operationId });
		expect(driven).toMatchObject({
			ok: true,
			value: {
				kind: "settled",
				operationId,
				outcome: {
					operation: "run",
					runId: operationId,
					kind: "completed",
					finalMessage: { role: "assistant", stopReason: "stop" },
				},
			},
		});
		expect(faux.state.callCount).toBe(1);
		expect(await session.getRegister("op.meta", operationId)).toBeUndefined();
		expect(await session.getRegister("op.state", operationId)).toBeUndefined();
		expect(await session.getRegister("lane.state", "main")).toMatchObject({ value: { currentOperationId: null } });
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { operationId, kind: "run", outcome: "completed", runCompletion: "assistant" },
		});

		const types = events.map((event) => event.type);
		expect(types.slice(4, 6)).toEqual(["turn_start", "message_start"]);
		expect(types.slice(6, -5).every((type) => type === "message_update")).toBe(true);
		expect(types.slice(-5)).toEqual(["message_end", "entry_added", "usage", "turn_end", "run_end"]);
	});

	it("applies context, request-option, and response hooks around the captured request", async () => {
		const { harness, faux } = await createFixture();
		await harness.setThinkingLevel("high");
		await harness.setStreamOptions({ headers: { base: "yes" } });
		harness.hooks.on("transform_context", ({ messages }) => ({
			messages: [...messages, { role: "user", content: "context hook", timestamp: 2 }],
		}));
		harness.hooks.on("before_request", () => ({ streamOptions: { headers: { extra: "yes" } } }));
		harness.hooks.on("after_response", ({ message }) => ({
			message: { ...message, content: [{ type: "text", text: "post-hook" }] },
		}));
		faux.setResponses([
			(context, options) => {
				expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "context hook" });
				expect(options).toMatchObject({ reasoning: "high", headers: { base: "yes", extra: "yes" } });
				return fauxAssistantMessage("provider");
			},
		]);
		const result = await harness.prompt("go");
		expect(result).toMatchObject({
			ok: true,
			value: { finalMessage: { content: [{ type: "text", text: "post-hook" }] } },
		});
	});

	it("implements prompt as acceptance followed by the same drive path", async () => {
		const { harness, faux } = await createFixture();
		faux.setResponses([fauxAssistantMessage("done")]);
		const result = await harness.prompt("go");
		expect(result).toMatchObject({
			ok: true,
			value: { kind: "completed", finalMessage: { role: "assistant", stopReason: "stop" } },
		});
	});

	it("rejects caller-supplied pending assistants without opening an operation", async () => {
		const { harness } = await createFixture();
		const pending = fauxAssistantMessage("draft", { stopReason: "pending" });
		expect(await harness.accept({ kind: "prompt", prompt: pending })).toMatchObject({
			ok: false,
			error: { _tag: "InvalidMessage", reason: "pending_assistant" },
		});
		expect((await harness.inspectExecution()).current).toBeNull();
	});

	it("expands run resources and rejects unknown or empty prompts without opening an operation", async () => {
		const { harness } = await createFixture();
		await harness.setResources({
			skills: [{ name: "review", description: "Review", content: "Check it", filePath: "/skills/review/SKILL.md" }],
			promptTemplates: [{ name: "hello", content: "Hello $1" }],
		});
		const skill = await harness.accept({ kind: "skill", name: "review", additionalInstructions: "carefully" });
		expect(skill.ok).toBe(true);
		if (skill.ok) {
			const meta = await harness.session.getEntry((await harness.getLeafId())!);
			expect(meta).toMatchObject({ type: "message", message: { content: expect.stringContaining("carefully") } });
			await harness.close();
		}

		const second = await createFixture();
		await second.harness.setResources({ promptTemplates: [{ name: "hello", content: "Hello $1" }] });
		const template = await second.harness.accept({ kind: "prompt_template", name: "hello", args: ["Ada"] });
		expect(template.ok).toBe(true);
		expect(await second.harness.session.getEntry((await second.harness.getLeafId())!)).toMatchObject({
			message: { content: "Hello Ada" },
		});

		const third = await createFixture();
		expect(await third.harness.accept({ kind: "skill", name: "missing" })).toMatchObject({
			ok: false,
			error: { _tag: "UnknownSkill" },
		});
		expect(await third.harness.accept({ kind: "prompt", prompt: "" })).toMatchObject({
			ok: false,
			error: { _tag: "InvalidMessage" },
		});
		expect((await third.harness.inspectExecution()).current).toBeNull();
	});

	it("persists before_run injections, system override, and per-handler resume data", async () => {
		const { harness, session } = await createFixture();
		harness.hooks.on(
			"before_run",
			() => ({
				messages: [{ role: "user", content: "hook", timestamp: 2 }],
				systemPrompt: "override",
				resumeData: { token: "saved" },
			}),
			{ id: "extension" },
		);
		const accepted = await harness.accept({ kind: "prompt", prompt: "caller" });
		if (!accepted.ok) throw accepted.error;
		const operation = await session.getRegister("op.meta", accepted.value.operationId);
		expect(operation?.value.intent).toMatchObject({
			kind: "run",
			systemPromptOverride: "override",
			resumeData: { extension: { token: "saved" } },
		});
		if (operation?.value.intent.kind !== "run") throw new Error("missing run operation");
		expect(operation.value.intent.promptEntryIds).toHaveLength(1);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(branch).toHaveLength(2);
		expect(branch[1]).toMatchObject({ message: { content: "hook" } });
	});

	it("rejects unresolved model and active-tool identities before writing an operation", async () => {
		const modelFixture = await createFixture();
		await modelFixture.harness.setModel({ ...modelFixture.faux.getModel(), id: "missing-model" });
		expect(await modelFixture.harness.accept({ kind: "prompt", prompt: "hello" })).toMatchObject({
			ok: false,
			error: { _tag: "MissingIdentities", models: [expect.stringContaining("missing-model")], tools: [] },
		});
		expect((await modelFixture.harness.inspectExecution()).current).toBeNull();

		const toolFixture = await createFixture();
		await toolFixture.harness.setActiveTools(["missing-tool"]);
		expect(await toolFixture.harness.accept({ kind: "prompt", prompt: "hello" })).toMatchObject({
			ok: false,
			error: { _tag: "MissingIdentities", models: [], tools: ["missing-tool"] },
		});
		expect((await toolFixture.harness.inspectExecution()).current).toBeNull();
	});

	it("holds a stable admission reservation across before_run and lets a matching drive wait", async () => {
		const { harness, session, faux } = await createFixture();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const gate = deferred();
		const operationId = session.idGenerator.next();
		harness.hooks.on(
			"before_run",
			async ({ runId }) => {
				expect(runId).toBe(operationId);
				await gate.promise;
				return { messages: [{ role: "user", content: "injected", timestamp: 2 }], resumeData: { accepted: true } };
			},
			{ id: "test" },
		);

		const acceptance = harness.accept({ kind: "prompt", operationId, prompt: "hello" });
		await waitForTick();
		const competing = await harness.accept({ kind: "prompt", prompt: "other" });
		expect(competing).toMatchObject({ ok: false, error: { _tag: "LaneBusy", operationId } });
		const drive = harness.drive({ operationId });
		expect(faux.state.callCount).toBe(0);
		gate.resolve();
		expect(await acceptance).toMatchObject({ ok: true, value: { operationId } });
		expect(await drive).toMatchObject({ ok: true, value: { kind: "settled", operationId } });
		expect((await session.getRegister("lane.lastResult", "main"))?.value.operationId).toBe(operationId);
	});

	it("makes leaf-moving tree writes wait for a pre-acceptance reservation", async () => {
		const { harness, session } = await createFixture();
		const gate = deferred();
		harness.hooks.on(
			"before_run",
			async () => {
				await gate.promise;
				return undefined;
			},
			{ id: "wait" },
		);
		const acceptance = harness.accept({ kind: "prompt", prompt: "accepted" });
		await waitForTick();
		const append = harness.session.appendMessage({ role: "user", content: "later", timestamp: 3 });
		await waitForTick();
		expect((await session.getRegister("lane.leaf", "main"))?.value).toBeNull();
		gate.resolve();
		const accepted = await acceptance;
		if (!accepted.ok) throw accepted.error;
		const appendedId = await append;
		expect((await session.getRegister("pending.entry", appendedId))?.value).toMatchObject({
			type: "message",
			payload: { content: "later" },
		});
		expect((await session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			inbox: { writes: [appendedId] },
		});
	});

	it("captures and places pending next-run payloads before the caller prompt", async () => {
		const { harness, session } = await createFixture();
		const pendingId = session.idGenerator.next();
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
						value: { type: "message", payload: { role: "user", content: "queued", timestamp: 1 } },
					},
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: "main",
						value: { ...laneState.value, pendingNextRun: [pendingId] },
					},
				],
			});
		});

		const accepted = await harness.accept({ kind: "prompt", prompt: "caller" });
		expect(accepted.ok).toBe(true);
		const branch = await harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(
			branch.map((entry) =>
				entry.type === "message" && entry.message.role === "user" ? entry.message.content : "custom",
			),
		).toEqual(["queued", [{ type: "text", text: "caller" }]]);
		expect(await session.getRegister("pending.entry", pendingId)).toBeUndefined();
		expect((await session.getRegister("lane.state", "main"))?.value.pendingNextRun).toEqual([]);
	});

	it("publishes stable manual breakpoints for the same durable run", async () => {
		const { harness, faux, session } = await createFixture({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("manual")]);
		const accepted = await harness.accept({ kind: "prompt", prompt: "step" });
		if (!accepted.ok) throw accepted.error;
		const drive = harness.drive({ operationId: accepted.value.operationId });
		const actions: string[] = [];
		while (true) {
			await waitForAction(harness);
			const parked = await harness.peekAction();
			if (parked?.kind === "run.finish") {
				const state = await session.getRegister("op.state", accepted.value.operationId);
				const leaf = await session.getRegister("lane.leaf", "main");
				expect(state?.value).toMatchObject({
					latestAssistantEntryId: leaf?.value,
					phase: { kind: "checkpoint", triggerEntryId: leaf?.value },
				});
			}
			const action = await harness.executeAction();
			if (action !== undefined) actions.push(action.kind);
			if (action?.kind === "run.finish") break;
		}
		expect(await drive).toMatchObject({ ok: true, value: { kind: "settled" } });
		expect(actions).toEqual([
			"runtime.dispatch",
			"run.generation_ready",
			"assistant.intent",
			"assistant.request",
			"assistant.settlement",
			"run.finish",
		]);
	});

	it("re-resolves the durable model identity when the provider request starts", async () => {
		const { harness, faux, models } = await createFixture({ drive: "manual" });
		faux.setResponses([fauxAssistantMessage("must not be requested")]);
		const accepted = await harness.accept({ kind: "prompt", prompt: "race" });
		if (!accepted.ok) throw accepted.error;
		const drive = harness.drive({ operationId: accepted.value.operationId });
		for (const expected of ["runtime.dispatch", "run.generation_ready", "assistant.intent"] as const) {
			await waitForAction(harness);
			expect((await harness.executeAction())?.kind).toBe(expected);
		}
		await waitForAction(harness);
		expect(await harness.peekAction()).toMatchObject({ kind: "assistant.request" });
		models.deleteProvider(faux.provider.id);
		await harness.executeAction();
		await harness.runToCompletion();
		expect(await drive).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "failed", error: { code: "assistant_error" } } },
		});
		expect(faux.state.callCount).toBe(0);
	});

	it("closes at the provider boundary without starting the request or advancing the intent", async () => {
		const fixture = await createFixture({ drive: "manual" });
		fixture.faux.setResponses([fauxAssistantMessage("must not start")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "close" });
		if (!accepted.ok) throw accepted.error;
		const drive = fixture.harness.drive({ operationId: accepted.value.operationId });
		for (const expected of ["runtime.dispatch", "run.generation_ready", "assistant.intent"] as const) {
			await waitForAction(fixture.harness);
			expect((await fixture.harness.executeAction())?.kind).toBe(expected);
		}
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({ kind: "assistant.request" });
		await fixture.harness.close();
		await expect(drive).rejects.toMatchObject({ name: "HarnessClosed" });
		expect(fixture.faux.state.callCount).toBe(0);
		fixtures.splice(fixtures.indexOf(fixture), 1);
		const reopened = await fixture.repo.open(fixture.session.metadata);
		expect((await reopened.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			phase: { kind: "assistant", generation: { status: "effect_pending" } },
		});
		await reopened.close();
		await fixture.repo.close();
	});

	it.each([
		{ target: "assistant.settlement", phase: "assistant", generationStatus: "effect_pending" },
		{ target: "run.finish", phase: "checkpoint", generationStatus: undefined },
	] as const)(
		"closes at $target without starting the following commit",
		async ({ target, phase, generationStatus }) => {
			const fixture = await createFixture({ drive: "manual" });
			fixture.faux.setResponses([fauxAssistantMessage("boundary")]);
			const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "boundary" });
			if (!accepted.ok) throw accepted.error;
			const drive = fixture.harness.drive({ operationId: accepted.value.operationId });
			while (true) {
				await waitForAction(fixture.harness);
				if ((await fixture.harness.peekAction())?.kind === target) break;
				await fixture.harness.executeAction();
			}
			await fixture.harness.close();
			await expect(drive).rejects.toMatchObject({ name: "HarnessClosed" });
			fixtures.splice(fixtures.indexOf(fixture), 1);
			const reopened = await fixture.repo.open(fixture.session.metadata);
			const state = (await reopened.getRegister("op.state", accepted.value.operationId))?.value;
			expect(state).toMatchObject({
				phase: {
					kind: phase,
					...(generationStatus === undefined ? {} : { generation: { status: generationStatus } }),
				},
			});
			await reopened.close();
			await fixture.repo.close();
		},
	);

	it("reopens a durable generation-ready state and performs the request", async () => {
		const fixture = await createFixture({ drive: "manual" });
		fixture.faux.setResponses([fauxAssistantMessage("ready after reopen")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "ready" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		for (const expected of ["runtime.dispatch", "run.generation_ready"] as const) {
			await waitForAction(fixture.harness);
			expect((await fixture.harness.executeAction())?.kind).toBe(expected);
		}
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({ kind: "assistant.intent" });
		await fixture.harness.close();
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		fixtures.splice(fixtures.indexOf(fixture), 1);

		const reopenedSession = await fixture.repo.open(fixture.session.metadata);
		const models = createModels();
		models.setProvider(fixture.faux.provider);
		const created = await AgentHarness.create({
			session: reopenedSession,
			models,
			model: fixture.faux.getModel(),
			activeToolNames: [],
		});
		const reopened: Fixture = {
			harness: created.harness,
			session: reopenedSession,
			repo: fixture.repo,
			faux: fixture.faux,
			models,
		};
		fixtures.push(reopened);
		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
		expect(fixture.faux.state.callCount).toBe(1);
	});

	it("settles adapter-reported errors durably as failed runs", async () => {
		const { harness, faux, session } = await createFixture();
		faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "adapter failed" })]);
		const result = await harness.prompt("fail");
		expect(result).toMatchObject({
			ok: true,
			value: { kind: "failed", error: { code: "assistant_error", message: "adapter failed" } },
		});
		expect(await session.getRegister("lane.lastResult", "main")).toMatchObject({
			value: { outcome: "failed", error: { message: "adapter failed" } },
		});
	});

	it("reopens an accepted checkpoint without activating it and resumes on matching drive", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("resumed")]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "persist" });
		if (!accepted.ok) throw accepted.error;
		const metadata = fixture.session.metadata;
		await fixture.harness.close();
		fixtures.splice(fixtures.indexOf(fixture), 1);

		const reopenedSession = await fixture.repo.open(metadata);
		const models = createModels();
		models.setProvider(fixture.faux.provider);
		const created = await AgentHarness.create({
			session: reopenedSession,
			models,
			model: fixture.faux.getModel(),
			activeToolNames: [],
		});
		const reopened: Fixture = {
			harness: created.harness,
			session: reopenedSession,
			repo: fixture.repo,
			faux: fixture.faux,
			models,
		};
		fixtures.push(reopened);
		expect(created.suspended).toMatchObject([{ operationId: accepted.value.operationId, reason: "crash" }]);
		expect(fixture.faux.state.callCount).toBe(0);
		const resumeEvents: HarnessEvent[] = [];
		reopened.harness.events.on("run_resume", (event) => {
			resumeEvents.push(event);
		});
		const driven = await reopened.harness.drive({ operationId: accepted.value.operationId });
		expect(driven).toMatchObject({ ok: true, value: { kind: "settled" } });
		expect(resumeEvents).toMatchObject([{ type: "run_resume", recovery: true }]);
	});
});
