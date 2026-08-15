import type { Api, Model, Models } from "@draht/ai";
import type { ThinkingLevel } from "../../types.ts";
import type { AgentLane } from "../agent-harness.ts";
import { RuntimeSliceNotImplemented } from "../runtime/types.ts";
import type { CommitResult, Session, SessionReader, SessionTree, Transaction } from "../session/types.ts";
import type { LaneState } from "./types.ts";

type FaultHandler = (cause: unknown) => Error;

interface LaneTransition<TResult> {
	transaction: Transaction;
	next: LaneState;
	materialize(commit: CommitResult): TResult;
}

/** Runtime2 implementation of one configured lane. */
export class Lane implements AgentLane {
	readonly name: string;
	readonly sessionTree: SessionTree;
	readonly session: Session;
	readonly models: Models;
	readonly onFault: FaultHandler;
	state: LaneState;
	closedError: Error | undefined;

	constructor(name: string, session: Session, models: Models, state: LaneState, onFault: FaultHandler) {
		this.session = session;
		this.models = models;
		this.name = name;
		this.sessionTree = session.view(name);
		this.state = state;
		this.onFault = onFault;
	}

	async getLeafId(): Promise<string | null> {
		this.assertOpen();
		return this.state.leafId;
	}

	async getLastResult() {
		this.assertOpen();
		return this.state.lastResult;
	}

	async transition<TResult>(
		plan: (state: LaneState, reader: SessionReader) => LaneTransition<TResult> | Promise<LaneTransition<TResult>>,
	): Promise<TResult> {
		this.assertOpen();
		try {
			return await this.session.mutate(this.name, async (mutator) => {
				const transition = await plan(this.state, mutator);
				const commit = await mutator.commit(transition.transaction);
				this.state = transition.next;
				return transition.materialize(commit);
			});
		} catch (error) {
			if (this.closedError !== undefined) throw this.closedError;
			throw this.onFault(error);
		}
	}

	async accept(): Promise<never> {
		throw new RuntimeSliceNotImplemented("accept");
	}

	async drive(): Promise<never> {
		throw new RuntimeSliceNotImplemented("drive");
	}

	async requestAbort(): Promise<never> {
		throw new RuntimeSliceNotImplemented("requestAbort");
	}

	async inspectExecution(): Promise<never> {
		throw new RuntimeSliceNotImplemented("inspectExecution");
	}

	async prompt(): Promise<never> {
		throw new RuntimeSliceNotImplemented("prompt");
	}

	async skill(): Promise<never> {
		throw new RuntimeSliceNotImplemented("skill");
	}

	async promptFromTemplate(): Promise<never> {
		throw new RuntimeSliceNotImplemented("promptFromTemplate");
	}

	async compact(): Promise<never> {
		throw new RuntimeSliceNotImplemented("compact");
	}

	async navigateTree(): Promise<never> {
		throw new RuntimeSliceNotImplemented("navigateTree");
	}

	async resume(): Promise<never> {
		throw new RuntimeSliceNotImplemented("resume");
	}

	async abort(): Promise<never> {
		throw new RuntimeSliceNotImplemented("abort");
	}

	async steer(): Promise<never> {
		throw new RuntimeSliceNotImplemented("steer");
	}

	async followUp(): Promise<never> {
		throw new RuntimeSliceNotImplemented("followUp");
	}

	async nextRun(): Promise<never> {
		throw new RuntimeSliceNotImplemented("nextRun");
	}

	async cancelQueued(): Promise<never> {
		throw new RuntimeSliceNotImplemented("cancelQueued");
	}

	async recordUsage(): Promise<never> {
		throw new RuntimeSliceNotImplemented("recordUsage");
	}

	async waitForIdle(): Promise<never> {
		throw new RuntimeSliceNotImplemented("waitForIdle");
	}

	async runWhenIdle(): Promise<never> {
		throw new RuntimeSliceNotImplemented("runWhenIdle");
	}

	async peekAction(): Promise<never> {
		throw new RuntimeSliceNotImplemented("peekAction");
	}

	async executeAction(): Promise<never> {
		throw new RuntimeSliceNotImplemented("executeAction");
	}

	async runToCompletion(): Promise<never> {
		throw new RuntimeSliceNotImplemented("runToCompletion");
	}

	async getModel(): Promise<Model<Api> | undefined> {
		this.assertOpen();
		return this.models.getModel(this.state.configuration.model.provider, this.state.configuration.model.modelId);
	}

	setModel(model: Model<Api>): Promise<void> {
		return this.setConfiguration((configuration) => ({
			...configuration,
			model: { provider: model.provider, modelId: model.id },
		}));
	}

	async getThinkingLevel(): Promise<ThinkingLevel> {
		this.assertOpen();
		return this.state.configuration.thinkingLevel;
	}

	setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
		return this.setConfiguration((configuration) => ({ ...configuration, thinkingLevel }));
	}

	async getActiveTools(): Promise<string[]> {
		this.assertOpen();
		return this.state.configuration.activeToolNames;
	}

	setActiveTools(activeToolNames: string[]): Promise<void> {
		return this.setConfiguration((configuration) => ({ ...configuration, activeToolNames }));
	}

	async watch(): Promise<never> {
		throw new RuntimeSliceNotImplemented("watch");
	}

	setConfiguration(update: (configuration: LaneState["configuration"]) => LaneState["configuration"]): Promise<void> {
		return this.transition((state) => {
			const configuration = update(state.configuration);
			return {
				transaction: {
					writes: [
						{ kind: "register", op: "set", namespace: "lane.config", key: this.name, value: configuration },
					],
				},
				next: { ...state, configuration },
				materialize: () => undefined,
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
