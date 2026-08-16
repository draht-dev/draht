import { MemoryStorage } from "../../../src/harness/session/memory.ts";
import type { CommitResult, Transaction } from "../../../src/harness/session/types.ts";

export class FailingMemoryStorage extends MemoryStorage {
	failure: Error | undefined;

	override commit(transaction: Transaction) {
		const failure = this.failure;
		this.failure = undefined;
		return failure === undefined ? super.commit(transaction) : Promise.reject(failure);
	}
}

export class ControlledMemoryStorage extends MemoryStorage {
	beforeNextCommit: (() => Promise<void>) | undefined;

	override async commit(transaction: Transaction): Promise<CommitResult> {
		const beforeCommit = this.beforeNextCommit;
		this.beforeNextCommit = undefined;
		await beforeCommit?.();
		return super.commit(transaction);
	}
}

export function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}
