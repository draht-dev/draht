/** Process-local admission gate for one operation's external work. */
export interface EffectGate {
	/** The operation-owned cooperative signal. */
	readonly signal: AbortSignal;
	/** Synchronously throws when ordinary work may no longer start. */
	assertOpen(): void;
}
