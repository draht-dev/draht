import type { Api, AssistantMessage, ImageContent, Model, RetryPolicy, Usage } from "@draht/ai";
import type { AgentMessage, QueueMode, ThinkingLevel } from "../types.ts";
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
	type LaneExecutionInfo,
	LaneExists,
	type LaneInfo,
	type LaneSnapshot,
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
	UnknownTarget,
	type WatchHandle,
} from "./agent-harness.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "./compaction/compaction.ts";
import { HarnessEventBus } from "./events.ts";
import { BreakpointBarrier } from "./execution/breakpoint.ts";
import { OperationEffectGate } from "./execution/effect-gate.ts";
import { HookRegistry } from "./hooks.ts";
import { type RestoredLane, restoreLane } from "./restore.ts";
import { Result } from "./result.ts";
import { LaneMutationLine } from "./session/lane-mutations.ts";
import {
	SessionInvalidLaneError,
	SessionInvariantError,
	SessionLaneExistsError,
	SessionUnknownTargetError,
} from "./session/session.ts";
import type {
	JsonValue,
	LaneConfiguration,
	LaneLastResult,
	Session,
	SessionMutator,
	SessionTree,
} from "./session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessTool } from "./types.ts";

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
}

interface DeferredValue<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

interface ActiveOperation {
	operationId: string;
	completion: Promise<DriveResult>;
	resolve: (result: DriveResult) => void;
	reject: (error: unknown) => void;
	effectGate: OperationEffectGate;
	task?: Promise<void>;
}

type DriveArbitration =
	| { kind: "result"; result: DriveResult }
	| { kind: "join"; completion: Promise<DriveResult> }
	| { kind: "installed"; active: ActiveOperation };

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
	readonly settingsLine = new LaneMutationLine();
	readonly laneRuntimes = new Map<string, AgentLaneRuntime<TContext>>();
	readonly activeOperations = new Map<string, ActiveOperation>();
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
		this.session = options.session.view("main");
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
				const deferred = deferredValue<DriveResult>();
				const active: ActiveOperation = {
					operationId: options.operationId,
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
		return {
			lane: restored.lane,
			operationId: current.operation.operationId,
			kind: current.operation.intent.kind,
			startedAt: current.operation.startedAt,
			reason: "crash",
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
				active.reject(error);
			}
		})();
	}

	private async executeDrivePass(
		lane: AgentLaneRuntime<TContext>,
		active: ActiveOperation,
		options: DriveOptions,
	): Promise<DriveResult> {
		let restored: RestoredLane;
		try {
			restored = await this.sessionStorage.mutate(lane.name, (reader) => restoreLane(reader, lane.name));
		} catch (error) {
			throw this.fault(error);
		}
		if (restored.current === undefined || restored.current.operation.operationId !== active.operationId) {
			let inspected: RestoredLane;
			try {
				inspected = await this.sessionStorage.mutate(lane.name, (reader) =>
					restoreLane(reader, lane.name, { includeLastResult: true }),
				);
			} catch (error) {
				throw this.fault(error);
			}
			if (inspected.lastResult?.operationId === active.operationId) {
				let outcome: TerminalOperationOutcome;
				try {
					outcome = await this.sessionStorage.mutate(lane.name, (reader) =>
						hydrateTerminalOutcome(reader, inspected.lastResult!),
					);
				} catch (error) {
					throw this.fault(error);
				}
				return Result.ok({ kind: "settled", operationId: active.operationId, outcome });
			}
			return Result.err(this.mismatch(lane.name, active.operationId, inspected));
		}
		if (deadlineReached(options)) return Result.ok({ kind: "yielded", operationId: active.operationId });

		await lane.breakpoint.hit({
			kind: "runtime.dispatch",
			description: "Advance durable operation",
			details: { operationId: active.operationId, operationKind: restored.current.state.kind },
		});
		if (deadlineReached(options)) return Result.ok({ kind: "yielded", operationId: active.operationId });
		throw new RuntimeSliceNotImplemented(`drive(${restored.current.state.kind})`);
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
		this.session = harness.sessionStorage.view(name);
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

	accept(_request: OperationRequest): Promise<OperationAdmissionResult> {
		return this.unimplementedResult("accept");
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

	prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	prompt(_message: string | AgentMessage | AgentMessage[], _images?: ImageContent[]): Promise<RunResult> {
		return this.unimplementedResult("prompt");
	}
	skill(_name: string, _additionalInstructions?: string): Promise<RunResult> {
		return this.unimplementedResult("skill");
	}
	promptFromTemplate(_name: string, _args?: string[]): Promise<RunResult> {
		return this.unimplementedResult("promptFromTemplate");
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
