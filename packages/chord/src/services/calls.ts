type Resolve = () => void;

/** Tracks calls admitted to one service target so replacement can drain it without disconnecting consumers. */
export class CallTracker {
	#active = 0;
	#retired = false;
	#settled: Promise<void> | undefined;
	#resolve: Resolve | undefined;

	run<T>(callback: () => T): T {
		if (this.#retired) throw new Error("Service target is retired");
		this.#active += 1;
		let result: T;
		try {
			result = callback();
		} catch (error) {
			this.#release();
			throw error;
		}
		if (!isPromiseLike(result)) {
			this.#release();
			return result;
		}
		return Promise.resolve(result).then(
			(value) => {
				this.#release();
				return value;
			},
			(error: unknown) => {
				this.#release();
				throw error;
			},
		) as T;
	}

	retire(): Promise<void> {
		if (this.#retired) return this.#settled ?? Promise.resolve();
		this.#retired = true;
		if (this.#active === 0) return Promise.resolve();
		this.#settled = new Promise<void>((resolve) => {
			this.#resolve = resolve;
		});
		return this.#settled;
	}

	#release(): void {
		this.#active -= 1;
		if (!this.#retired || this.#active !== 0) return;
		this.#resolve?.();
		this.#resolve = undefined;
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		((typeof value === "object" && value !== null) || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	);
}
