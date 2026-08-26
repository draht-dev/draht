import type { Context } from "../context.ts";
import { SessionInvariantError } from "../session/session.ts";
import type {
	LaneState as DurableLaneState,
	LaneConfiguration,
	LaneLastResult,
	Session,
	SessionReader,
} from "../session/types.ts";
import {
	branchTip,
	branchTipInventoryPrefix,
	laneConfig,
	laneLastResult,
	laneState as laneStateValue,
	operationMeta,
	operationState,
	type StoredValue,
} from "../session/values.ts";
import type { LaneState } from "./types.ts";

type LaneValues = {
	tip: StoredValue<string | null> | undefined;
	configuration: StoredValue<LaneConfiguration> | undefined;
	laneState: StoredValue<DurableLaneState> | undefined;
	lastResult: StoredValue<LaneLastResult> | undefined;
};

export type ClassifiedLaneStorage =
	| { kind: "absent" }
	| { kind: "branch"; tip: StoredValue<string | null> }
	| {
			kind: "lane";
			tip: StoredValue<string | null>;
			configuration: StoredValue<LaneConfiguration>;
			laneState: StoredValue<DurableLaneState>;
			lastResult: StoredValue<LaneLastResult> | undefined;
	  };

function classifyLaneStorage(lane: string, values: LaneValues): ClassifiedLaneStorage {
	const { tip, configuration, laneState, lastResult } = values;
	if (tip === undefined && configuration === undefined && laneState === undefined && lastResult === undefined) {
		return { kind: "absent" };
	}
	if (tip !== undefined && configuration === undefined && laneState === undefined && lastResult === undefined) {
		return { kind: "branch", tip };
	}
	if (tip === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing branch.tip`);
	if (configuration === undefined)
		throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.config`);
	if (laneState === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.state`);
	return { kind: "lane", tip, configuration, laneState, lastResult };
}

export async function readLaneStorage(
	reader: SessionReader,
	lane: string,
	context: Context,
): Promise<ClassifiedLaneStorage> {
	const [tip, configuration, laneState, lastResult] = await Promise.all([
		reader.getValue(branchTip(lane), context),
		reader.getValue(laneConfig(lane), context),
		reader.getValue(laneStateValue(lane), context),
		reader.getValue(laneLastResult(lane), context),
	]);
	return classifyLaneStorage(lane, { tip, configuration, laneState, lastResult });
}

/** Restore every complete configured AgentLane in one coherent Session read. */
export function restoreSession(session: Session, context: Context): Promise<Map<string, LaneState>> {
	return session.mutate(async (reader) => {
		const [tips, configurations, states, lastResults] = await Promise.all([
			reader.scanValues(branchTipInventoryPrefix(), context),
			reader.scanValues(laneConfig(""), context),
			reader.scanValues(laneStateValue(""), context),
			reader.scanValues(laneLastResult(""), context),
		]);
		const tipByLane = new Map(tips.map((value) => [value.address.key, value]));
		const configurationByLane = new Map(configurations.map((value) => [value.address.key, value]));
		const stateByLane = new Map(states.map((value) => [value.address.key, value]));
		const lastResultByLane = new Map(lastResults.map((value) => [value.address.key, value]));
		const names = new Set([
			...tipByLane.keys(),
			...configurationByLane.keys(),
			...stateByLane.keys(),
			...lastResultByLane.keys(),
		]);
		const restored = new Map<string, LaneState>();
		for (const lane of names) {
			const stored = classifyLaneStorage(lane, {
				tip: tipByLane.get(lane),
				configuration: configurationByLane.get(lane),
				laneState: stateByLane.get(lane),
				lastResult: lastResultByLane.get(lane),
			});
			if (stored.kind !== "lane") continue;
			restored.set(lane, await restoreLaneState(reader, lane, stored, context));
		}
		return restored;
	}, context);
}

/** Restore one configured lane without starting work or interpreting its state. */
export function restoreLane(session: Session, lane: string, context: Context): Promise<LaneState> {
	return session.mutate(async (reader) => {
		const stored = await readLaneStorage(reader, lane, context);
		if (stored.kind === "absent") {
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing branch.tip`);
		}
		if (stored.kind === "branch") {
			throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.config`);
		}
		return restoreLaneState(reader, lane, stored, context);
	}, context);
}

export async function restoreLaneState(
	reader: SessionReader,
	lane: string,
	stored: Extract<ClassifiedLaneStorage, { kind: "lane" }>,
	context: Context,
): Promise<LaneState> {
	const operationId = stored.laneState.value.currentOperationId;
	let operation: LaneState["operation"] = null;
	if (operationId !== null) {
		const [meta, state] = await Promise.all([
			reader.getValue(operationMeta(operationId), context),
			reader.getValue(operationState(operationId), context),
		]);
		if (meta === undefined) throw new SessionInvariantError(`Operation ${operationId} is missing op.meta`);
		if (state === undefined) throw new SessionInvariantError(`Operation ${operationId} is missing op.state`);
		if (meta.value.operationId !== operationId) {
			throw new SessionInvariantError(
				`Operation ${operationId} metadata names operation ${JSON.stringify(meta.value.operationId)}`,
			);
		}
		if (meta.value.lane !== lane) {
			throw new SessionInvariantError(
				`Operation ${operationId} belongs to lane ${JSON.stringify(meta.value.lane)}, not ${JSON.stringify(lane)}`,
			);
		}
		if (!state.value.at.startsWith(`${meta.value.intent.kind}.`)) {
			throw new SessionInvariantError(
				`Operation ${operationId} intent ${meta.value.intent.kind} does not match state ${state.value.at}`,
			);
		}
		operation = { meta: meta.value, state: state.value };
	}

	return {
		tipId: stored.tip.value,
		configuration: stored.configuration.value,
		pendingNextRun: stored.laneState.value.pendingNextRun,
		...(stored.lastResult === undefined ? {} : { lastResult: stored.lastResult.value }),
		operation,
	};
}
