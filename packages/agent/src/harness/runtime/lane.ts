import { type Api, type ImageContent, type Model, type Models, reduceAssistantMessageFrames } from "@draht/ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import type {
	AbortRequestResult,
	AgentLane,
	HarnessEvent,
	LaneConfigEventPayload,
	LaneExecutionInfo,
	LaneSnapshot,
	ModelIdentity,
	OperationAdmissionResult,
	OperationRequest,
	WatchHandle,
} from "../agent-harness.ts";
import type { Context } from "../context.ts";
import type { HookRegistry } from "../hooks.ts";
import { formatPromptTemplateInvocation } from "../prompt-templates.ts";
import {
	Closed,
	HarnessClosed,
	InvalidMessage,
	LaneBusy,
	OperationMismatch,
	Result,
	UnknownSkill,
	UnknownTemplate,
} from "../result.ts";
import { insertEntry } from "../session/commit.ts";
import { SessionInvariantError, SessionPendingAssistantMessageError } from "../session/session.ts";
import type {
	BranchScan,
	Entry,
	InboxItem,
	InboxItemKind,
	JsonValue,
	NewEntry,
	Operation,
	OperationMeta,
	OperationResultRecord,
	OperationState,
	PendingEntry,
	Session,
	SessionReader,
	StartingOperation,
} from "../session/types.ts";
import {
	branchTip,
	deleteValue,
	laneConfig,
	laneState as laneStateValue,
	operationMeta as operationMetaValue,
	operationResult as operationResultValue,
	operationState as operationStateValue,
	operationToolArgs,
	pendingEntry,
	pendingToolOutput,
	setValue,
} from "../session/values.ts";
import { formatSkillInvocation } from "../skills.ts";
import { readAssistantFrames } from "./progress.ts";
import { chainEntries, committedEntryEvents, readPendingMessages } from "./transcript.ts";
import {
	type Config,
	type ContinueOperationResult,
	type Drive,
	type LaneCommand,
	type LaneState,
	type OperationCommand,
	SliceNotImplemented,
} from "./types.ts";

type EmitBatch = (events: readonly HarnessEvent[], context: Context) => Promise<void>;
type WatchHandler = <T>(snapshot: T, filter: (event: HarnessEvent) => boolean, context: Context) => WatchHandle<T>;
type FaultHandler = (cause: unknown, context: Context) => Error;

type LaneCommandOutcome<TResult> =
	| { kind: "return"; result: TResult; delivery?: Promise<void> }
	| { kind: "reject"; error: Error };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	return "then" in value && typeof value.then === "function";
}

function inboxItems(inbox: readonly InboxItem[], kind: InboxItemKind): InboxItem[] {
	return inbox.filter((item) => item.kind === kind);
}

function withoutInboxItems(inbox: readonly InboxItem[], removed: readonly InboxItem[]): InboxItem[] {
	const removedIds = new Set(removed.map((item) => item.entryId));
	return inbox.filter((item) => !removedIds.has(item.entryId));
}

function selectAcceptedInbox(
	inbox: readonly InboxItem[],
	steeringMode: "all" | "one-at-a-time",
	followUpMode: "all" | "one-at-a-time",
): { selected: InboxItem[]; remainder: InboxItem[] } {
	let steerTaken = false;
	let followUpTaken = false;
	const selected: InboxItem[] = [];
	const remainder: InboxItem[] = [];
	for (const item of inbox) {
		const eligible =
			item.kind === "write" ||
			item.kind === "nextRun" ||
			(item.kind === "steer" && (steeringMode === "all" || !steerTaken)) ||
			(item.kind === "followUp" && (followUpMode === "all" || !followUpTaken));
		if (eligible) {
			selected.push(item);
			if (item.kind === "steer") steerTaken = true;
			if (item.kind === "followUp") followUpTaken = true;
		} else {
			remainder.push(item);
		}
	}
	return { selected, remainder };
}

function pendingEntryWrite(entryId: string, pending: PendingEntry): NewEntry {
	return pending.type === "message"
		? { id: entryId, parentId: null, type: "message", message: pending.payload }
		: {
				id: entryId,
				parentId: null,
				type: "custom",
				customType: pending.customType,
				...(pending.payload === undefined ? {} : { data: pending.payload }),
			};
}

function capturedModel(operation: Operation): ModelIdentity | undefined {
	const { state } = operation;
	switch (state.at) {
		case "assistant.ready":
		case "assistant.effect_pending":
		case "assistant.retry_wait":
			return state.generationContext.configuration.model;
		case "tools":
			return state.batch.configuration.model;
		case "deferred.suspended":
		case "deferred.effect_pending":
			return state.configuration.model;
		case "summary.ready":
		case "summary.effect_pending":
		case "summary.retry_wait":
			return state.summaryContext.configuration.model;
		default:
			return undefined;
	}
}

/** Runtime implementation of one configured lane. */
export class Lane<TContext extends object | undefined> implements AgentLane {
	readonly name: string;
	readonly session: Session;
	readonly models: Models;
	readonly hooks: HookRegistry;
	readonly emitBatch: EmitBatch;
	private readonly onFault: FaultHandler;
	private readonly installWatch: WatchHandler;
	private readonly config: () => Config<TContext>;
	/** Package-internal drive owner. Public only because deterministic procedure tests install exact owners directly. */
	activeDrive: Drive | undefined;
	/** Authoritative live control projection while this harness owns the Session. */
	state: LaneState;
	closedError: Error | undefined;

	constructor(
		name: string,
		session: Session,
		models: Models,
		hooks: HookRegistry,
		state: LaneState,
		onFault: FaultHandler,
		emitBatch: EmitBatch,
		installWatch: WatchHandler,
		readConfig: () => Config<TContext>,
	) {
		this.session = session;
		this.models = models;
		this.hooks = hooks;
		this.name = name;
		this.state = state;
		this.onFault = onFault;
		this.emitBatch = emitBatch;
		this.installWatch = installWatch;
		this.config = readConfig;
	}

	async getTipId(_context: Context): Promise<string | null> {
		this.assertOpen();
		return this.state.tipId;
	}

	async getResult(operationId: string, context: Context): Promise<OperationResultRecord | undefined> {
		this.assertOpen();
		return (await this.session.getValue(operationResultValue(operationId), context))?.value;
	}

	readConfig(): Config<TContext> {
		return this.config();
	}

	mismatch(expected: string, currentOperationId: string | null, lastOperationId: string | null): OperationMismatch {
		return new OperationMismatch({
			lane: this.name,
			expectedOperationId: expected,
			...(currentOperationId === null ? {} : { currentOperationId }),
			...(lastOperationId === null ? {} : { lastOperationId }),
			message: `Operation ${expected} does not own lane ${JSON.stringify(this.name)}`,
		});
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
	 * - `return` returns without a commit, boxed so a promise value is not awaited while holding the Session line;
	 * - `reject` rejects outside the mutation/fault boundary as an expected caller error without a commit.
	 *
	 * Planner, commit, and materialization errors fault the harness before releasing the Session line. Close/fault gates
	 * are checked both before queueing and when the callback starts: close-first rejects, while a callback admitted
	 * before close may finish its commit, publish memory, and resolve without another open check. Never invoke providers,
	 * tools, hooks, timers, event handlers, or wait for task completion here; perform those after `command()` returns.
	 */
	async command<TResult>(
		plan: (state: LaneState, reader: SessionReader) => LaneCommand<TResult> | Promise<LaneCommand<TResult>>,
		context: Context,
	): Promise<TResult> {
		this.assertOpen();
		let outcome: LaneCommandOutcome<TResult>;
		try {
			outcome = await this.session.mutate(async (mutator) => {
				this.assertOpen();
				try {
					const decision = await plan(this.state, mutator);
					switch (decision.kind) {
						case "return":
							return { kind: "return", result: decision.result };
						case "reject":
							return { kind: "reject", error: decision.error };
						case "commit": {
							const commit = await mutator.commit(decision.writes, context);
							this.state = decision.next;
							const result = decision.materialize(commit);
							if (isPromiseLike(result)) {
								throw new TypeError("Lane command materialize() must be synchronous");
							}
							const events = decision.events?.(commit) ?? [];
							const delivery = events.length === 0 ? undefined : this.emitBatch(events, context);
							return { kind: "return", result, ...(delivery === undefined ? {} : { delivery }) };
						}
					}
				} catch (error) {
					if (this.closedError !== undefined) throw this.closedError;
					throw this.onFault(error, context);
				}
			}, context);
		} catch (error) {
			if (this.closedError !== undefined) throw this.closedError;
			throw error;
		}
		if (outcome.kind === "reject") throw outcome.error;
		await outcome.delivery;
		return outcome.result;
	}

	/**
	 * Run a command against the current operation even after cancellation is requested. Use this to settle admitted
	 * effects, finish the operation, or update concurrent child state. The capability narrows the planner's state type;
	 * the Drive continuation remains the sole top-level state writer.
	 */
	settleOperation<TState extends OperationState, TResult>(
		_capability: TState,
		plan: (
			state: LaneState,
			current: TState,
			meta: OperationMeta,
			reader: SessionReader,
		) => OperationCommand<TResult> | Promise<OperationCommand<TResult>>,
		context: Context,
	): Promise<TResult> {
		return this.command(async (state, reader) => {
			const operation = state.operation!;
			const decision = await plan(state, operation.state as TState, operation.meta, reader);
			if (decision.kind === "commit") {
				return {
					kind: "commit",
					writes: [
						...decision.writes,
						setValue(operationStateValue(operation.meta.operationId), decision.operationState),
						...(decision.lane?.inbox === undefined
							? []
							: [
									setValue(laneStateValue(this.name), {
										currentOperationId: operation.meta.operationId,
										lastOperationId: state.lastOperationId,
										inbox: decision.lane.inbox,
									}),
								]),
					],
					next: {
						...state,
						...decision.lane,
						operation: { meta: operation.meta, state: decision.operationState },
					},
					materialize: decision.materialize,
					...(decision.events === undefined ? {} : { events: decision.events }),
				};
			}
			if (decision.kind !== "finish") return decision;
			const inbox = decision.lane?.inbox ?? state.inbox;
			return {
				kind: "commit",
				writes: [
					...decision.writes,
					setValue(operationResultValue(operation.meta.operationId), decision.record),
					setValue(laneStateValue(this.name), {
						currentOperationId: null,
						lastOperationId: operation.meta.operationId,
						inbox,
					}),
				],
				next: {
					...state,
					...decision.lane,
					inbox,
					lastOperationId: operation.meta.operationId,
					operation: null,
				},
				materialize: decision.materialize,
				...(decision.events === undefined ? {} : { events: decision.events }),
			};
		}, context);
	}

	/**
	 * Run an ordinary operation command only while durable control is running. Use this before starting new hooks,
	 * effects, or forward progress. Returns `cancel_requested` without invoking the planner once cancellation is requested.
	 */
	continueOperation<TState extends OperationState, TResult>(
		capability: TState,
		plan: (
			state: LaneState,
			current: TState,
			meta: OperationMeta,
			reader: SessionReader,
		) => OperationCommand<TResult> | Promise<OperationCommand<TResult>>,
		context: Context,
	): Promise<ContinueOperationResult<TResult>> {
		return this.settleOperation<TState, ContinueOperationResult<TResult>>(
			capability,
			async (state, latest, meta, reader) => {
				if (latest.control.status === "cancel_requested") {
					return { kind: "return", result: { kind: "cancel_requested" } };
				}
				const decision = await plan(state, latest, meta, reader);
				if (decision.kind === "return") {
					return { kind: "return", result: { kind: "result", value: decision.result } };
				}
				return {
					...decision,
					materialize: (commit) => ({ kind: "result", value: decision.materialize(commit) }),
				};
			},
			context,
		);
	}

	async accept(request: OperationRequest, context: Context): Promise<OperationAdmissionResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();
		if (request.kind === "compaction" || request.kind === "navigation") {
			throw new SliceNotImplemented(`accept(${request.kind})`);
		}

		const startedAt = Date.now();
		const operationId = request.operationId ?? this.session.idGenerator.next(startedAt);
		const acceptanceConfig = this.readConfig();
		let messages: AgentMessage[];
		switch (request.kind) {
			case "prompt":
				if (typeof request.prompt !== "string") {
					messages = Array.isArray(request.prompt) ? request.prompt : [request.prompt];
				} else {
					const images = request.images ?? [];
					messages =
						request.prompt.length === 0 && images.length === 0
							? []
							: [
									{
										role: "user",
										content: [
											...(request.prompt.length === 0
												? []
												: [{ type: "text" as const, text: request.prompt }]),
											...images,
										],
										timestamp: startedAt,
									},
								];
				}
				break;
			case "skill": {
				const skill = acceptanceConfig.resources.skills?.find((candidate) => candidate.name === request.name);
				if (skill === undefined) {
					return Result.err(new UnknownSkill({ name: request.name, message: `Unknown skill: ${request.name}` }));
				}
				messages = [
					{
						role: "user",
						content: [{ type: "text", text: formatSkillInvocation(skill, request.additionalInstructions) }],
						timestamp: startedAt,
					},
				];
				break;
			}
			case "prompt_template": {
				const template = acceptanceConfig.resources.promptTemplates?.find(
					(candidate) => candidate.name === request.name,
				);
				if (template === undefined) {
					return Result.err(
						new UnknownTemplate({ name: request.name, message: `Unknown prompt template: ${request.name}` }),
					);
				}
				const content = formatPromptTemplateInvocation(template, request.args);
				messages =
					content.length === 0
						? []
						: [{ role: "user", content: [{ type: "text", text: content }], timestamp: startedAt }];
				break;
			}
		}

		for (const message of messages) {
			if (message.role === "assistant" && message.stopReason === "pending") {
				return Result.err(
					new InvalidMessage({
						lane: this.name,
						reason: "pending_assistant",
						message: "Cannot accept a pending assistant message",
					}),
				);
			}
		}
		const prompt = messages.map((message) => ({ id: this.session.idGenerator.next(startedAt), message }));

		return this.command<OperationAdmissionResult>(async (state, reader) => {
			if (state.operation !== null) {
				return {
					kind: "return",
					result: Result.err(
						new LaneBusy({
							lane: this.name,
							operationId: state.operation.meta.operationId,
							operationKind: state.operation.meta.intent.kind,
							message: `Lane ${JSON.stringify(this.name)} already has an active operation`,
						}),
					),
				};
			}
			const { selected: selectedItems, remainder: inbox } = selectAcceptedInbox(
				state.inbox,
				acceptanceConfig.steeringMode,
				acceptanceConfig.followUpMode,
			);
			const captured = await Promise.all(
				selectedItems.map(async (item) => {
					const stored = await reader.getValue(pendingEntry(item.entryId), context);
					if (stored === undefined) {
						throw new SessionInvariantError(`Pending ${item.kind} entry ${item.entryId} is missing its payload`);
					}
					if (item.kind !== "write" && stored.value.type !== "message") {
						throw new SessionInvariantError(`Pending ${item.kind} entry ${item.entryId} is not a message`);
					}
					if (
						stored.value.type === "message" &&
						stored.value.payload.role === "assistant" &&
						stored.value.payload.stopReason === "pending"
					) {
						throw new SessionInvariantError(
							`Pending ${item.kind} entry ${item.entryId} contains a pending assistant`,
						);
					}
					return { item, pending: stored.value };
				}),
			);
			const hasCapturedConversation = selectedItems.some((item) => item.kind !== "write");
			if (prompt.length === 0 && !hasCapturedConversation) {
				return {
					kind: "return",
					result: Result.err(
						new InvalidMessage({
							lane: this.name,
							reason: "empty",
							message: "Acceptance must append at least one message",
						}),
					),
				};
			}

			const entries = chainEntries(state.tipId, [
				...captured.map(({ item, pending }) => pendingEntryWrite(item.entryId, pending)),
				...prompt.map(({ id, message }) => ({ id, parentId: null, type: "message" as const, message })),
			]);
			const parentId = entries[entries.length - 1]!.id;
			const meta = {
				operationId,
				lane: this.name,
				sourceTipId: state.tipId,
				startedAt,
				intent: { kind: "run" as const, promptEntryIds: prompt.map(({ id }) => id) },
			};
			const operationState: StartingOperation = {
				at: "starting",
				control: { status: "running" },
				settings: {
					compaction: acceptanceConfig.compaction,
					steeringMode: acceptanceConfig.steeringMode,
					followUpMode: acceptanceConfig.followUpMode,
					toolExecution: acceptanceConfig.toolExecution,
				},
				latestAssistantEntryId: null,
			};
			const [remainingSteer, remainingFollowUp, remainingNextRun] = await Promise.all([
				readPendingMessages(
					reader,
					inboxItems(inbox, "steer").map((item) => item.entryId),
					"Steer entry",
					context,
				),
				readPendingMessages(
					reader,
					inboxItems(inbox, "followUp").map((item) => item.entryId),
					"Follow-up entry",
					context,
				),
				readPendingMessages(
					reader,
					inboxItems(inbox, "nextRun").map((item) => item.entryId),
					"Pending next-run entry",
					context,
				),
			]);
			const next: LaneState = {
				...state,
				tipId: parentId,
				inbox,
				operation: { meta, state: operationState },
			};
			return {
				kind: "commit",
				writes: [
					...entries.map((entry) => insertEntry(entry)),
					...selectedItems.map((item) => deleteValue(pendingEntry(item.entryId))),
					setValue(branchTip(this.name), parentId),
					setValue(operationMetaValue(operationId), meta),
					setValue(operationStateValue(operationId), operationState),
					setValue(laneStateValue(this.name), {
						currentOperationId: operationId,
						lastOperationId: state.lastOperationId,
						inbox,
					}),
				],
				next,
				materialize: () => Result.ok({ operationId, kind: "run", startedAt }),
				events: (commit) => {
					const events: HarnessEvent[] = [
						{ type: "run_start", runId: operationId, lane: this.name },
						...committedEntryEvents(entries, commit, this.name, operationId),
					];
					if (hasCapturedConversation) {
						events.push({
							type: "queue_update",
							steer: remainingSteer,
							followUp: remainingFollowUp,
							nextRun: remainingNextRun,
							lane: this.name,
						});
					}
					return events;
				},
			};
		}, context);
	}

	async drive(..._args: Parameters<AgentLane["drive"]>): Promise<never> {
		throw new SliceNotImplemented("drive");
	}

	/** Package-private durable cancellation primitive. Public exposure remains guarded until M8. */
	async requestOperationAbort(operationId: string, context: Context): Promise<AbortRequestResult> {
		if (this.closedError instanceof HarnessClosed) {
			return Result.err(new Closed({ message: this.closedError.message }));
		}
		this.assertOpen();

		const drive = this.activeDrive?.operationId === operationId ? this.activeDrive : undefined;
		let resolveCancellation!: () => void;
		let rejectCancellation!: (error: unknown) => void;
		const cancellation = new Promise<void>((resolve, reject) => {
			resolveCancellation = resolve;
			rejectCancellation = reject;
		});
		void cancellation.catch(() => {});
		drive?.beginAbort(cancellation);
		let gateSettled = false;
		const settleGate = (signal: boolean): void => {
			if (gateSettled) return;
			gateSettled = true;
			resolveCancellation();
			if (signal) drive?.signalAbort();
		};

		try {
			const result = await this.command<AbortRequestResult>(async (state, reader) => {
				const operation = state.operation;
				if (operation?.meta.operationId !== operationId) {
					return {
						kind: "return",
						result: Result.err(
							this.mismatch(operationId, operation?.meta.operationId ?? null, state.lastOperationId),
						),
					};
				}
				if (operation.state.control.status === "cancel_requested") {
					return {
						kind: "return",
						result: Result.ok({ operationId, newlyRequested: false, steer: [], followUp: [] }),
					};
				}

				const removed = state.inbox.filter((item) => item.kind === "steer" || item.kind === "followUp");
				const payloads = await Promise.all(
					removed.map(async (item) => {
						const stored = await reader.getValue(pendingEntry(item.entryId), context);
						if (stored?.value.type !== "message") {
							throw new SessionInvariantError(
								`Pending ${item.kind} entry ${item.entryId} is missing its message`,
							);
						}
						return { item, message: stored.value.payload };
					}),
				);
				const steer = payloads.filter(({ item }) => item.kind === "steer").map(({ message }) => message);
				const followUp = payloads.filter(({ item }) => item.kind === "followUp").map(({ message }) => message);
				const removedIds = new Set(removed.map((item) => item.entryId));
				const inbox = state.inbox.filter((item) => !removedIds.has(item.entryId));
				const operationState: OperationState = {
					...operation.state,
					control: { status: "cancel_requested", requestedAt: Date.now() },
				};
				return {
					kind: "commit",
					writes: [
						...removed.map((item) => deleteValue(pendingEntry(item.entryId))),
						setValue(operationStateValue(operationId), operationState),
						setValue(laneStateValue(this.name), {
							currentOperationId: operationId,
							lastOperationId: state.lastOperationId,
							inbox,
						}),
					],
					next: { ...state, inbox, operation: { meta: operation.meta, state: operationState } },
					materialize: () => {
						settleGate(true);
						return Result.ok({ operationId, newlyRequested: true, steer, followUp });
					},
					events: () => [
						{
							type: "operation_abort",
							operationId,
							steer,
							followUp,
							lane: this.name,
						},
					],
				};
			}, context);
			// A fresh Drive may observe an already-durable marker; pull its gate on the repeat path too.
			settleGate(result.ok && result.value.newlyRequested === false);
			return result;
		} catch (error) {
			if (!gateSettled) rejectCancellation(error);
			throw error;
		}
	}

	async requestAbort(..._args: Parameters<AgentLane["requestAbort"]>): Promise<never> {
		throw new SliceNotImplemented("requestAbort");
	}

	inspectExecution(context: Context): Promise<LaneExecutionInfo> {
		return this.command((state) => {
			const operation = state.operation;
			const captured = operation === null ? undefined : capturedModel(operation);
			const current =
				operation === null
					? null
					: {
							id: operation.meta.operationId,
							kind: operation.meta.intent.kind,
							status:
								operation.state.control.status === "cancel_requested"
									? ("aborting" as const)
									: ("open" as const),
							startedAt: operation.meta.startedAt,
							...(captured === undefined ? {} : { capturedModel: captured }),
						};
			return {
				kind: "return",
				result: {
					lane: this.name,
					tipId: state.tipId,
					configuredModel: state.configuration.model,
					current,
					lastOperationId: state.lastOperationId,
				},
			};
		}, context);
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

	watch(context: Context): Promise<WatchHandle<LaneSnapshot>> {
		return this.command(async (state, reader) => {
			const watcher = this.installWatch<LaneSnapshot>(
				{} as LaneSnapshot,
				(event) => event.type === "usage" || !("lane" in event) || event.lane === this.name,
				context,
			);
			const captured = structuredClone(state);
			try {
				const transcript =
					captured.tipId === null
						? []
						: (
								await reader.scanBranch(
									{ start: captured.tipId, stopAtType: "compaction", order: "newestFirst" },
									context,
								)
							).reverse();
				const [steer, followUp, nextRun] = await Promise.all([
					readPendingMessages(
						reader,
						inboxItems(captured.inbox, "steer").map((item) => item.entryId),
						"Steer entry",
						context,
					),
					readPendingMessages(
						reader,
						inboxItems(captured.inbox, "followUp").map((item) => item.entryId),
						"Follow-up entry",
						context,
					),
					readPendingMessages(
						reader,
						inboxItems(captured.inbox, "nextRun").map((item) => item.entryId),
						"Pending next-run entry",
						context,
					),
				]);
				// TODO does a client really need pending writes? We wouldn't visualize those, any other uses for them?
				const pendingWrites = await Promise.all(
					inboxItems(captured.inbox, "write").map(async ({ entryId }) => {
						const stored = await reader.getValue(pendingEntry(entryId), context);
						if (stored === undefined) {
							throw new SessionInvariantError(`Pending write ${entryId} is missing its payload`);
						}
						return stored.value.type === "message"
							? { entryId, type: "message" as const, message: stored.value.payload }
							: {
									entryId,
									type: "custom" as const,
									customType: stored.value.customType,
									...(stored.value.payload === undefined ? {} : { data: stored.value.payload }),
								};
					}),
				);
				const operation = captured.operation;

				let operationSnapshot: NonNullable<LaneSnapshot["operation"]> | null = null;
				if (operation !== null) {
					const runningTools: NonNullable<LaneSnapshot["operation"]>["runningTools"] = [];
					let streamingMessage: NonNullable<LaneSnapshot["operation"]>["streamingMessage"];
					let retry: NonNullable<LaneSnapshot["operation"]>["retry"];
					let deferred: NonNullable<LaneSnapshot["operation"]>["deferred"];
					const readStreamingMessage = async (responseEntryId: string) =>
						reduceAssistantMessageFrames(
							await readAssistantFrames(reader, operation.meta.operationId, responseEntryId, context),
						);
					const state = operation.state;
					switch (state.at) {
						case "assistant.retry_wait":
							retry = {
								attempt: state.nextAttempt,
								maxAttempts: state.generationContext.retryPolicy.maxAttempts,
								nextAttemptAt: state.notBefore,
							};
							break;
						case "assistant.effect_pending":
							streamingMessage = await readStreamingMessage(state.responseEntryId);
							break;
						case "deferred.suspended":
						case "deferred.effect_pending": {
							const source = (await reader.getEntries([state.sourceEntryId], context)).get(state.sourceEntryId);
							if (
								source?.type !== "message" ||
								source.message.role !== "assistant" ||
								source.message.deferred === undefined
							) {
								throw new SessionInvariantError("Deferred source is missing its assistant handle");
							}
							deferred = { handle: source.message.deferred, poll: state.poll };
							if (state.at === "deferred.effect_pending") {
								streamingMessage = await readStreamingMessage(state.responseEntryId);
							}
							break;
						}
						case "tools": {
							const { batch } = state;
							const assistant = (await reader.getEntries([batch.assistantEntryId], context)).get(
								batch.assistantEntryId,
							);
							if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
								throw new SessionInvariantError("Tool batch assistant entry is invalid");
							}
							for (const call of batch.calls) {
								if (call.status !== "effect_pending") continue;
								const block = assistant.message.content[call.sourceIndex];
								if (block?.type !== "toolCall") {
									throw new SessionInvariantError(
										`Tool call source index ${call.sourceIndex} does not name a tool-call block`,
									);
								}
								const args = await reader.getValue(
									operationToolArgs(operation.meta.operationId, batch.turnId, call.sourceIndex),
									context,
								);
								if (args === undefined) {
									throw new SessionInvariantError(`Tool call ${block.id} is missing persisted arguments`);
								}
								const checkpoint = await reader.getValue(
									pendingToolOutput(operation.meta.operationId, call.resultEntryId),
									context,
								);
								runningTools.push({
									toolCallId: block.id,
									toolName: block.name,
									args: args.value,
									...(checkpoint === undefined ? {} : { partialResult: checkpoint.value }),
								});
							}
							break;
						}
						case "summary.retry_wait":
							retry = {
								attempt: state.nextAttempt,
								maxAttempts: state.summaryContext.retryPolicy.maxAttempts,
								nextAttemptAt: state.notBefore,
							};
							break;
						default:
							break;
					}

					operationSnapshot = {
						id: operation.meta.operationId,
						kind: operation.meta.intent.kind,
						startedAt: operation.meta.startedAt,
						status: operation.state.control.status === "cancel_requested" ? "aborting" : "open",
						...(retry === undefined ? {} : { retry }),
						...(deferred === undefined ? {} : { deferred }),
						...(streamingMessage === undefined ? {} : { streamingMessage }),
						runningTools,
					};
				}

				watcher.snapshot = structuredClone({
					lane: this.name,
					transcript,
					tipId: captured.tipId,
					lastOperationId: captured.lastOperationId,
					operation: operationSnapshot,
					queues: { steer, followUp, nextRun },
					pendingWrites,
					faulted: false,
				});
				return { kind: "return", result: watcher };
			} catch (error) {
				watcher.unsubscribe();
				throw error;
			}
		}, context);
	}

	private async setConfiguration(
		update: (configuration: LaneState["configuration"]) => LaneState["configuration"],
		event: (previous: LaneState["configuration"], value: LaneState["configuration"]) => LaneConfigEventPayload,
		context: Context,
	): Promise<void> {
		await this.command((state) => {
			const configuration = update(state.configuration);
			return {
				kind: "commit",
				writes: [setValue(laneConfig(this.name), configuration)],
				next: { ...state, configuration },
				materialize: () => undefined,
				events: () => [{ ...event(state.configuration, configuration), lane: this.name }],
			};
		}, context);
	}

	async findEntries(query: BranchScan | undefined, context: Context): Promise<Entry[]> {
		query ??= {};
		this.assertOpen();
		const start = query.start ?? this.state.tipId;
		return start === null
			? []
			: this.session.scanBranch({ ...query, start, order: query.order ?? "newestFirst" }, context);
	}

	async findEntry(query: BranchScan | undefined, context: Context): Promise<Entry | undefined> {
		query ??= {};
		return (
			await this.findEntries({ ...query, limit: query.limit === undefined ? 1 : Math.min(query.limit, 1) }, context)
		)[0];
	}

	appendMessage(message: AgentMessage, context: Context): Promise<string> {
		return this.append({ type: "message", payload: message }, context);
	}

	appendCustomEntry(customType: string, data: JsonValue | undefined, context: Context): Promise<string> {
		return this.append({ type: "custom", customType, ...(data === undefined ? {} : { payload: data }) }, context);
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
		return this.command(async (state, reader) => {
			if (state.operation === null) {
				const queued = inboxItems(state.inbox, "write");
				const captured = await Promise.all(
					queued.map(async (item) => {
						const stored = await reader.getValue(pendingEntry(item.entryId), context);
						if (stored === undefined) {
							throw new SessionInvariantError(`Pending write ${item.entryId} is missing its payload`);
						}
						return pendingEntryWrite(item.entryId, stored.value);
					}),
				);
				const inbox = withoutInboxItems(state.inbox, queued);
				const entries = chainEntries(state.tipId, [...captured, pendingEntryWrite(id, pending)]);
				return {
					kind: "commit",
					writes: [
						...entries.map((entry) => insertEntry(entry)),
						...queued.map((item) => deleteValue(pendingEntry(item.entryId))),
						setValue(branchTip(this.name), id),
						setValue(laneStateValue(this.name), {
							currentOperationId: null,
							lastOperationId: state.lastOperationId,
							inbox,
						}),
					],
					next: { ...state, tipId: id, inbox },
					materialize: () => id,
					events: (commit) => committedEntryEvents(entries, commit, this.name),
				};
			}

			const operation = state.operation;
			const inbox = [...state.inbox, { entryId: id, kind: "write" as const }];
			return {
				kind: "commit",
				writes: [
					setValue(pendingEntry(id), pending),
					setValue(laneStateValue(this.name), {
						currentOperationId: operation.meta.operationId,
						lastOperationId: state.lastOperationId,
						inbox,
					}),
				],
				next: { ...state, inbox },
				materialize: () => id,
				events: () => [
					{
						type: "write_pending",
						runId: operation.meta.operationId,
						entryId: id,
						entryType: pending.type,
						lane: this.name,
					},
				],
			};
		}, context);
	}

	seal(error: Error): void {
		this.closedError ??= error;
		this.activeDrive?.closeGate(error);
	}

	assertOpen(): void {
		if (this.closedError !== undefined) throw this.closedError;
	}
}
