import type { Context } from "../context.ts";
import { SessionInvariantError } from "../session/session.ts";
import type { Session, SessionReader } from "../session/types.ts";
import {
	branchTip,
	branchTipInventoryPrefix,
	laneConfig,
	laneLastResult,
	laneState as laneStateValue,
	operationMeta,
	operationState,
} from "../session/values.ts";
import type { LaneState } from "./types.ts";

/** Restore every complete configured AgentLane in one coherent Session read. */
export function restoreSession(session: Session, context: Context): Promise<Map<string, LaneState>> {
	return session.mutate(async (reader) => {
		const inventories = await Promise.all([
			reader.scanValues(branchTipInventoryPrefix(), context),
			reader.scanValues(laneConfig(""), context),
			reader.scanValues(laneStateValue(""), context),
			reader.scanValues(laneLastResult(""), context),
		]);
		const names = new Set(inventories.flatMap((values) => values.map(({ address }) => address.key)));
		const restored = new Map<string, LaneState>();
		for (const lane of names) {
			const [configuration, state, lastResult] = await Promise.all([
				reader.getValue(laneConfig(lane), context),
				reader.getValue(laneStateValue(lane), context),
				reader.getValue(laneLastResult(lane), context),
			]);
			const tip = await reader.getValue(branchTip(lane), context);
			if (tip !== undefined && configuration === undefined && state === undefined && lastResult === undefined) {
				continue;
			}
			if (tip === undefined || configuration === undefined || state === undefined) {
				throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} has incomplete durable state`);
			}
			restored.set(lane, await restoreLaneState(reader, lane, context));
		}
		return restored;
	}, context);
}

/** Restore one configured lane without starting work or interpreting its state. */
export function restoreLane(session: Session, lane: string, context: Context): Promise<LaneState> {
	return session.mutate((reader) => restoreLaneState(reader, lane, context), context);
}

export async function restoreLaneState(reader: SessionReader, lane: string, context: Context): Promise<LaneState> {
	const [tip, configuration, laneState, lastResult] = await Promise.all([
		reader.getValue(branchTip(lane), context),
		reader.getValue(laneConfig(lane), context),
		reader.getValue(laneStateValue(lane), context),
		reader.getValue(laneLastResult(lane), context),
	]);
	if (tip === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing branch.tip`);
	if (configuration === undefined)
		throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.config`);
	if (laneState === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.state`);

	const operationId = laneState.value.currentOperationId;
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
		if (meta.value.intent.kind !== state.value.kind) {
			throw new SessionInvariantError(
				`Operation ${operationId} intent ${meta.value.intent.kind} does not match state ${state.value.kind}`,
			);
		}
		operation = { meta: meta.value, state: state.value };
	}

	return {
		tipId: tip.value,
		configuration: configuration.value,
		pendingNextRun: laneState.value.pendingNextRun,
		...(lastResult === undefined ? {} : { lastResult: lastResult.value }),
		operation,
	};
}
