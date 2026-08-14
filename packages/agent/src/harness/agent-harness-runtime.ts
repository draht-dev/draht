import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	RetryPolicy,
	SimpleStreamOptions,
	Usage,
} from "@draht/ai";
import {
	createAssistantMessageEventStream,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
} from "@draht/ai";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@draht/telemetry";
import type { AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import {
	type AbortRequestResult,
	type AbortResult,
	type ActionInfo,
	type AgentHarness,
	type AgentHarnessOptions,
	type AgentLane,
	type CancelQueuedResult,
	Closed,
	type CompactionResult,
	type CreateLaneResult,
	type CurrentOperationInfo,
	type DriveOptions,
	type DriveResult,
	HarnessClosed,
	type HarnessEvent,
	HarnessFault,
	InvalidLane,
	InvalidMessage,
	LaneBusy,
	type LaneExecutionInfo,
	LaneExists,
	type LaneInfo,
	type LaneSnapshot,
	MissingIdentities,
	type NavigateOptions,
	type NavigationResult,
	type NextRunResult,
	type OperationAdmissionResult,
	OperationMismatch,
	type OperationRequest,
	type QueueResult,
	type RecordUsageResult,
	type Resources,
	type ResumeResult,
	type RunResult,
	type SessionSnapshot,
	type SuspendedOperation,
	type TerminalOperationOutcome,
	UnknownSkill,
	UnknownTarget,
	UnknownTemplate,
	type WatchHandle,
} from "./agent-harness.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction/compaction.ts";
import { HarnessEventBus } from "./events.ts";
import { streamHarnessAssistant } from "./execution/assistant.ts";
import { BreakpointBarrier } from "./execution/breakpoint.ts";
import { OperationEffectGate } from "./execution/effect-gate.ts";
import { applyStreamOptionsPatch, HookRegistry } from "./hooks.ts";
import { convertToLlm } from "./messages.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { type RestoredLane, restoreLane } from "./restore.ts";
import { Result } from "./result.ts";
import { buildSessionContext } from "./session/context.ts";
import { LaneMutationLine } from "./session/lane-mutations.ts";
import {
	SessionInvalidLaneError,
	SessionInvariantError,
	SessionLaneExistsError,
	SessionPendingAssistantMessageError,
	SessionUnknownTargetError,
} from "./session/session.ts";
import type {
	Entry,
	EntryProjector,
	JsonValue,
	LaneConfiguration,
	LaneLastResult,
	NewEntry,
	Operation,
	OperationError,
	PendingEntry,
	RunState,
	Session,
	SessionMutator,
	SessionTree,
	SettledAssistantMessage,
} from "./session/types.ts";
import { formatSkillInvocation } from "./skills.ts";
import { startHarnessSpan } from "./telemetry.ts";
import type { AgentHarnessStreamOptions, AgentHarnessTool, AgentHarnessToolContextSource } from "./types.ts";

const DEFAULT_RETRY_POLICY: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 1_000 };

class RuntimeSliceNotImplemented extends Error {
	constructor(operation: string) {
		super(`${operation} is not implemented until its later AgentHarness runtime slice`);
		this.name = "RuntimeSliceNotImplemented";
	}
}

interface RuntimeSettings<TContext extends object | undefined> {
	tools: AgentHarnessTool<TContext>[];
	resources: Resources;
	streamOptions: AgentHarnessStreamOptions;
	retryPolicy: RetryPolicy;
	compaction: CompactionSettings;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	toolExecution: "sequential" | "parallel";
}

interface DeferredValue<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

interface ActiveOperation {
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	completion: Promise<DriveResult>;
	resolve: (result: DriveResult) => void;
	reject: (error: unknown) => void;
	effectGate: OperationEffectGate;
	task?: Promise<void>;
}

interface AdmissionReservation {
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	completion: Promise<void>;
	resolve(): void;
}

type DriveArbitration =
	| { kind: "result"; result: DriveResult }
	| { kind: "join"; completion: Promise<DriveResult> }
	| { kind: "installed"; active: ActiveOperation };

interface NormalizedRunRequest {
	operationId: string;
	startedAt: number;
	messages: AgentMessage[];
	resources: Resources;
}

interface AcceptancePublication {
	admission: { operationId: string; kind: "run"; startedAt: number };
	entries: Entry[];
	capturedNextRun: boolean;
}

interface AssistantSettlementDecision {
	message: SettledAssistantMessage;
	phase: RunState["phase"];
	outcome: CommittedAssistantSettlement["outcome"];
}

interface CommittedAssistantSettlement {
	entry: Entry;
	row: { id: string; seq: number; usage: Usage; entryId: string; adjustment: false };
	totals: Usage;
	message: SettledAssistantMessage;
	outcome:
		| { kind: "completed" }
		| { kind: "aborted" }
		| { kind: "deferred"; handle: DeferredHandle }
		| { kind: "retry"; nextAttempt: number; delayMs: number; notBefore: number; errorMessage: string }
		| { kind: "failed"; error: OperationError };
}

type AssistantExecutionResult =
	| { kind: "advanced" }
	| { kind: "yielded" }
	| { kind: "missing_identities"; missing: { tools: string[]; models: string[] } };

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function deferredValue<T>(): DeferredValue<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	let rejectPromise: ((error: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve(value) {
			resolvePromise?.(value);
		},
		reject(error) {
			rejectPromise?.(error);
		},
	};
}

export async function createAgentHarness<TContext extends object | undefined = object | undefined>(
	options: AgentHarnessOptions<TContext>,
): Promise<{ harness: AgentHarness<TContext>; suspended: SuspendedOperation[] }> {
	const runtime = new AgentHarnessRuntime(options);
	try {
		const suspended = await runtime.initialize();
		return { harness: runtime, suspended };
	} catch (error) {
		throw runtime.fault(error);
	}
}

class AgentHarnessRuntime<TContext extends object | undefined> implements AgentHarness<TContext> {
	readonly name = "main";
	readonly session: SessionTree;
	readonly hooks: HookRegistry;
	readonly events: HarnessEventBus;
	readonly sessionStorage: Session;
	readonly models: AgentHarnessOptions<TContext>["models"];
	readonly driveMode: "automatic" | "manual";
	readonly seed: LaneConfiguration;
	readonly toolContext: AgentHarnessToolContextSource<TContext> | undefined;
	readonly systemPromptSource: AgentHarnessOptions<TContext>["systemPrompt"];
	readonly toProviderMessages: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	readonly entryProjectors: Readonly<Record<string, EntryProjector>>;
	readonly telemetryContext: TelemetryContext;
	readonly settingsLine = new LaneMutationLine();
	readonly laneRuntimes = new Map<string, AgentLaneRuntime<TContext>>();
	readonly activeOperations = new Map<string, ActiveOperation>();
	readonly admissionReservations = new Map<string, AdmissionReservation>();
	readonly attachedOperationIds = new Set<string>();
	readonly resumedOperationIds = new Set<string>();
	readonly resumeEventOperationIds = new Set<string>();
	readonly restoredSuspensions = new Map<string, SuspendedOperation>();
	settings: RuntimeSettings<TContext>;
	settingsRevision = 0;
	state: "open" | "faulted" | "closing" | "closed" = "open";
	faultError: HarnessFault | undefined;
	closePromise: Promise<void> | undefined;

	constructor(options: AgentHarnessOptions<TContext>) {
		validateRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
		validateCompactionSettings(options.compaction ?? DEFAULT_COMPACTION_SETTINGS);
		this.sessionStorage = options.session;
		this.models = options.models;
		this.driveMode = options.drive ?? "automatic";
		this.toolContext = options.toolContext;
		this.systemPromptSource = options.systemPrompt;
		this.toProviderMessages = options.toProviderMessages ?? convertToLlm;
		this.entryProjectors = options.entryProjectors ?? {};
		this.telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
		const tools = [...(options.tools ?? [])];
		this.seed = {
			model: { provider: options.model.provider, modelId: options.model.id },
			thinkingLevel: options.thinkingLevel ?? "off",
			activeToolNames: [...(options.activeToolNames ?? tools.map((tool) => tool.name))],
		};
		this.settings = {
			tools,
			resources: options.resources ?? {},
			streamOptions: options.streamOptions ?? {},
			retryPolicy: options.retry ?? DEFAULT_RETRY_POLICY,
			compaction: options.compaction ?? DEFAULT_COMPACTION_SETTINGS,
			steeringMode: options.steeringMode ?? "all",
			followUpMode: options.followUpMode ?? "all",
			toolExecution: options.toolExecution ?? "parallel",
		};
		this.events = new HarnessEventBus();
		this.hooks = new HookRegistry((error, hook, lane) =>
			this.events.emit({
				type: "handler_error",
				kind: "hook",
				hook,
				error: error.message,
				...(error.stack === undefined ? {} : { stack: error.stack }),
				lane,
			}),
		);
		this.session = this.createPublicSessionView("main");
	}

	async initialize(): Promise<SuspendedOperation[]> {
		await this.initializeMainConfiguration();
		const [leaves, configurations, states, lastResults] = await Promise.all([
			this.sessionStorage.listRegisters("lane.leaf"),
			this.sessionStorage.listRegisters("lane.config"),
			this.sessionStorage.listRegisters("lane.state"),
			this.sessionStorage.listRegisters("lane.lastResult"),
		]);
		const leafNames = new Set(leaves.map((register) => register.key));
		if (!leafNames.has("main")) throw new SessionInvariantError("Session is missing main lane");
		for (const register of [...configurations, ...states, ...lastResults]) {
			if (!leafNames.has(register.key)) {
				throw new SessionInvariantError(
					`Lane ${JSON.stringify(register.key)} has ${register.namespace} without lane.leaf`,
				);
			}
		}

		const suspended: SuspendedOperation[] = [];
		for (const { key: lane } of leaves) {
			const restored = await this.sessionStorage.mutate(lane, (reader) => restoreLane(reader, lane));
			const runtime = new AgentLaneRuntime(this, lane);
			this.laneRuntimes.set(lane, runtime);
			if (restored.current === undefined) continue;
			const descriptor = this.describeSuspension(restored);
			this.restoredSuspensions.set(lane, descriptor);
			suspended.push(descriptor);
		}
		return suspended;
	}

	async lane(name: string): Promise<AgentLane | undefined> {
		this.assertOpen();
		return this.laneRuntimes.get(name);
	}

	async createLane(name: string, at: string | null): Promise<CreateLaneResult> {
		const closed = this.resultClosedError();
		if (closed !== undefined) return Result.err(closed);
		try {
			await this.sessionStorage.createLane(name, at, cloneConfiguration(this.seed));
			const lane = new AgentLaneRuntime(this, name);
			this.laneRuntimes.set(name, lane);
			await this.events.emit({ type: "lane_created", lane: name, at });
			return Result.ok(lane);
		} catch (error) {
			if (error instanceof SessionLaneExistsError) {
				return Result.err(new LaneExists({ lane: error.lane, message: error.message }));
			}
			if (error instanceof SessionInvalidLaneError) {
				return Result.err(new InvalidLane({ lane: error.lane, reason: error.reason, message: error.message }));
			}
			if (error instanceof SessionUnknownTargetError) {
				return Result.err(new UnknownTarget({ targetId: error.targetId, message: error.message }));
			}
			throw this.fault(error);
		}
	}

	async lanes(): Promise<LaneInfo[]> {
		this.assertOpen();
		return Promise.all(
			[...this.laneRuntimes.values()].map(async (lane) => {
				const execution = await lane.inspectExecution();
				return {
					name: lane.name,
					leafId: execution.leafId,
					operation:
						execution.current === null
							? null
							: {
									id: execution.current.id,
									kind: execution.current.kind,
									status: execution.current.status,
								},
				};
			}),
		);
	}

	getTools(): Promise<AgentHarnessTool<TContext>[]> {
		return this.readSettings((settings) => [...settings.tools]);
	}

	setTools(tools: AgentHarnessTool<TContext>[]): Promise<void> {
		return this.writeSettings((settings) => ({ ...settings, tools: [...tools] }), {
			type: "config_update",
			property: "tools",
		});
	}

	getResources(): Promise<Resources> {
		return this.readSettings((settings) => settings.resources);
	}

	setResources(resources: Resources): Promise<void> {
		return this.writeSettings((settings) => ({ ...settings, resources }), {
			type: "config_update",
			property: "resources",
		});
	}

	getStreamOptions(): Promise<NonNullable<AgentHarnessOptions<TContext>["streamOptions"]>> {
		return this.readSettings((settings) => settings.streamOptions);
	}

	setStreamOptions(options: NonNullable<AgentHarnessOptions<TContext>["streamOptions"]>): Promise<void> {
		return this.writeSettings((settings) => ({ ...settings, streamOptions: options }), {
			type: "config_update",
			property: "streamOptions",
		});
	}

	getRetryPolicy(): Promise<RetryPolicy> {
		return this.readSettings((settings) => settings.retryPolicy);
	}

	setRetryPolicy(policy: RetryPolicy): Promise<void> {
		validateRetryPolicy(policy);
		return this.writeSettings((settings) => ({ ...settings, retryPolicy: policy }), {
			type: "config_update",
			property: "retryPolicy",
		});
	}

	getCompactionSettings(): Promise<CompactionSettings> {
		return this.readSettings((settings) => settings.compaction);
	}

	setCompactionSettings(compaction: CompactionSettings): Promise<void> {
		validateCompactionSettings(compaction);
		return this.writeSettings((settings) => ({ ...settings, compaction }), {
			type: "config_update",
			property: "compactionSettings",
		});
	}

	getSteeringMode(): Promise<QueueMode> {
		return this.readSettings((settings) => settings.steeringMode);
	}

	setSteeringMode(steeringMode: QueueMode): Promise<void> {
		return this.writeSettings((settings) => ({ ...settings, steeringMode }), {
			type: "config_update",
			property: "steeringMode",
		});
	}

	getFollowUpMode(): Promise<QueueMode> {
		return this.readSettings((settings) => settings.followUpMode);
	}

	setFollowUpMode(followUpMode: QueueMode): Promise<void> {
		return this.writeSettings((settings) => ({ ...settings, followUpMode }), {
			type: "config_update",
			property: "followUpMode",
		});
	}

	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		this.assertOpen();
		throw new RuntimeSliceNotImplemented("watchSession");
	}

	createPublicSessionView(lane: string): SessionTree {
		const delegate = this.sessionStorage.view(lane);
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
			appendMessage: (message) => this.appendPublicEntry(lane, { type: "message", payload: message }),
			appendCustomEntry: (customType, data) =>
				this.appendPublicEntry(lane, {
					type: "custom",
					customType,
					...(data === undefined ? {} : { payload: data }),
				}),
		};
	}

	async acceptLane(lane: AgentLaneRuntime<TContext>, request: OperationRequest): Promise<OperationAdmissionResult> {
		const closed = this.resultClosedError();
		if (closed !== undefined) return Result.err(closed);
		if (request.kind === "compaction" || request.kind === "navigation") {
			throw new RuntimeSliceNotImplemented(`accept(${request.kind})`);
		}

		const resources = await this.readSettings((settings) => settings.resources);
		const normalized = this.normalizeRunRequest(request, resources);
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
			const busy = await this.sessionStorage.mutate(lane.name, async (reader) => {
				const restored = await restoreLane(reader, lane.name);
				const existingReservation = this.admissionReservations.get(lane.name);
				if (existingReservation !== undefined) return this.busy(lane.name, existingReservation);
				const active = this.activeOperations.get(lane.name);
				if (active !== undefined) return this.busy(lane.name, active);
				if (restored.current !== undefined) {
					return new LaneBusy({
						lane: lane.name,
						operationId: restored.current.operation.operationId,
						operationKind: restored.current.operation.intent.kind,
						message: `Lane ${JSON.stringify(lane.name)} already has an active operation`,
					});
				}
				this.admissionReservations.set(lane.name, reservation);
				return undefined;
			});
			if (busy !== undefined) return Result.err(busy);

			let systemPrompt = "";
			let hookMessages: AgentMessage[] = [];
			let systemPromptOverride: string | undefined;
			let resumeData: Record<string, JsonValue> | undefined;
			if (this.hooks.has("before_run")) {
				systemPrompt = (await this.resolveSystemPrompt()) ?? "";
				await lane.breakpoint.hit({
					kind: "hook.before_run",
					description: "Run pre-acceptance hooks",
					details: { operationId: provisional.operationId },
				});
				this.assertOpen();
				const aggregate = await this.hooks.runBeforeAcceptanceWithResumeData(
					{
						lane: lane.name,
						runId: provisional.operationId,
						prompt: provisional.messages,
						systemPrompt,
						resources: provisional.resources,
					},
					() => this.assertOpen(),
				);
				hookMessages = aggregate.result?.messages ?? [];
				systemPromptOverride = aggregate.result?.systemPrompt;
				if (Object.keys(aggregate.resumeData).length !== 0) resumeData = aggregate.resumeData;
			}
			const settings = await this.snapshotSettings();
			const publication = await this.sessionStorage.mutate(lane.name, async (mutator) => {
				if (this.admissionReservations.get(lane.name) !== reservation) {
					throw new SessionInvariantError(`Lane ${JSON.stringify(lane.name)} lost its admission reservation`);
				}
				const restored = await restoreLane(mutator, lane.name);
				if (restored.current !== undefined || this.activeOperations.has(lane.name)) {
					const owner = restored.current?.operation;
					return Result.err(
						owner === undefined
							? this.busy(lane.name, this.activeOperations.get(lane.name)!)
							: new LaneBusy({
									lane: lane.name,
									operationId: owner.operationId,
									operationKind: owner.intent.kind,
									message: `Lane ${JSON.stringify(lane.name)} already has an active operation`,
								}),
					);
				}
				const missing = this.missingIdentities(restored.configuration, settings);
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
				const pendingRegisters = await Promise.all(
					pendingIds.map((id) => mutator.getRegister("pending.entry", id)),
				);
				for (let index = 0; index < pendingIds.length; index++) {
					if (pendingRegisters[index] === undefined) {
						throw new SessionInvariantError(`Pending next-run entry ${pendingIds[index]} is missing`);
					}
				}
				const callerIds = provisional.messages.map(() => this.sessionStorage.idGenerator.next());
				const hookIds = hookMessages.map(() => this.sessionStorage.idGenerator.next());
				const placements: Array<{ id: string; pending: NonNullable<(typeof pendingRegisters)[number]>["value"] }> =
					[];
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
				const operation: Operation = {
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
				await mutator.commit({
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
				const entries = await mutator.getEntries(placements.map((placement) => placement.id));
				return Result.ok<AcceptancePublication>({
					admission: { operationId: provisional.operationId, kind: "run", startedAt: provisional.startedAt },
					entries: placements.map((placement) => entries.get(placement.id)!),
					capturedNextRun: pendingIds.length !== 0,
				});
			});
			if (!publication.ok) return publication;
			this.attachedOperationIds.add(provisional.operationId);
			await this.events.emit({ type: "run_start", runId: provisional.operationId, lane: lane.name });
			for (const entry of publication.value.entries) {
				if (entry.type === "message") {
					await this.events.emit({
						type: "message_start",
						runId: provisional.operationId,
						message: entry.message,
						lane: lane.name,
					});
					await this.events.emit({
						type: "message_end",
						runId: provisional.operationId,
						message: entry.message,
						entryId: entry.id,
						lane: lane.name,
					});
				}
				await this.events.emit({ type: "entry_added", entry, lane: lane.name });
			}
			if (publication.value.capturedNextRun) {
				await this.events.emit({ type: "queue_update", steer: [], followUp: [], nextRun: [], lane: lane.name });
			}
			return Result.ok(publication.value.admission);
		} catch (error) {
			if (error instanceof HarnessClosed) return Result.err(this.closedError());
			if (error instanceof HarnessFault) throw error;
			throw this.fault(error);
		} finally {
			if (this.admissionReservations.get(lane.name) === reservation) {
				this.admissionReservations.delete(lane.name);
			}
			reservation.resolve();
		}
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		this.state = "closing";
		const error = new HarnessClosed();
		this.hooks.close(error);
		this.events.close(error);
		for (const lane of this.laneRuntimes.values()) lane.breakpoint.close(error);
		for (const active of this.activeOperations.values()) {
			active.effectGate.close(error);
			active.reject(error);
		}
		this.closePromise = (async () => {
			await this.settingsLine.seal(error);
			await Promise.allSettled(
				[...this.activeOperations.values()].flatMap((active) => (active.task === undefined ? [] : [active.task])),
			);
			await this.sessionStorage.close();
			this.state = "closed";
		})();
		return this.closePromise;
	}

	getLeafId(): Promise<string | null> {
		return this.mainLane().getLeafId();
	}
	getLastResult(): Promise<LaneLastResult | undefined> {
		return this.mainLane().getLastResult();
	}
	accept(request: OperationRequest): Promise<OperationAdmissionResult> {
		return this.mainLane().accept(request);
	}
	drive(options: DriveOptions): Promise<DriveResult> {
		return this.mainLane().drive(options);
	}
	requestAbort(operationId: string): Promise<AbortRequestResult> {
		return this.mainLane().requestAbort(operationId);
	}
	inspectExecution(): Promise<LaneExecutionInfo> {
		return this.mainLane().inspectExecution();
	}
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	prompt(message: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return typeof message === "string" ? this.mainLane().prompt(message, images) : this.mainLane().prompt(message);
	}
	skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		return this.mainLane().skill(name, additionalInstructions);
	}
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult> {
		return this.mainLane().promptFromTemplate(name, args);
	}
	compact(options?: { customInstructions?: string }): Promise<CompactionResult> {
		return this.mainLane().compact(options);
	}
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult> {
		return this.mainLane().navigateTree(targetId, options);
	}
	resume(): Promise<ResumeResult> {
		return this.mainLane().resume();
	}
	abort(): Promise<AbortResult> {
		return this.mainLane().abort();
	}
	steer(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.mainLane().steer(message, images);
	}
	followUp(message: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.mainLane().followUp(message, images);
	}
	nextRun(message: string | AgentMessage, images?: ImageContent[]): Promise<NextRunResult> {
		return this.mainLane().nextRun(message, images);
	}
	cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		return this.mainLane().cancelQueued(entryId);
	}
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.mainLane().recordUsage(usage, options);
	}
	waitForIdle(): Promise<void> {
		return this.mainLane().waitForIdle();
	}
	runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		return this.mainLane().runWhenIdle(callback);
	}
	peekAction(): Promise<ActionInfo | undefined> {
		return this.mainLane().peekAction();
	}
	executeAction(): Promise<ActionInfo | undefined> {
		return this.mainLane().executeAction();
	}
	runToCompletion(): Promise<void> {
		return this.mainLane().runToCompletion();
	}
	getModel(): Promise<Model<Api> | undefined> {
		return this.mainLane().getModel();
	}
	setModel(model: Model<Api>): Promise<void> {
		return this.mainLane().setModel(model);
	}
	getThinkingLevel(): Promise<ThinkingLevel> {
		return this.mainLane().getThinkingLevel();
	}
	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.mainLane().setThinkingLevel(level);
	}
	getActiveTools(): Promise<string[]> {
		return this.mainLane().getActiveTools();
	}
	setActiveTools(names: string[]): Promise<void> {
		return this.mainLane().setActiveTools(names);
	}
	watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.mainLane().watch();
	}

	async driveLane(lane: AgentLaneRuntime<TContext>, options: DriveOptions): Promise<DriveResult> {
		const closed = this.resultClosedError();
		if (closed !== undefined) return Result.err(closed);
		const reservation = this.admissionReservations.get(lane.name);
		if (reservation?.operationId === options.operationId) {
			await reservation.completion;
			const afterReservation = this.resultClosedError();
			if (afterReservation !== undefined) return Result.err(afterReservation);
		}
		let arbitration: DriveArbitration;
		try {
			arbitration = await this.sessionStorage.mutate(lane.name, async (reader): Promise<DriveArbitration> => {
				const restored = await restoreLane(reader, lane.name, { includeLastResult: true });
				const currentId = restored.laneState.currentOperationId;
				if (currentId === null) {
					if (restored.lastResult?.operationId === options.operationId) {
						return {
							kind: "result",
							result: Result.ok({
								kind: "settled",
								operationId: options.operationId,
								outcome: await hydrateTerminalOutcome(reader, restored.lastResult),
							}),
						};
					}
					return { kind: "result", result: Result.err(this.mismatch(lane.name, options.operationId, restored)) };
				}
				if (currentId !== options.operationId) {
					return { kind: "result", result: Result.err(this.mismatch(lane.name, options.operationId, restored)) };
				}
				const existing = this.activeOperations.get(lane.name);
				if (existing !== undefined) {
					if (existing.operationId !== options.operationId) {
						throw new SessionInvariantError(`Lane ${JSON.stringify(lane.name)} has a task for another operation`);
					}
					return { kind: "join", completion: existing.completion };
				}
				if (restored.current === undefined)
					throw new SessionInvariantError("Current operation metadata is missing");
				const deferred = deferredValue<DriveResult>();
				const active: ActiveOperation = {
					operationId: options.operationId,
					operationKind: restored.current.operation.intent.kind,
					completion: deferred.promise,
					resolve: deferred.resolve,
					reject: deferred.reject,
					effectGate: new OperationEffectGate(),
				};
				this.activeOperations.set(lane.name, active);
				return { kind: "installed", active };
			});
		} catch (error) {
			throw this.fault(error);
		}

		if (arbitration.kind === "result") return arbitration.result;
		if (arbitration.kind === "join") return arbitration.completion;
		this.startDrivePass(lane, arbitration.active, options);
		return arbitration.active.completion;
	}

	async inspectLane(lane: AgentLaneRuntime<TContext>): Promise<LaneExecutionInfo> {
		this.assertOpen();
		try {
			return await this.sessionStorage.mutate(lane.name, async (reader) => {
				const restored = await restoreLane(reader, lane.name, { includeLastResult: true });
				return {
					lane: lane.name,
					leafId: restored.leafId,
					current: this.currentInfo(lane.name, restored),
					...(restored.lastResult === undefined ? {} : { lastResult: restored.lastResult }),
				};
			});
		} catch (error) {
			throw this.fault(error);
		}
	}

	async updateLaneConfiguration(
		lane: string,
		update: (configuration: LaneConfiguration) => LaneConfiguration,
	): Promise<{ previous: LaneConfiguration; value: LaneConfiguration }> {
		this.assertOpen();
		try {
			return await this.sessionStorage.mutate(lane, async (mutator) => {
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
			throw this.fault(error);
		}
	}

	describeSuspension(restored: RestoredLane): SuspendedOperation {
		const current = restored.current;
		if (current === undefined) throw new SessionInvariantError(`Lane ${restored.lane} is not suspended`);
		const base = this.suspensionBase(restored);
		if (current.state.kind === "run" && current.state.phase.kind === "deferred") {
			const entry = current.entries.get(current.state.phase.deferred.sourceEntryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant" || entry.message.deferred === undefined) {
				throw new SessionInvariantError("Deferred suspension source is invalid");
			}
			return { ...base, reason: "deferred", deferred: entry.message.deferred };
		}
		if (
			current.state.kind === "run" &&
			current.state.phase.kind === "assistant" &&
			current.state.phase.generation.status === "ready"
		) {
			const missing = this.missingIdentities(current.state.phase.generation.context.configuration, this.settings);
			if (missing.tools.length !== 0 || missing.models.length !== 0) {
				return { ...base, reason: "crash", missing };
			}
		}
		return { ...base, reason: "crash" };
	}

	private suspensionBase(restored: RestoredLane): Omit<SuspendedOperation, "reason" | "deferred" | "missing"> {
		const current = restored.current;
		if (current === undefined) throw new SessionInvariantError(`Lane ${restored.lane} is not suspended`);
		return {
			lane: restored.lane,
			operationId: current.operation.operationId,
			kind: current.operation.intent.kind,
			startedAt: current.operation.startedAt,
			...(current.operation.intent.kind !== "run"
				? {}
				: {
						prompt: current.operation.intent.promptEntryIds.map((id) => {
							const entry = current.entries.get(id);
							if (entry?.type !== "message") throw new SessionInvariantError(`Prompt entry ${id} is missing`);
							return entry.message;
						}),
					}),
		};
	}

	assertOpen(): void {
		if (this.faultError !== undefined) throw this.faultError;
		if (!this.isOpen()) throw new HarnessClosed();
	}

	isOpen(): boolean {
		return this.state === "open";
	}

	closedError(): Closed {
		return new Closed({ message: "AgentHarness is closed" });
	}

	resultClosedError(): Closed | undefined {
		if (this.faultError !== undefined) throw this.faultError;
		return this.isOpen() ? undefined : this.closedError();
	}

	fault(cause: unknown): HarnessFault {
		if (this.faultError !== undefined) return this.faultError;
		const normalized = cause instanceof Error ? cause : new Error(String(cause));
		const fault = new HarnessFault("AgentHarness storage or invariant fault", normalized);
		this.faultError = fault;
		this.state = "faulted";
		this.hooks.close(fault);
		for (const lane of this.laneRuntimes.values()) lane.breakpoint.close(fault);
		for (const active of this.activeOperations.values()) {
			active.effectGate.close(fault);
			active.reject(fault);
		}
		void this.events.emit({ type: "fault", code: "harness_fault", message: fault.message });
		this.events.close(fault);
		return fault;
	}

	private async appendPublicEntry(lane: string, pending: PendingEntry): Promise<string> {
		this.assertOpen();
		if (
			pending.type === "message" &&
			pending.payload.role === "assistant" &&
			pending.payload.stopReason === "pending"
		) {
			throw new SessionPendingAssistantMessageError();
		}
		const id = this.sessionStorage.idGenerator.next();
		while (true) {
			const disposition = await this.sessionStorage.mutate(lane, async (mutator) => {
				const reservation = this.admissionReservations.get(lane);
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
			this.assertOpen();
		}
	}

	private normalizeRunRequest(
		request: Extract<OperationRequest, { kind: "prompt" | "skill" | "prompt_template" }>,
		resources: Resources,
	) {
		const operationId = request.operationId ?? this.sessionStorage.idGenerator.next();
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

	private async snapshotSettings(): Promise<RuntimeSettings<TContext>> {
		return this.readSettings((settings) => ({
			...settings,
			tools: [...settings.tools],
			streamOptions: { ...settings.streamOptions },
			retryPolicy: { ...settings.retryPolicy },
			compaction: { ...settings.compaction },
		}));
	}

	private missingIdentities(
		configuration: LaneConfiguration,
		settings: RuntimeSettings<TContext>,
	): { tools: string[]; models: string[] } {
		const model = this.models.getModel(configuration.model.provider, configuration.model.modelId);
		const availableTools = new Set(settings.tools.map((tool) => tool.name));
		return {
			tools: configuration.activeToolNames.filter((name) => !availableTools.has(name)),
			models: model === undefined ? [`${configuration.model.provider}/${configuration.model.modelId}`] : [],
		};
	}

	private busy(lane: string, owner: Pick<AdmissionReservation, "operationId" | "operationKind">): LaneBusy {
		return new LaneBusy({
			lane,
			operationId: owner.operationId,
			operationKind: owner.operationKind,
			message: `Lane ${JSON.stringify(lane)} already has an active operation`,
		});
	}

	private async resolveSystemPrompt(): Promise<string | undefined> {
		const source = this.systemPromptSource;
		if (source === undefined || typeof source === "string") return source;
		const contextSource = this.toolContext;
		const context = typeof contextSource === "function" ? await contextSource() : contextSource;
		return source(context as TContext);
	}

	private mainLane(): AgentLaneRuntime<TContext> {
		const lane = this.laneRuntimes.get("main");
		if (lane === undefined) throw new SessionInvariantError("AgentHarness main lane is not initialized");
		return lane;
	}

	private async initializeMainConfiguration(): Promise<void> {
		await this.sessionStorage.mutate("main", async (mutator) => {
			const [leaf, state, configuration, lastResult] = await Promise.all([
				mutator.getRegister("lane.leaf", "main"),
				mutator.getRegister("lane.state", "main"),
				mutator.getRegister("lane.config", "main"),
				mutator.getRegister("lane.lastResult", "main"),
			]);
			if (leaf === undefined || state === undefined) {
				throw new SessionInvariantError("Session main lane has incomplete durable state");
			}
			if (configuration !== undefined) return;
			if (state.value.currentOperationId !== null || lastResult !== undefined) {
				throw new SessionInvariantError("Configured or active main lane is missing lane.config");
			}
			await mutator.commit({
				writes: [
					{
						kind: "register",
						op: "set",
						namespace: "lane.config",
						key: "main",
						value: cloneConfiguration(this.seed),
					},
				],
			});
		});
	}

	private startDrivePass(lane: AgentLaneRuntime<TContext>, active: ActiveOperation, options: DriveOptions): void {
		active.task = (async () => {
			try {
				const result = await this.executeDrivePass(lane, active, options);
				await this.removeActiveOperation(lane.name, active);
				active.resolve(result);
			} catch (error) {
				await this.removeActiveOperation(lane.name, active);
				active.reject(
					error instanceof HarnessClosed ||
						error instanceof HarnessFault ||
						error instanceof RuntimeSliceNotImplemented
						? error
						: this.fault(error),
				);
			}
		})();
	}

	private async executeDrivePass(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		options: DriveOptions,
	): Promise<DriveResult> {
		const initial = await this.loadExpected(lane.name, active.operationId, false);
		if (initial.current === undefined) return this.settledOrMismatch(lane.name, active.operationId, initial);
		const resultAtDeadline = (): DriveResult => {
			const current = initial.current;
			const state = current?.state;
			if (
				state?.kind === "run" &&
				state.phase.kind === "assistant" &&
				state.phase.generation.status === "retry_wait" &&
				Date.now() < state.phase.generation.notBefore
			) {
				return Result.ok({
					kind: "waiting",
					operationId: active.operationId,
					reason: "retry",
					notBefore: state.phase.generation.notBefore,
				});
			}
			if (state?.kind === "run" && state.phase.kind === "deferred" && state.phase.deferred.status === "suspended") {
				const source = current?.entries.get(state.phase.deferred.sourceEntryId);
				if (
					source?.type !== "message" ||
					source.message.role !== "assistant" ||
					source.message.deferred === undefined
				) {
					throw new SessionInvariantError("Deferred suspension source is invalid");
				}
				return Result.ok({
					kind: "waiting",
					operationId: active.operationId,
					reason: "deferred",
					deferred: source.message.deferred,
				});
			}
			return Result.ok({ kind: "yielded", operationId: active.operationId });
		};
		if (deadlineReached(options)) return resultAtDeadline();

		await lane.breakpoint.hit({
			kind: "runtime.dispatch",
			description: "Advance durable operation",
			details: { operationId: active.operationId, operationKind: initial.current.state.kind },
		});
		if (deadlineReached(options)) return resultAtDeadline();
		if (initial.current.state.kind !== "run") {
			throw new RuntimeSliceNotImplemented(`drive(${initial.current.state.kind})`);
		}

		const recovery = !this.attachedOperationIds.has(active.operationId);
		const assistantOrphanAtStart =
			initial.current.state.kind === "run" &&
			initial.current.state.phase.kind === "assistant" &&
			initial.current.state.phase.generation.status === "effect_pending";
		const recoveryLifecycle =
			recovery && (!this.resumeEventOperationIds.has(active.operationId) || assistantOrphanAtStart);
		return startHarnessSpan(
			this.telemetryContext,
			"pi.harness.run",
			{
				"pi.session.id": this.sessionStorage.metadata.id,
				"pi.lane.name": lane.name,
				"pi.operation.id": active.operationId,
				"pi.operation.recovery": recoveryLifecycle,
				"pi.operation.kind": "run",
			},
			async (runSpan) => {
				const resultAtRunDeadline = (): DriveResult => {
					const result = resultAtDeadline();
					if (result.ok && result.value.kind === "waiting") {
						runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
					}
					return result;
				};
				if (recovery) {
					if (!this.resumedOperationIds.has(active.operationId)) {
						const resumed = await this.resumeRun(lane, active, initial, options);
						if (!resumed) return resultAtRunDeadline();
						this.resumedOperationIds.add(active.operationId);
					}
					if (deadlineReached(options)) {
						if (!assistantOrphanAtStart) {
							this.attachedOperationIds.add(active.operationId);
							this.restoredSuspensions.delete(lane.name);
						}
						return resultAtRunDeadline();
					}
					const recovered = await this.recoverRunAtActivation(lane, active, runSpan, options);
					if (!recovered) return Result.ok({ kind: "yielded", operationId: active.operationId });
					this.attachedOperationIds.add(active.operationId);
					this.restoredSuspensions.delete(lane.name);
				}
				while (true) {
					const restored = await this.loadExpected(lane.name, active.operationId, true);
					if (restored.current === undefined) {
						const terminal = await this.settledOrMismatch(lane.name, active.operationId, restored);
						if (terminal.ok && terminal.value.kind === "settled" && terminal.value.outcome.operation === "run") {
							const outcome = terminal.value.outcome;
							runSpan.setAttributes({
								"pi.operation.outcome": outcome.kind,
								...(outcome.kind === "failed" ? { "pi.error.code": outcome.error.code } : {}),
							});
							if (outcome.kind === "failed") runSpan.setStatus({ status: "error" });
						}
						return terminal;
					}
					const state = restored.current.state;
					if (state.kind !== "run") throw new SessionInvariantError("Run operation changed state kind");
					if (state.control.status !== "running") {
						throw new RuntimeSliceNotImplemented("drive(cancel_requested)");
					}
					if (state.phase.kind === "assistant" && state.phase.generation.status === "retry_wait") {
						const retry = await this.driveAssistantRetryWait(lane, active, state, runSpan, options);
						if (retry !== "advanced") {
							if (retry.ok && retry.value.kind === "waiting") {
								runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
							}
							return retry;
						}
						continue;
					}
					if (state.phase.kind === "deferred") {
						if (state.phase.deferred.status !== "suspended") {
							throw new RuntimeSliceNotImplemented("drive(deferred.effect_pending)");
						}
						const waiting = await this.waitForDeferred(lane, active, restored, state, recoveryLifecycle);
						runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
						return waiting;
					}
					if (deadlineReached(options)) return Result.ok({ kind: "yielded", operationId: active.operationId });
					if (state.phase.kind === "checkpoint") {
						if (state.phase.continuation.kind === "need_assistant") {
							const advanced = await this.startGeneration(lane, active, state, runSpan, options);
							if (!advanced) return Result.ok({ kind: "yielded", operationId: active.operationId });
							continue;
						}
						const finished = await this.finishRun(lane, active, undefined, options, recoveryLifecycle);
						if (finished === undefined) return Result.ok({ kind: "yielded", operationId: active.operationId });
						runSpan.setAttributes({ "pi.operation.outcome": "completed" });
						return Result.ok({ kind: "settled", operationId: active.operationId, outcome: finished });
					}
					if (state.phase.kind === "assistant") {
						if (state.phase.generation.status !== "ready") {
							throw new SessionInvariantError("Ordinary dispatch reached an unowned assistant effect");
						}
						const result = await this.executeAssistantGeneration(
							lane,
							active,
							restored,
							state,
							runSpan,
							options,
							recoveryLifecycle,
						);
						if (result.kind === "yielded") {
							return Result.ok({ kind: "yielded", operationId: active.operationId });
						}
						if (result.kind === "missing_identities") {
							runSpan.setAttributes({ "pi.operation.outcome": "suspended" });
							return Result.ok({
								kind: "waiting",
								operationId: active.operationId,
								reason: "missing_identities",
								missing: result.missing,
							});
						}
						continue;
					}
					if (state.phase.kind === "failure_drain") {
						const failure = state.phase.error;
						const finished = await startHarnessSpan(
							runSpan,
							"pi.harness.checkpoint",
							{
								"pi.lane.name": lane.name,
								"pi.operation.id": active.operationId,
								"pi.checkpoint.kind": "failure_drain",
							},
							() => this.finishRun(lane, active, failure, options, recoveryLifecycle),
						);
						if (finished === undefined) return Result.ok({ kind: "yielded", operationId: active.operationId });
						runSpan.setAttributes({ "pi.operation.outcome": "failed", "pi.error.code": failure.code });
						runSpan.setStatus({ status: "error" });
						return Result.ok({ kind: "settled", operationId: active.operationId, outcome: finished });
					}
					throw new RuntimeSliceNotImplemented(`drive(run.${state.phase.kind})`);
				}
			},
		);
	}

	private async loadExpected(lane: string, operationId: string, includeLastResult: boolean): Promise<RestoredLane> {
		try {
			return await this.sessionStorage.mutate(lane, async (reader) => {
				const restored = await restoreLane(reader, lane, { includeLastResult });
				const currentId = restored.laneState.currentOperationId;
				if (currentId !== null && currentId !== operationId) {
					throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} changed operation while a drive owns it`);
				}
				return restored;
			});
		} catch (error) {
			if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
			throw this.fault(error);
		}
	}

	private async settledOrMismatch(lane: string, operationId: string, restored: RestoredLane): Promise<DriveResult> {
		if (restored.lastResult?.operationId !== operationId) {
			return Result.err(this.mismatch(lane, operationId, restored));
		}
		try {
			const outcome = await this.sessionStorage.mutate(lane, (reader) =>
				hydrateTerminalOutcome(reader, restored.lastResult!),
			);
			return Result.ok({ kind: "settled", operationId, outcome });
		} catch (error) {
			throw this.fault(error);
		}
	}

	private async resumeRun(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		restored: RestoredLane,
		options: DriveOptions,
	): Promise<boolean> {
		const current = restored.current;
		if (current === undefined || current.operation.intent.kind !== "run") {
			throw new SessionInvariantError("Run resume is missing run metadata");
		}
		if (!this.resumeEventOperationIds.has(active.operationId)) {
			await this.events.emit({ type: "run_resume", runId: active.operationId, lane: lane.name, recovery: true });
			this.resumeEventOperationIds.add(active.operationId);
		}
		if (!this.hooks.has("before_resume")) return true;
		await lane.breakpoint.hit({
			kind: "hook.before_resume",
			description: "Run resume hooks",
			details: { operationId: active.operationId },
		});
		if (deadlineReached(options)) return false;
		const prompt = current.operation.intent.promptEntryIds.map((id) => {
			const entry = current.entries.get(id);
			if (entry?.type !== "message") throw new SessionInvariantError(`Prompt entry ${id} is missing`);
			return entry.message;
		});
		await this.hooks.runBeforeResumeWithGate(
			{
				kind: "run",
				lane: lane.name,
				runId: active.operationId,
				prompt,
				...(current.operation.intent.systemPromptOverride === undefined
					? {}
					: { systemPromptOverride: current.operation.intent.systemPromptOverride }),
			},
			current.operation.intent.resumeData ?? {},
			active.effectGate,
		);
		return true;
	}

	private async recoverRunAtActivation(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		runTelemetry: TelemetryContext,
		options: DriveOptions,
	): Promise<boolean> {
		const restored = await this.loadExpected(lane.name, active.operationId, true);
		const current = restored.current;
		if (current === undefined || current.state.kind !== "run") return true;
		if (current.state.control.status !== "running") return true;
		const phase = current.state.phase;
		if (phase.kind !== "assistant" || phase.generation.status !== "effect_pending") return true;
		const pending = phase.generation;
		const context = pending.context;
		if (pending.attempt < context.retryPolicy.maxAttempts) {
			await lane.breakpoint.hit({
				kind: "assistant.recover_retry",
				description: "Recover an uncertain assistant request with a later attempt",
				details: {
					operationId: active.operationId,
					stepId: context.stepId,
					attempt: pending.attempt,
					nextAttempt: pending.attempt + 1,
				},
			});
			if (deadlineReached(options)) return false;
			try {
				this.assertOpen();
				await this.sessionStorage.mutate(lane.name, async (mutator) => {
					const latest = await restoreLane(mutator, lane.name);
					const state = latest.current?.state;
					if (
						latest.current?.operation.operationId !== active.operationId ||
						state?.kind !== "run" ||
						state.control.status !== "running" ||
						state.phase.kind !== "assistant" ||
						state.phase.generation.status !== "effect_pending" ||
						state.phase.generation.context.stepId !== context.stepId ||
						state.phase.generation.attempt !== pending.attempt ||
						state.phase.generation.responseEntryId !== pending.responseEntryId ||
						state.phase.generation.usageId !== pending.usageId
					) {
						throw new SessionInvariantError("Assistant recovery found another restart point");
					}
					await mutator.commit({
						writes: [
							{
								kind: "register",
								op: "set",
								namespace: "op.state",
								key: active.operationId,
								value: {
									...state,
									phase: {
										kind: "assistant",
										generation: { status: "ready", context, nextAttempt: pending.attempt + 1 },
									},
								},
							},
						],
					});
				});
			} catch (error) {
				if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
				throw this.fault(error);
			}
			return true;
		}

		const resolvedModel = this.models.getModel(
			context.configuration.model.provider,
			context.configuration.model.modelId,
		);
		const error: OperationError = {
			code: "assistant_error",
			message: `Assistant request outcome is unknown after interruption at attempt ${pending.attempt}`,
		};
		const message: SettledAssistantMessage = {
			role: "assistant",
			content: [],
			api: resolvedModel?.api ?? "unknown",
			provider: context.configuration.model.provider,
			model: context.configuration.model.modelId,
			usage: cloneUsage(ZERO_USAGE),
			stopReason: "error",
			errorMessage: error.message,
			timestamp: Date.now(),
		};
		await this.events.emit({
			type: "turn_start",
			runId: active.operationId,
			turnId: context.stepId,
			lane: lane.name,
			recovery: true,
		});
		await this.events.emit({
			type: "message_start",
			runId: active.operationId,
			message,
			lane: lane.name,
			recovery: true,
		});
		await this.events.emit({
			type: "message_end",
			runId: active.operationId,
			message,
			entryId: pending.responseEntryId,
			lane: lane.name,
			recovery: true,
		});
		await lane.breakpoint.hit({
			kind: "assistant.recover_settlement",
			description: "Settle an uncertain final assistant request",
			details: { operationId: active.operationId, stepId: context.stepId, attempt: pending.attempt },
		});
		if (deadlineReached(options)) return false;
		const committed = await startHarnessSpan(
			runTelemetry,
			"pi.harness.turn",
			{
				"pi.lane.name": lane.name,
				"pi.operation.id": active.operationId,
				"pi.turn.id": context.stepId,
			},
			(turnSpan) =>
				startHarnessSpan(
					turnSpan,
					"pi.harness.step",
					{
						"pi.lane.name": lane.name,
						"pi.operation.id": active.operationId,
						"pi.step.kind": "assistant",
						"pi.step.attempt": pending.attempt,
					},
					async (stepSpan) => {
						stepSpan.setAttributes({ "pi.step.outcome": "failed" });
						stepSpan.setStatus({ status: "error" });
						return this.commitSyntheticAssistantRecovery(lane.name, active.operationId, pending, message, error);
					},
				),
		);
		await this.events.emit({ type: "entry_added", entry: committed.entry, lane: lane.name });
		await this.events.emit({ type: "usage", lane: lane.name, row: committed.row, totals: committed.totals });
		await this.events.emit({
			type: "turn_end",
			runId: active.operationId,
			turnId: context.stepId,
			message,
			toolResults: [],
			lane: lane.name,
			recovery: true,
		});
		if (pending.attempt > 1) {
			await this.events.emit({
				type: "retry_end",
				runId: active.operationId,
				step: context.stepId,
				attempt: pending.attempt,
				success: false,
				finalError: error.message,
				lane: lane.name,
				recovery: true,
			});
		}
		return true;
	}

	private async commitSyntheticAssistantRecovery(
		lane: string,
		operationId: string,
		pending: Extract<RunState["phase"], { kind: "assistant" }>["generation"] & { status: "effect_pending" },
		message: SettledAssistantMessage,
		error: OperationError,
	): Promise<Pick<CommittedAssistantSettlement, "entry" | "row" | "totals">> {
		try {
			this.assertOpen();
			const committed = await this.sessionStorage.mutate(lane, async (mutator) => {
				const restored = await restoreLane(mutator, lane);
				const state = restored.current?.state;
				if (
					restored.current?.operation.operationId !== operationId ||
					state?.kind !== "run" ||
					state.control.status !== "running" ||
					state.phase.kind !== "assistant" ||
					state.phase.generation.status !== "effect_pending" ||
					state.phase.generation.context.stepId !== pending.context.stepId ||
					state.phase.generation.attempt !== pending.attempt ||
					state.phase.generation.responseEntryId !== pending.responseEntryId ||
					state.phase.generation.usageId !== pending.usageId
				) {
					throw new SessionInvariantError("Synthetic assistant recovery found another restart point");
				}
				const result = await mutator.commit({
					writes: [
						{
							kind: "entry",
							entry: { id: pending.responseEntryId, parentId: restored.leafId, type: "message", message },
						},
						{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: pending.responseEntryId },
						{
							kind: "usage",
							row: {
								id: pending.usageId,
								usage: message.usage,
								entryId: pending.responseEntryId,
								adjustment: false,
							},
						},
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: operationId,
							value: {
								...state,
								latestAssistantEntryId: pending.responseEntryId,
								phase: {
									kind: "failure_drain",
									error,
									provenance: { kind: "response", entryId: pending.responseEntryId },
								},
							},
						},
					],
				});
				const entry = (await mutator.getEntries([pending.responseEntryId])).get(pending.responseEntryId);
				if (entry === undefined) throw new SessionInvariantError("Synthetic assistant response is missing");
				return {
					entry,
					row: {
						id: pending.usageId,
						seq: result.seqs[2]!,
						usage: message.usage,
						entryId: pending.responseEntryId,
						adjustment: false as const,
					},
				};
			});
			return { ...committed, totals: (await this.sessionStorage.getStats()).usage };
		} catch (caught) {
			if (caught instanceof HarnessClosed || caught instanceof HarnessFault) throw caught;
			throw this.fault(caught);
		}
	}

	private async driveAssistantRetryWait(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		state: RunState,
		runTelemetry: TelemetryContext,
		options: DriveOptions,
	): Promise<"advanced" | DriveResult> {
		if (state.phase.kind !== "assistant" || state.phase.generation.status !== "retry_wait") {
			throw new SessionInvariantError("Assistant retry wait is not current");
		}
		const wait = state.phase.generation;
		const now = Date.now();
		const alreadyDue = now >= wait.notBefore;
		let timerAdmitted = false;
		if (!alreadyDue) {
			if (options.waitForRetry !== true || (options.deadline !== undefined && options.deadline < wait.notBefore)) {
				return Result.ok({
					kind: "waiting",
					operationId: active.operationId,
					reason: "retry",
					notBefore: wait.notBefore,
				});
			}
			await lane.breakpoint.hit({
				kind: "assistant.retry_wait",
				description: "Wait for an assistant retry",
				details: {
					operationId: active.operationId,
					stepId: wait.context.stepId,
					attempt: wait.nextAttempt,
					notBefore: wait.notBefore,
				},
			});
			if (options.deadline !== undefined && options.deadline < wait.notBefore) {
				return Result.ok({
					kind: "waiting",
					operationId: active.operationId,
					reason: "retry",
					notBefore: wait.notBefore,
				});
			}
			if (deadlineReached(options)) {
				return Result.ok({ kind: "yielded", operationId: active.operationId });
			}
			timerAdmitted = await startHarnessSpan(
				runTelemetry,
				"pi.harness.sleep",
				{
					"pi.operation.id": active.operationId,
					"pi.sleep.delay_ms": Math.max(0, wait.notBefore - Date.now()),
				},
				async (sleepSpan) => {
					if (deadlineReached(options)) return false;
					try {
						active.effectGate.assertOpen();
						await waitUntil(wait.notBefore, active.effectGate.signal);
						sleepSpan.setAttributes({ "pi.sleep.outcome": "elapsed" });
						return true;
					} catch (error) {
						sleepSpan.setAttributes({ "pi.sleep.outcome": "aborted" });
						throw error;
					}
				},
			);
			if (!timerAdmitted) return Result.ok({ kind: "yielded", operationId: active.operationId });
		}
		if (!timerAdmitted && deadlineReached(options)) {
			return Result.ok({ kind: "yielded", operationId: active.operationId });
		}
		await lane.breakpoint.hit({
			kind: "assistant.retry_ready",
			description: "Make an assistant retry ready",
			details: {
				operationId: active.operationId,
				stepId: wait.context.stepId,
				attempt: wait.nextAttempt,
			},
		});
		if (!timerAdmitted && deadlineReached(options)) {
			return Result.ok({ kind: "yielded", operationId: active.operationId });
		}
		try {
			this.assertOpen();
			await this.sessionStorage.mutate(lane.name, async (mutator) => {
				const restored = await restoreLane(mutator, lane.name);
				const latest = restored.current?.state;
				if (
					restored.current?.operation.operationId !== active.operationId ||
					latest?.kind !== "run" ||
					latest.control.status !== "running" ||
					latest.phase.kind !== "assistant" ||
					latest.phase.generation.status !== "retry_wait" ||
					latest.phase.generation.context.stepId !== wait.context.stepId ||
					latest.phase.generation.nextAttempt !== wait.nextAttempt ||
					latest.phase.generation.notBefore !== wait.notBefore ||
					latest.phase.generation.errorMessage !== wait.errorMessage
				) {
					throw new SessionInvariantError("Assistant retry found another wait");
				}
				await mutator.commit({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: active.operationId,
							value: {
								...latest,
								phase: {
									kind: "assistant",
									generation: {
										status: "ready",
										context: wait.context,
										nextAttempt: wait.nextAttempt,
									},
								},
							},
						},
					],
				});
			});
		} catch (error) {
			if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
			throw this.fault(error);
		}
		return "advanced";
	}

	private async waitForDeferred(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		restored: RestoredLane,
		state: RunState,
		recovery: boolean,
	): Promise<DriveResult> {
		if (state.phase.kind !== "deferred" || state.phase.deferred.status !== "suspended") {
			throw new SessionInvariantError("Deferred response is not suspended");
		}
		const source = restored.current?.entries.get(state.phase.deferred.sourceEntryId);
		if (source?.type !== "message" || source.message.role !== "assistant" || source.message.deferred === undefined) {
			throw new SessionInvariantError("Deferred source response is invalid");
		}
		const descriptor: SuspendedOperation = {
			...this.suspensionBase(restored),
			reason: "deferred",
			deferred: source.message.deferred,
		};
		this.restoredSuspensions.set(lane.name, descriptor);
		await this.events.emit({
			type: "run_suspend",
			runId: active.operationId,
			reason: "deferred",
			deferred: source.message.deferred,
			lane: lane.name,
			...(recovery ? { recovery: true as const } : {}),
		});
		return Result.ok({
			kind: "waiting",
			operationId: active.operationId,
			reason: "deferred",
			deferred: source.message.deferred,
		});
	}

	private async startGeneration(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		state: RunState,
		runTelemetry: TelemetryContext,
		options: DriveOptions,
	): Promise<boolean> {
		if (state.phase.kind !== "checkpoint" || state.phase.continuation.kind !== "need_assistant") {
			throw new SessionInvariantError("Generation start is not at a need-assistant checkpoint");
		}
		const expectedTriggerEntryId = state.phase.triggerEntryId;
		const settings = await this.snapshotSettings();
		await lane.breakpoint.hit({
			kind: "run.generation_ready",
			description: "Prepare an assistant generation",
			details: { operationId: active.operationId },
		});
		if (deadlineReached(options)) return false;
		const stepId = this.sessionStorage.idGenerator.next();
		await startHarnessSpan(
			runTelemetry,
			"pi.harness.checkpoint",
			{
				"pi.lane.name": lane.name,
				"pi.operation.id": active.operationId,
				"pi.checkpoint.kind": "normal",
			},
			async () => {
				try {
					this.assertOpen();
					await this.sessionStorage.mutate(lane.name, async (mutator) => {
						const restored = await restoreLane(mutator, lane.name);
						const current = restored.current;
						if (
							current === undefined ||
							current.operation.operationId !== active.operationId ||
							current.state.kind !== "run"
						) {
							throw new SessionInvariantError("Generation start lost run ownership");
						}
						const latest = current.state;
						if (
							latest.phase.kind !== "checkpoint" ||
							latest.phase.continuation.kind !== "need_assistant" ||
							latest.phase.triggerEntryId !== expectedTriggerEntryId ||
							latest.control.status !== "running"
						) {
							throw new SessionInvariantError("Generation start found another run phase");
						}
						const context = {
							stepId,
							triggerEntryId: latest.phase.triggerEntryId,
							configuration: cloneConfiguration(restored.configuration),
							streamOptions: { ...settings.streamOptions },
							retryPolicy: normalizeRetryPolicy(settings.retryPolicy),
							overflowRecoveryUsed: latest.phase.continuation.overflowRecoveryUsed,
						};
						await mutator.commit({
							writes: [
								{
									kind: "register",
									op: "set",
									namespace: "op.state",
									key: active.operationId,
									value: {
										...latest,
										phase: { kind: "assistant", generation: { status: "ready", context, nextAttempt: 1 } },
									},
								},
							],
						});
					});
				} catch (error) {
					if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
					throw this.fault(error);
				}
			},
		);
		return true;
	}

	private async executeAssistantGeneration(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		restored: RestoredLane,
		state: RunState,
		runTelemetry: TelemetryContext,
		options: DriveOptions,
		recovery: boolean,
	): Promise<AssistantExecutionResult> {
		if (state.phase.kind !== "assistant" || state.phase.generation.status !== "ready") {
			throw new SessionInvariantError("Assistant generation is not ready");
		}
		const ready = state.phase.generation;
		const context = ready.context;
		const settings = await this.snapshotSettings();
		const missing = this.missingIdentities(context.configuration, settings);
		if (missing.tools.length !== 0 || missing.models.length !== 0) {
			const descriptor: SuspendedOperation = {
				...this.suspensionBase(restored),
				reason: "missing_identities",
				missing,
			};
			this.restoredSuspensions.set(lane.name, descriptor);
			await this.events.emit({
				type: "run_suspend",
				runId: active.operationId,
				reason: "missing_identities",
				missing,
				lane: lane.name,
				...(recovery ? { recovery: true as const } : {}),
			});
			return { kind: "missing_identities", missing };
		}
		this.restoredSuspensions.delete(lane.name);
		const model = this.models.getModel(context.configuration.model.provider, context.configuration.model.modelId);
		const providerRegistration = this.models.getProvider(context.configuration.model.provider);
		if (model === undefined || providerRegistration === undefined) {
			throw new SessionInvariantError("Assistant model disappeared during identity preflight");
		}

		let streamOptions = { ...context.streamOptions };
		if (this.hooks.has("before_request")) {
			await lane.breakpoint.hit({
				kind: "hook.before_request",
				description: "Transform assistant request options",
				details: { operationId: active.operationId, attempt: ready.nextAttempt },
			});
			if (deadlineReached(options)) return { kind: "yielded" };
			const result = await this.hooks.runWithGate(
				"before_request",
				{
					lane: lane.name,
					runId: active.operationId,
					model,
					step: "assistant",
					attempt: ready.nextAttempt,
					streamOptions,
				},
				active.effectGate,
			);
			if (result?.streamOptions !== undefined) {
				streamOptions = applyStreamOptionsPatch(streamOptions, result.streamOptions);
			}
			if (deadlineReached(options)) return { kind: "yielded" };
		}
		const operation = restored.current?.operation;
		if (operation?.intent.kind !== "run")
			throw new SessionInvariantError("Assistant generation is missing run metadata");
		const systemPrompt = operation.intent.systemPromptOverride ?? (await this.resolveSystemPrompt());
		const responseEntryId = this.sessionStorage.idGenerator.next();
		const usageId = this.sessionStorage.idGenerator.next();
		await lane.breakpoint.hit({
			kind: "assistant.intent",
			description: "Commit assistant request intent",
			details: { operationId: active.operationId, stepId: context.stepId, attempt: ready.nextAttempt },
		});
		if (deadlineReached(options)) return { kind: "yielded" };
		try {
			this.assertOpen();
			await this.sessionStorage.mutate(lane.name, async (mutator) => {
				const latest = await restoreLane(mutator, lane.name);
				const current = latest.current;
				if (
					current === undefined ||
					current.operation.operationId !== active.operationId ||
					current.state.kind !== "run"
				) {
					throw new SessionInvariantError("Assistant intent lost run ownership");
				}
				const phase = current.state.phase;
				if (
					phase.kind !== "assistant" ||
					phase.generation.status !== "ready" ||
					phase.generation.context.stepId !== context.stepId ||
					phase.generation.nextAttempt !== ready.nextAttempt
				) {
					throw new SessionInvariantError("Assistant intent found another restart point");
				}
				await mutator.commit({
					writes: [
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: active.operationId,
							value: {
								...current.state,
								phase: {
									kind: "assistant",
									generation: {
										status: "effect_pending",
										context,
										attempt: ready.nextAttempt,
										responseEntryId,
										usageId,
										intendedOutputLimit: model.maxTokens,
										contextWindow: model.contextWindow,
									},
								},
							},
						},
					],
				});
			});
		} catch (error) {
			if (error instanceof HarnessClosed || error instanceof HarnessFault) throw error;
			throw this.fault(error);
		}
		if (ready.nextAttempt > 1) {
			await this.events.emit({
				type: "retry_start",
				runId: active.operationId,
				step: context.stepId,
				attempt: ready.nextAttempt,
				lane: lane.name,
				...(recovery ? { recovery: true as const } : {}),
			});
		}

		const newestFirst = await lane.session.findEntriesOnBranch({ order: "newestFirst", stopAtType: "compaction" });
		const messages = await buildSessionContext([...newestFirst].reverse(), { entryProjectors: this.entryProjectors });
		await this.events.emit({
			type: "turn_start",
			runId: active.operationId,
			turnId: context.stepId,
			lane: lane.name,
			...(recovery ? { recovery: true as const } : {}),
		});
		const providerTools = context.configuration.activeToolNames.map(
			(name) => settings.tools.find((tool) => tool.name === name)! as unknown as AgentTool,
		);
		const message = await startHarnessSpan(
			runTelemetry,
			"pi.harness.turn",
			{
				"pi.lane.name": lane.name,
				"pi.operation.id": active.operationId,
				"pi.turn.id": context.stepId,
			},
			(turnSpan) =>
				startHarnessSpan(
					turnSpan,
					"pi.harness.step",
					{
						"pi.lane.name": lane.name,
						"pi.operation.id": active.operationId,
						"pi.step.kind": "assistant",
						"pi.step.attempt": ready.nextAttempt,
					},
					async (stepSpan) => {
						const settled = await streamHarnessAssistant(messages, {
							model,
							...(systemPrompt === undefined ? {} : { systemPrompt }),
							...(providerTools.length === 0 ? {} : { tools: providerTools }),
							thinkingLevel: context.configuration.thinkingLevel,
							streamOptions,
							transformContext: this.hooks.has("transform_context")
								? async (input) => {
										await lane.breakpoint.hit({
											kind: "hook.transform_context",
											description: "Transform assistant context",
											details: { operationId: active.operationId, stepId: context.stepId },
										});
										const result = await this.hooks.runWithGate(
											"transform_context",
											{ lane: lane.name, runId: active.operationId, messages: input },
											active.effectGate,
										);
										return result?.messages ?? input;
									}
								: undefined,
							toProviderMessages: this.toProviderMessages,
							beforePayload: this.hooks.has("before_payload")
								? async (payload, requestModel) => {
										await lane.breakpoint.hit({
											kind: "hook.before_payload",
											description: "Transform provider payload",
											details: { operationId: active.operationId, stepId: context.stepId },
										});
										return (
											await this.hooks.runWithGate(
												"before_payload",
												{ lane: lane.name, runId: active.operationId, model: requestModel, payload },
												active.effectGate,
											)
										)?.payload;
									}
								: undefined,
							afterResponse: async (settledMessage, metadata) => {
								let transformed = settledMessage;
								if (this.hooks.has("after_response")) {
									await lane.breakpoint.hit({
										kind: "hook.after_response",
										description: "Transform assistant response",
										details: { operationId: active.operationId, stepId: context.stepId },
									});
									const result = await this.hooks.runWithGate(
										"after_response",
										{
											lane: lane.name,
											runId: active.operationId,
											...metadata,
											message: transformed,
										},
										active.effectGate,
									);
									transformed = result?.message ?? transformed;
								}
								return normalizeInvalidDeferredResponse(transformed, context.configuration, model.api);
							},

							request: async (
								providerContext: Context,
								providerOptions: SimpleStreamOptions,
							): Promise<AssistantMessageEventStream> => {
								await lane.breakpoint.hit({
									kind: "assistant.request",
									description: "Request assistant response",
									details: {
										operationId: active.operationId,
										stepId: context.stepId,
										attempt: ready.nextAttempt,
									},
								});
								const requestModel = this.models.getModel(
									context.configuration.model.provider,
									context.configuration.model.modelId,
								);
								const requestProvider = this.models.getProvider(context.configuration.model.provider);
								if (requestModel !== model || requestProvider !== providerRegistration) {
									active.effectGate.assertOpen();
									return createMissingModelStream(model);
								}
								active.effectGate.assertOpen();
								return this.models.streamSimple(requestModel, providerContext, providerOptions);
							},
							observer: {
								start: (draft) =>
									this.events.emit({
										type: "message_start",
										runId: active.operationId,
										message: draft,
										lane: lane.name,
										...(recovery ? { recovery: true as const } : {}),
									}),
								update: (draft, event) =>
									this.events.emit({
										type: "message_update",
										runId: active.operationId,
										message: draft,
										event,
										lane: lane.name,
										...(recovery ? { recovery: true as const } : {}),
									}),
								end: (finalMessage) =>
									this.events.emit({
										type: "message_end",
										runId: active.operationId,
										message: finalMessage,
										entryId: responseEntryId,
										lane: lane.name,
										...(recovery ? { recovery: true as const } : {}),
									}),
							},
							telemetryContext: stepSpan,
							signal: active.effectGate.signal,
						});
						const outcome = predictAssistantStepOutcome(settled, ready.nextAttempt, context, model.api);
						stepSpan.setAttributes({ "pi.step.outcome": outcome });
						if (outcome === "retry" || outcome === "failed") stepSpan.setStatus({ status: "error" });
						return settled;
					},
				),
		);
		if (message.role !== "assistant") {
			throw this.fault(new SessionInvariantError("after_response returned an invalid assistant message"));
		}
		this.assertOpen();
		await lane.breakpoint.hit({
			kind: "assistant.settlement",
			description: "Commit assistant response",
			details: { operationId: active.operationId, stepId: context.stepId, attempt: ready.nextAttempt },
		});
		const settled = await this.commitAssistantSettlement(
			lane.name,
			active.operationId,
			context.stepId,
			responseEntryId,
			usageId,
			model.api,
			message,
		);
		await this.events.emit({ type: "entry_added", entry: settled.entry, lane: lane.name });
		await this.events.emit({ type: "usage", lane: lane.name, row: settled.row, totals: settled.totals });
		await this.events.emit({
			type: "turn_end",
			runId: active.operationId,
			turnId: context.stepId,
			message: settled.message,
			toolResults: [],
			lane: lane.name,
			...(recovery ? { recovery: true as const } : {}),
		});
		if (settled.outcome.kind === "retry") {
			await this.events.emit({
				type: "retry_scheduled",
				runId: active.operationId,
				step: context.stepId,
				attempt: settled.outcome.nextAttempt,
				maxAttempts: context.retryPolicy.maxAttempts,
				delayMs: settled.outcome.delayMs,
				errorMessage: settled.outcome.errorMessage,
				lane: lane.name,
				...(recovery ? { recovery: true as const } : {}),
			});
		} else if (ready.nextAttempt > 1) {
			const success = settled.outcome.kind === "completed" || settled.outcome.kind === "deferred";
			await this.events.emit({
				type: "retry_end",
				runId: active.operationId,
				step: context.stepId,
				attempt: ready.nextAttempt,
				success,
				...(success || settled.outcome.kind !== "failed" ? {} : { finalError: settled.outcome.error.message }),
				lane: lane.name,
				...(recovery ? { recovery: true as const } : {}),
			});
		}
		return { kind: "advanced" };
	}

	private async commitAssistantSettlement(
		lane: string,
		operationId: string,
		stepId: string,
		responseEntryId: string,
		usageId: string,
		requestApi: Api,
		message: SettledAssistantMessage,
	): Promise<CommittedAssistantSettlement> {
		try {
			this.assertOpen();
			const committed = await this.sessionStorage.mutate(lane, async (mutator) => {
				const restored = await restoreLane(mutator, lane);
				const current = restored.current;
				if (
					current === undefined ||
					current.operation.operationId !== operationId ||
					current.state.kind !== "run"
				) {
					throw new SessionInvariantError("Assistant settlement lost run ownership");
				}
				const phase = current.state.phase;
				if (
					phase.kind !== "assistant" ||
					phase.generation.status !== "effect_pending" ||
					phase.generation.context.stepId !== stepId ||
					phase.generation.responseEntryId !== responseEntryId ||
					phase.generation.usageId !== usageId
				) {
					throw new SessionInvariantError("Assistant settlement found another pending request");
				}
				const decision = classifyAssistantSettlement(
					message,
					phase.generation,
					current.state.control.status,
					responseEntryId,
					requestApi,
					Date.now(),
				);
				const result = await mutator.commit({
					writes: [
						{
							kind: "entry",
							entry: {
								id: responseEntryId,
								parentId: restored.leafId,
								type: "message",
								message: decision.message,
							},
						},
						{ kind: "register", op: "set", namespace: "lane.leaf", key: lane, value: responseEntryId },
						{
							kind: "usage",
							row: {
								id: usageId,
								usage: decision.message.usage,
								entryId: responseEntryId,
								adjustment: false,
							},
						},
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: operationId,
							value: {
								...current.state,
								latestAssistantEntryId: responseEntryId,
								phase: decision.phase,
							},
						},
					],
				});
				const entry = (await mutator.getEntries([responseEntryId])).get(responseEntryId);
				if (entry === undefined) throw new SessionInvariantError("Committed assistant response is missing");
				return {
					entry,
					message: decision.message,
					outcome: decision.outcome,
					row: {
						id: usageId,
						seq: result.seqs[2]!,
						usage: decision.message.usage,
						entryId: responseEntryId,
						adjustment: false as const,
					},
				};
			});
			return { ...committed, totals: (await this.sessionStorage.getStats()).usage };
		} catch (error) {
			if (
				error instanceof RuntimeSliceNotImplemented ||
				error instanceof HarnessClosed ||
				error instanceof HarnessFault
			) {
				throw error;
			}
			throw this.fault(error);
		}
	}

	private async finishRun(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		error: OperationError | undefined,
		options: DriveOptions,
		recovery: boolean,
	): Promise<TerminalOperationOutcome | undefined> {
		await lane.breakpoint.hit({
			kind: "run.finish",
			description: "Finish the run",
			details: { operationId: active.operationId, outcome: error === undefined ? "completed" : "failed" },
		});
		if (deadlineReached(options)) return undefined;
		try {
			this.assertOpen();
			const lastResult = await this.sessionStorage.mutate(lane.name, async (mutator) => {
				const restored = await restoreLane(mutator, lane.name);
				const current = restored.current;
				if (
					current === undefined ||
					current.operation.operationId !== active.operationId ||
					current.state.kind !== "run"
				) {
					throw new SessionInvariantError("Run finish lost operation ownership");
				}
				if (
					current.state.inbox.steer.length !== 0 ||
					current.state.inbox.followUp.length !== 0 ||
					current.state.inbox.writes.length !== 0
				) {
					throw new RuntimeSliceNotImplemented("finish(run with queued input)");
				}
				if (error === undefined) {
					if (
						current.state.phase.kind !== "checkpoint" ||
						current.state.phase.continuation.kind !== "may_finish"
					) {
						throw new SessionInvariantError("Completed run is not at a finish checkpoint");
					}
				} else if (current.state.phase.kind !== "failure_drain") {
					throw new SessionInvariantError("Failed run is not at failure drain");
				}
				if (restored.leafId === null) throw new SessionInvariantError("Run cannot finish at the root");
				const finalAssistantEntryId = current.state.latestAssistantEntryId ?? undefined;
				const result: LaneLastResult =
					error === undefined
						? {
								operationId: active.operationId,
								kind: "run",
								outcome: "completed",
								leafId: restored.leafId,
								runCompletion: "assistant",
								...(finalAssistantEntryId === undefined ? {} : { finalAssistantEntryId }),
							}
						: {
								operationId: active.operationId,
								kind: "run",
								outcome: "failed",
								leafId: restored.leafId,
								error,
								...(finalAssistantEntryId === undefined ? {} : { finalAssistantEntryId }),
							};
				const [toolArgs, preparations] = await Promise.all([
					mutator.listRegisters("op.tool_args", `${active.operationId}:`),
					mutator.listRegisters("op.preparation", `${active.operationId}:`),
				]);
				const pendingIds = [
					...current.state.inbox.steer,
					...current.state.inbox.followUp,
					...current.state.inbox.writes,
					...(current.state.control.status === "cancel_requested"
						? [...current.state.control.drainedSteer, ...current.state.control.drainedFollowUp]
						: []),
				];
				await mutator.commit({
					writes: [
						{ kind: "register", op: "delete", namespace: "op.meta", key: active.operationId },
						{ kind: "register", op: "delete", namespace: "op.state", key: active.operationId },
						...toolArgs.map(
							(register) =>
								({ kind: "register", op: "delete", namespace: "op.tool_args", key: register.key }) as const,
						),
						...preparations.map(
							(register) =>
								({ kind: "register", op: "delete", namespace: "op.preparation", key: register.key }) as const,
						),
						...pendingIds.map(
							(id) => ({ kind: "register", op: "delete", namespace: "pending.entry", key: id }) as const,
						),
						{ kind: "register", op: "set", namespace: "lane.lastResult", key: lane.name, value: result },
						{
							kind: "register",
							op: "set",
							namespace: "lane.state",
							key: lane.name,
							value: { ...restored.laneState, currentOperationId: null },
						},
					],
				});
				return result;
			});
			const outcome = await this.sessionStorage.mutate(lane.name, (reader) =>
				hydrateTerminalOutcome(reader, lastResult),
			);
			if (outcome.operation !== "run")
				throw new SessionInvariantError("Run terminal result hydrated as another kind");
			this.attachedOperationIds.delete(active.operationId);
			this.resumedOperationIds.delete(active.operationId);
			this.resumeEventOperationIds.delete(active.operationId);
			this.restoredSuspensions.delete(lane.name);
			const finalFields =
				outcome.finalEntryId === undefined
					? {}
					: { finalEntryId: outcome.finalEntryId, finalMessage: outcome.finalMessage };
			if (outcome.kind === "failed") {
				await this.events.emit({
					type: "run_end",
					runId: active.operationId,
					outcome: "failed",
					leafId: outcome.leafId,
					error: outcome.error,
					...finalFields,
					lane: lane.name,
					...(recovery ? { recovery: true as const } : {}),
				});
			} else {
				await this.events.emit({
					type: "run_end",
					runId: active.operationId,
					outcome: outcome.kind,
					leafId: outcome.leafId,
					...finalFields,
					lane: lane.name,
					...(recovery ? { recovery: true as const } : {}),
				});
			}
			return outcome;
		} catch (caught) {
			if (
				caught instanceof RuntimeSliceNotImplemented ||
				caught instanceof HarnessClosed ||
				caught instanceof HarnessFault
			)
				throw caught;
			throw this.fault(caught);
		}
	}

	private async removeActiveOperation(lane: string, active: ActiveOperation): Promise<void> {
		if (this.state === "open") {
			await this.sessionStorage.mutate(lane, () => {
				if (this.activeOperations.get(lane) === active) this.activeOperations.delete(lane);
			});
			return;
		}
		if (this.activeOperations.get(lane) === active) this.activeOperations.delete(lane);
	}

	private currentInfo(lane: string, restored: RestoredLane): CurrentOperationInfo | null {
		const current = restored.current;
		if (current === undefined) return null;
		const active = this.activeOperations.get(lane);
		if (active !== undefined && active.operationId !== current.operation.operationId) {
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} has a task for another operation`);
		}
		const status =
			current.state.control.status === "cancel_requested"
				? "aborting"
				: active?.operationId === current.operation.operationId
					? "running"
					: "suspended";
		const suspended = status === "suspended" ? this.suspensionForInspection(restored) : undefined;
		return {
			id: current.operation.operationId,
			kind: current.state.kind,
			status,
			startedAt: current.operation.startedAt,
			...(suspended === undefined ? {} : { suspended }),
		};
	}

	private suspensionForInspection(restored: RestoredLane): SuspendedOperation | undefined {
		const remembered = this.restoredSuspensions.get(restored.lane);
		return remembered?.operationId === restored.current?.operation.operationId ? remembered : undefined;
	}

	private mismatch(lane: string, expectedOperationId: string, restored: RestoredLane): OperationMismatch {
		const currentOperationId = restored.laneState.currentOperationId ?? undefined;
		const lastOperationId = restored.lastResult?.operationId;
		return new OperationMismatch({
			lane,
			expectedOperationId,
			...(currentOperationId === undefined ? {} : { currentOperationId }),
			...(lastOperationId === undefined ? {} : { lastOperationId }),
			message: `Operation ${expectedOperationId} does not own lane ${JSON.stringify(lane)}`,
		});
	}

	private async readSettings<T>(read: (settings: RuntimeSettings<TContext>) => T): Promise<T> {
		this.assertOpen();
		return this.settingsLine.run("settings", () => read(this.settings));
	}

	private async writeSettings(
		update: (settings: RuntimeSettings<TContext>) => RuntimeSettings<TContext>,
		event: Extract<HarnessEvent, { type: "config_update" }>,
	): Promise<void> {
		this.assertOpen();
		await this.settingsLine.run("settings", () => {
			this.settings = update(this.settings);
			this.settingsRevision++;
		});
		await this.events.emit(event);
	}
}

class AgentLaneRuntime<TContext extends object | undefined> implements AgentLane {
	readonly name: string;
	readonly session: SessionTree;
	readonly breakpoint: BreakpointBarrier;
	private readonly harness: AgentHarnessRuntime<TContext>;

	constructor(harness: AgentHarnessRuntime<TContext>, name: string) {
		this.harness = harness;
		this.name = name;
		this.session = harness.createPublicSessionView(name);
		this.breakpoint = new BreakpointBarrier(harness.driveMode);
	}

	async getLeafId(): Promise<string | null> {
		this.harness.assertOpen();
		return this.session.getLeafId();
	}

	async getLastResult(): Promise<LaneLastResult | undefined> {
		this.harness.assertOpen();
		return (await this.harness.sessionStorage.getRegister("lane.lastResult", this.name))?.value;
	}

	accept(request: OperationRequest): Promise<OperationAdmissionResult> {
		return this.harness.acceptLane(this, request);
	}

	drive(options: DriveOptions): Promise<DriveResult> {
		return this.harness.driveLane(this, options);
	}

	requestAbort(_operationId: string): Promise<AbortRequestResult> {
		return this.unimplementedResult("requestAbort");
	}

	inspectExecution(): Promise<LaneExecutionInfo> {
		return this.harness.inspectLane(this);
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
		const { previous, value } = await this.harness.updateLaneConfiguration(this.name, (configuration) => ({
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
		const { previous } = await this.harness.updateLaneConfiguration(this.name, (configuration) => ({
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
		const { previous } = await this.harness.updateLaneConfiguration(this.name, (configuration) => ({
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

function classifyAssistantSettlement(
	message: SettledAssistantMessage,
	pending: Extract<RunState["phase"], { kind: "assistant" }>["generation"] & { status: "effect_pending" },
	controlStatus: RunState["control"]["status"],
	responseEntryId: string,
	requestApi: Api,
	now: number,
): AssistantSettlementDecision {
	if (controlStatus === "cancel_requested") {
		const normalized: SettledAssistantMessage = {
			...message,
			stopReason: "aborted",
			errorMessage: message.errorMessage ?? "Assistant request was cancelled",
		};
		return {
			message: normalized,
			phase: {
				kind: "checkpoint",
				continuation: { kind: "may_finish", includeFinalAssistant: true },
				triggerEntryId: responseEntryId,
			},
			outcome: { kind: "aborted" },
		};
	}
	if (message.stopReason === "aborted") {
		throw new SessionInvariantError("Assistant response is aborted without durable cancellation");
	}
	if (isContextOverflow(message, pending.contextWindow) || isRecoverableLength(message, pending.intendedOutputLimit)) {
		throw new RuntimeSliceNotImplemented("assistant settlement(overflow)");
	}
	if (message.stopReason === "deferred") {
		const normalized = normalizeInvalidDeferredResponse(message, pending.context.configuration, requestApi);
		if (normalized.stopReason === "deferred" && normalized.deferred !== undefined) {
			return {
				message: normalized,
				phase: {
					kind: "deferred",
					deferred: {
						status: "suspended",
						stepId: pending.context.stepId,
						sourceEntryId: responseEntryId,
						poll: 0,
						configuration: cloneConfiguration(pending.context.configuration),
						streamOptions: { ...pending.context.streamOptions },
					},
				},
				outcome: { kind: "deferred", handle: normalized.deferred },
			};
		}
		const errorMessage = normalized.errorMessage ?? "Invalid deferred response handle for the captured model";
		const error = { code: "assistant_error", message: errorMessage };
		return {
			message: normalized,
			phase: { kind: "failure_drain", error, provenance: { kind: "response", entryId: responseEntryId } },
			outcome: { kind: "failed", error },
		};
	}
	if (message.stopReason === "error") {
		const errorMessage = message.errorMessage ?? "Assistant request failed";
		if (pending.attempt < pending.context.retryPolicy.maxAttempts && isRetryableAssistantError(message)) {
			const delayMs = calculateRetryDelay(pending.context.retryPolicy.baseDelayMs, pending.attempt);
			const notBefore = saturatingAdd(now, delayMs);
			return {
				message,
				phase: {
					kind: "assistant",
					generation: {
						status: "retry_wait",
						context: pending.context,
						nextAttempt: pending.attempt + 1,
						notBefore,
						errorMessage,
					},
				},
				outcome: { kind: "retry", nextAttempt: pending.attempt + 1, delayMs, notBefore, errorMessage },
			};
		}
		const error = { code: "assistant_error", message: errorMessage };
		return {
			message,
			phase: { kind: "failure_drain", error, provenance: { kind: "response", entryId: responseEntryId } },
			outcome: { kind: "failed", error },
		};
	}
	if (message.stopReason === "toolUse" || message.content.some((block) => block.type === "toolCall")) {
		throw new RuntimeSliceNotImplemented("assistant settlement(toolUse)");
	}
	return {
		message,
		phase: {
			kind: "checkpoint",
			continuation: { kind: "may_finish", includeFinalAssistant: true },
			triggerEntryId: responseEntryId,
		},
		outcome: { kind: "completed" },
	};
}

function normalizeInvalidDeferredResponse(
	message: SettledAssistantMessage,
	configuration: LaneConfiguration,
	requestApi: Api,
): SettledAssistantMessage {
	if (message.stopReason !== "deferred") return message;
	const handle = message.deferred;
	if (
		handle !== undefined &&
		handle.id.length !== 0 &&
		handle.provider === configuration.model.provider &&
		handle.modelId === configuration.model.modelId &&
		handle.api === requestApi
	) {
		return message;
	}
	const { deferred: _invalidHandle, ...rest } = message;
	return {
		...rest,
		stopReason: "error",
		errorMessage: "Invalid deferred response handle for the captured model",
	};
}

function predictAssistantStepOutcome(
	message: SettledAssistantMessage,
	attempt: number,
	context: Extract<RunState["phase"], { kind: "assistant" }>["generation"]["context"],
	requestApi: Api,
): "succeeded" | "retry" | "failed" | "aborted" | "deferred" {
	if (message.stopReason === "stop" || message.stopReason === "length") return "succeeded";
	if (message.stopReason === "deferred") {
		return normalizeInvalidDeferredResponse(message, context.configuration, requestApi).stopReason === "deferred"
			? "deferred"
			: "failed";
	}
	if (message.stopReason === "aborted") return "aborted";
	if (
		message.stopReason === "error" &&
		attempt < context.retryPolicy.maxAttempts &&
		isRetryableAssistantError(message)
	) {
		return "retry";
	}
	return "failed";
}

function calculateRetryDelay(baseDelayMs: number, failedAttempt: number): number {
	if (baseDelayMs === 0) return 0;
	const exponent = failedAttempt - 1;
	if (exponent >= 53) return Number.MAX_SAFE_INTEGER;
	const multiplier = 2 ** exponent;
	return baseDelayMs > Number.MAX_SAFE_INTEGER / multiplier ? Number.MAX_SAFE_INTEGER : baseDelayMs * multiplier;
}

function saturatingAdd(left: number, right: number): number {
	return left >= Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}

function waitUntil(notBefore: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(signal.reason instanceof Error ? signal.reason : new Error("Retry wait was aborted"));
		};
		const schedule = () => {
			if (signal.aborted) {
				onAbort();
				return;
			}
			const remaining = notBefore - Date.now();
			if (remaining <= 0) {
				cleanup();
				resolve();
				return;
			}
			timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		schedule();
	});
}

function cloneUsage(usage: Usage): Usage {
	return { ...usage, cost: { ...usage.cost } };
}

function cloneConfiguration(configuration: LaneConfiguration): LaneConfiguration {
	return { ...configuration, model: { ...configuration.model }, activeToolNames: [...configuration.activeToolNames] };
}

function validateRetryPolicy(policy: RetryPolicy): void {
	if (
		!Number.isSafeInteger(policy.maxRetries) ||
		policy.maxRetries < 0 ||
		policy.maxRetries === Number.MAX_SAFE_INTEGER ||
		!Number.isSafeInteger(policy.baseDelayMs) ||
		policy.baseDelayMs < 0
	) {
		throw new RangeError("Retry policy values must be finite non-negative safe integers");
	}
}

function validateCompactionSettings(settings: CompactionSettings): void {
	if (
		!Number.isSafeInteger(settings.reserveTokens) ||
		settings.reserveTokens < 0 ||
		!Number.isSafeInteger(settings.keepRecentTokens) ||
		settings.keepRecentTokens < 0
	) {
		throw new RangeError("Compaction token counts must be finite non-negative safe integers");
	}
}

function deadlineReached(options: DriveOptions): boolean {
	return options.deadline !== undefined && Date.now() >= options.deadline;
}

function normalizeRetryPolicy(policy: RetryPolicy): { maxAttempts: number; baseDelayMs: number } {
	return { maxAttempts: policy.enabled ? policy.maxRetries + 1 : 1, baseDelayMs: policy.baseDelayMs };
}

function isPendingAssistant(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "pending";
}

function createMissingModelStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: `Model is no longer available: ${model.provider}/${model.id}`,
		timestamp: Date.now(),
	};
	stream.push({ type: "error", reason: "error", error: message });
	stream.end(message);
	return stream;
}

async function hydrateTerminalOutcome(
	reader: Pick<SessionMutator, "getEntries">,
	lastResult: LaneLastResult,
): Promise<TerminalOperationOutcome> {
	const referencedIds = [
		...(lastResult.leafId === null ? [] : [lastResult.leafId]),
		...(lastResult.kind === "run" && lastResult.finalAssistantEntryId !== undefined
			? [lastResult.finalAssistantEntryId]
			: []),
		...(lastResult.kind === "navigation" &&
		lastResult.outcome === "completed" &&
		lastResult.summaryEntryId !== undefined
			? [lastResult.summaryEntryId]
			: []),
	];
	const entries = await reader.getEntries([...new Set(referencedIds)]);
	if (lastResult.leafId !== null && !entries.has(lastResult.leafId)) {
		throw new SessionInvariantError(`Terminal leaf ${lastResult.leafId} is missing`);
	}
	if (lastResult.kind === "run") {
		const final =
			lastResult.finalAssistantEntryId === undefined ? undefined : entries.get(lastResult.finalAssistantEntryId);
		if (lastResult.finalAssistantEntryId !== undefined && final === undefined) {
			throw new SessionInvariantError(`Final assistant ${lastResult.finalAssistantEntryId} is missing`);
		}
		if (final !== undefined && (final.type !== "message" || final.message.role !== "assistant")) {
			throw new SessionInvariantError(`Final assistant ${lastResult.finalAssistantEntryId} is invalid`);
		}
		const finalMessage = final?.message as AssistantMessage | undefined;
		if (lastResult.outcome === "completed" && lastResult.runCompletion === "assistant") {
			if (final === undefined || finalMessage === undefined) {
				throw new SessionInvariantError("Completed assistant run has no final assistant");
			}
			if (lastResult.finalAssistantEntryId !== lastResult.leafId) {
				throw new SessionInvariantError("Completed assistant run final entry is not its leaf");
			}
			if (finalMessage.stopReason !== "stop" && finalMessage.stopReason !== "length") {
				throw new SessionInvariantError("Completed assistant run has an invalid stop reason");
			}
		}
		const finalFields =
			final === undefined || finalMessage === undefined ? {} : { finalEntryId: final.id, finalMessage };
		if (lastResult.outcome === "failed") {
			return {
				operation: "run",
				runId: lastResult.operationId,
				kind: "failed",
				leafId: lastResult.leafId,
				error: lastResult.error,
				...finalFields,
			};
		}
		return {
			operation: "run",
			runId: lastResult.operationId,
			kind: lastResult.outcome,
			leafId: lastResult.leafId,
			...finalFields,
		};
	}
	if (lastResult.kind === "compaction") {
		if (lastResult.outcome === "completed") {
			const entry = entries.get(lastResult.leafId);
			if (entry?.type !== "compaction") throw new SessionInvariantError("Completed compaction leaf is invalid");
			return {
				operation: "compaction",
				runId: lastResult.operationId,
				kind: "completed",
				leafId: lastResult.leafId,
				entry,
			};
		}
		if (lastResult.outcome === "failed") {
			return {
				operation: "compaction",
				runId: lastResult.operationId,
				kind: "failed",
				leafId: lastResult.leafId,
				error: lastResult.error,
			};
		}
		return {
			operation: "compaction",
			runId: lastResult.operationId,
			kind: lastResult.outcome,
			leafId: lastResult.leafId,
		};
	}
	if (lastResult.outcome === "completed") {
		const summary = lastResult.summaryEntryId === undefined ? undefined : entries.get(lastResult.summaryEntryId);
		if (lastResult.summaryEntryId !== undefined && summary === undefined) {
			throw new SessionInvariantError(`Navigation summary ${lastResult.summaryEntryId} is missing`);
		}
		if (summary !== undefined && summary.type !== "branch_summary") {
			throw new SessionInvariantError(`Navigation summary ${lastResult.summaryEntryId} is invalid`);
		}
		return {
			operation: "navigation",
			runId: lastResult.operationId,
			kind: "completed",
			oldLeafId: lastResult.oldLeafId,
			newLeafId: lastResult.leafId,
			...(summary === undefined ? {} : { summaryEntry: summary }),
		};
	}
	if (lastResult.outcome === "failed") {
		return {
			operation: "navigation",
			runId: lastResult.operationId,
			kind: "failed",
			leafId: lastResult.leafId,
			error: lastResult.error,
		};
	}
	return {
		operation: "navigation",
		runId: lastResult.operationId,
		kind: lastResult.outcome,
		leafId: lastResult.leafId,
	};
}
