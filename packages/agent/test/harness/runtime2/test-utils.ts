import type { DriveOptions } from "../../../src/harness/agent-harness.ts";
import { BACKGROUND_CONTEXT, type Context, withoutAbortSignal } from "../../../src/harness/context.ts";
import {
	type ActiveDriveHandle,
	createActiveDrive,
	type DriveScope,
	type LaneDriveCapabilities,
} from "../../../src/harness/runtime2/types.ts";
import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import type { CommitResult, Write } from "../../../src/harness/session/types.ts";

export class FailingMemoryStorage extends MemoryStorage {
	failure: Error | undefined;

	override commit(writes: Write[]) {
		const failure = this.failure;
		this.failure = undefined;
		return failure === undefined ? super.commit(writes, BACKGROUND_CONTEXT) : Promise.reject(failure);
	}
}

export class ControlledMemoryStorage extends MemoryStorage {
	beforeNextCommit: (() => Promise<void>) | undefined;

	override async commit(writes: Write[]): Promise<CommitResult> {
		const beforeCommit = this.beforeNextCommit;
		this.beforeNextCommit = undefined;
		await beforeCommit?.();
		return super.commit(writes, BACKGROUND_CONTEXT);
	}
}

export function createDriveScope<TContext extends object | undefined>(
	lane: LaneDriveCapabilities<TContext>,
	options: DriveOptions,
	context: Context = BACKGROUND_CONTEXT,
): { scope: DriveScope<TContext>; handle: ActiveDriveHandle } {
	const handle = createActiveDrive(options.operationId);
	return {
		handle,
		scope: {
			lane,
			operationId: options.operationId,
			owner: handle.active,
			context: withoutAbortSignal(context),
			pass: {
				waitForRetry: options.waitForRetry ?? false,
				deferredPermits: options.pollDeferred === true ? 1 : 0,
			},
		},
	};
}

export function createDriveFixture<TContext extends object | undefined>(
	lane: LaneDriveCapabilities<TContext>,
	operationId = "operation",
	context: Context = BACKGROUND_CONTEXT,
): { scope: DriveScope<TContext>; handle: ActiveDriveHandle } {
	return createDriveScope(lane, { operationId }, context);
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}
