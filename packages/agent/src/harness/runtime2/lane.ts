import type { Session, Transaction } from "../session/types.ts";
import type { LaneState } from "./types.ts";

interface LaneTransition<TResult> {
	transaction: Transaction;
	next: LaneState;
	result: TResult;
}

/** Process-local owner of one restored lane. */
export class Lane {
	readonly name: string;
	readonly #session: Session;
	#state: LaneState;

	constructor(session: Session, name: string, state: LaneState) {
		this.#session = session;
		this.name = name;
		this.#state = state;
	}

	get state(): LaneState {
		return this.#state;
	}

	transition<TResult>(plan: (state: LaneState) => LaneTransition<TResult>): Promise<TResult> {
		return this.#session.mutate(this.name, async (mutator) => {
			const transition = plan(this.#state);
			await mutator.commit(transition.transaction);
			this.#state = transition.next;
			return transition.result;
		});
	}
}
