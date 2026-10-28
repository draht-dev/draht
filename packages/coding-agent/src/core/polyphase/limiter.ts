export interface LimiterLease {
	/** Idempotent: a second call is a no-op. */
	release(): void;
}

export interface LimiterStats {
	capacity: number;
	active: number;
	queued: number;
}

export class LimiterAbortedError extends Error {
	constructor(message = "aborted while waiting for an agent slot") {
		super(message);
		this.name = "LimiterAbortedError";
	}
}

interface Waiter {
	resolve: (lease: LimiterLease) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
}

function normalizeCapacity(capacity: number): number {
	if (capacity === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
	const floored = Math.floor(capacity);
	return Number.isFinite(floored) && floored >= 1 ? floored : 1;
}

/**
 * FIFO semaphore gating how many child agent processes run at once in a session.
 * Leases are held only around a child process, never by orchestrators, so nested
 * acquisition inside a lease cannot deadlock.
 */
export class AgentLimiter {
	private cap: number;
	private active = 0;
	private readonly waiters: Waiter[] = [];
	private readonly listeners = new Set<() => void>();

	constructor(capacity: number) {
		this.cap = normalizeCapacity(capacity);
	}

	get capacity(): number {
		return this.cap;
	}

	setCapacity(capacity: number): void {
		this.cap = normalizeCapacity(capacity);
		this.grantWaiting();
		this.notify();
	}

	acquire(options?: { signal?: AbortSignal; onQueued?: () => void }): Promise<LimiterLease> {
		const signal = options?.signal;
		if (signal?.aborted) {
			return Promise.reject(new LimiterAbortedError());
		}

		if (this.active < this.cap && this.waiters.length === 0) {
			this.active++;
			this.notify();
			return Promise.resolve(this.makeLease());
		}

		return new Promise<LimiterLease>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, cleanup: () => {} };
			if (signal) {
				const onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index === -1) return;
					this.waiters.splice(index, 1);
					waiter.reject(new LimiterAbortedError());
					this.notify();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			this.waiters.push(waiter);
			this.notify();
			// onQueued may abort the signal synchronously; the listener above already ran by now.
			try {
				options?.onQueued?.();
			} catch (error) {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) {
					this.waiters.splice(index, 1);
					waiter.cleanup();
					this.notify();
				}
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	stats(): LimiterStats {
		return { capacity: this.cap, active: this.active, queued: this.waiters.length };
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	rejectAll(reason: Error): void {
		const waiters = this.waiters.splice(0, this.waiters.length);
		for (const waiter of waiters) {
			waiter.cleanup();
			waiter.reject(reason);
		}
		if (waiters.length > 0) this.notify();
	}

	private makeLease(): LimiterLease {
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.active--;
				this.grantWaiting();
				this.notify();
			},
		};
	}

	/** Grants queued waiters up to capacity. Does not notify; callers notify once themselves. */
	private grantWaiting(): boolean {
		let granted = false;
		while (this.active < this.cap && this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (!waiter) break;
			waiter.cleanup();
			this.active++;
			waiter.resolve(this.makeLease());
			granted = true;
		}
		return granted;
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A listener (store/dock rendering) must not stall the grant queue.
			}
		}
	}
}
