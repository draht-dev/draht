import type { Api, Model, Models } from "@draht/ai";
import type { ThinkingLevel } from "../../types.ts";
import type { AgentLane, HarnessEvent, LaneConfigEventPayload } from "../agent-harness.ts";
import { SessionPendingAssistantMessageError } from "../session/session.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	PendingEntry,
	Session,
	SessionReader,
	SessionTree,
	Transaction,
} from "../session/types.ts";
import { type LaneState, SliceNotImplemented } from "./types.ts";

type EventHandler = (event: HarnessEvent) => Promise<void>;
type FaultHandler = (cause: unknown) => Error;
type Synchronous<TResult> = TResult extends PromiseLike<unknown> ? never : TResult;

type LaneCommand<TResult> =
	| {
			kind: "commit";
			transaction: Transaction;
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
	state: LaneState;
	closedError: Error | undefined;

	constructor(
		name: string,
		session: Session,
		models: Models,
		state: LaneState,
		onFault: FaultHandler,
		onEvent: EventHandler,
	) {
		this.session = session;
		this.models = models;
		this.name = name;
		this.sessionView = session.view(name);
		this.sessionTree = {
			...this.sessionView,
			getLeafId: () => this.getLeafId(),
			findEntriesOnBranch: (query) => this.findEntriesOnBranch(query),
			findEntryOnBranch: (query) => this.findEntryOnBranch(query),
			appendMessage: (message) => this.append({ type: "message", payload: message }),
			appendCustomEntry: (customType, data) =>
				this.append({ type: "custom", customType, ...(data === undefined ? {} : { payload: data }) }),
		};
		this.state = state;
		this.onFault = onFault;
		this.onEvent = onEvent;
	}

	async getLeafId(): Promise<string | null> {
		this.assertOpen();
		return this.state.leafId;
	}

	async getLastResult() {
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
		plan: (state: LaneState, reader: SessionReader) => LaneCommand<TResult> | Promise<LaneCommand<TResult>>,
	): Promise<TResult> {
		this.assertOpen();
		let outcome: LaneCommandOutcome<TResult>;
		try {
			outcome = await this.session.mutate(this.name, async (mutator) => {
				this.assertOpen();
				try {
					const decision = await plan(this.state, mutator);
					switch (decision.kind) {
						case "return":
							return { kind: "return", result: decision.result };
						case "reject":
							return { kind: "reject", error: decision.error };
						case "commit": {
							const commit = await mutator.commit(decision.transaction);
							this.state = decision.next;
							const result = decision.materialize(commit);
							if (isPromiseLike(result)) throw new TypeError("Lane command materialize() must be synchronous");
							return { kind: "return", result };
						}
					}
				} catch (error) {
					if (this.closedError !== undefined) throw this.closedError;
					throw this.onFault(error);
				}
			});
		} catch (error) {
			if (this.closedError !== undefined) throw this.closedError;
			throw error;
		}
		if (outcome.kind === "reject") throw outcome.error;
		return outcome.result;
	}

	async accept(): Promise<never> {
		throw new SliceNotImplemented("accept");
	}

	async drive(): Promise<never> {
		throw new SliceNotImplemented("drive");
	}

	async requestAbort(): Promise<never> {
		throw new SliceNotImplemented("requestAbort");
	}

	async inspectExecution(): Promise<never> {
		throw new SliceNotImplemented("inspectExecution");
	}

	async prompt(): Promise<never> {
		throw new SliceNotImplemented("prompt");
	}

	async skill(): Promise<never> {
		throw new SliceNotImplemented("skill");
	}

	async promptFromTemplate(): Promise<never> {
		throw new SliceNotImplemented("promptFromTemplate");
	}

	async compact(): Promise<never> {
		throw new SliceNotImplemented("compact");
	}

	async navigateTree(): Promise<never> {
		throw new SliceNotImplemented("navigateTree");
	}

	async resume(): Promise<never> {
		throw new SliceNotImplemented("resume");
	}

	async abort(): Promise<never> {
		throw new SliceNotImplemented("abort");
	}

	async steer(): Promise<never> {
		throw new SliceNotImplemented("steer");
	}

	async followUp(): Promise<never> {
		throw new SliceNotImplemented("followUp");
	}

	async nextRun(): Promise<never> {
		throw new SliceNotImplemented("nextRun");
	}

	async cancelQueued(): Promise<never> {
		throw new SliceNotImplemented("cancelQueued");
	}

	async recordUsage(): Promise<never> {
		throw new SliceNotImplemented("recordUsage");
	}

	async waitForIdle(): Promise<never> {
		throw new SliceNotImplemented("waitForIdle");
	}

	async runWhenIdle(): Promise<never> {
		throw new SliceNotImplemented("runWhenIdle");
	}

	async peekAction(): Promise<never> {
		throw new SliceNotImplemented("peekAction");
	}

	async executeAction(): Promise<never> {
		throw new SliceNotImplemented("executeAction");
	}

	async runToCompletion(): Promise<never> {
		throw new SliceNotImplemented("runToCompletion");
	}

	async getModel(): Promise<Model<Api> | undefined> {
		this.assertOpen();
		return this.models.getModel(this.state.configuration.model.provider, this.state.configuration.model.modelId);
	}

	setModel(model: Model<Api>): Promise<void> {
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
		);
	}

	async getThinkingLevel(): Promise<ThinkingLevel> {
		this.assertOpen();
		return this.state.configuration.thinkingLevel;
	}

	setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({ ...configuration, thinkingLevel }),
			(previous, value) => ({
				type: "config_update",
				property: "thinkingLevel",
				previous: previous.thinkingLevel,
				value: value.thinkingLevel,
			}),
		);
	}

	async getActiveTools(): Promise<string[]> {
		this.assertOpen();
		return this.state.configuration.activeToolNames;
	}

	setActiveTools(activeToolNames: string[]): Promise<void> {
		return this.setConfiguration(
			(configuration) => ({ ...configuration, activeToolNames }),
			(previous, value) => ({
				type: "config_update",
				property: "activeTools",
				previous: previous.activeToolNames,
				value: value.activeToolNames,
			}),
		);
	}

	async watch(): Promise<never> {
		throw new SliceNotImplemented("watch");
	}

	private async setConfiguration(
		update: (configuration: LaneState["configuration"]) => LaneState["configuration"],
		event: (previous: LaneState["configuration"], value: LaneState["configuration"]) => LaneConfigEventPayload,
	): Promise<void> {
		const payload = await this.command((state) => {
			const configuration = update(state.configuration);
			return {
				kind: "commit",
				transaction: {
					writes: [
						{ kind: "register", op: "set", namespace: "lane.config", key: this.name, value: configuration },
					],
				},
				next: { ...state, configuration },
				materialize: () => event(state.configuration, configuration),
			};
		});
		await this.onEvent({ ...payload, lane: this.name });
	}

	private async findEntriesOnBranch(query: BranchScan = {}): Promise<Entry[]> {
		this.assertOpen();
		const start = query.start ?? this.state.leafId;
		return start === null ? [] : this.sessionView.findEntriesOnBranch({ ...query, start });
	}

	private async findEntryOnBranch(query: BranchScan = {}): Promise<Entry | undefined> {
		return (await this.findEntriesOnBranch({ ...query, limit: 1 }))[0];
	}

	private append(pending: PendingEntry): Promise<string> {
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
					transaction: {
						writes: [
							{
								kind: "entry",
								entry:
									pending.type === "message"
										? { id, parentId: state.leafId, type: "message", message: pending.payload }
										: {
												id,
												parentId: state.leafId,
												type: "custom",
												customType: pending.customType,
												...(pending.payload === undefined ? {} : { data: pending.payload }),
											},
							},
							{ kind: "register", op: "set", namespace: "lane.leaf", key: this.name, value: id },
						],
					},
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
				transaction: {
					writes: [
						{ kind: "register", op: "set", namespace: "pending.entry", key: id, value: pending },
						{
							kind: "register",
							op: "set",
							namespace: "op.state",
							key: state.operation.meta.operationId,
							value: operationState,
						},
					],
				},
				next: { ...state, operation: { meta: state.operation.meta, state: operationState } },
				materialize: () => id,
			};
		});
	}

	seal(error: Error): void {
		this.closedError ??= error;
	}

	assertOpen(): void {
		if (this.closedError !== undefined) throw this.closedError;
	}
}
