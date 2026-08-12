/** Serializes complete read-modify-write jobs independently per lane. */
export class LaneMutationLine {
	private readonly tails = new Map<string, Promise<void>>();
	private sealedError: Error | undefined;

	run<T>(lane: string, operation: () => T | Promise<T>): Promise<T> {
		if (this.sealedError !== undefined) return Promise.reject(this.sealedError);
		const result = (this.tails.get(lane) ?? Promise.resolve()).then(() => {
			if (this.sealedError !== undefined) throw this.sealedError;
			return operation();
		});
		this.tails.set(
			lane,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	seal(error: Error): Promise<void> {
		this.sealedError ??= error;
		return Promise.all(this.tails.values()).then(() => undefined);
	}
}
