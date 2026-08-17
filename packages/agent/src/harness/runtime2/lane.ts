import type { Api, ImageContent, Model, Models } from "@draht/ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import type {
	AgentLane,
	HarnessEvent,
	LaneConfigEventPayload,
	LaneExecutionInfo,
	SuspendedOperation,
} from "../agent-harness.ts";
import type { Context } from "../context.ts";
import { insertEntry } from "../session/commit.ts";
import { SessionPendingAssistantMessageError } from "../session/session.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	LaneLastResult,
	PendingEntry,
	Session,
	SessionReader,
	SessionTree,
	Write,
} from "../session/types.ts";
import {
	laneConfig,
	laneLeaf,
	operationState as operationStateValue,
	pendingEntry,
	setValue,
} from "../session/values.ts";
import { type LaneState, SliceNotImplemented } from "./types.ts";

type EventHandler = (event: HarnessEvent, context: Context) => Promise<void>;
type FaultHandler = (cause: unknown, context: Context) => Error;
type Synchronous<TResult> = TResult extends PromiseLike<unknown> ? never : TResult;

type LaneCommand<TResult> =
	| {
			kind: "commit";
			writes: Write[];
			next: LaneState;
			materialize(commit: CommitResult): Synchronous<TResult>;
	  }
	| { kind: "return"; result: TResult }
	| { kind: "reject"; error: Error };

type LaneCommandOutcome<TResult> = { kind: "return"; result: TResult } | { kind: "reject"; error: Error };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	return "then" in value && typeof value.then === "function";
}

/** Runtime2 implementation of one configured lane. */
export class Lane implements AgentLane {
	readonly name: string;
	readonly sessionTree: SessionTree;
	private readonly sessionView: SessionTree;
	protected readonly session: Session;
	protected readonly models: Models;
	private readonly onFault: FaultHandler;
	private readonly onEvent: EventHandler;
	private suspension: SuspendedOperation | undefined;
	state: LaneState;
	closedError: Error | undefined;

	constructor(
		name: string,
		session: Session,
		models: Models,
		state: LaneState,
		onFault: FaultHandler,
		onEvent: EventHandler,
		suspension?: SuspendedOperation,
	) {
		this.session = session;
		this.models = models;
		this.name = name;
		this.sessionView = session.view(name);
		this.sessionTree = {
			...this.sessionView,
			getLeafId: (context) => this.getLeafId(context),
			setName: (name, context) => this.setName(name, context),
			setLabel: (targetId, label, context) => this.setLabel(targetId, label, context),
			findEntriesOnBranch: (query, context) => this.findEntriesOnBranch(query, context),
			findEntryOnBranch: (query, context) => this.findEntryOnBranch(query, context),
			appendMessage: (message, context) => this.append({ type: "message", payload: message }, context),
			appendCustomEntry: (customType, data, context) =>
				this.append({ type: "custom", customType, ...(data === undefined ? {} : { payload: data }) }, context),
		};
		this.state = state;
		this.onFault = onFault;
		this.onEvent = onEvent;
		this.suspension = suspension;
	}

	async getLeafId(_context: Context): Promise<string | null> {
		this.assertOpen();
		return this.state.leafId;
	}

	async getLastResult(_context: Context): Promise<LaneLastResult | undefined> {
		this.assertOpen();
		return this.state.lastResult;
	}

	/**
	 * Run one effect-free command on this lane's serialized mutation line. Owned `state` is authoritative; the
	 * planner receives that state plus a read-only reader for bounded payload lookups. Committed values and owned
	 * state are immutable snapshots: update them by replacement, never in place. State-independent input validation
	 * belongs before `command()`, while every state-dependent decision belongs inside its planner.
	 *
	 * A planner may choose exactly one outcome:
	 * - `commit` commits once, publishes `next`, then synchronously materializes the caller result from
	 *   storage-assigned `CommitResult` metadata;
	 * - `return` returns without a commit, boxed so a promise value is not awaited while holding the lane line;
	 * - `reject` rejects outside the mutation/fault boundary as an expected caller error without a commit.
	 *
	 * Planner, commit, and materialization errors fault the harness before releasing the lane line. Close/fault gates
	 * are checked both before queueing and when the callback starts: close-first rejects, while an admitted successful
	 * commit always publishes memory and resolves without another open check. Never invoke providers, tools, hooks,
	 * timers, event handlers, or wait for task completion here; perform those after `command()` returns.
	 */
	async command<TResult>(
		plan: (
			state: LaneState,
			reader: SessionReader,
			context: Context,
		) => LaneCommand<TResult> | Promise<LaneCommand<TResult>>,
		context: Context,
	): Promise<TResult> {
		this.assertOpen();
		let outcome: LaneCommandOutcome<TResult>;
		try {
			outcome = await this.session.mutate(
				this.name,
				async (mutator) => {
					this.assertOpen();
					try {
						const decision = await plan(this.state, mutator, context);
						switch (decision.kind) {
							case "return":
								return { kind: "return", result: decision.result };
							case "reject":
								return { kind: "reject", error: decision.error };
							case "commit": {
								const commit = await mutator.commit(decision.writes, context);
								this.state = decision.next;
								if (this.suspension?.operationId !== decision.next.operation?.meta.operationId) {
									this.suspension = undefined;
								}
								const result = decision.materialize(commit);
								if (isPromiseLike(result)) {
									throw new TypeError("Lane command materialize() must be synchronous");
								}
								return { kind: "return", result };
							}
						}
					} catch (error) {
						if (this.closedError !== undefined) throw this.closedError;
						throw this.onFault(error, context);
					}
				},
				context,
			);
		} catch (error) {
			if (this.closedError !== undefined) throw this.closedError;
			throw error;
		}
		if (outcome.kind === "reject") throw outcome.error;
		return outcome.result;
	}

	async accept(..._args: Parameters<AgentLane["accept"]>): Promise<never> {
		throw new SliceNotImplemented("accept");
	}

	async drive(..._args: Parameters<AgentLane["drive"]>): Promise<never> {
		throw new SliceNotImplemented("drive");
	}

	async requestAbort(..._args: Parameters<AgentLane["requestAbort"]>): Promise<never> {
		throw new SliceNotImplemented("requestAbort");
	}

	async inspectExecution(_context: Context): Promise<LaneExecutionInfo> {
		this.assertOpen();
		const operation = this.state.operation;
		if (operation === null) {
			return {
				lane: this.name,
				leafId: this.state.leafId,
				current: null,
				...(this.state.lastResult === undefined ? {} : { lastResult: this.state.lastResult }),
			};
		}
		const status = operation.state.control.status === "cancel_requested" ? "aborting" : "suspended";
		const suspended =
			status === "suspended" && this.suspension?.operationId === operation.meta.operationId
				? this.suspension
				: undefined;
		return {
			lane: this.name,
			leafId: this.state.leafId,
			current: {
				id: operation.meta.operationId,
				kind: operation.meta.intent.kind,
				status,
				startedAt: operation.meta.startedAt,
				...(suspended === undefined ? {} : { suspended }),
			},
			...(this.state.lastResult === undefined ? {} : { lastResult: this.state.lastResult }),
		};
	}

	async prompt(
		..._args:
			| [text: string, images: ImageContent[] | undefined, context: Context]
			| [message: AgentMessage | AgentMessage[], context: Context]
	): Promise<never> {
		throw new SliceNotImplemented("prompt");
	}

	async skill(..._args: Parameters<AgentLane["skill"]>): Promise<never> {
		throw new SliceNotImplemented("skill");
	}

	async promptFromTemplate(..._args: Parameters<AgentLane["promptFromTemplate"]>): Promise<never> {
		throw new SliceNotImplemented("promptFromTemplate");
	}

	async compact(..._args: Parameters<AgentLane["compact"]>): Promise<never> {
		throw new SliceNotImplemented("compact");
	}

	async navigateTree(..._args: Parameters<AgentLane["navigateTree"]>): Promise<never> {
		throw new SliceNotImplemented("navigateTree");
	}

	async resume(..._args: Parameters<AgentLane["resume"]>): Promise<never> {
		throw new SliceNotImplemented("resume");
	}

	async abort(..._args: Parameters<AgentLane["abort"]>): Promise<never> {
		throw new SliceNotImplemented("abort");
	}

	async steer(..._args: Parameters<AgentLane["steer"]>): Promise<never> {
		throw new SliceNotImplemented("steer");
	}

	async followUp(..._args: Parameters<AgentLane["followUp"]>): Promise<never> {
		throw new SliceNotImplemented("followUp");
	}

	async nextRun(..._args: Parameters<AgentLane["nextRun"]>): Promise<never> {
		throw new SliceNotImplemented("nextRun");
	}

	async cancelQueued(..._args: Parameters<AgentLane["cancelQueued"]>): Promise<never> {
		throw new SliceNotImplemented("cancelQueued");
	}

	async recordUsage(..._args: Parameters<AgentLane["recordUsage"]>): Promise<never> {
		throw new SliceNotImplemented("recordUsage");
	}

	async waitForIdle(..._args: Parameters<AgentLane["waitForIdle"]>): Promise<never> {
		throw new SliceNotImplemented("waitForIdle");
	}

	async runWhenIdle(..._args: Parameters<AgentLane["runWhenIdle"]>): Promise<never> {
		throw new SliceNotImplemented("runWhenIdle");
	}

	async peekAction(..._args: Parameters<AgentLane["peekAction"]>): Promise<never> {
		throw new SliceNotImplemented("peekAction");
	}

	async executeAction(..._args: Parameters<AgentLane["executeAction"]>): Promise<never> {
		throw new SliceNotImplemented("executeAction");
	}

	async runToCompletion(..._args: Parameters<AgentLane["runToCompletion"]>): Promise<never> {
		throw new SliceNotImplemented("runToCompletion");
	}

	async getModel(_context: Context): Promise<Model<Api> | undefined> {
		this.assertOpen();
		return this.models.getModel(this.state.configuration.model.provider, this.state.configuration.model.modelId);
	}

	setModel(model: Model<Api>, context: Context): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({
				...configuration,
				model: { provider: model.provider, modelId: model.id },
			}),
			(previous, value) => ({
				type: "config_update",
				property: "model",
				previous: previous.model,
				value: value.model,
			}),
			context,
		);
	}

	async getThinkingLevel(_context: Context): Promise<ThinkingLevel> {
		this.assertOpen();
		return this.state.configuration.thinkingLevel;
	}

	setThinkingLevel(thinkingLevel: ThinkingLevel, context: Context): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({ ...configuration, thinkingLevel }),
			(previous, value) => ({
				type: "config_update",
				property: "thinkingLevel",
				previous: previous.thinkingLevel,
				value: value.thinkingLevel,
			}),
			context,
		);
	}

	async getActiveTools(_context: Context): Promise<string[]> {
		this.assertOpen();
		return this.state.configuration.activeToolNames;
	}

	setActiveTools(activeToolNames: string[], context: Context): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({ ...configuration, activeToolNames }),
			(previous, value) => ({
				type: "config_update",
				property: "activeTools",
				previous: previous.activeToolNames,
				value: value.activeToolNames,
			}),
			context,
		);
	}

	async watch(..._args: Parameters<AgentLane["watch"]>): Promise<never> {
		throw new SliceNotImplemented("watch");
	}

	private async setConfiguration(
		update: (configuration: LaneState["configuration"]) => LaneState["configuration"],
		event: (previous: LaneState["configuration"], value: LaneState["configuration"]) => LaneConfigEventPayload,
		context: Context,
	): Promise<void> {
		const payload = await this.command((state) => {
			const configuration = update(state.configuration);
			return {
				kind: "commit",
				writes: [setValue(laneConfig(this.name), configuration)],
				next: { ...state, configuration },
				materialize: () => event(state.configuration, configuration),
			};
		}, context);
		await this.onEvent({ ...payload, lane: this.name }, context);
	}

	private async setName(name: string | undefined, context: Context): Promise<void> {
		await this.sessionView.setName(name, context);
		await this.onEvent({ type: "value_update", value: "session_name", name }, context);
	}

	private async setLabel(targetId: string, label: string | undefined, context: Context): Promise<void> {
		await this.sessionView.setLabel(targetId, label, context);
		await this.onEvent({ type: "value_update", value: "entry_label", targetId, label }, context);
	}

	private async findEntriesOnBranch(query: BranchScan | undefined, context: Context): Promise<Entry[]> {
		query ??= {};
		this.assertOpen();
		const start = query.start ?? this.state.leafId;
		return start === null ? [] : this.sessionView.findEntriesOnBranch({ ...query, start }, context);
	}

	private async findEntryOnBranch(query: BranchScan | undefined, context: Context): Promise<Entry | undefined> {
		return (await this.findEntriesOnBranch({ ...query, limit: 1 }, context))[0];
	}

	private append(pending: PendingEntry, context: Context): Promise<string> {
		this.assertOpen();
		if (
			pending.type === "message" &&
			pending.payload.role === "assistant" &&
			pending.payload.stopReason === "pending"
		) {
			return Promise.reject(new SessionPendingAssistantMessageError());
		}
		const id = this.session.idGenerator.next();
		return this.command((state) => {
			if (state.operation === null) {
				return {
					kind: "commit",
					writes: [
						insertEntry(
							pending.type === "message"
								? { id, parentId: state.leafId, type: "message", message: pending.payload }
								: {
										id,
										parentId: state.leafId,
										type: "custom",
										customType: pending.customType,
										...(pending.payload === undefined ? {} : { data: pending.payload }),
									},
						),
						setValue(laneLeaf(this.name), id),
					],
					next: { ...state, leafId: id },
					materialize: () => id,
				};
			}

			if (state.operation.state.kind !== "run") {
				return {
					kind: "reject",
					error: new Error(
						`Cannot append while structural operation ${state.operation.meta.operationId} is active`,
					),
				};
			}
			const operationState = {
				...state.operation.state,
				inbox: {
					...state.operation.state.inbox,
					writes: [...state.operation.state.inbox.writes, id],
				},
			};
			return {
				kind: "commit",
				writes: [
					setValue(pendingEntry(id), pending),
					setValue(operationStateValue(state.operation.meta.operationId), operationState),
				],
				next: { ...state, operation: { meta: state.operation.meta, state: operationState } },
				materialize: () => id,
			};
		}, context);
	}

	seal(error: Error): void {
		this.closedError ??= error;
	}

	assertOpen(): void {
		if (this.closedError !== undefined) throw this.closedError;
	}
}
