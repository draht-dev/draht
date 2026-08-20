import type { RetryPolicy } from "@draht/ai";
import type { QueueMode } from "../../types.ts";
import type {
	AgentHarness,
	AgentHarnessOptions,
	AgentLane,
	CreateLaneResult,
	GlobalConfigEventPayload,
	LaneInfo,
	OpenOperation,
	Resources,
} from "../agent-harness.ts";
import { Closed, HarnessClosed, HarnessFault, InvalidLane, LaneExists, UnknownTarget } from "../agent-harness.ts";
import { type CompactionSettings, DEFAULT_COMPACTION_SETTINGS } from "../compaction/compaction.ts";
import { DEFAULT_RETRY_POLICY, validateCompactionSettings, validateRetryPolicy, validateToolNames } from "../config.ts";
import type { Context } from "../context.ts";
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
import { laneConfig, laneLastResult, laneLeaf, laneState, setValue } from "../session/values.ts";
import type { AgentHarnessStreamOptions, AgentHarnessTool } from "../types.ts";
import { Lane } from "./lane.ts";
import { restoreSession } from "./restore.ts";
import { type Config, type LaneState, SliceNotImplemented } from "./types.ts";

type GlobalConfigProperty = GlobalConfigEventPayload["property"];

/** Runtime2 implementation of AgentHarness. The harness is the main lane. */
export class Harness<TContext extends object | undefined> extends Lane<TContext> implements AgentHarness<TContext> {
	readonly events: HarnessEventBus;
	readonly seed: LaneConfiguration;
	readonly lanesByName = new Map<string, Lane<TContext>>();
	private readonly configStore: { value: Config<TContext> };
	closePromise: Promise<void> | undefined;
	faultError: HarnessFault | undefined;

	constructor(options: AgentHarnessOptions<TContext>, seed: LaneConfiguration, restored: Map<string, LaneState>) {
		const main = restored.get("main");
		if (main === undefined) throw new SessionInvariantError("Session is missing main lane");
		const events = new HarnessEventBus();
		const hooks = new HookRegistry((error, hook, lane, context) =>
			events.emit(
				{
					type: "handler_error",
					kind: "hook",
					hook,
					error: error.message,
					...(error.stack === undefined ? {} : { stack: error.stack }),
					lane,
				},
				context,
			),
		);
		const configStore: { value: Config<TContext> } = {
			value: {
				tools: options.tools ?? [],
				resources: options.resources ?? {},
				streamOptions: options.streamOptions ?? {},
				retryPolicy: options.retry ?? DEFAULT_RETRY_POLICY,
				compaction: options.compaction ?? DEFAULT_COMPACTION_SETTINGS,
				steeringMode: options.steeringMode ?? "all",
				followUpMode: options.followUpMode ?? "all",
				toolExecution: options.toolExecution ?? "parallel",
				toolContext: options.toolContext,
				systemPrompt: options.systemPrompt,
				toProviderMessages: options.toProviderMessages ?? ((messages) => convertToLlm(messages)),
				entryProjectors: options.entryProjectors ?? {},
			},
		};
		super(
			"main",
			options.session,
			options.models,
			hooks,
			main,
			(cause, context) => this.fault(cause, context),
			(events, context) => this.events.emitBatch(events, context),
			(snapshot, filter, context) => this.events.watch(snapshot, filter, context),
			() => configStore.value,
		);
		this.seed = seed;
		this.configStore = configStore;
		this.events = events;
		this.lanesByName.set("main", this);
		for (const [name, state] of restored) {
			if (name !== "main") this.lanesByName.set(name, this.buildLane(name, state));
		}
	}

	async lane(name: string, _context: Context): Promise<AgentLane | undefined> {
		this.assertOpen();
		return this.lanesByName.get(name);
	}

	async lanes(context: Context): Promise<LaneInfo[]> {
		this.assertOpen();
		const executions = await Promise.all(
			[...this.lanesByName.values()].map((lane) => lane.inspectExecution(context)),
		);
		return executions.map((execution) => ({
			name: execution.lane,
			leafId: execution.leafId,
			operation: execution.current,
		}));
	}

	async createLane(name: string, at: string | null, context: Context): Promise<CreateLaneResult> {
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
			const lane = this.buildLane(name, state);
			await this.session.createLane(
				name,
				at,
				this.seed,
				(context) => {
					if (this.closedError !== undefined) lane.seal(this.closedError);
					this.lanesByName.set(name, lane);
					return this.events.emitBatch([{ type: "lane_created", lane: name, at }], context);
				},
				context,
			);
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
			throw this.fault(error, context);
		}
	}

	getTools(context: Context): Promise<AgentHarnessTool<TContext>[]> {
		return this.getConfig("tools", context);
	}

	setTools(tools: AgentHarnessTool<TContext>[], context: Context): Promise<void> {
		validateToolNames(tools);
		return this.setConfig("tools", tools, "tools", context);
	}

	getResources(context: Context): Promise<Resources> {
		return this.getConfig("resources", context);
	}

	setResources(resources: Resources, context: Context): Promise<void> {
		return this.setConfig("resources", resources, "resources", context);
	}

	getStreamOptions(context: Context): Promise<AgentHarnessStreamOptions> {
		return this.getConfig("streamOptions", context);
	}

	setStreamOptions(options: AgentHarnessStreamOptions, context: Context): Promise<void> {
		return this.setConfig("streamOptions", options, "streamOptions", context);
	}

	getRetryPolicy(context: Context): Promise<RetryPolicy> {
		return this.getConfig("retryPolicy", context);
	}

	setRetryPolicy(policy: RetryPolicy, context: Context): Promise<void> {
		validateRetryPolicy(policy);
		return this.setConfig("retryPolicy", policy, "retryPolicy", context);
	}

	getCompactionSettings(context: Context): Promise<CompactionSettings> {
		return this.getConfig("compaction", context);
	}

	setCompactionSettings(compaction: CompactionSettings, context: Context): Promise<void> {
		validateCompactionSettings(compaction);
		return this.setConfig("compaction", compaction, "compactionSettings", context);
	}

	getSteeringMode(context: Context): Promise<QueueMode> {
		return this.getConfig("steeringMode", context);
	}

	setSteeringMode(steeringMode: QueueMode, context: Context): Promise<void> {
		return this.setConfig("steeringMode", steeringMode, "steeringMode", context);
	}

	getFollowUpMode(context: Context): Promise<QueueMode> {
		return this.getConfig("followUpMode", context);
	}

	setFollowUpMode(followUpMode: QueueMode, context: Context): Promise<void> {
		return this.setConfig("followUpMode", followUpMode, "followUpMode", context);
	}

	async watchSession(_context: Context): Promise<never> {
		throw new SliceNotImplemented("watchSession");
	}

	private buildLane(name: string, state: LaneState): Lane<TContext> {
		return new Lane<TContext>(
			name,
			this.session,
			this.models,
			this.hooks,
			state,
			(cause, context) => this.fault(cause, context),
			(events, context) => this.events.emitBatch(events, context),
			(snapshot, filter, context) => this.events.watch(snapshot, filter, context),
			() => this.configStore.value,
		);
	}

	private async getConfig<TKey extends keyof Config<TContext>>(
		key: TKey,
		_context: Context,
	): Promise<Config<TContext>[TKey]> {
		this.assertOpen();
		return this.configStore.value[key];
	}

	private async setConfig<TKey extends keyof Config<TContext>>(
		key: TKey,
		value: Config<TContext>[TKey],
		property: GlobalConfigProperty,
		context: Context,
	): Promise<void> {
		this.assertOpen();
		this.configStore.value = { ...this.configStore.value, [key]: value };
		await this.events.emit({ type: "config_update", property }, context);
	}

	fault(cause: unknown, context: Context): Error {
		if (this.faultError !== undefined) return this.faultError;
		if (this.closedError !== undefined) return this.closedError;
		const normalized = cause instanceof Error ? cause : new Error(String(cause));
		const fault = new HarnessFault("AgentHarness storage or invariant fault", normalized);
		this.faultError = fault;
		for (const lane of this.lanesByName.values()) lane.seal(fault);
		this.hooks.close(fault);
		void this.events.emit({ type: "fault", code: "harness_fault", message: fault.message }, context);
		this.events.close(fault);
		return fault;
	}

	close(context: Context): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		/*
		 * Close is a process-local admission boundary, not an abort. Public lane work checks Lane.assertOpen() at
		 * entry. Durable work then enters Session.mutate(), whose mutation line is the final write-admission gate.
		 * External effects use Gate.admit() immediately around invocation. Closing seals all applicable gates
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
		this.closePromise = this.session.close(context);
		return this.closePromise;
	}
}

/** Attach runtime2 without starting provider, tool, hook, or timer effects. */
export async function createAgentHarness<TContext extends object | undefined = object | undefined>(
	options: AgentHarnessOptions<TContext>,
	context: Context,
): Promise<{ harness: AgentHarness<TContext>; open: OpenOperation[] }> {
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
		await seedMain(options.session, seed, context);
		const restored = await restoreSession(options.session, context);
		const open = [...restored].flatMap(([lane, state]): OpenOperation[] => {
			const operation = state.operation;
			return operation === null
				? []
				: [
						{
							lane,
							operationId: operation.meta.operationId,
							kind: operation.meta.intent.kind,
							startedAt: operation.meta.startedAt,
							...(operation.state.control.status === "cancel_requested" ? { aborting: true as const } : {}),
						},
					];
		});
		return { harness: new Harness(options, seed, restored), open };
	} catch (error) {
		throw new HarnessFault("AgentHarness storage or invariant fault", error);
	}
}

async function seedMain(session: Session, seed: LaneConfiguration, context: Context): Promise<void> {
	await session.mutate(
		"main",
		async (mutator) => {
			const [leaf, state, configuration, lastResult] = await Promise.all([
				mutator.getValue(laneLeaf("main"), context),
				mutator.getValue(laneState("main"), context),
				mutator.getValue(laneConfig("main"), context),
				mutator.getValue(laneLastResult("main"), context),
			]);
			if (leaf === undefined || state === undefined) {
				throw new SessionInvariantError("Session main lane has incomplete durable state");
			}
			if (configuration !== undefined) return;
			if (state.value.currentOperationId !== null || lastResult !== undefined) {
				throw new SessionInvariantError("Configured or active main lane is missing lane.config");
			}
			await mutator.commit([setValue(laneConfig("main"), seed)], context);
		},
		context,
	);
}
