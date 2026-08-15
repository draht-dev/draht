import { SessionInvariantError } from "../session/session.ts";
import type { Session, SessionReader } from "../session/types.ts";
import { Lane } from "./lane.ts";
import type { LaneState } from "./types.ts";

/** Restore every configured lane in one session without starting work. */
export async function restoreSession(session: Session): Promise<Map<string, Lane>> {
	const lanes = await session.listRegisters("lane.leaf");
	if (!lanes.some((lane) => lane.key === "main")) throw new SessionInvariantError("Session is missing main lane");
	const restored = await Promise.all(
		lanes.map(({ key }) => session.mutate(key, (reader) => restoreLane(reader, key))),
	);
	return new Map(restored.map((lane) => [lane.name, lane]));
}

/** Restore one configured lane without starting work or interpreting its state. */
export async function restoreLane(reader: SessionReader, lane: string): Promise<Lane> {
	const [leaf, configuration, laneState, lastResult] = await Promise.all([
		reader.getRegister("lane.leaf", lane),
		reader.getRegister("lane.config", lane),
		reader.getRegister("lane.state", lane),
		reader.getRegister("lane.lastResult", lane),
	]);
	if (leaf === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.leaf`);
	if (configuration === undefined)
		throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.config`);
	if (laneState === undefined) throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} is missing lane.state`);

	const operationId = laneState.value.currentOperationId;
	let operation: LaneState["operation"] = null;
	if (operationId !== null) {
		const [meta, state] = await Promise.all([
			reader.getRegister("op.meta", operationId),
			reader.getRegister("op.state", operationId),
		]);
		if (meta === undefined) throw new SessionInvariantError(`Operation ${operationId} is missing op.meta`);
		if (state === undefined) throw new SessionInvariantError(`Operation ${operationId} is missing op.state`);
		operation = { meta: meta.value, state: state.value };
	}

	return new Lane(lane, {
		leafId: leaf.value,
		configuration: configuration.value,
		pendingNextRun: laneState.value.pendingNextRun,
		...(lastResult === undefined ? {} : { lastResult: lastResult.value }),
		operation,
	});
}
