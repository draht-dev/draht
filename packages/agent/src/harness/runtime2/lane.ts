import type { AgentLane } from "../agent-harness.ts";
import { RuntimeSliceNotImplemented } from "../runtime/types.ts";
import type { Session, SessionTree, Transaction } from "../session/types.ts";
import type { LaneState } from "./types.ts";

interface LaneTransition<TResult> {
	transaction: Transaction;
	next: LaneState;
	result: TResult;
}

/** Runtime2 implementation of one configured lane. */
export class Lane implements AgentLane {
	readonly name: string;
	readonly sessionTree: SessionTree;
	readonly session: Session;
	state: LaneState;

	constructor(name: string, session: Session, state: LaneState) {
		this.session = session;
		this.name = name;
		this.sessionTree = session.view(name);
		this.state = state;
	}

	async getLeafId(): Promise<string | null> {
		return this.state.leafId;
	}

	async getLastResult() {
		return this.state.lastResult;
	}

	transition<TResult>(plan: (state: LaneState) => LaneTransition<TResult>): Promise<TResult> {
		return this.session.mutate(this.name, async (mutator) => {
			const transition = plan(this.state);
			await mutator.commit(transition.transaction);
			this.state = transition.next;
			return transition.result;
		});
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

	async getModel(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getModel");
	}

	async setModel(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setModel");
	}

	async getThinkingLevel(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getThinkingLevel");
	}

	async setThinkingLevel(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setThinkingLevel");
	}

	async getActiveTools(): Promise<never> {
		throw new RuntimeSliceNotImplemented("getActiveTools");
	}

	async setActiveTools(): Promise<never> {
		throw new RuntimeSliceNotImplemented("setActiveTools");
	}

	async watch(): Promise<never> {
		throw new RuntimeSliceNotImplemented("watch");
	}
}
