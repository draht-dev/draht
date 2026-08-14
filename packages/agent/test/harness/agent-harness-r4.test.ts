import {
	createModels,
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type MutableModels,
} from "@draht/ai";
import { InMemoryTelemetryContext, type TelemetryContext } from "@draht/telemetry";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentHarness,
	type AgentHarness as AgentHarnessInstance,
	type AgentHarnessTool,
	type AgentHarnessToolInvocation,
	type HarnessEvent,
	MemorySessionRepo,
	type Session,
} from "../../src/index.ts";
import { waitForTick } from "../utils/wait-for-tick.ts";

interface ToolContext {
	prefix: string;
}

interface Fixture {
	harness: AgentHarnessInstance<ToolContext>;
	session: Session;
	repo: MemorySessionRepo;
	faux: FauxProviderHandle;
	models: MutableModels;
	tools: AgentHarnessTool<ToolContext>[];
}

const fixtures: Fixture[] = [];
const echoParameters = Type.Object({ value: Type.String() });

async function createFixture(
	options: {
		tools?: AgentHarnessTool<ToolContext>[];
		activeToolNames?: string[];
		toolContext?: ToolContext | (() => ToolContext | Promise<ToolContext>);
		toolExecution?: "sequential" | "parallel";
		drive?: "automatic" | "manual";
		telemetryContext?: TelemetryContext;
	} = {},
): Promise<Fixture> {
	const repo = new MemorySessionRepo();
	const session = await repo.create({});
	const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
	const models = createModels();
	models.setProvider(faux.provider);
	const tools = options.tools ?? [];
	const { harness } = await AgentHarness.create<ToolContext>({
		session,
		models,
		model: faux.getModel(),
		tools,
		activeToolNames: options.activeToolNames ?? tools.map((tool) => tool.name),
		toolContext: options.toolContext ?? { prefix: "ctx" },
		toolExecution: options.toolExecution,
		drive: options.drive,
		telemetryContext: options.telemetryContext,
	});
	const fixture = { harness, session, repo, faux, models, tools };
	fixtures.push(fixture);
	return fixture;
}

async function reopenFixture(
	fixture: Fixture,
	options: {
		tools?: AgentHarnessTool<ToolContext>[];
		drive?: "automatic" | "manual";
		toolContext?: ToolContext | (() => ToolContext | Promise<ToolContext>);
	} = {},
) {
	await fixture.harness.close();
	fixtures.splice(fixtures.indexOf(fixture), 1);
	const session = await fixture.repo.open(fixture.session.metadata);
	const models = createModels();
	models.setProvider(fixture.faux.provider);
	const tools = options.tools ?? fixture.tools;
	const created = await AgentHarness.create<ToolContext>({
		session,
		models,
		model: fixture.faux.getModel(),
		tools,
		toolContext: options.toolContext ?? { prefix: "recovered" },
		drive: options.drive,
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

async function waitForAction(harness: AgentHarnessInstance<ToolContext>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await harness.peekAction()) !== undefined) return;
		await waitForTick();
	}
	throw new Error("action did not park");
}

function echoTool(
	execute: AgentHarnessTool<ToolContext, typeof echoParameters>["execute"],
): AgentHarnessTool<ToolContext, typeof echoParameters> {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo a value",
		parameters: echoParameters,
		replay: "safe",
		execute,
	};
}

function captureEvents(harness: AgentHarnessInstance<ToolContext>): HarnessEvent[] {
	const events: HarnessEvent[] = [];
	for (const type of [
		"turn_start",
		"message_start",
		"message_end",
		"entry_added",
		"usage",
		"tool_start",
		"tool_update",
		"tool_end",
		"turn_end",
		"run_end",
	] as const) {
		harness.events.on(type, (event) => {
			events.push(event);
		});
	}
	return events;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: (value) => resolvePromise?.(value) };
}

function textContent(content: Array<{ type: string; text?: string }>): string {
	return content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) {
		await fixture.harness.close();
		await fixture.repo.close();
	}
});

describe("AgentHarness R4 tools", () => {
	it("rejects duplicate tool names before publishing a registry", async () => {
		const fixture = await createFixture();
		const tool = echoTool(async () => ({ content: [{ type: "text", text: "unused" }], details: {} }));

		expect(() => fixture.harness.setTools([tool, { ...tool }])).toThrow(/Duplicate tool name/);
		expect(await fixture.harness.getTools()).toEqual([]);
	});

	it("persists a complete plan before clearance, binds context and invocation identity, then continues", async () => {
		const invocations: AgentHarnessToolInvocation[] = [];
		let contextResolutions = 0;
		let fixture: Fixture;
		const tool: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echoTool(async (_toolCallId, args, _signal, onUpdate, context, invocation) => {
				invocations.push(invocation);
				expect(
					(await fixture.session.getRegister("op.tool_args", `${invocation.operationId}:${invocation.turnId}:0`))
						?.value,
				).toEqual({ value: "input-prepared-hook" });
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { partial: true } });
				return {
					content: [{ type: "text", text: `${context.prefix}:${args.value}` }],
					details: { context: context.prefix },
				};
			}),
			prepareArguments(args) {
				return { value: `${(args as { value: string }).value}-prepared` };
			},
		};
		fixture = await createFixture({
			tools: [tool],
			toolContext: () => {
				contextResolutions++;
				return { prefix: "bound" };
			},
		});
		const events = captureEvents(fixture.harness);
		let plannedResultId: string | undefined;
		fixture.harness.hooks.on("before_tool", async ({ runId, args }) => {
			const state = await fixture.session.getRegister("op.state", runId);
			expect(state?.value).toMatchObject({
				phase: {
					kind: "tools",
					batch: { calls: [{ status: "planned", sourceIndex: 0, resultEntryId: expect.any(String) }] },
				},
			});
			if (state?.value.kind === "run" && state.value.phase.kind === "tools") {
				plannedResultId = state.value.phase.batch.calls[0]?.resultEntryId;
			}
			return { args: { value: `${args.value}-hook` } };
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "input" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
				const result = context.messages[2];
				expect(result?.role === "toolResult" ? textContent(result.content) : "").toBe("bound:input-prepared-hook");
				return fauxAssistantMessage("done");
			},
		]);

		const result = await fixture.harness.prompt("use the tool");

		expect(result).toMatchObject({
			ok: true,
			value: { kind: "completed", finalMessage: { content: [{ text: "done" }] } },
		});
		expect(contextResolutions).toBe(1);
		expect(invocations).toHaveLength(1);
		expect(invocations[0]).toMatchObject({
			invocationId: plannedResultId,
			operationId: result.ok ? result.value.runId : "",
		});
		expect(invocations[0]?.turnId).toEqual(expect.any(String));
		const branch = await fixture.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const toolResult = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(toolResult?.id).toBe(plannedResultId);
		const assistant = branch.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse",
		);
		expect(toolResult?.id.slice(0, 13)).toBe(assistant?.id.slice(0, 13));
		expect(await fixture.session.listRegisters("op.tool_args")).toEqual([]);
		expect(events.filter((event) => event.type === "tool_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_update")).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool_end")).toHaveLength(1);
		const toolStartIndex = events.findIndex((event) => event.type === "tool_start");
		expect(events.slice(toolStartIndex, toolStartIndex + 7).map((event) => event.type)).toEqual([
			"tool_start",
			"tool_update",
			"tool_end",
			"message_start",
			"message_end",
			"entry_added",
			"turn_end",
		]);
		const firstTurnEnd = events.find((event) => event.type === "turn_end");
		expect(firstTurnEnd).toMatchObject({ toolResults: [{ toolCallId: "call-1", toolName: "echo" }] });
	});

	it("settles preparation, validation, hook failure, block, and replacement failures without tool effects", async () => {
		let executions = 0;
		const echo = echoTool(async () => {
			executions++;
			return { content: [], details: {} };
		});
		const preparing: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echo,
			name: "preparing",
			prepareArguments() {
				throw new Error("prepare failed");
			},
		};
		const fixture = await createFixture({ tools: [echo, preparing] });
		fixture.harness.hooks.on("before_tool", ({ toolCallId }) => {
			if (toolCallId === "call-hook-throw") throw new Error("hook failed closed");
			if (toolCallId === "call-block") return { block: { reason: "blocked", terminate: true } };
			if (toolCallId === "call-replacement") return { args: {} };
			return undefined;
		});
		const events = captureEvents(fixture.harness);
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("unknown", {}, { id: "call-unknown" }),
					fauxToolCall("preparing", { value: "x" }, { id: "call-prepare" }),
					fauxToolCall("echo", {}, { id: "call-invalid" }),
					fauxToolCall("echo", { value: "x" }, { id: "call-hook-throw" }),
					fauxToolCall("echo", { value: "x" }, { id: "call-block" }),
					fauxToolCall("echo", { value: "x" }, { id: "call-replacement" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results).toHaveLength(6);
				expect(results.every((message) => message.isError)).toBe(true);
				return fauxAssistantMessage("done");
			},
		]);

		expect(await fixture.harness.prompt("fail clearance")).toMatchObject({ ok: true, value: { kind: "completed" } });
		expect(executions).toBe(0);
		expect(events.filter((event) => event.type === "tool_start")).toHaveLength(0);
		expect(await fixture.session.listRegisters("op.tool_args")).toEqual([]);
	});

	it("applies after-tool patches and commits reported usage with the result", async () => {
		const rawUsage = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const patchedUsage = { ...rawUsage, input: 4, totalTokens: 6 };
		const tool = echoTool(async () => ({
			content: [{ type: "text", text: "raw" }],
			details: { raw: true },
			usage: rawUsage,
		}));
		const fixture = await createFixture({ tools: [tool] });
		fixture.harness.hooks.on("after_tool", () => ({
			content: [{ type: "text", text: "patched" }],
			details: { patched: true },
			isError: true,
			usage: patchedUsage,
		}));
		const events = captureEvents(fixture.harness);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "call-patch" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		expect(await fixture.harness.prompt("patch")).toMatchObject({ ok: true, value: { kind: "completed" } });
		const resultEntry = (await fixture.harness.session.findEntriesOnBranch({ order: "oldestFirst" })).find(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(resultEntry).toMatchObject({
			message: {
				content: [{ text: "patched" }],
				details: { patched: true },
				isError: true,
				usage: patchedUsage,
			},
		});
		const toolUsage = events.find((event) => event.type === "usage" && event.row.entryId === resultEntry?.id);
		expect(toolUsage).toMatchObject({ row: { usage: patchedUsage } });
		const entryIndex = events.findIndex(
			(event) => event.type === "entry_added" && event.entry.id === resultEntry?.id,
		);
		const usageIndex = events.findIndex((event) => event.type === "usage" && event.row.entryId === resultEntry?.id);
		expect(usageIndex).toBeGreaterThan(entryIndex);
	});

	it("emits one content-free raw tool span and no span for synthetic outcomes", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const tool = echoTool(async () => ({
			content: [{ type: "text", text: "secret-result" }],
			details: { secret: "secret-details" },
		}));
		const fixture = await createFixture({ tools: [tool], telemetryContext: telemetry });
		fixture.harness.hooks.on("before_tool", () => undefined, { id: "before-telemetry" });
		fixture.harness.hooks.on("after_tool", () => undefined, { id: "after-telemetry" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "secret-argument" }, { id: "real-call" }),
					fauxToolCall("unknown", { value: "secret-synthetic" }, { id: "synthetic-call" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		expect(await fixture.harness.prompt("telemetry")).toMatchObject({ ok: true, value: { kind: "completed" } });
		const recordedSpans = telemetry.getSpans();
		const spans = recordedSpans.filter((span) => span.name === "pi.harness.tool");
		expect(recordedSpans.filter((span) => span.name === "pi.harness.turn")).toHaveLength(2);
		expect(spans).toHaveLength(1);
		expect(spans[0]?.attributes).toMatchObject({
			"pi.tool.name": "echo",
			"pi.tool.call_id": "real-call",
			"pi.tool.replay": "safe",
			"pi.tool.recovery": false,
			"pi.tool.is_error": false,
		});
		const turnSpan = recordedSpans.find((span) => span.id === spans[0]?.parentId);
		expect(turnSpan?.name).toBe("pi.harness.turn");
		const hookSpans = recordedSpans.filter((span) => span.name === "pi.harness.hook");
		expect(hookSpans.every((span) => span.parentId === turnSpan?.id)).toBe(true);
		expect(hookSpans.map((span) => span.attributes)).toMatchObject([
			{
				"pi.hook.name": "before_tool",
				"pi.hook.registration_id": "before-telemetry",
				"pi.hook.outcome": "completed",
			},
			{
				"pi.hook.name": "after_tool",
				"pi.hook.registration_id": "after-telemetry",
				"pi.hook.outcome": "completed",
			},
		]);
		const serialized = JSON.stringify([...spans, ...hookSpans]);
		expect(serialized).not.toContain("secret-argument");
		expect(serialized).not.toContain("secret-result");
		expect(serialized).not.toContain("secret-details");
		expect(serialized).not.toContain("secret-synthetic");
	});

	it("classifies error telemetry before tool-call content", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let executions = 0;
		const tool = echoTool(async () => {
			executions++;
			return { content: [{ type: "text", text: "must not run" }], details: {} };
		});
		const fixture = await createFixture({ tools: [tool], telemetryContext: telemetry });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "ignored" }, { id: "error-call" }), {
				stopReason: "error",
				errorMessage: "deterministic failure",
			}),
		]);

		expect(await fixture.harness.prompt("error telemetry")).toMatchObject({
			ok: true,
			value: { kind: "failed" },
		});
		expect(executions).toBe(0);
		const step = telemetry.getSpans().find((span) => span.name === "pi.harness.step");
		expect(step?.attributes["pi.step.outcome"]).toBe("failed");
	});

	it("preflights the complete captured tool set before starting a planned batch", async () => {
		let executions = 0;
		const tool = echoTool(async () => {
			executions++;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		});
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "call-preflight" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "preflight" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			const action = await fixture.harness.peekAction();
			if (action?.kind === "assistant.settlement") break;
			await fixture.harness.executeAction();
		}
		await fixture.harness.setTools([]);
		await fixture.harness.executeAction();
		expect(await firstDrive).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "missing_identities", missing: { tools: ["echo"], models: [] } },
		});
		expect(executions).toBe(0);
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			phase: { kind: "tools", batch: { calls: [{ status: "planned" }] } },
		});
		await fixture.harness.setTools([tool]);
		const secondDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		await waitForAction(fixture.harness);
		await fixture.harness.runToCompletion();
		expect(await secondDrive).toMatchObject({ ok: true, value: { kind: "settled" } });
		expect(executions).toBe(1);
	});

	it("starts parallel real effects without letting a later immediate result overtake source order", async () => {
		const first = deferred<{ content: [{ type: "text"; text: string }]; details: Record<string, never> }>();
		const third = deferred<{ content: [{ type: "text"; text: string }]; details: Record<string, never> }>();
		const starts: string[] = [];
		const tool = echoTool(async (_id, args) => {
			starts.push(args.value);
			return args.value === "first" ? first.promise : third.promise;
		});
		const fixture = await createFixture({ tools: [tool], toolExecution: "parallel" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "first" }, { id: "call-first" }),
					fauxToolCall("inactive", {}, { id: "call-immediate" }),
					fauxToolCall("echo", { value: "third" }, { id: "call-third" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const result = fixture.harness.prompt("parallel");
		for (let attempt = 0; attempt < 100 && starts.length < 2; attempt++) await waitForTick();
		expect(starts).toEqual(["first", "third"]);
		const execution = await fixture.harness.inspectExecution();
		if (execution.current === null) throw new Error("parallel run is not active");
		expect((await fixture.session.getRegister("op.state", execution.current.id))?.value).toMatchObject({
			phase: {
				kind: "tools",
				batch: { calls: [{ status: "effect_pending" }, { status: "planned" }, { status: "effect_pending" }] },
			},
		});
		third.resolve({ content: [{ type: "text", text: "third" }], details: {} });
		await waitForTick();
		expect(
			(await fixture.harness.session.findEntriesOnBranch({ order: "oldestFirst" })).filter(
				(entry) => entry.type === "message" && entry.message.role === "toolResult",
			),
		).toHaveLength(0);
		first.resolve({ content: [{ type: "text", text: "first" }], details: {} });
		expect(await result).toMatchObject({ ok: true, value: { kind: "completed" } });
		const resultEntries = (await fixture.harness.session.findEntriesOnBranch({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(
			resultEntries.map((entry) =>
				entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : "",
			),
		).toEqual(["call-first", "call-immediate", "call-third"]);
		expect(resultEntries[1]?.parentId).toBe(resultEntries[0]?.id);
		expect(resultEntries[2]?.parentId).toBe(resultEntries[1]?.id);
	});

	it("honors a called tool's sequential override before starting the next effect", async () => {
		const first = deferred<{ content: [{ type: "text"; text: string }]; details: Record<string, never> }>();
		const second = deferred<{ content: [{ type: "text"; text: string }]; details: Record<string, never> }>();
		const starts: string[] = [];
		const tool: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echoTool(async (_id, args) => {
				starts.push(args.value);
				return args.value === "first" ? first.promise : second.promise;
			}),
			executionMode: "sequential",
		};
		const fixture = await createFixture({ tools: [tool], toolExecution: "parallel" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "first" }, { id: "call-first" }),
					fauxToolCall("echo", { value: "second" }, { id: "call-second" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const result = fixture.harness.prompt("sequential");
		for (let attempt = 0; attempt < 100 && starts.length === 0; attempt++) await waitForTick();
		expect(starts).toEqual(["first"]);
		first.resolve({ content: [{ type: "text", text: "first" }], details: {} });
		for (let attempt = 0; attempt < 100 && starts.length < 2; attempt++) await waitForTick();
		expect(starts).toEqual(["first", "second"]);
		second.resolve({ content: [{ type: "text", text: "second" }], details: {} });
		expect(await result).toMatchObject({ ok: true, value: { kind: "completed" } });
	});

	it("replays an orphaned safe effect with persisted arguments and the same invocation id", async () => {
		const invocations: AgentHarnessToolInvocation[] = [];
		const argumentsSeen: string[] = [];
		const tool = echoTool(async (_id, args, _signal, _update, context, invocation) => {
			invocations.push(invocation);
			argumentsSeen.push(`${context.prefix}:${args.value}`);
			return { content: [{ type: "text", text: args.value }], details: {} };
		});
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "persisted" }, { id: "call-replay" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("after replay"),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "replay" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			const action = await fixture.harness.peekAction();
			if (action?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		const pending = await fixture.session.getRegister("op.state", accepted.value.operationId);
		expect(pending?.value).toMatchObject({
			phase: { kind: "tools", batch: { calls: [{ status: "effect_pending", replay: "safe" }] } },
		});
		const pendingArgs = await fixture.session.listRegisters("op.tool_args");
		expect(pendingArgs).toHaveLength(1);
		expect(pendingArgs[0]?.value).toEqual({ value: "persisted" });
		expect(invocations).toHaveLength(1);
		const firstInvocationId = invocations[0]?.invocationId;

		const reopened = await reopenFixture(fixture, { tools: [tool] });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const recoveryEvents = captureEvents(reopened.harness);
		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});

		expect(invocations.map((invocation) => invocation.invocationId)).toEqual([firstInvocationId, firstInvocationId]);
		expect(argumentsSeen).toEqual(["ctx:persisted", "recovered:persisted"]);
		expect(await reopened.fixture.session.listRegisters("op.tool_args")).toEqual([]);
		expect(recoveryEvents.find((event) => event.type === "tool_start")).toMatchObject({ recovery: true });
		expect(recoveryEvents.find((event) => event.type === "entry_added")).not.toHaveProperty("recovery");
	});

	it("replays a safe pending prefix before suspending an unrelated planned call", async () => {
		let executions = 0;
		const safe = echoTool(async () => {
			executions++;
			return { content: [{ type: "text", text: "safe" }], details: {} };
		});
		const unused: AgentHarnessTool<ToolContext> = {
			name: "unused",
			label: "Unused",
			description: "Unused active declaration",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		const fixture = await createFixture({
			tools: [safe, unused],
			activeToolNames: ["echo", "unused"],
			drive: "manual",
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "safe" }, { id: "call-safe-prefix" }),
					fauxToolCall("inactive", {}, { id: "call-planned" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "recover prefix" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		expect(executions).toBe(1);
		const reopened = await reopenFixture(fixture, { tools: [safe] });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "missing_identities", missing: { tools: ["unused"] } },
		});
		expect(executions).toBe(2);
		expect((await reopened.fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject(
			{
				phase: { kind: "tools", batch: { calls: [{ status: "completed" }, { status: "planned" }] } },
			},
		);
	});

	it.each([
		{ target: "hook.before_tool", expectedStatus: "planned", executions: 0 },
		{ target: "tool.intent", expectedStatus: "planned", executions: 0 },
		{ target: "tool.execute", expectedStatus: "effect_pending", executions: 0 },
		{ target: "hook.after_tool", expectedStatus: "effect_pending", executions: 1 },
		{ target: "tool.settlement", expectedStatus: "effect_pending", executions: 1 },
	] as const)(
		"close at $target preserves the exact durable tool prefix",
		async ({ target, expectedStatus, executions }) => {
			let executionCount = 0;
			const tool = echoTool(async () => {
				executionCount++;
				return { content: [{ type: "text", text: "result" }], details: {} };
			});
			const fixture = await createFixture({ tools: [tool], drive: "manual" });
			fixture.harness.hooks.on("before_tool", () => undefined);
			fixture.harness.hooks.on("after_tool", () => undefined);
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "call-boundary" }), {
					stopReason: "toolUse",
				}),
			]);
			const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "boundary" });
			if (!accepted.ok) throw accepted.error;
			const drive = fixture.harness.drive({ operationId: accepted.value.operationId });
			while (true) {
				await waitForAction(fixture.harness);
				const action = await fixture.harness.peekAction();
				if (action?.kind === target) {
					expect(JSON.parse(JSON.stringify(action))).toEqual(action);
					expect(action.details).toMatchObject({
						operationId: accepted.value.operationId,
						turnId: expect.any(String),
						sourceIndex: 0,
						toolCallId: "call-boundary",
						toolName: "echo",
					});
					break;
				}
				await fixture.harness.executeAction();
			}
			const reopened = await reopenFixture(fixture, { tools: [tool] });
			await expect(drive).rejects.toMatchObject({ name: "HarnessClosed" });
			expect(
				(await reopened.fixture.session.getRegister("op.state", accepted.value.operationId))?.value,
			).toMatchObject({
				phase: { kind: "tools", batch: { calls: [{ status: expectedStatus }] } },
			});
			expect(executionCount).toBe(executions);
		},
	);

	it("settles a planned call synthetically when cancellation wins the intent race", async () => {
		let executions = 0;
		const tool = echoTool(async () => {
			executions++;
			return { content: [], details: {} };
		});
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "x" }, { id: "call-cancelled" }), {
				stopReason: "toolUse",
			}),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "cancel race" });
		if (!accepted.ok) throw accepted.error;
		const drive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.intent") break;
			await fixture.harness.executeAction();
		}
		await fixture.session.mutate("main", async (mutator) => {
			const stored = await mutator.getRegister("op.state", accepted.value.operationId);
			if (stored?.value.kind !== "run") throw new Error("run state is missing");
			await mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: accepted.value.operationId,
						value: {
							...stored.value,
							control: {
								status: "cancel_requested",
								requestedAt: Date.now(),
								drainedSteer: [],
								drainedFollowUp: [],
							},
						},
					},
				],
			});
		});
		await fixture.harness.executeAction();
		await waitForAction(fixture.harness);
		expect(await fixture.harness.peekAction()).toMatchObject({ kind: "tool.settlement" });
		await fixture.harness.executeAction();
		await expect(drive).rejects.toThrow(/drive\(cancel_requested\).*later AgentHarness runtime slice/);
		expect(executions).toBe(0);
		const branch = await fixture.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		expect(branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult")).toMatchObject({
			message: { toolCallId: "call-cancelled", isError: true },
		});
		expect((await fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject({
			control: { status: "cancel_requested" },
			phase: { kind: "checkpoint", continuation: { kind: "need_assistant" } },
		});
	});

	it("interrupts an unsafe orphan without requiring its missing tool identity", async () => {
		let executions = 0;
		const unsafe = {
			...echoTool(async () => {
				executions++;
				return { content: [{ type: "text", text: "raw" }], details: {} };
			}),
			replay: "never" as const,
		};
		const fixture = await createFixture({ tools: [unsafe], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "unsafe" }, { id: "call-unsafe" }), {
				stopReason: "toolUse",
			}),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "unsafe" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		expect(executions).toBe(1);
		const reopened = await reopenFixture(fixture, { tools: [] });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "missing_identities", missing: { tools: ["echo"], models: [] } },
		});
		expect(executions).toBe(1);
		const branch = await reopened.harness.session.findEntriesOnBranch({ order: "oldestFirst" });
		const interrupted = branch.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(interrupted).toMatchObject({
			type: "message",
			message: {
				toolCallId: "call-unsafe",
				isError: true,
				content: [{ text: expect.stringContaining("not safe") }],
			},
		});
		expect(await reopened.fixture.session.listRegisters("op.tool_args")).toEqual([]);
	});

	it("interrupts a stored-safe effect when the current declaration downgrades replay", async () => {
		let executions = 0;
		const safe = echoTool(async () => {
			executions++;
			return { content: [{ type: "text", text: "raw" }], details: {} };
		});
		const fixture = await createFixture({ tools: [safe], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "safe" }, { id: "call-downgraded" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("after interruption"),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "downgrade" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		expect(executions).toBe(1);
		const downgraded = { ...safe, replay: "never" as const };
		const reopened = await reopenFixture(fixture, { tools: [downgraded] });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
		expect(executions).toBe(1);
		const results = (await reopened.harness.session.findEntriesOnBranch({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results[0]).toMatchObject({
			message: { isError: true, content: [{ text: expect.stringContaining("not safe") }] },
		});
	});

	it("close detaches from an admitted tool that ignores its signal", async () => {
		const started = deferred<void>();
		const tool = echoTool(async () => {
			started.resolve();
			return new Promise<never>(() => {});
		});
		const fixture = await createFixture({ tools: [tool] });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "hang" }, { id: "call-hang" }), {
				stopReason: "toolUse",
			}),
		]);
		const prompt = fixture.harness.prompt("hang");
		await started.promise;

		await expect(fixture.harness.close()).resolves.toBeUndefined();
		await expect(prompt).rejects.toMatchObject({ name: "HarnessClosed" });
	});

	it("creates no raw tool span when close wins at the execution boundary", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const tool = echoTool(async () => ({ content: [{ type: "text", text: "must not run" }], details: {} }));
		const fixture = await createFixture({ tools: [tool], drive: "manual", telemetryContext: telemetry });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "close" }, { id: "call-close-span" }), {
				stopReason: "toolUse",
			}),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "close span" });
		if (!accepted.ok) throw accepted.error;
		const drive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.execute") break;
			await fixture.harness.executeAction();
		}

		await fixture.harness.close();
		await expect(drive).rejects.toMatchObject({ name: "HarnessClosed" });
		expect(telemetry.getSpans().filter((span) => span.name === "pi.harness.tool")).toEqual([]);
	});

	it("observes retained parallel promise rejection when automatic close skips settlement", async () => {
		let executions = 0;
		const first: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echoTool(async () => {
				executions++;
				return { content: [{ type: "text", text: "first" }], details: {} };
			}),
			name: "first",
		};
		const second: AgentHarnessTool<ToolContext, typeof echoParameters> = { ...first, name: "second" };
		const fixture = await createFixture({ tools: [first, second] });
		fixture.harness.events.on("tool_start", (event) => {
			if (event.toolName !== "first") return;
			queueMicrotask(() => queueMicrotask(() => void fixture.harness.close()));
		});
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("first", { value: "one" }, { id: "call-close-first" }),
					fauxToolCall("second", { value: "two" }, { id: "call-close-second" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		await expect(fixture.harness.prompt("close parallel start")).rejects.toMatchObject({ name: "HarnessClosed" });
		await expect(fixture.harness.close()).resolves.toBeUndefined();
		expect(executions).toBe(0);
	});

	it("reopens a recovered turn bracket for a restored planned batch", async () => {
		const tool = echoTool(async () => ({ content: [{ type: "text", text: "restored" }], details: {} }));
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.harness.hooks.on("before_tool", () => undefined);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "planned" }, { id: "call-restored-planned" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "restore planned" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "hook.before_tool") break;
			await fixture.harness.executeAction();
		}
		const reopened = await reopenFixture(fixture, { tools: [tool], drive: "manual" });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const events = captureEvents(reopened.harness);
		reopened.harness.hooks.on("before_resume", () => undefined, { id: "planned-deadline" });
		const now = vi.spyOn(Date, "now").mockReturnValue(100);
		const deadlineDrive = reopened.harness.drive({ operationId: accepted.value.operationId, deadline: 150 });
		await waitForAction(reopened.harness);
		expect(await reopened.harness.peekAction()).toMatchObject({ kind: "runtime.dispatch" });
		await reopened.harness.executeAction();
		await waitForAction(reopened.harness);
		expect(await reopened.harness.peekAction()).toMatchObject({ kind: "hook.before_resume" });
		now.mockReturnValue(200);
		await reopened.harness.executeAction();
		expect(await deadlineDrive).toMatchObject({ ok: true, value: { kind: "yielded" } });
		expect((await reopened.fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toMatchObject(
			{
				phase: { kind: "tools", batch: { calls: [{ status: "planned" }] } },
			},
		);

		const completedDrive = reopened.harness.drive({ operationId: accepted.value.operationId });
		await waitForAction(reopened.harness);
		await reopened.harness.runToCompletion();
		expect(await completedDrive).toMatchObject({
			ok: true,
			value: { kind: "settled", outcome: { kind: "completed" } },
		});
		const recoveredStarts = events.flatMap((event) =>
			event.type === "turn_start" && event.recovery ? [event.turnId] : [],
		);
		const recoveredEnds = events.flatMap((event) =>
			event.type === "turn_end" && event.recovery ? [event.turnId] : [],
		);
		expect(recoveredStarts).toEqual(recoveredEnds);
		expect(new Set(recoveredStarts).size).toBe(recoveredStarts.length);
	});

	it("settles an identity-free orphan prefix before resolving context for planned work", async () => {
		const tool: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echoTool(async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} })),
			replay: "never",
		};
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "orphan" }, { id: "call-identity-free" }),
					fauxToolCall("echo", { value: "planned" }, { id: "call-needs-context" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "recover prefix" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			const action = await fixture.harness.peekAction();
			if (
				action?.kind === "tool.intent" &&
				action.details !== null &&
				typeof action.details === "object" &&
				!Array.isArray(action.details) &&
				action.details.sourceIndex === 1
			) {
				break;
			}
			await fixture.harness.executeAction();
		}
		let contextResolutions = 0;
		const reopened = await reopenFixture(fixture, {
			tools: [tool],
			toolContext: () => {
				contextResolutions++;
				throw new Error("planned context failed");
			},
		});
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		await expect(reopened.harness.drive({ operationId: accepted.value.operationId })).rejects.toMatchObject({
			name: "HarnessFault",
		});
		expect(contextResolutions).toBe(1);
		const state = await reopened.fixture.session.getRegister("op.state", accepted.value.operationId);
		expect(state?.value).toMatchObject({
			phase: { kind: "tools", batch: { calls: [{ status: "completed" }, { status: "planned" }] } },
		});
		const results = (await reopened.fixture.session.findEntriesOnBranch({ order: "oldestFirst" })).filter(
			(entry) => entry.type === "message" && entry.message.role === "toolResult",
		);
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ message: { toolCallId: "call-identity-free", isError: true } });
	});

	it("does not resolve context past the first safe orphan with a missing identity", async () => {
		const first = echoTool(async () => ({ content: [{ type: "text", text: "first" }], details: {} }));
		const second: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echoTool(async () => ({ content: [{ type: "text", text: "second" }], details: {} })),
			name: "second",
		};
		const fixture = await createFixture({ tools: [first, second], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "one" }, { id: "call-missing-first" }),
					fauxToolCall("second", { value: "two" }, { id: "call-available-second" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "missing first" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		let contextResolutions = 0;
		const reopened = await reopenFixture(fixture, {
			tools: [second],
			toolContext: () => {
				contextResolutions++;
				throw new Error("context must not resolve");
			},
		});
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "missing_identities", missing: { tools: ["echo"] } },
		});
		expect(contextResolutions).toBe(0);
	});

	it("reopens a recovery bracket after yielding with planned calls remaining", async () => {
		const tool = echoTool(async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: {} }));
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.harness.hooks.on("before_tool", () => undefined);
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "one" }, { id: "call-planned-one" }),
					fauxToolCall("echo", { value: "two" }, { id: "call-planned-two" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "planned deadline" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "hook.before_tool") break;
			await fixture.harness.executeAction();
		}
		const reopened = await reopenFixture(fixture, { tools: [tool], drive: "manual" });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const events = captureEvents(reopened.harness);
		const now = vi.spyOn(Date, "now").mockReturnValue(100);
		const resumed = reopened.harness.drive({ operationId: accepted.value.operationId, deadline: 150 });
		while (true) {
			await waitForAction(reopened.harness);
			const action = await reopened.harness.peekAction();
			if (action?.kind === "tool.execute") now.mockReturnValue(200);
			await reopened.harness.executeAction();
			if (action?.kind === "tool.settlement") break;
		}
		expect(await resumed).toMatchObject({ ok: true, value: { kind: "yielded" } });
		const firstPassStarts = events.flatMap((event) =>
			event.type === "turn_start" && event.recovery ? [event.turnId] : [],
		);
		const firstPassEnds = events.flatMap((event) =>
			event.type === "turn_end" && event.recovery ? [event.turnId] : [],
		);
		expect(firstPassStarts).toEqual(firstPassEnds);
		events.splice(0);

		const finished = reopened.harness.drive({ operationId: accepted.value.operationId });
		await waitForAction(reopened.harness);
		await reopened.harness.runToCompletion();
		expect(await finished).toMatchObject({ ok: true, value: { kind: "settled" } });
		const secondPassStarts = events.flatMap((event) =>
			event.type === "turn_start" && event.recovery ? [event.turnId] : [],
		);
		const secondPassEnds = events.flatMap((event) =>
			event.type === "turn_end" && event.recovery ? [event.turnId] : [],
		);
		expect(secondPassStarts).toEqual(secondPassEnds);
	});

	it("balances a recovered turn bracket when a deadline yields between orphaned calls", async () => {
		const tool = echoTool(async (_id, args) => ({
			content: [{ type: "text", text: args.value }],
			details: {},
		}));
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "one" }, { id: "call-deadline-one" }),
					fauxToolCall("echo", { value: "two" }, { id: "call-deadline-two" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "deadline recovery" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		const reopened = await reopenFixture(fixture, { tools: [tool], drive: "manual" });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const events = captureEvents(reopened.harness);
		const now = vi.spyOn(Date, "now").mockReturnValue(100);
		const drive = reopened.harness.drive({ operationId: accepted.value.operationId, deadline: 150 });
		while (true) {
			await waitForAction(reopened.harness);
			const action = await reopened.harness.peekAction();
			if (action?.kind === "tool.execute") {
				now.mockReturnValue(200);
				await reopened.harness.executeAction();
				break;
			}
			await reopened.harness.executeAction();
		}
		await waitForAction(reopened.harness);
		expect(await reopened.harness.peekAction()).toMatchObject({ kind: "tool.settlement" });
		await reopened.harness.executeAction();
		expect(await drive).toMatchObject({ ok: true, value: { kind: "yielded" } });
		expect(events.filter((event) => event.type === "turn_start" && event.recovery)).toHaveLength(1);
		expect(events.filter((event) => event.type === "turn_end" && event.recovery)).toHaveLength(1);
	});

	it("honors a current sequential override while recovering before a later missing identity", async () => {
		const original = ["first", "second", "missing"].map(
			(name): AgentHarnessTool<ToolContext, typeof echoParameters> => ({
				...echoTool(async () => ({ content: [{ type: "text", text: name }], details: {} })),
				name,
			}),
		);
		const fixture = await createFixture({ tools: original, drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("first", { value: "one" }, { id: "call-sequential-first" }),
					fauxToolCall("second", { value: "two" }, { id: "call-sequential-second" }),
					fauxToolCall("missing", { value: "three" }, { id: "call-sequential-missing" }),
				],
				{ stopReason: "toolUse" },
			),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "sequential recovery" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		const firstStarted = deferred<void>();
		const firstResult = deferred<{ content: [{ type: "text"; text: string }]; details: Record<string, never> }>();
		let secondExecutions = 0;
		const currentFirst: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echoTool(async () => {
				firstStarted.resolve();
				return firstResult.promise;
			}),
			name: "first",
			executionMode: "sequential",
		};
		const currentSecond: AgentHarnessTool<ToolContext, typeof echoParameters> = {
			...echoTool(async () => {
				secondExecutions++;
				return { content: [{ type: "text", text: "second" }], details: {} };
			}),
			name: "second",
		};
		const reopened = await reopenFixture(fixture, { tools: [currentFirst, currentSecond] });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });
		const drive = reopened.harness.drive({ operationId: accepted.value.operationId });
		await firstStarted.promise;
		expect(secondExecutions).toBe(0);

		firstResult.resolve({ content: [{ type: "text", text: "first" }], details: {} });
		expect(await drive).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "missing_identities", missing: { tools: ["missing"] } },
		});
		expect(secondExecutions).toBe(1);
	});

	it("suspends a safe orphan without mutation when its replay identity is missing", async () => {
		const tool = echoTool(async () => ({ content: [{ type: "text", text: "raw" }], details: {} }));
		const fixture = await createFixture({ tools: [tool], drive: "manual" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "safe" }, { id: "call-safe-missing" }), {
				stopReason: "toolUse",
			}),
		]);
		const accepted = await fixture.harness.accept({ kind: "prompt", prompt: "safe" });
		if (!accepted.ok) throw accepted.error;
		const firstDrive = fixture.harness.drive({ operationId: accepted.value.operationId });
		while (true) {
			await waitForAction(fixture.harness);
			if ((await fixture.harness.peekAction())?.kind === "tool.settlement") break;
			await fixture.harness.executeAction();
		}
		const before = (await fixture.session.getRegister("op.state", accepted.value.operationId))?.value;
		const argsBefore = await fixture.session.listRegisters("op.tool_args");
		const reopened = await reopenFixture(fixture, { tools: [] });
		await expect(firstDrive).rejects.toMatchObject({ name: "HarnessClosed" });

		expect(await reopened.harness.drive({ operationId: accepted.value.operationId })).toMatchObject({
			ok: true,
			value: { kind: "waiting", reason: "missing_identities", missing: { tools: ["echo"], models: [] } },
		});
		expect((await reopened.fixture.session.getRegister("op.state", accepted.value.operationId))?.value).toEqual(
			before,
		);
		expect(await reopened.fixture.session.listRegisters("op.tool_args")).toEqual(argsBefore);
	});

	it("finishes without another assistant request when every result terminates", async () => {
		const tool = echoTool(async () => ({
			content: [{ type: "text", text: "submitted" }],
			details: {},
			terminate: true,
		}));
		const fixture = await createFixture({ tools: [tool] });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "final" }, { id: "call-final" }), {
				stopReason: "toolUse",
			}),
		]);

		const result = await fixture.harness.prompt("finish through tool");

		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		if (!result.ok) throw result.error;
		expect(result.value).not.toHaveProperty("finalEntryId");
		expect(result.value).not.toHaveProperty("finalMessage");
		expect(fixture.faux.state.callCount).toBe(1);
		const lastResult = await fixture.session.getRegister("lane.lastResult", "main");
		expect(lastResult).toMatchObject({ value: { outcome: "completed", runCompletion: "terminated_tools" } });
		expect(lastResult?.value).not.toHaveProperty("finalAssistantEntryId");
	});

	it("lets an intentional blocked result terminate the run", async () => {
		let executions = 0;
		const tool = echoTool(async () => {
			executions++;
			return { content: [], details: {} };
		});
		const fixture = await createFixture({ tools: [tool] });
		fixture.harness.hooks.on("before_tool", () => ({ block: { reason: "submitted", terminate: true } }));
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { value: "final" }, { id: "call-block-final" }), {
				stopReason: "toolUse",
			}),
		]);

		const result = await fixture.harness.prompt("block and finish");
		expect(result).toMatchObject({ ok: true, value: { kind: "completed" } });
		if (!result.ok) throw result.error;
		expect(result.value).not.toHaveProperty("finalMessage");
		expect(executions).toBe(0);
		expect(fixture.faux.state.callCount).toBe(1);
	});

	it("turns genuine-length calls into ordered synthetic errors without invoking tools", async () => {
		let executions = 0;
		const tool = echoTool(async () => {
			executions++;
			return { content: [], details: {} };
		});
		const fixture = await createFixture({ tools: [tool] });
		fixture.harness.hooks.on("after_response", ({ message }) => ({
			message: {
				...message,
				usage: { ...message.usage, output: fixture.faux.getModel().maxTokens },
			},
		}));
		fixture.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("echo", { value: "one" }, { id: "call-one" }),
					fauxToolCall("echo", { value: "two" }, { id: "call-two" }),
				],
				{ stopReason: "length" },
			),
			(context) => {
				const results = context.messages.filter((message) => message.role === "toolResult");
				expect(results.map((message) => message.toolCallId)).toEqual(["call-one", "call-two"]);
				expect(results.every((message) => message.isError)).toBe(true);
				return fauxAssistantMessage("reissued");
			},
		]);

		expect(await fixture.harness.prompt("truncated tools")).toMatchObject({
			ok: true,
			value: { kind: "completed", finalMessage: { content: [{ text: "reissued" }] } },
		});
		expect(executions).toBe(0);
	});
});
