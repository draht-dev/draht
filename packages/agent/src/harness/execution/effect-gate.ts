/** Expected internal control flow when cancellation wins effect admission. */
export class AbortRequested extends Error {
	readonly cancellation: Promise<void>;

	constructor(cancellation: Promise<void>) {
		super("Abort requested");
		this.name = "AbortRequested";
		this.cancellation = cancellation;
	}
}

type EffectGateState =
	| { status: "open" }
	| { status: "aborting"; cancellation: Promise<void> }
	| { status: "closed"; error: Error };

/** Process-local admission gate for one operation's external work. */
export interface EffectGate {
	/** The operation-owned cooperative signal. */
	readonly signal: AbortSignal;
	/** Synchronously throws when ordinary work may no longer start. */
	assertOpen(): void;
	/** Close ordinary starts before the durable cancellation mutation begins. */
	beginAbort(cancellation: Promise<void>): void;
	/** Pull the cooperative signal only after cancellation is durable. */
	signalAbort(): void;
	/** Permanently stop starts and signal already-admitted work. */
	close(error: Error): void;
}

/** Default {@link EffectGate} implementation used by drive passes. */
export class OperationEffectGate implements EffectGate {
	private readonly controller = new AbortController();
	private state: EffectGateState = { status: "open" };

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	assertOpen(): void {
		if (this.state.status === "aborting") throw new AbortRequested(this.state.cancellation);
		if (this.state.status === "closed") throw this.state.error;
	}

	beginAbort(cancellation: Promise<void>): void {
		if (this.state.status === "open") {
			this.state = { status: "aborting", cancellation };
		}
	}

	signalAbort(): void {
		if (this.state.status !== "aborting" || this.controller.signal.aborted) return;
		this.controller.abort(new AbortRequested(this.state.cancellation));
	}

	close(error: Error): void {
		if (this.state.status === "closed") return;
		this.state = { status: "closed", error };
		if (!this.controller.signal.aborted) this.controller.abort(error);
	}
}
