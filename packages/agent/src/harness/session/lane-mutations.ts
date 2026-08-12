/** Serializes complete read-modify-write jobs independently per lane. */
export class LaneMutationLine {
	private readonly tails = new Map<string, Promise<void>>();
	private sealedError: Error | undefined;

	run<T>(lane: string, operation: () => T | Promise<T>): Promise<T> {
		if (this.sealedError !== undefined) return Promise.reject(this.sealedError);
		const previous = this.tails.get(lane);
		let result: Promise<T>;
		if (previous === undefined) {
			try {
				result = Promise.resolve(operation());
			} catch (error) {
				result = Promise.reject(error);
			}
		} else {
			result = previous.then(() => {
				if (this.sealedError !== undefined) throw this.sealedError;
				return operation();
			});
		}

		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(lane, tail);
		void tail.then(() => {
			if (this.tails.get(lane) === tail) this.tails.delete(lane);
		});
		return result;
	}

	seal(error: Error): Promise<void> {
		this.sealedError ??= error;
		return Promise.all(this.tails.values()).then(() => undefined);
	}
}
