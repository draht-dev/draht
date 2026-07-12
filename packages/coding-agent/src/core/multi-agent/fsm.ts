/**
 * FSM protocol for multi-agent coordination.
 *
 * Each agent instance is backed by an `AgentFSM` that tracks its lifecycle:
 *
 *   IDLE -> REQUEST -> WORKING -> RESPOND -> IDLE
 *                         ^          |
 *                         |          v
 *                        WAIT <------+ (WORKING <-> WAIT while blocked on input)
 *
 * The orchestrator observes transitions via `onTransition` (wire this into the
 * shared event bus) and can persist/restore FSM state via serialize/deserialize
 * for crash recovery.
 */

export type AgentState = "IDLE" | "REQUEST" | "WORKING" | "WAIT" | "RESPOND";

export interface AgentFSMTransitionEvent {
	from: AgentState;
	to: AgentState;
	agentId: string;
	timestamp: number;
}

export type AgentFSMTransitionListener = (event: AgentFSMTransitionEvent) => void;

export interface AgentFSMSnapshot {
	agentId: string;
	state: AgentState;
}

export class InvalidAgentTransitionError extends Error {
	readonly agentId: string;
	readonly from: AgentState;
	readonly to: AgentState;

	constructor(agentId: string, from: AgentState, to: AgentState) {
		super(`Invalid agent FSM transition for "${agentId}": ${from} -> ${to}`);
		this.name = "InvalidAgentTransitionError";
		this.agentId = agentId;
		this.from = from;
		this.to = to;
	}
}

export class AgentFSM {
	/** Valid transition map: from-state -> allowed to-states. */
	static readonly TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
		IDLE: ["REQUEST"],
		REQUEST: ["WORKING"],
		WORKING: ["WAIT", "RESPOND"],
		WAIT: ["WORKING"],
		RESPOND: ["IDLE"],
	};

	readonly agentId: string;
	private currentState: AgentState;
	private readonly listeners: Set<AgentFSMTransitionListener> = new Set();

	constructor(agentId: string, initialState: AgentState = "IDLE") {
		this.agentId = agentId;
		this.currentState = initialState;
	}

	/** Current state of the agent. */
	get state(): AgentState {
		return this.currentState;
	}

	/** Whether `to` is a legal next state from `from` per the static transition map. */
	static isValidTransition(from: AgentState, to: AgentState): boolean {
		return AgentFSM.TRANSITIONS[from].includes(to);
	}

	/**
	 * Attempt to move the FSM to `to`. Throws `InvalidAgentTransitionError` if the
	 * transition is not permitted from the current state, leaving state unchanged.
	 * On success, notifies all registered listeners synchronously and returns the
	 * new state.
	 */
	transition(to: AgentState): AgentState {
		const from = this.currentState;
		if (!AgentFSM.isValidTransition(from, to)) {
			throw new InvalidAgentTransitionError(this.agentId, from, to);
		}

		this.currentState = to;

		const event: AgentFSMTransitionEvent = {
			from,
			to,
			agentId: this.agentId,
			timestamp: Date.now(),
		};
		for (const listener of this.listeners) {
			listener(event);
		}

		return this.currentState;
	}

	/** Subscribe to transition events. Returns an unsubscribe function. */
	onTransition(listener: AgentFSMTransitionListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Serialize agentId + current state to a JSON string for persistence. */
	serialize(): string {
		return JSON.stringify(this.toSnapshot());
	}

	/** Plain-object snapshot form, useful when embedding in a larger persisted document. */
	toSnapshot(): AgentFSMSnapshot {
		return { agentId: this.agentId, state: this.currentState };
	}

	/** Rehydrate an FSM from a `serialize()` string or an `AgentFSMSnapshot` object. */
	static deserialize(data: string | AgentFSMSnapshot): AgentFSM {
		const snapshot: AgentFSMSnapshot = typeof data === "string" ? JSON.parse(data) : data;
		return new AgentFSM(snapshot.agentId, snapshot.state);
	}
}
