import { SessionInvariantError } from "./session/session.ts";
import type {
	Entry,
	LaneConfiguration,
	LaneLastResult,
	LaneState,
	Operation,
	OperationState,
	SessionReader,
} from "./session/types.ts";

export interface RestoredOperation {
	operation: Operation;
	state: OperationState;
	entries: Map<string, Entry>;
}

export interface RestoredLane {
	lane: string;
	leafId: string | null;
	configuration: LaneConfiguration;
	laneState: LaneState;
	lastResult?: LaneLastResult;
	current?: RestoredOperation;
}

interface RestoreOptions {
	includeLastResult?: boolean;
}

/** Load and validate the lane and operation ownership needed by the R1 shell. */
export async function restoreLane(
	reader: SessionReader,
	lane: string,
	options: RestoreOptions = {},
): Promise<RestoredLane> {
	const [configuration, laneState, leaf, lastResult] = await Promise.all([
		reader.getRegister("lane.config", lane),
		reader.getRegister("lane.state", lane),
		reader.getRegister("lane.leaf", lane),
		options.includeLastResult ? reader.getRegister("lane.lastResult", lane) : Promise.resolve(undefined),
	]);
	if (configuration === undefined) invariant(lane, "is missing lane.config");
	if (laneState === undefined) invariant(lane, "is missing lane.state");
	if (leaf === undefined) invariant(lane, "is missing lane.leaf");

	const operationId = laneState.value.currentOperationId;
	const [operation, operationState] =
		operationId === null
			? [undefined, undefined]
			: await Promise.all([reader.getRegister("op.meta", operationId), reader.getRegister("op.state", operationId)]);
	if (operationId !== null && operation === undefined) {
		invariant(lane, `names operation ${operationId}, which is missing op.meta`);
	}
	if (operationId !== null && operationState === undefined) {
		invariant(lane, `names operation ${operationId}, which is missing op.state`);
	}

	const expectations = new Map<string, "any" | "message">();
	if (leaf.value !== null) expectations.set(leaf.value, "any");
	if (operation !== undefined && operationState !== undefined) {
		if (operation.value.operationId !== operationId) {
			invariant(lane, `op.meta/${operationId} has another operation id`);
		}
		if (operation.value.lane !== lane) {
			invariant(lane, `operation ${operationId} belongs to lane ${operation.value.lane}`);
		}
		if (operation.value.intent.kind !== operationState.value.kind) {
			invariant(
				lane,
				`operation ${operationId} intent ${operation.value.intent.kind} does not match state ${operationState.value.kind}`,
			);
		}
		if (operation.value.sourceLeafId !== null) expectations.set(operation.value.sourceLeafId, "any");
		if (operation.value.intent.kind === "run") {
			for (const id of operation.value.intent.promptEntryIds) expectations.set(id, "message");
		} else if (operation.value.intent.kind === "navigation" && operation.value.intent.targetId !== null) {
			expectations.set(operation.value.intent.targetId, "any");
		}
	}

	const entries = await reader.getEntries([...expectations.keys()]);
	for (const [id, expected] of expectations) {
		const entry = entries.get(id);
		if (entry === undefined) invariant(lane, `references missing entry ${id}`);
		if (expected === "message" && entry.type !== "message") invariant(lane, `entry ${id} is not a message`);
	}

	return {
		lane,
		leafId: leaf.value,
		configuration: configuration.value,
		laneState: laneState.value,
		...(lastResult === undefined ? {} : { lastResult: lastResult.value }),
		...(operation === undefined || operationState === undefined
			? {}
			: { current: { operation: operation.value, state: operationState.value, entries } }),
	};
}

function invariant(lane: string, message: string): never {
	throw new SessionInvariantError(`Lane ${JSON.stringify(lane)} ${message}`);
}
