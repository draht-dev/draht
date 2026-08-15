import type { DriveOptions, DriveResult } from "../agent-harness.ts";
import { HarnessClosed, HarnessFault, OperationMismatch } from "../agent-harness.ts";
import { OperationEffectGate } from "../execution/effect-gate.ts";
import { type RestoredLane, restoreLane } from "../restore.ts";
import { Result } from "../result.ts";
import { SessionInvariantError } from "../session/session.ts";
import { executeDrivePass } from "./run-driver.ts";
import { hydrateTerminalOutcome } from "./transitions.ts";
import type { ActiveOperation, DeferredValue, DriveArbitration, OperationTaskContext, RuntimeLane } from "./types.ts";
import { RuntimeSliceNotImplemented } from "./types.ts";

export function deferredValue<T>(): DeferredValue<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	let rejectPromise: ((error: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve(value) {
			resolvePromise?.(value);
		},
		reject(error) {
			rejectPromise?.(error);
		},
	};
}

export async function driveLane<TContext extends object | undefined>(
	runtime: OperationTaskContext<TContext>,
	lane: RuntimeLane,
	options: DriveOptions,
): Promise<DriveResult> {
	const closed = runtime.resultClosedError();
	if (closed !== undefined) return Result.err(closed);
	const reservation = runtime.admissionReservations.get(lane.name);
	if (reservation?.operationId === options.operationId) {
		await reservation.completion;
		const afterReservation = runtime.resultClosedError();
		if (afterReservation !== undefined) return Result.err(afterReservation);
	}
	let arbitration: DriveArbitration;
	try {
		arbitration = await runtime.sessionStorage.mutate(lane.name, async (reader): Promise<DriveArbitration> => {
			const restored = await restoreLane(reader, lane.name, { includeLastResult: true });
			const currentId = restored.laneState.currentOperationId;
			if (currentId === null) {
				if (restored.lastResult?.operationId === options.operationId) {
					return {
						kind: "result",
						result: Result.ok({
							kind: "settled",
							operationId: options.operationId,
							outcome: await hydrateTerminalOutcome(reader, restored.lastResult),
						}),
					};
				}
				return { kind: "result", result: Result.err(mismatch(lane.name, options.operationId, restored)) };
			}
			if (currentId !== options.operationId) {
				return { kind: "result", result: Result.err(mismatch(lane.name, options.operationId, restored)) };
			}
			const existing = runtime.activeOperations.get(lane.name);
			if (existing !== undefined) {
				if (existing.operationId !== options.operationId) {
					throw new SessionInvariantError(`Lane ${JSON.stringify(lane.name)} has a task for another operation`);
				}
				return { kind: "join", completion: existing.completion };
			}
			if (restored.current === undefined) throw new SessionInvariantError("Current operation metadata is missing");
			const deferred = deferredValue<DriveResult>();
			const active: ActiveOperation = {
				operationId: options.operationId,
				operationKind: restored.current.operation.intent.kind,
				completion: deferred.promise,
				resolve: deferred.resolve,
				reject: deferred.reject,
				effectGate: new OperationEffectGate(),
			};
			runtime.activeOperations.set(lane.name, active);
			return { kind: "installed", active };
		});
	} catch (error) {
		throw runtime.fault(error);
	}

	if (arbitration.kind === "result") return arbitration.result;
	if (arbitration.kind === "join") return arbitration.completion;
	startDrivePass(runtime, lane, arbitration.active, options);
	return arbitration.active.completion;
}

function startDrivePass<TContext extends object | undefined>(
	runtime: OperationTaskContext<TContext>,
	lane: RuntimeLane,
	active: ActiveOperation,
	options: DriveOptions,
): void {
	active.task = (async () => {
		try {
			const result = await executeDrivePass(runtime, lane, active, options);
			await removeActiveOperation(runtime, lane.name, active);
			active.resolve(result);
		} catch (error) {
			await removeActiveOperation(runtime, lane.name, active);
			active.reject(
				error instanceof HarnessClosed ||
					error instanceof HarnessFault ||
					error instanceof RuntimeSliceNotImplemented
					? error
					: runtime.fault(error),
			);
		}
	})();
}

async function removeActiveOperation<TContext extends object | undefined>(
	runtime: OperationTaskContext<TContext>,
	lane: string,
	active: ActiveOperation,
): Promise<void> {
	if (runtime.state === "open") {
		await runtime.sessionStorage.mutate(lane, () => {
			if (runtime.activeOperations.get(lane) === active) runtime.activeOperations.delete(lane);
		});
		return;
	}
	if (runtime.activeOperations.get(lane) === active) runtime.activeOperations.delete(lane);
}

function mismatch(lane: string, expectedOperationId: string, restored: RestoredLane): OperationMismatch {
	const currentOperationId = restored.laneState.currentOperationId ?? undefined;
	const lastOperationId = restored.lastResult?.operationId;
	return new OperationMismatch({
		lane,
		expectedOperationId,
		...(currentOperationId === undefined ? {} : { currentOperationId }),
		...(lastOperationId === undefined ? {} : { lastOperationId }),
		message: `Operation ${expectedOperationId} does not own lane ${JSON.stringify(lane)}`,
	});
}
