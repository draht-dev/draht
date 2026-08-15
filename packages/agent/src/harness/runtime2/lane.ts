import type { LaneState } from "./types.ts";

/** Process-local owner of one restored lane. */
export class Lane {
	readonly name: string;
	#state: LaneState;

	constructor(name: string, state: LaneState) {
		this.name = name;
		this.#state = state;
	}

	get state(): LaneState {
		return this.#state;
	}
}
