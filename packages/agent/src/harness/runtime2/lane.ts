import { type Api, type ImageContent, type Model, type Models, reduceAssistantMessageFrames } from "@draht/ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import {
	type AgentLane,
	Closed,
	HarnessClosed,
	type HarnessEvent,
	InvalidMessage,
	LaneBusy,
	type LaneConfigEventPayload,
	type LaneExecutionInfo,
	type LaneSnapshot,
	type ModelIdentity,
	type OperationAdmissionResult,
	type OperationRequest,
	type QueuedItem,
	UnknownSkill,
	UnknownTemplate,
	type WatchHandle,
} from "../agent-harness.ts";
import type { Context } from "../context.ts";
import { formatPromptTemplateInvocation } from "../prompt-templates.ts";
import { Result } from "../result.ts";
import { insertEntry } from "../session/commit.ts";
import { SessionInvariantError, SessionPendingAssistantMessageError } from "../session/session.ts";
import type {
	BranchScan,
	CommitResult,
	Entry,
	LaneLastResult,
	Operation,
	PendingEntry,
	Session,
	SessionReader,
	SessionTree,
	StructuralDecision,
	Write,
} from "../session/types.ts";
import {
	deleteValue,
	entryLabel,
	laneConfig,
	laneLeaf,
	laneState as laneStateValue,
	operationMeta as operationMetaValue,
	operationState as operationStateValue,
	operationToolArgs,
	pendingAssistantFrames,
	pendingEntry,
	pendingToolOutput,
	sessionName,
	setValue,
} from "../session/values.ts";
import { formatSkillInvocation } from "../skills.ts";
import { type AcceptanceConfig, type LaneState, SliceNotImplemented } from "./types.ts";

type EmitBatch = (events: readonly HarnessEvent[], context: Context) => Promise<void>;
type WatchHandler = <T>(snapshot: T, filter: (event: HarnessEvent) => boolean, context: Context) => WatchHandle<T>;
type FaultHandler = (cause: unknown, context: Context) => Error;
type Synchronous<TResult> = TResult extends PromiseLike<unknown> ? never : TResult;

type LaneCommand<TResult> =
	| {
			kind: "commit";
			writes: Write[];
			next: LaneState;
			materialize(commit: CommitResult): Synchronous<TResult>;
			events?(commit: CommitResult): HarnessEvent[];
	  }
	| { kind: "return"; result: TResult }
	| { kind: "reject"; error: Error };

type LaneCommandOutcome<TResult> =
	| { kind: "return"; result: TResult; delivery?: Promise<void> }
	| { kind: "reject"; error: Error };

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	return "then" in value && typeof value.then === "function";
}

function structuralModel(structural: StructuralDecision): ModelIdentity | undefined {
	return structural.status === "generating" ? structural.generation.context.configuration.model : undefined;
}

function capturedModel(operation: Operation): ModelIdentity | undefined {
	const { state } = operation;
	if (state.kind === "compaction") return structuralModel(state.structural);
	if (state.kind === "navigation") {
		return state.summarize ? structuralModel(state.phase.structural) : undefined;
	}
	switch (state.phase.kind) {
		case "assistant":
			return state.phase.generation.context.configuration.model;
		case "tools":
			return state.phase.batch.configuration.model;
		case "compaction":
			return structuralModel(state.phase.structural);
		case "deferred":
			return state.phase.deferred.configuration.model;
		case "starting":
		case "checkpoint":
		case "failure_drain":
			return undefined;
	}
}

/** Runtime2 implementation of one configured lane. */
export class Lane implements AgentLane {
	readonly name: string;
	readonly sessionTree: SessionTree;
	private readonly sessionView: SessionTree;
	protected readonly session: Session;
	protected readonly models: Models;
	private readonly onFault: FaultHandler;
	private readonly emitBatch: EmitBatch;
	private readonly installWatch: WatchHandler;
	private readonly getAcceptanceConfig: () => AcceptanceConfig;
	state: LaneState;
	closedError: Error | undefined;

	constructor(
		name: string,
		session: Session,
		models: Models,
		state: LaneState,
		onFault: FaultHandler,
		emitBatch: EmitBatch,
		installWatch: WatchHandler,
		getAcceptanceConfig: () => AcceptanceConfig,
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
		this.emitBatch = emitBatch;
		this.installWatch = installWatch;
		this.getAcceptanceConfig = getAcceptanceConfig;
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
				},
				context,
			);
		} catch (error) {
			if (this.closedError !== undefined) throw this.closedError;
			throw error;
		}
		if (outcome.kind === "reject") throw outcome.error;
		await outcome.delivery;
		return outcome.result;
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
		const acceptanceConfig = this.getAcceptanceConfig();
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
			const capturedIds = [...state.pendingNextRun];
			const captured = await Promise.all(
				capturedIds.map(async (id) => {
					const stored = await reader.getValue(pendingEntry(id), context);
					if (stored?.value.type !== "message") {
						throw new SessionInvariantError(`Pending next-run entry ${id} is missing a message payload`);
					}
					if (stored.value.payload.role === "assistant" && stored.value.payload.stopReason === "pending") {
						throw new SessionInvariantError(`Pending next-run entry ${id} contains a pending assistant message`);
					}
					return { id, message: stored.value.payload };
				}),
			);
			const placed = [...captured, ...prompt];
			if (placed.length === 0) {
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

			let parentId = state.leafId;
			const entryWrites = placed.map(({ id, message }) => {
				const write = insertEntry({ id, parentId, type: "message", message });
				parentId = id;
				return write;
			});
			const meta = {
				operationId,
				lane: this.name,
				sourceLeafId: state.leafId,
				startedAt,
				intent: { kind: "run" as const, promptEntryIds: prompt.map(({ id }) => id) },
			};
			const operationState = {
				kind: "run" as const,
				control: { status: "running" as const },
				settings: {
					compaction: acceptanceConfig.compaction,
					steeringMode: acceptanceConfig.steeringMode,
					followUpMode: acceptanceConfig.followUpMode,
					toolExecution: acceptanceConfig.toolExecution,
				},
				phase: { kind: "starting" as const },
				inbox: { steer: [], followUp: [], writes: [] },
				latestAssistantEntryId: null,
			};
			const next: LaneState = {
				...state,
				leafId: parentId,
				pendingNextRun: [],
				operation: { meta, state: operationState },
			};
			return {
				kind: "commit",
				writes: [
					...entryWrites,
					...capturedIds.map((id) => deleteValue(pendingEntry(id))),
					setValue(laneLeaf(this.name), parentId),
					setValue(operationMetaValue(operationId), meta),
					setValue(operationStateValue(operationId), operationState),
					setValue(laneStateValue(this.name), { currentOperationId: operationId, pendingNextRun: [] }),
				],
				next,
				materialize: () => Result.ok({ operationId, kind: "run", startedAt }),
				events: (commit) => {
					const events: HarnessEvent[] = [{ type: "run_start", runId: operationId, lane: this.name }];
					for (const [index, item] of placed.entries()) {
						const parent = index === 0 ? state.leafId : placed[index - 1]!.id;
						const entry: Entry = {
							id: item.id,
							parentId: parent,
							type: "message",
							message: item.message,
							seq: commit.seqs[index]!,
							timestamp: commit.timestamp,
						};
						events.push(
							{ type: "message_start", runId: operationId, message: item.message, lane: this.name },
							{
								type: "message_end",
								runId: operationId,
								message: item.message,
								entryId: item.id,
								lane: this.name,
							},
							{ type: "entry_added", entry, lane: this.name },
						);
					}
					if (captured.length !== 0) {
						events.push({
							type: "queue_update",
							steer: [],
							followUp: [],
							nextRun: [],
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
					leafId: state.leafId,
					configuredModel: state.configuration.model,
					current,
					...(state.lastResult === undefined ? {} : { lastResult: state.lastResult }),
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
					captured.leafId === null
						? []
						: (
								await reader.scanBranch(
									{ start: captured.leafId, stopAtType: "compaction", order: "newestFirst" },
									context,
								)
							).reverse();
				const queuedItems = async (ids: readonly string[], description: string): Promise<QueuedItem[]> =>
					Promise.all(
						ids.map(async (entryId) => {
							const stored = await reader.getValue(pendingEntry(entryId), context);
							if (stored?.value.type !== "message") {
								throw new SessionInvariantError(`${description} ${entryId} is missing a message payload`);
							}
							return { entryId, message: stored.value.payload };
						}),
					);
				const nextRun = await queuedItems(captured.pendingNextRun, "Pending next-run entry");
				const operation = captured.operation;
				const steer =
					operation?.state.kind === "run" ? await queuedItems(operation.state.inbox.steer, "Steer entry") : [];
				const followUp =
					operation?.state.kind === "run"
						? await queuedItems(operation.state.inbox.followUp, "Follow-up entry")
						: [];
				// TODO does a client really need pending writes? We wouldn't visualize those, any other uses for them?
				const pendingWrites =
					operation?.state.kind === "run"
						? await Promise.all(
								operation.state.inbox.writes.map(async (entryId) => {
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
							)
						: [];

				let operationSnapshot: NonNullable<LaneSnapshot["operation"]> | null = null;
				if (operation !== null) {
					const runningTools: NonNullable<LaneSnapshot["operation"]>["runningTools"] = [];
					let streamingMessage: NonNullable<LaneSnapshot["operation"]>["streamingMessage"];
					let retry: NonNullable<LaneSnapshot["operation"]>["retry"];
					let deferred: NonNullable<LaneSnapshot["operation"]>["deferred"];
					// TODO we should always read the full frame list here, assistant messages
					// are never humongous
					const readStreamingMessage = async (responseEntryId: string) => {
						const frames = [];
						let cursor: { seq: number } | undefined;
						while (frames.length < 10_000) {
							const limit = Math.min(1_000, 10_000 - frames.length);
							const page = await reader.readList(
								pendingAssistantFrames(operation.meta.operationId, responseEntryId),
								{ order: "asc", limit, ...(cursor === undefined ? {} : { cursor }) },
								context,
							);
							frames.push(...page.map(({ value }) => value));
							if (page.length < limit) break;
							cursor = { seq: page[page.length - 1]!.seq };
						}
						return reduceAssistantMessageFrames(frames);
					};
					const readRetry = (generation: {
						status: string;
						nextAttempt?: number;
						notBefore?: number;
						context: { retryPolicy: { maxAttempts: number } };
					}) => {
						if (generation.status !== "retry_wait") return undefined;
						if (generation.nextAttempt === undefined || generation.notBefore === undefined) {
							throw new SessionInvariantError("Retry wait is missing retry metadata");
						}
						return {
							attempt: generation.nextAttempt,
							maxAttempts: generation.context.retryPolicy.maxAttempts,
							nextAttemptAt: generation.notBefore,
						};
					};
					const readStructuralRetry = (structural: StructuralDecision) => {
						if (structural.status !== "generating") return undefined;
						return readRetry(structural.generation);
					};

					if (operation.state.kind === "run") {
						switch (operation.state.phase.kind) {
							case "assistant":
								retry = readRetry(operation.state.phase.generation);
								if (operation.state.phase.generation.status === "effect_pending") {
									streamingMessage = await readStreamingMessage(
										operation.state.phase.generation.responseEntryId,
									);
								}
								break;
							case "deferred": {
								const durable = operation.state.phase.deferred;
								const source = (await reader.getEntries([durable.sourceEntryId], context)).get(
									durable.sourceEntryId,
								);
								if (
									source?.type !== "message" ||
									source.message.role !== "assistant" ||
									source.message.deferred === undefined
								) {
									throw new SessionInvariantError("Deferred source is missing its assistant handle");
								}
								deferred = { handle: source.message.deferred, poll: durable.poll };
								if (durable.status === "effect_pending") {
									streamingMessage = await readStreamingMessage(durable.responseEntryId);
								}
								break;
							}
							case "tools": {
								const { batch } = operation.state.phase;
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
							case "compaction":
								retry = readStructuralRetry(operation.state.phase.structural);
								break;
							case "starting":
							case "checkpoint":
							case "failure_drain":
								break;
						}
					} else if (operation.state.kind === "compaction") {
						retry = readStructuralRetry(operation.state.structural);
					} else if (operation.state.summarize) {
						retry = readStructuralRetry(operation.state.phase.structural);
					}

					const drained =
						operation.state.control.status === "cancel_requested"
							? {
									steer: await queuedItems(operation.state.control.drainedSteer, "Drained steer entry"),
									followUp: await queuedItems(
										operation.state.control.drainedFollowUp,
										"Drained follow-up entry",
									),
								}
							: undefined;
					operationSnapshot = {
						id: operation.meta.operationId,
						kind: operation.meta.intent.kind,
						startedAt: operation.meta.startedAt,
						status: operation.state.control.status === "cancel_requested" ? "aborting" : "open",
						...(retry === undefined ? {} : { retry }),
						...(deferred === undefined ? {} : { deferred }),
						...(drained === undefined ? {} : { drained }),
						...(streamingMessage === undefined ? {} : { streamingMessage }),
						runningTools,
					};
				}

				watcher.snapshot = structuredClone({
					lane: this.name,
					transcript,
					leafId: captured.leafId,
					...(captured.lastResult === undefined ? {} : { lastResult: captured.lastResult }),
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

	private async setName(name: string | undefined, context: Context): Promise<void> {
		await this.command(
			(state) => ({
				kind: "commit",
				writes: [name === undefined ? deleteValue(sessionName) : setValue(sessionName, name)],
				next: state,
				materialize: () => undefined,
				events: () => [{ type: "value_update", value: "session_name", name }],
			}),
			context,
		);
	}

	private async setLabel(targetId: string, label: string | undefined, context: Context): Promise<void> {
		await this.command(
			(state) => ({
				kind: "commit",
				writes: [label === undefined ? deleteValue(entryLabel(targetId)) : setValue(entryLabel(targetId), label)],
				next: state,
				materialize: () => undefined,
				events: () => [{ type: "value_update", value: "entry_label", targetId, label }],
			}),
			context,
		);
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
					events: (commit) => {
						const entry: Entry =
							pending.type === "message"
								? {
										id,
										parentId: state.leafId,
										type: "message",
										message: pending.payload,
										seq: commit.seqs[0]!,
										timestamp: commit.timestamp,
									}
								: {
										id,
										parentId: state.leafId,
										type: "custom",
										customType: pending.customType,
										...(pending.payload === undefined ? {} : { data: pending.payload }),
										seq: commit.seqs[0]!,
										timestamp: commit.timestamp,
									};
						return pending.type === "message"
							? [
									{ type: "message_start", message: pending.payload, lane: this.name },
									{ type: "message_end", message: pending.payload, entryId: id, lane: this.name },
									{ type: "entry_added", entry, lane: this.name },
								]
							: [{ type: "entry_added", entry, lane: this.name }];
					},
				};
			}

			const operation = state.operation;
			if (operation.state.kind !== "run") {
				return {
					kind: "reject",
					error: new Error(`Cannot append while structural operation ${operation.meta.operationId} is active`),
				};
			}
			const operationState = {
				...operation.state,
				inbox: {
					...operation.state.inbox,
					writes: [...operation.state.inbox.writes, id],
				},
			};
			return {
				kind: "commit",
				writes: [
					setValue(pendingEntry(id), pending),
					setValue(operationStateValue(operation.meta.operationId), operationState),
				],
				next: { ...state, operation: { meta: operation.meta, state: operationState } },
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
	}

	assertOpen(): void {
		if (this.closedError !== undefined) throw this.closedError;
	}
}
