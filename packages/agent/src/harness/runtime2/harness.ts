import type { AgentHarness, AgentHarnessOptions, AgentLane, LaneInfo, SuspendedOperation } from "../agent-harness.ts";
import { HarnessClosed, HarnessFault } from "../agent-harness.ts";
import { HarnessEventBus } from "../events.ts";
import { HookRegistry } from "../hooks.ts";
import { RuntimeSliceNotImplemented } from "../runtime/types.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { LaneConfiguration, Session } from "../session/types.ts";
import { Lane } from "./lane.ts";
import { restoreSession } from "./restore.ts";
import type { LaneState } from "./types.ts";

/** Runtime2 implementation of AgentHarness. The harness is the main lane. */
export class Harness<TContext extends object | undefined> extends Lane implements AgentHarness<TContext> {
	readonly hooks: HookRegistry;
	readonly events: HarnessEventBus;
	readonly seed: LaneConfiguration;
	readonly lanesByName = new Map<string, Lane>();
	closePromise: Promise<void> | undefined;
	faultError: HarnessFault | undefined;

	constructor(options: AgentHarnessOptions<TContext>, seed: LaneConfiguration, restored: Map<string, LaneState>) {
		const main = restored.get("main");
		if (main === undefined) throw new SessionInvariantError("Session is missing main lane");
		super("main", options.session, options.models, main, (cause) => this.fault(cause));
		this.seed = seed;
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
			if (name !== "main") {
				this.lanesByName.set(
					name,
					new Lane(name, options.session, options.models, state, (cause) => this.fault(cause)),
				);
			}
		}
	}

	async lane(name: string): Promise<AgentLane | undefined> {
		this.assertOpen();
		return this.lanesByName.get(name);
	}

	async lanes(): Promise<LaneInfo[]> {
		this.assertOpen();
		return [...this.lanesByName.values()].map((lane) => {
			const operation = lane.state.operation;
			return {
				name: lane.name,
				leafId: lane.state.leafId,
				operation:
					operation === null
						? null
						: {
								id: operation.meta.operationId,
								kind: operation.meta.intent.kind,
								status: operation.state.control.status === "cancel_requested" ? "aborting" : "suspended",
							},
			};
		});
	}

	async createLane(): Promise<never> {
		throw new RuntimeSliceNotImplemented("createLane");
	}

	async getTools(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getTools");
	}

	async setTools(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setTools");
	}

	async getResources(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getResources");
	}

	async setResources(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setResources");
	}

	async getStreamOptions(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getStreamOptions");
	}

	async setStreamOptions(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setStreamOptions");
	}

	async getRetryPolicy(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getRetryPolicy");
	}

	async setRetryPolicy(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setRetryPolicy");
	}

	async getCompactionSettings(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getCompactionSettings");
	}

	async setCompactionSettings(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setCompactionSettings");
	}

	async getSteeringMode(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getSteeringMode");
	}

	async setSteeringMode(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setSteeringMode");
	}

	async getFollowUpMode(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getFollowUpMode");
	}

	async setFollowUpMode(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setFollowUpMode");
	}

	async watchSession(): Promise<never> {
		throw new RuntimeSliceNotImplemented("watchSession");
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
	const toolNames = new Set<string>();
	for (const tool of tools) {
		if (toolNames.has(tool.name)) throw new TypeError(`Duplicate tool name: ${JSON.stringify(tool.name)}`);
		toolNames.add(tool.name);
	}
	const seed: LaneConfiguration = {
		model: { provider: options.model.provider, modelId: options.model.id },
		thinkingLevel: options.thinkingLevel ?? "off",
		activeToolNames: options.activeToolNames ?? tools.map((tool) => tool.name),
	};
	try {
		await seedMain(options.session, seed);
		const restored = await restoreSession(options.session);
		const harness = new Harness(options, seed, restored);
		const suspended: SuspendedOperation[] = [];
		for (const [lane, state] of restored) {
			const operation = state.operation;
			if (operation === null) continue;
			suspended.push({
				lane,
				operationId: operation.meta.operationId,
				kind: operation.meta.intent.kind,
				startedAt: operation.meta.startedAt,
				reason: "crash",
			});
		}
		return { harness, suspended };
	} catch (error) {
		throw new HarnessFault("AgentHarness storage or invariant fault", error);
	}
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
