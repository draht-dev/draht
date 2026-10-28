import {
	ChildEventReducer,
	type ChildWireRecord,
	createChildAgentState,
} from "../../../src/core/polyphase/child-events.ts";
import type { AgentModelInfo, AgentView, ChildAgentState, RunView } from "../../../src/core/polyphase/types.ts";

/**
 * Plain `AgentView`/`RunView` fixtures for tests that do not need the real store (store.ts,
 * wave 2). `state` defaults to a fresh reducer-shaped `ChildAgentState`; callers who want it
 * mutated by wire records should drive a real `ChildEventReducer` and pass `reducer.state` in
 * `overrides.state`, or pass `records` to drive one here.
 */

function freshModelInfo(): AgentModelInfo {
	return { source: "inherited", confirmed: false };
}

/** Reduces `records` through a fresh `ChildEventReducer` and returns its resulting state. */
export function applyWire(
	records: readonly ChildWireRecord[],
	model: AgentModelInfo = freshModelInfo(),
): ChildAgentState {
	const reducer = new ChildEventReducer({ model });
	for (const record of records) reducer.apply(record);
	return reducer.state;
}

export function makeAgentView(
	overrides: Partial<AgentView> & { runId?: string; records?: ChildWireRecord[] } = {},
): AgentView {
	const { runId = "run-1", records, ...rest } = overrides;
	const index = rest.index ?? 0;
	return {
		key: `${runId}#${index}`,
		index,
		label: `agent#${index}`,
		agentType: "reviewer",
		task: "review the diff",
		status: "pending",
		state: records ? applyWire(records) : createChildAgentState(freshModelInfo()),
		createdAt: Date.now(),
		...rest,
	};
}

export function makeRunView(overrides: Partial<RunView> = {}): RunView {
	return {
		id: "run-1",
		kind: "subagent",
		origin: "tool",
		mode: "single",
		title: "review the diff",
		phases: [],
		status: "running",
		startedAt: Date.now(),
		agents: [],
		log: [],
		logDropped: 0,
		budget: { totalTokens: null, spentTokens: 0, exhausted: false },
		version: 0,
		coarseVersion: 0,
		...overrides,
	};
}
