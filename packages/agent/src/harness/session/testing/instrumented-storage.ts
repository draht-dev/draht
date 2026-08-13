import type { CommitResult, Transaction } from "../types.ts";
import { StorageDecorator } from "./storage-decorator.ts";

/** Test-only transparent Storage decorator that records commit admission. */
export class InstrumentedStorage extends StorageDecorator {
	private readonly commitAttempts: Transaction[] = [];

	getCommitAttempts(): readonly Transaction[] {
		return this.commitAttempts.slice();
	}

	clearCommitAttempts(): void {
		this.commitAttempts.length = 0;
	}

	override commit(transaction: Transaction): Promise<CommitResult> {
		this.commitAttempts.push(transaction);
		return this.delegate.commit(transaction);
	}
}
