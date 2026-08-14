import type { ActionInfo } from "../agent-harness.ts";
import { AbortRequested } from "./effect-gate.ts";

interface ParkedBreakpoint {
	info: ActionInfo;
	interruptOnAbort: boolean;
	resolve: () => void;
	reject: (error: Error) => void;
}

/** Process-local manual-execution barrier. It owns no durable state or work. */
export class BreakpointBarrier {
	private readonly mode: "automatic" | "manual";
	private parked: ParkedBreakpoint | undefined;
	private closedError: Error | undefined;
	private readonly changeWaiters = new Set<() => void>();

	constructor(mode: "automatic" | "manual") {
		this.mode = mode;
	}

	hit(info: ActionInfo, options: { interruptOnAbort?: boolean } = {}): Promise<void> {
		if (this.closedError !== undefined) return Promise.reject(this.closedError);
		if (this.mode === "automatic") return Promise.resolve();
		if (this.parked !== undefined) {
			return Promise.reject(new Error(`Breakpoint ${JSON.stringify(this.parked.info.kind)} is already parked`));
		}
		return new Promise<void>((resolve, reject) => {
			this.parked = {
				info,
				interruptOnAbort: options.interruptOnAbort !== false,
				resolve,
				reject,
			};
			this.notifyChange();
		});
	}

	peek(): ActionInfo | undefined {
		return this.parked?.info;
	}

	release(): ActionInfo | undefined {
		const parked = this.parked;
		if (parked === undefined) return undefined;
		this.parked = undefined;
		parked.resolve();
		this.notifyChange();
		return parked.info;
	}

	interrupt(cancellation: Promise<void>): void {
		const parked = this.parked;
		if (parked === undefined || !parked.interruptOnAbort) return;
		this.parked = undefined;
		parked.reject(new AbortRequested(cancellation));
		this.notifyChange();
	}

	close(error: Error): void {
		this.closedError ??= error;
		const parked = this.parked;
		this.parked = undefined;
		parked?.reject(this.closedError);
		this.notifyChange();
	}

	/** Resolve when the parked action changes or the barrier closes. */
	waitForChange(): Promise<void> {
		if (this.closedError !== undefined) return Promise.resolve();
		return new Promise<void>((resolve) => this.changeWaiters.add(resolve));
	}

	private notifyChange(): void {
		for (const resolve of this.changeWaiters) resolve();
		this.changeWaiters.clear();
	}
}
