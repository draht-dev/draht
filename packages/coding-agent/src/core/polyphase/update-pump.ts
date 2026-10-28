export interface UpdatePump {
	schedule(runId: string, change: "fine" | "coarse"): void;
	setIntervalMs(ms: number): void;
	setFlushHandler(handler: (dirty: ReadonlyMap<string, boolean>) => void): void;
	/** Schedules a "fine" change for runId every heartbeatMs. */
	startHeartbeat(runId: string): void;
	stopHeartbeat(runId: string): void;
	flushNow(): void;
	dispose(): void;
	readonly activeTimers: number;
}

export interface UpdatePumpOptions {
	intervalMs: number;
	heartbeatMs?: number;
	coarseDelayMs?: number;
}

export function createUpdatePump(options: UpdatePumpOptions): UpdatePump {
	return new UpdatePumpImpl(options);
}

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_COARSE_DELAY_MS = 50;

function normalizeMs(value: number, fallback: number): number {
	return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

class UpdatePumpImpl implements UpdatePump {
	private intervalMs: number;
	private readonly heartbeatMs: number;
	private readonly coarseDelayMs: number;
	private readonly dirty = new Map<string, boolean>();
	private readonly heartbeats = new Set<string>();
	private flushHandler: ((dirty: ReadonlyMap<string, boolean>) => void) | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	private flushDeadline = 0;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private disposed = false;

	constructor(options: UpdatePumpOptions) {
		this.intervalMs = normalizeMs(options.intervalMs, DEFAULT_INTERVAL_MS);
		this.heartbeatMs = normalizeMs(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS);
		this.coarseDelayMs = normalizeMs(options.coarseDelayMs ?? DEFAULT_COARSE_DELAY_MS, DEFAULT_COARSE_DELAY_MS);
	}

	get activeTimers(): number {
		return (this.flushTimer ? 1 : 0) + (this.heartbeatTimer ? 1 : 0);
	}

	setIntervalMs(ms: number): void {
		if (this.disposed) return;
		this.intervalMs = normalizeMs(ms, this.intervalMs);
		// A pending fine flush armed under the old (larger) interval would otherwise wait out its
		// original deadline; ensureFlushTimer only ever moves the deadline earlier, so this is safe
		// even when nothing is actually pending.
		if (this.dirty.size > 0) this.ensureFlushTimer(this.intervalMs);
	}

	setFlushHandler(handler: (dirty: ReadonlyMap<string, boolean>) => void): void {
		this.flushHandler = handler;
		// runFlush holds dirty entries when no handler is installed; once one arrives, make sure
		// those held changes still flush instead of waiting for the next unrelated schedule() call.
		if (this.dirty.size > 0) this.ensureFlushTimer(this.intervalMs);
	}

	schedule(runId: string, change: "fine" | "coarse"): void {
		if (this.disposed) return;
		const coarse = change === "coarse";
		this.dirty.set(runId, (this.dirty.get(runId) ?? false) || coarse);
		const delayMs = coarse ? Math.min(this.coarseDelayMs, this.intervalMs) : this.intervalMs;
		this.ensureFlushTimer(delayMs);
	}

	startHeartbeat(runId: string): void {
		if (this.disposed) return;
		this.heartbeats.add(runId);
		this.ensureHeartbeatTimer();
	}

	stopHeartbeat(runId: string): void {
		this.heartbeats.delete(runId);
		if (this.heartbeats.size === 0 && this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	flushNow(): void {
		if (this.disposed) return;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.runFlush();
	}

	dispose(): void {
		this.disposed = true;
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		this.dirty.clear();
		this.heartbeats.clear();
		this.flushHandler = undefined;
	}

	private ensureFlushTimer(delayMs: number): void {
		const deadline = Date.now() + delayMs;
		if (this.flushTimer) {
			if (deadline >= this.flushDeadline) return;
			clearTimeout(this.flushTimer);
		}
		this.flushDeadline = deadline;
		const timer = setTimeout(() => {
			this.flushTimer = undefined;
			this.runFlush();
		}, delayMs);
		timer.unref?.();
		this.flushTimer = timer;
	}

	private ensureHeartbeatTimer(): void {
		if (this.heartbeatTimer) return;
		const timer = setInterval(() => {
			for (const runId of this.heartbeats) this.schedule(runId, "fine");
		}, this.heartbeatMs);
		timer.unref?.();
		this.heartbeatTimer = timer;
	}

	private runFlush(): void {
		if (this.dirty.size === 0) return;
		// setFlushHandler can be called after schedule(): keep the dirty entries rather than
		// discarding changes that arrived before a handler was installed.
		if (!this.flushHandler) return;
		const dirty = new Map(this.dirty);
		this.dirty.clear();
		try {
			this.flushHandler(dirty);
		} catch {
			// A flush handler (tool-row/dock rendering) must not stall future flushes.
		}
	}
}
