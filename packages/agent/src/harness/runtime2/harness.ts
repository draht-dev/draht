import type { Models, RetryPolicy } from "@draht/ai";
import { NOOP_TELEMETRY_CONTEXT } from "@draht/telemetry";
import type { QueueMode } from "../../types.ts";
import type {
	AgentHarness,
	AgentHarnessOptions,
	AgentLane,
	CreateLaneResult,
	GlobalConfigEventPayload,
	LaneInfo,
	Resources,
	SuspendedOperation,
} from "../agent-harness.ts";
import { Closed, HarnessClosed, HarnessFault, InvalidLane, LaneExists, UnknownTarget } from "../agent-harness.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "../compaction/compaction.ts";
import {
	DEFAULT_RETRY_POLICY,
	hasMissingIdentities,
	missingIdentities,
	missingToolIdentities,
	validateCompactionSettings,
	validateRetryPolicy,
	validateToolNames,
} from "../config.ts";
import { HarnessEventBus } from "../events.ts";
import { HookRegistry } from "../hooks.ts";
import { convertToLlm } from "../messages.ts";
import { Result } from "../result.ts";
import {
	SessionInvalidLaneError,
	SessionInvariantError,
	SessionLaneExistsError,
	SessionUnknownTargetError,
} from "../session/session.ts";
import type { LaneConfiguration, Session } from "../session/types.ts";
import type { AgentHarnessStreamOptions, AgentHarnessTool } from "../types.ts";
import { Lane } from "./lane.ts";
import { restoreSession } from "./restore.ts";
import { type Config, type LaneState, SliceNotImplemented } from "./types.ts";

type GlobalConfigProperty = GlobalConfigEventPayload["property"];

/** Runtime2 implementation of AgentHarness. The harness is the main lane. */
export class Harness<TContext extends object | undefined> extends Lane implements AgentHarness<TContext> {
	readonly hooks: HookRegistry;
	readonly events: HarnessEventBus;
	readonly seed: LaneConfiguration;
	readonly lanesByName = new Map<string, Lane>();
	private config: Config<TContext>;
	closePromise: Promise<void> | undefined;
	faultError: HarnessFault | undefined;

	constructor(
		options: AgentHarnessOptions<TContext>,
		seed: LaneConfiguration,
		restored: Map<string, LaneState>,
		suspensionsByLane: Map<string, SuspendedOperation>,
	) {
		const main = restored.get("main");
		if (main === undefined) throw new SessionInvariantError("Session is missing main lane");
		super(
			"main",
			options.session,
			options.models,
			main,
			(cause) => this.fault(cause),
			(event) => this.events.emit(event),
			suspensionsByLane.get("main"),
		);
		this.seed = seed;
		this.config = {
			tools: options.tools ?? [],
			resources: options.resources ?? {},
			streamOptions: options.streamOptions ?? {},
			retryPolicy: options.retry ?? DEFAULT_RETRY_POLICY,
			compaction: options.compaction ?? DEFAULT_COMPACTION_SETTINGS,
			steeringMode: options.steeringMode ?? "all",
			followUpMode: options.followUpMode ?? "all",
			toolExecution: options.toolExecution ?? "parallel",
			drive: options.drive ?? "automatic",
			toolContext: options.toolContext,
			systemPrompt: options.systemPrompt,
			toProviderMessages: options.toProviderMessages ?? convertToLlm,
			entryProjectors: options.entryProjectors ?? {},
			telemetryContext: options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT,
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
		this.lanesByName.set("main", this);
		for (const [name, state] of restored) {
			if (name !== "main") this.lanesByName.set(name, this.buildLane(name, state, suspensionsByLane.get(name)));
		}
	}

	async lane(name: string): Promise<AgentLane | undefined> {
		this.assertOpen();
		return this.lanesByName.get(name);
	}

	async lanes(): Promise<LaneInfo[]> {
		this.assertOpen();
		const executions = await Promise.all([...this.lanesByName.values()].map((lane) => lane.inspectExecution()));
		return executions.map((execution) => ({
			name: execution.lane,
			leafId: execution.leafId,
			operation:
				execution.current === null
					? null
					: {
							id: execution.current.id,
							kind: execution.current.kind,
							status: execution.current.status,
						},
		}));
	}

	async createLane(name: string, at: string | null): Promise<CreateLaneResult> {
		// Public Result errors are expected caller/lifecycle outcomes. Harness faults reject every API call because the
		// owned state can no longer advance safely; they are intentionally not members of CreateLaneResult.
		if (this.faultError !== undefined) throw this.faultError;
		if (this.closedError !== undefined) return Result.err(new Closed({ message: this.closedError.message }));
		const state: LaneState = {
			leafId: at,
			configuration: this.seed,
			pendingNextRun: [],
			operation: null,
		};
		try {
			await this.session.createLane(name, at, this.seed);
			const lane = this.buildLane(name, state);
			if (this.closedError !== undefined) lane.seal(this.closedError);
			this.lanesByName.set(name, lane);
			await this.events.emit({ type: "lane_created", lane: name, at });
			return Result.ok(lane);
		} catch (error) {
			// Session has no Result layer, so its expected validation failures are thrown. Translate only those failures
			// to the public tagged Result contract; storage and invariant failures fault the harness below.
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

	getTools(): Promise<AgentHarnessTool<TContext>[]> {
		return this.getConfig("tools");
	}

	setTools(tools: AgentHarnessTool<TContext>[]): Promise<void> {
		validateToolNames(tools);
		return this.setConfig("tools", tools, "tools");
	}

	getResources(): Promise<Resources> {
		return this.getConfig("resources");
	}

	setResources(resources: Resources): Promise<void> {
		return this.setConfig("resources", resources, "resources");
	}

	getStreamOptions(): Promise<AgentHarnessStreamOptions> {
		return this.getConfig("streamOptions");
	}

	setStreamOptions(options: AgentHarnessStreamOptions): Promise<void> {
		return this.setConfig("streamOptions", options, "streamOptions");
	}

	getRetryPolicy(): Promise<RetryPolicy> {
		return this.getConfig("retryPolicy");
	}

	setRetryPolicy(policy: RetryPolicy): Promise<void> {
		validateRetryPolicy(policy);
		return this.setConfig("retryPolicy", policy, "retryPolicy");
	}

	getCompactionSettings(): Promise<CompactionSettings> {
		return this.getConfig("compaction");
	}

	setCompactionSettings(compaction: CompactionSettings): Promise<void> {
		validateCompactionSettings(compaction);
		return this.setConfig("compaction", compaction, "compactionSettings");
	}

	getSteeringMode(): Promise<QueueMode> {
		return this.getConfig("steeringMode");
	}

	setSteeringMode(steeringMode: QueueMode): Promise<void> {
		return this.setConfig("steeringMode", steeringMode, "steeringMode");
	}

	getFollowUpMode(): Promise<QueueMode> {
		return this.getConfig("followUpMode");
	}

	setFollowUpMode(followUpMode: QueueMode): Promise<void> {
		return this.setConfig("followUpMode", followUpMode, "followUpMode");
	}

	async watchSession(): Promise<never> {
		throw new SliceNotImplemented("watchSession");
	}

	private buildLane(name: string, state: LaneState, suspension?: SuspendedOperation): Lane {
		return new Lane(
			name,
			this.session,
			this.models,
			state,
			(cause) => this.fault(cause),
			(event) => this.events.emit(event),
			suspension,
		);
	}

	private async getConfig<TKey extends keyof Config<TContext>>(key: TKey): Promise<Config<TContext>[TKey]> {
		this.assertOpen();
		return this.config[key];
	}

	private async setConfig<TKey extends keyof Config<TContext>>(
		key: TKey,
		value: Config<TContext>[TKey],
		property: GlobalConfigProperty,
	): Promise<void> {
		this.assertOpen();
		this.config = { ...this.config, [key]: value };
		await this.events.emit({ type: "config_update", property });
	}

	fault(cause: unknown): Error {
		if (this.faultError !== undefined) return this.faultError;
		if (this.closedError !== undefined) return this.closedError;
		const normalized = cause instanceof Error ? cause : new Error(String(cause));
		const fault = new HarnessFault("AgentHarness storage or invariant fault", normalized);
		this.faultError = fault;
		for (const lane of this.lanesByName.values()) lane.seal(fault);
		this.hooks.close(fault);
		void this.events.emit({ type: "fault", code: "harness_fault", message: fault.message });
		this.events.close(fault);
		return fault;
	}

	close(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		/*
		 * Close is a process-local admission boundary, not an abort. Public lane work checks Lane.assertOpen() at
		 * entry. Durable work then enters Session.mutate(), whose mutation line is the final write-admission gate.
		 * External effects check their EffectGate immediately before invocation. Closing seals all applicable gates
		 * before awaiting anything.
		 *
		 * If close wins, new work and queued mutation callbacks that have not started reject. An active mutation may
		 * finish, and close waits for it. A successful commit must always publish its in-memory candidate and resolve
		 * without another open check; otherwise close racing the commit would make durable and in-memory state
		 * diverge. An admitted effect is signalled and allowed to unwind, but its settlement is a new durable unit and
		 * cannot commit after close. Every later command, settlement, or effect must pass admission again.
		 *
		 * Session.close() is the final mutation barrier: it rejects later session jobs, drains active callbacks and
		 * commits, then closes storage. Close itself writes no cancellation or terminal state.
		 *
		 * HarnessClosed is a process-local control signal. Lower procedures let it propagate, using only finally blocks
		 * for cleanup. The outer drive owner catches it to remove live task state and reject the caller; it must not turn
		 * close into a durable failure, abort settlement, or harness fault. Calls with no drive owner reject directly.
		 */
		const error = new HarnessClosed();
		for (const lane of this.lanesByName.values()) lane.seal(error);
		this.hooks.close(error);
		this.events.close(error);
		this.closePromise = this.session.close();
		return this.closePromise;
	}
}

/** Attach runtime2 without starting provider, tool, hook, or timer effects. */
export async function createAgentHarness<TContext extends object | undefined = object | undefined>(
	options: AgentHarnessOptions<TContext>,
): Promise<{ harness: AgentHarness<TContext>; suspended: SuspendedOperation[] }> {
	const tools = options.tools ?? [];
	validateToolNames(tools);
	validateRetryPolicy(options.retry ?? DEFAULT_RETRY_POLICY);
	validateCompactionSettings(options.compaction ?? DEFAULT_COMPACTION_SETTINGS);
	const seed: LaneConfiguration = {
		model: { provider: options.model.provider, modelId: options.model.id },
		thinkingLevel: options.thinkingLevel ?? "off",
		activeToolNames: options.activeToolNames ?? tools.map((tool) => tool.name),
	};
	try {
		await seedMain(options.session, seed);
		const restored = await restoreSession(options.session);
		const suspended: SuspendedOperation[] = [];
		for (const [lane, state] of restored) {
			if (state.operation !== null) {
				suspended.push(await describeSuspension(options.session, options.models, tools, lane, state));
			}
		}
		const suspensionsByLane = new Map(suspended.map((descriptor) => [descriptor.lane, descriptor]));
		return { harness: new Harness(options, seed, restored, suspensionsByLane), suspended };
	} catch (error) {
		throw new HarnessFault("AgentHarness storage or invariant fault", error);
	}
}

async function describeSuspension(
	session: Session,
	models: Models,
	tools: readonly { name: string }[],
	lane: string,
	state: LaneState,
): Promise<SuspendedOperation> {
	const operation = state.operation;
	if (operation === null) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is not suspended`);
	const promptIds = operation.meta.intent.kind === "run" ? operation.meta.intent.promptEntryIds : [];
	const deferredSourceId =
		operation.state.kind === "run" && operation.state.phase.kind === "deferred"
			? operation.state.phase.deferred.sourceEntryId
			: undefined;
	const entries = await session.getEntries([
		...new Set([...promptIds, ...(deferredSourceId === undefined ? [] : [deferredSourceId])]),
	]);
	const prompt = promptIds.map((id) => {
		const entry = entries.get(id);
		if (entry?.type !== "message") throw new SessionInvariantError(`Prompt entry ${id} is missing`);
		return entry.message;
	});
	const base = {
		lane,
		operationId: operation.meta.operationId,
		kind: operation.meta.intent.kind,
		startedAt: operation.meta.startedAt,
		...(operation.meta.intent.kind === "run" ? { prompt } : {}),
	};
	if (deferredSourceId !== undefined) {
		const entry = entries.get(deferredSourceId);
		if (entry?.type !== "message" || entry.message.role !== "assistant" || entry.message.deferred === undefined) {
			throw new SessionInvariantError("Deferred suspension source is invalid");
		}
		return { ...base, reason: "deferred", deferred: entry.message.deferred };
	}
	if (
		operation.state.kind === "run" &&
		operation.state.phase.kind === "assistant" &&
		operation.state.phase.generation.status === "ready"
	) {
		const missing = missingIdentities(models, operation.state.phase.generation.context.configuration, tools);
		if (hasMissingIdentities(missing)) {
			return { ...base, reason: "crash", missing };
		}
	}
	if (operation.state.kind === "run" && operation.state.phase.kind === "tools") {
		const missing = missingToolIdentities(operation.state.phase.batch.configuration, tools);
		if (missing.length !== 0) {
			return { ...base, reason: "crash", missing: { tools: missing } };
		}
	}
	return { ...base, reason: "crash" };
}

async function seedMain(session: Session, seed: LaneConfiguration): Promise<void> {
	await session.mutate("main", async (mutator) => {
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
			writes: [{ kind: "register", op: "set", namespace: "lane.config", key: "main", value: seed }],
		});
	});
}
