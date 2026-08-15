import type { Api, ImageContent, Model, Usage } from "@draht/ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import {
	type AbortRequestResult,
	type AbortResult,
	type ActionInfo,
	type AgentLane,
	type CancelQueuedResult,
	type CompactionResult,
	type CurrentOperationInfo,
	type DriveOptions,
	type DriveResult,
	HarnessClosed,
	HarnessFault,
	InvalidMessage,
	LaneBusy,
	type LaneExecutionInfo,
	type LaneSnapshot,
	MissingIdentities,
	type NavigateOptions,
	type NavigationResult,
	type NextRunResult,
	type OperationAdmissionResult,
	type OperationRequest,
	type QueueResult,
	type RecordUsageResult,
	type Resources,
	type ResumeResult,
	type RunResult,
	type SuspendedOperation,
	UnknownSkill,
	UnknownTemplate,
	type WatchHandle,
} from "../agent-harness.ts";
import { BreakpointBarrier } from "../execution/breakpoint.ts";
import { formatPromptTemplateInvocation } from "../prompt-templates.ts";
import { type RestoredLane, restoreLane } from "../restore.ts";
import { Result } from "../result.ts";
import { materializeCommittedEntry } from "../session/commit.ts";
import { SessionInvariantError, SessionPendingAssistantMessageError } from "../session/session.ts";
import type {
	JsonValue,
	LaneConfiguration,
	LaneLastResult,
	NewEntry,
	OperationMeta,
	PendingEntry,
	RunState,
	SessionTree,
} from "../session/types.ts";
import { formatSkillInvocation } from "../skills.ts";
import { deferredValue, driveLane } from "./operation-task.ts";
import { isPendingAssistant, missingIdentities } from "./transitions.ts";
import type {
	AcceptancePublication,
	AdmissionReservation,
	LaneRuntimeContext,
	NormalizedRunRequest,
	RuntimeLane,
} from "./types.ts";
import { RuntimeSliceNotImplemented } from "./types.ts";

export function createPublicSessionView<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	lane: string,
): SessionTree {
	const delegate = runtime.sessionStorage.view(lane);
	return {
		getLeafId: () => delegate.getLeafId(),
		getEntry: (id) => delegate.getEntry(id),
		getStats: () => delegate.getStats(),
		getName: () => delegate.getName(),
		setName: (name) => delegate.setName(name),
		getLabel: (targetId) => delegate.getLabel(targetId),
		setLabel: (targetId, label) => delegate.setLabel(targetId, label),
		getCustomFact: (key) => delegate.getCustomFact(key),
		setCustomFact: (key, value) => delegate.setCustomFact(key, value),
		findEntries: (query) => delegate.findEntries(query),
		findEntry: (query) => delegate.findEntry(query),
		findEntriesOnBranch: (query) => delegate.findEntriesOnBranch(query),
		findEntryOnBranch: (query) => delegate.findEntryOnBranch(query),
		appendMessage: (message) => appendPublicEntry(runtime, lane, { type: "message", payload: message }),
		appendCustomEntry: (customType, data) =>
			appendPublicEntry(runtime, lane, {
				type: "custom",
				customType,
				...(data === undefined ? {} : { payload: data }),
			}),
	};
}

export async function acceptLane<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	lane: RuntimeLane,
	request: OperationRequest,
): Promise<OperationAdmissionResult> {
	const closed = runtime.resultClosedError();
	if (closed !== undefined) return Result.err(closed);
	if (request.kind === "compaction" || request.kind === "navigation") {
		throw new RuntimeSliceNotImplemented(`accept(${request.kind})`);
	}

	const resources = await runtime.readSettings((settings) => settings.resources);
	const normalized = normalizeRunRequest(runtime, request, resources);
	if (!normalized.ok) return normalized;
	const provisional = normalized.value;
	if (provisional.messages.some(isPendingAssistant)) {
		return Result.err(
			new InvalidMessage({
				lane: lane.name,
				reason: "pending_assistant",
				message: "A pending assistant message cannot be accepted",
			}),
		);
	}
	const reserved = deferredValue<void>();
	const reservation: AdmissionReservation = {
		operationId: provisional.operationId,
		operationKind: "run",
		completion: reserved.promise,
		resolve: () => reserved.resolve(undefined),
	};

	try {
		const busy = await runtime.sessionStorage.mutate(lane.name, async (reader) => {
			const restored = await restoreLane(reader, lane.name);
			const existingReservation = runtime.admissionReservations.get(lane.name);
			if (existingReservation !== undefined) return createLaneBusy(lane.name, existingReservation);
			const active = runtime.activeOperations.get(lane.name);
			if (active !== undefined) return createLaneBusy(lane.name, active);
			if (restored.current !== undefined) {
				return new LaneBusy({
					lane: lane.name,
					operationId: restored.current.operation.operationId,
					operationKind: restored.current.operation.intent.kind,
					message: `Lane ${JSON.stringify(lane.name)} already has an active operation`,
				});
			}
			runtime.admissionReservations.set(lane.name, reservation);
			return undefined;
		});
		if (busy !== undefined) return Result.err(busy);

		let systemPrompt = "";
		let hookMessages: AgentMessage[] = [];
		let systemPromptOverride: string | undefined;
		let resumeData: Record<string, JsonValue> | undefined;
		if (runtime.hooks.has("before_run")) {
			systemPrompt = (await resolveSystemPrompt(runtime)) ?? "";
			await lane.breakpoint.hit({
				kind: "hook.before_run",
				description: "Run pre-acceptance hooks",
				details: { operationId: provisional.operationId },
			});
			runtime.assertOpen();
			const aggregate = await runtime.hooks.runBeforeAcceptanceWithResumeData(
				{
					lane: lane.name,
					runId: provisional.operationId,
					prompt: provisional.messages,
					systemPrompt,
					resources: provisional.resources,
				},
				() => runtime.assertOpen(),
			);
			hookMessages = aggregate.result?.messages ?? [];
			systemPromptOverride = aggregate.result?.systemPrompt;
			if (Object.keys(aggregate.resumeData).length !== 0) resumeData = aggregate.resumeData;
		}
		const settings = await runtime.snapshotSettings();
		const publication = await runtime.sessionStorage.mutate(lane.name, async (mutator) => {
			if (runtime.admissionReservations.get(lane.name) !== reservation) {
				throw new SessionInvariantError(`Lane ${JSON.stringify(lane.name)} lost its admission reservation`);
			}
			const restored = await restoreLane(mutator, lane.name);
			if (restored.current !== undefined || runtime.activeOperations.has(lane.name)) {
				const owner = restored.current?.operation;
				return Result.err(
					owner === undefined
						? createLaneBusy(lane.name, runtime.activeOperations.get(lane.name)!)
						: new LaneBusy({
								lane: lane.name,
								operationId: owner.operationId,
								operationKind: owner.intent.kind,
								message: `Lane ${JSON.stringify(lane.name)} already has an active operation`,
							}),
				);
			}
			const missing = missingIdentities(runtime.models, restored.configuration, settings);
			if (missing.tools.length !== 0 || missing.models.length !== 0) {
				return Result.err(
					new MissingIdentities({
						lane: lane.name,
						...missing,
						message: `Lane ${JSON.stringify(lane.name)} has unresolved model or tool identities`,
					}),
				);
			}

			const pendingIds = [...restored.laneState.pendingNextRun];
			const pendingRegisters = await Promise.all(pendingIds.map((id) => mutator.getRegister("pending.entry", id)));
			for (let index = 0; index < pendingIds.length; index++) {
				if (pendingRegisters[index] === undefined) {
					throw new SessionInvariantError(`Pending next-run entry ${pendingIds[index]} is missing`);
				}
			}
			const callerIds = provisional.messages.map(() => runtime.sessionStorage.idGenerator.next());
			const hookIds = hookMessages.map(() => runtime.sessionStorage.idGenerator.next());
			const placements: Array<{ id: string; pending: NonNullable<(typeof pendingRegisters)[number]>["value"] }> = [];
			for (let index = 0; index < pendingIds.length; index++) {
				placements.push({ id: pendingIds[index]!, pending: pendingRegisters[index]!.value });
			}
			for (let index = 0; index < provisional.messages.length; index++) {
				placements.push({
					id: callerIds[index]!,
					pending: { type: "message", payload: provisional.messages[index]! },
				});
			}
			for (let index = 0; index < hookMessages.length; index++) {
				placements.push({ id: hookIds[index]!, pending: { type: "message", payload: hookMessages[index]! } });
			}
			if (
				placements.some(
					(placement) => placement.pending.type === "message" && isPendingAssistant(placement.pending.payload),
				)
			) {
				return Result.err(
					new InvalidMessage({
						lane: lane.name,
						reason: "pending_assistant",
						message: "A pending assistant message cannot be accepted",
					}),
				);
			}
			if (placements.length === 0) {
				return Result.err(
					new InvalidMessage({
						lane: lane.name,
						reason: "empty",
						message: "A run must place at least one message or pending entry",
					}),
				);
			}
			let parentId = restored.leafId;
			const entryWrites: Array<{ kind: "entry"; entry: NewEntry }> = [];
			for (const placement of placements) {
				const pending = placement.pending;
				const entry: NewEntry =
					pending.type === "message"
						? { id: placement.id, parentId, type: "message", message: pending.payload }
						: {
								id: placement.id,
								parentId,
								type: "custom",
								customType: pending.customType,
								...(pending.payload === undefined ? {} : { data: pending.payload }),
							};
				entryWrites.push({ kind: "entry", entry });
				parentId = placement.id;
			}
			const triggerEntryId = parentId!;
			const operation: OperationMeta = {
				operationId: provisional.operationId,
				lane: lane.name,
				sourceLeafId: restored.leafId,
				startedAt: provisional.startedAt,
				intent: {
					kind: "run",
					promptEntryIds: callerIds,
					...(systemPromptOverride === undefined ? {} : { systemPromptOverride }),
					...(resumeData === undefined ? {} : { resumeData }),
				},
			};
			const state: RunState = {
				kind: "run",
				control: { status: "running" },
				settings: {
					compaction: { ...settings.compaction },
					steeringMode: settings.steeringMode,
					followUpMode: settings.followUpMode,
					toolExecution: settings.toolExecution,
				},
				phase: {
					kind: "checkpoint",
					continuation: { kind: "need_assistant", overflowRecoveryUsed: false },
					triggerEntryId,
					skipInboxOnce: true,
				},
				inbox: { steer: [], followUp: [], writes: [] },
				latestAssistantEntryId: null,
			};
			const result = await mutator.commit({
				writes: [
					...entryWrites,
					...pendingIds.map(
						(id) => ({ kind: "register", op: "delete", namespace: "pending.entry", key: id }) as const,
					),
					{ kind: "register", op: "set", namespace: "lane.leaf", key: lane.name, value: triggerEntryId },
					{ kind: "register", op: "set", namespace: "op.meta", key: provisional.operationId, value: operation },
					{ kind: "register", op: "set", namespace: "op.state", key: provisional.operationId, value: state },
					{
						kind: "register",
						op: "set",
						namespace: "lane.state",
						key: lane.name,
						value: { ...restored.laneState, currentOperationId: provisional.operationId, pendingNextRun: [] },
					},
				],
			});
			return Result.ok<AcceptancePublication>({
				admission: { operationId: provisional.operationId, kind: "run", startedAt: provisional.startedAt },
				entries: entryWrites.map((write, index) =>
					materializeCommittedEntry(write.entry, result.seqs[index]!, result.timestamp),
				),
				capturedNextRun: pendingIds.length !== 0,
			});
		});
		if (!publication.ok) return publication;
		runtime.attachedOperationIds.add(provisional.operationId);
		await runtime.events.emit({ type: "run_start", runId: provisional.operationId, lane: lane.name });
		for (const entry of publication.value.entries) {
			if (entry.type === "message") {
				await runtime.events.emit({
					type: "message_start",
					runId: provisional.operationId,
					message: entry.message,
					lane: lane.name,
				});
				await runtime.events.emit({
					type: "message_end",
					runId: provisional.operationId,
					message: entry.message,
					entryId: entry.id,
					lane: lane.name,
				});
			}
			await runtime.events.emit({ type: "entry_added", entry, lane: lane.name });
		}
		if (publication.value.capturedNextRun) {
			await runtime.events.emit({ type: "queue_update", steer: [], followUp: [], nextRun: [], lane: lane.name });
		}
		return Result.ok(publication.value.admission);
	} catch (error) {
		if (error instanceof HarnessClosed) return Result.err(runtime.closedError());
		if (error instanceof HarnessFault) throw error;
		throw runtime.fault(error);
	} finally {
		if (runtime.admissionReservations.get(lane.name) === reservation) {
			runtime.admissionReservations.delete(lane.name);
		}
		reservation.resolve();
	}
}

export async function inspectLane<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	lane: RuntimeLane,
): Promise<LaneExecutionInfo> {
	runtime.assertOpen();
	try {
		return await runtime.sessionStorage.mutate(lane.name, async (reader) => {
			const restored = await restoreLane(reader, lane.name, { includeLastResult: true });
			return {
				lane: lane.name,
				leafId: restored.leafId,
				current: currentInfo(runtime, lane.name, restored),
				...(restored.lastResult === undefined ? {} : { lastResult: restored.lastResult }),
			};
		});
	} catch (error) {
		throw runtime.fault(error);
	}
}

async function updateLaneConfiguration<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	lane: string,
	update: (configuration: LaneConfiguration) => LaneConfiguration,
): Promise<{ previous: LaneConfiguration; value: LaneConfiguration }> {
	runtime.assertOpen();
	try {
		return await runtime.sessionStorage.mutate(lane, async (mutator) => {
			const stored = await mutator.getRegister("lane.config", lane);
			if (stored === undefined) {
				throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.config`);
			}
			const value = update(stored.value);
			await mutator.commit({
				writes: [{ kind: "register", op: "set", namespace: "lane.config", key: lane, value }],
			});
			return { previous: stored.value, value };
		});
	} catch (error) {
		throw runtime.fault(error);
	}
}

async function appendPublicEntry<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	lane: string,
	pending: PendingEntry,
): Promise<string> {
	runtime.assertOpen();
	if (pending.type === "message" && pending.payload.role === "assistant" && pending.payload.stopReason === "pending") {
		throw new SessionPendingAssistantMessageError();
	}
	const id = runtime.sessionStorage.idGenerator.next();
	while (true) {
		const disposition = await runtime.sessionStorage.mutate(lane, async (mutator) => {
			const reservation = runtime.admissionReservations.get(lane);
			if (reservation !== undefined) return { kind: "wait" as const, completion: reservation.completion };
			const [leaf, laneState] = await Promise.all([
				mutator.getRegister("lane.leaf", lane),
				mutator.getRegister("lane.state", lane),
			]);
			if (leaf === undefined || laneState === undefined) throw new SessionInvariantError(`Unknown lane: ${lane}`);
			const operationId = laneState.value.currentOperationId;
			if (operationId === null) {
				await mutator.commit({
					writes: [
						{
							kind: "entry",
							entry:
								pending.type === "message"
									? { id, parentId: leaf.value, type: "message", message: pending.payload }
									: {
											id,
											parentId: leaf.value,
											type: "custom",
											customType: pending.customType,
											...(pending.payload === undefined ? {} : { data: pending.payload }),
										},
						},
						{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: id },
					],
				});
				return { kind: "done" as const };
			}
			const [operation, state] = await Promise.all([
				mutator.getRegister("op.meta", operationId),
				mutator.getRegister("op.state", operationId),
			]);
			if (operation === undefined || state === undefined || operation.value.lane !== lane) {
				throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} has incomplete operation state`);
			}
			if (state.value.kind !== "run" || operation.value.intent.kind !== "run") {
				throw new RuntimeSliceNotImplemented("tree write during structural operation");
			}
			await mutator.commit({
				writes: [
					{ kind: "register", op: "set", namespace: "pending.entry", key: id, value: pending },
					{
						kind: "register",
						op: "set",
						namespace: "op.state",
						key: operationId,
						value: {
							...state.value,
							inbox: { ...state.value.inbox, writes: [...state.value.inbox.writes, id] },
						},
					},
				],
			});
			return { kind: "done" as const };
		});
		if (disposition.kind === "done") return id;
		await disposition.completion;
		runtime.assertOpen();
	}
}

function normalizeRunRequest<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	request: Extract<OperationRequest, { kind: "prompt" | "skill" | "prompt_template" }>,
	resources: Resources,
) {
	const operationId = request.operationId ?? runtime.sessionStorage.idGenerator.next();
	const startedAt = Date.now();
	let messages: AgentMessage[];
	if (request.kind === "prompt") {
		if (typeof request.prompt === "string") {
			const content = [
				...(request.prompt.length === 0 ? [] : [{ type: "text" as const, text: request.prompt }]),
				...(request.images ?? []),
			];
			messages = content.length === 0 ? [] : [{ role: "user", content, timestamp: startedAt }];
		} else {
			messages = Array.isArray(request.prompt) ? [...request.prompt] : [request.prompt];
		}
	} else if (request.kind === "skill") {
		const skill = resources.skills?.find((candidate) => candidate.name === request.name);
		if (skill === undefined) {
			return Result.err(new UnknownSkill({ name: request.name, message: `Unknown skill: ${request.name}` }));
		}
		messages = [
			{
				role: "user",
				content: formatSkillInvocation(skill, request.additionalInstructions),
				timestamp: startedAt,
			},
		];
	} else {
		const template = resources.promptTemplates?.find((candidate) => candidate.name === request.name);
		if (template === undefined) {
			return Result.err(
				new UnknownTemplate({ name: request.name, message: `Unknown prompt template: ${request.name}` }),
			);
		}
		messages = [
			{ role: "user", content: formatPromptTemplateInvocation(template, request.args), timestamp: startedAt },
		];
	}
	return Result.ok<NormalizedRunRequest>({ operationId, startedAt, messages, resources });
}

function createLaneBusy(lane: string, owner: Pick<AdmissionReservation, "operationId" | "operationKind">): LaneBusy {
	return new LaneBusy({
		lane,
		operationId: owner.operationId,
		operationKind: owner.operationKind,
		message: `Lane ${JSON.stringify(lane)} already has an active operation`,
	});
}

async function resolveSystemPrompt<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
): Promise<string | undefined> {
	const source = runtime.systemPromptSource;
	if (source === undefined || typeof source === "string") return source;
	const contextSource = runtime.toolContext;
	const context = typeof contextSource === "function" ? await contextSource() : contextSource;
	return source(context as TContext);
}

function currentInfo<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	lane: string,
	restored: RestoredLane,
): CurrentOperationInfo | null {
	const current = restored.current;
	if (current === undefined) return null;
	const active = runtime.activeOperations.get(lane);
	if (active !== undefined && active.operationId !== current.operation.operationId) {
		throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} has a task for another operation`);
	}
	const status =
		current.state.control.status === "cancel_requested"
			? "aborting"
			: active?.operationId === current.operation.operationId
				? "running"
				: "suspended";
	const suspended = status === "suspended" ? suspensionForInspection(runtime, restored) : undefined;
	return {
		id: current.operation.operationId,
		kind: current.state.kind,
		status,
		startedAt: current.operation.startedAt,
		...(suspended === undefined ? {} : { suspended }),
	};
}

function suspensionForInspection<TContext extends object | undefined>(
	runtime: LaneRuntimeContext<TContext>,
	restored: RestoredLane,
): SuspendedOperation | undefined {
	const remembered = runtime.restoredSuspensions.get(restored.lane);
	return remembered?.operationId === restored.current?.operation.operationId ? remembered : undefined;
}

export class AgentLaneRuntime<TContext extends object | undefined> implements AgentLane {
	readonly name: string;
	readonly sessionTree: SessionTree;
	readonly breakpoint: BreakpointBarrier;
	private readonly harness: LaneRuntimeContext<TContext>;

	constructor(harness: LaneRuntimeContext<TContext>, name: string) {
		this.harness = harness;
		this.name = name;
		this.sessionTree = createPublicSessionView(harness, name);
		this.breakpoint = new BreakpointBarrier(harness.driveMode);
	}

	async getLeafId(): Promise<string | null> {
		this.harness.assertOpen();
		return this.sessionTree.getLeafId();
	}

	async getLastResult(): Promise<LaneLastResult | undefined> {
		this.harness.assertOpen();
		return (await this.harness.sessionStorage.getRegister("lane.lastResult", this.name))?.value;
	}

	accept(request: OperationRequest): Promise<OperationAdmissionResult> {
		return acceptLane(this.harness, this, request);
	}

	drive(options: DriveOptions): Promise<DriveResult> {
		return driveLane(this.harness, this, options);
	}

	requestAbort(_operationId: string): Promise<AbortRequestResult> {
		return this.unimplementedResult("requestAbort");
	}

	inspectExecution(): Promise<LaneExecutionInfo> {
		return inspectLane(this.harness, this);
	}

	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	prompt(message: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return this.runAccepted(
			typeof message === "string"
				? { kind: "prompt", prompt: message, ...(images === undefined ? {} : { images }) }
				: { kind: "prompt", prompt: message },
		);
	}
	skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		return this.runAccepted({
			kind: "skill",
			name,
			...(additionalInstructions === undefined ? {} : { additionalInstructions }),
		});
	}
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult> {
		return this.runAccepted({ kind: "prompt_template", name, ...(args === undefined ? {} : { args }) });
	}
	compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		return this.unimplementedResult("compact");
	}
	navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		return this.unimplementedResult("navigateTree");
	}
	resume(): Promise<ResumeResult> {
		return this.unimplementedResult("resume");
	}
	abort(): Promise<AbortResult> {
		return this.unimplementedResult("abort");
	}
	steer(_message: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unimplementedResult("steer");
	}
	followUp(_message: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unimplementedResult("followUp");
	}
	nextRun(_message: string | AgentMessage, _images?: ImageContent[]): Promise<NextRunResult> {
		return this.unimplementedResult("nextRun");
	}
	cancelQueued(_entryId: string): Promise<CancelQueuedResult> {
		return this.unimplementedResult("cancelQueued");
	}
	recordUsage(_usage: Usage, _options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.unimplementedResult("recordUsage");
	}
	waitForIdle(): Promise<void> {
		return this.notImplemented("waitForIdle");
	}
	runWhenIdle(_callback: () => void | Promise<void>): Promise<void> {
		return this.notImplemented("runWhenIdle");
	}
	async peekAction(): Promise<ActionInfo | undefined> {
		this.harness.assertOpen();
		return this.harness.sessionStorage.mutate(this.name, () => this.breakpoint.peek());
	}
	async executeAction(): Promise<ActionInfo | undefined> {
		this.harness.assertOpen();
		return this.harness.sessionStorage.mutate(this.name, () => this.breakpoint.release());
	}
	async runToCompletion(): Promise<void> {
		this.harness.assertOpen();
		while (true) {
			const active = this.harness.activeOperations.get(this.name);
			if (active === undefined) return;
			const action = this.breakpoint.peek();
			if (action !== undefined) {
				this.breakpoint.release();
				continue;
			}
			await Promise.race([
				active.completion.then(
					() => undefined,
					() => undefined,
				),
				this.breakpoint.waitForChange(),
			]);
		}
	}
	async getModel(): Promise<Model<Api> | undefined> {
		this.harness.assertOpen();
		const configuration = await this.getConfiguration();
		return this.harness.models.getModel(configuration.model.provider, configuration.model.modelId);
	}
	async setModel(model: Model<Api>): Promise<void> {
		const { previous, value } = await updateLaneConfiguration(this.harness, this.name, (configuration) => ({
			...configuration,
			model: { provider: model.provider, modelId: model.id },
		}));
		await this.harness.events.emit({
			type: "config_update",
			property: "model",
			value: { ...value.model },
			previous: { ...previous.model },
			lane: this.name,
		});
	}
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return (await this.getConfiguration()).thinkingLevel;
	}
	async setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
		const { previous } = await updateLaneConfiguration(this.harness, this.name, (configuration) => ({
			...configuration,
			thinkingLevel,
		}));
		await this.harness.events.emit({
			type: "config_update",
			property: "thinkingLevel",
			value: thinkingLevel,
			previous: previous.thinkingLevel,
			lane: this.name,
		});
	}
	async getActiveTools(): Promise<string[]> {
		return [...(await this.getConfiguration()).activeToolNames];
	}
	async setActiveTools(activeToolNames: string[]): Promise<void> {
		const names = [...activeToolNames];
		const { previous } = await updateLaneConfiguration(this.harness, this.name, (configuration) => ({
			...configuration,
			activeToolNames: names,
		}));
		await this.harness.events.emit({
			type: "config_update",
			property: "activeTools",
			value: [...names],
			previous: [...previous.activeToolNames],
			lane: this.name,
		});
	}
	watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.notImplemented("watch");
	}

	private async runAccepted(
		request: Extract<OperationRequest, { kind: "prompt" | "skill" | "prompt_template" }>,
	): Promise<RunResult> {
		const admission = await this.accept(request);
		if (!admission.ok) {
			if (
				admission.error._tag === "LaneBusy" ||
				admission.error._tag === "MissingIdentities" ||
				admission.error._tag === "InvalidMessage" ||
				admission.error._tag === "UnknownSkill" ||
				admission.error._tag === "UnknownTemplate" ||
				admission.error._tag === "Closed"
			) {
				return Result.err(admission.error);
			}
			throw new SessionInvariantError("Run acceptance returned a structural-operation error");
		}
		while (true) {
			const driven = await this.drive({
				operationId: admission.value.operationId,
				waitForRetry: true,
				pollDeferred: true,
			});
			if (!driven.ok) {
				throw new SessionInvariantError("A convenience drive lost ownership of its accepted operation");
			}
			if (driven.value.kind === "yielded") continue;
			if (driven.value.kind !== "settled") {
				if (driven.value.reason === "retry") continue;
				const leafId = await this.getLeafId();
				if (leafId === null) throw new SessionInvariantError("A suspended run cannot be at the root");
				if (driven.value.reason === "missing_identities") {
					return Result.ok({
						runId: admission.value.operationId,
						kind: "suspended",
						reason: "missing_identities",
						missing: driven.value.missing,
						leafId,
					});
				}
				return Result.ok({
					runId: admission.value.operationId,
					kind: "suspended",
					reason: "deferred",
					leafId,
					finalEntryId: leafId,
					deferred: driven.value.deferred,
				});
			}
			const outcome = driven.value.outcome;
			if (outcome.operation !== "run")
				throw new SessionInvariantError("Accepted run settled as another operation kind");
			const { operation: _operation, ...run } = outcome;
			return Result.ok(run);
		}
	}

	private async getConfiguration(): Promise<LaneConfiguration> {
		this.harness.assertOpen();
		try {
			const configuration = await this.harness.sessionStorage.getRegister("lane.config", this.name);
			if (configuration === undefined) {
				throw new SessionInvariantError(`Lane ${JSON.stringify(this.name)} is missing lane.config`);
			}
			return configuration.value;
		} catch (error) {
			throw this.harness.fault(error);
		}
	}

	private async unimplementedResult(operation: string) {
		const closed = this.harness.resultClosedError();
		if (closed !== undefined) return Result.err(closed);
		throw new RuntimeSliceNotImplemented(operation);
	}

	private async notImplemented<T>(operation: string): Promise<T> {
		this.harness.assertOpen();
		throw new RuntimeSliceNotImplemented(operation);
	}
}
