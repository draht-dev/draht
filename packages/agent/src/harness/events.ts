import type { EventListener, Events, HarnessEvent, HarnessEventType, WatchHandle } from "./agent-harness.ts";

type UntypedEventListener = (event: HarnessEvent) => void | Promise<void>;

/** Passive harness event bus with isolated handler failures. */
export class HarnessEventBus implements Events {
	private readonly listeners = new Map<HarnessEventType, Set<UntypedEventListener>>();
	private readonly watchListeners = new Set<UntypedEventListener>();
	private deliveryTail: Promise<void> = Promise.resolve();
	private closedError: Error | undefined;

	on<TType extends HarnessEventType>(
		type: TType,
		listener: EventListener<Extract<HarnessEvent, { type: TType }>>,
	): () => void {
		if (this.closedError !== undefined) throw this.closedError;
		const wrapped: UntypedEventListener = (event) => listener(event as Extract<HarnessEvent, { type: TType }>);
		let listeners = this.listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(wrapped);
		return () => listeners?.delete(wrapped);
	}

	emit(event: HarnessEvent): Promise<void> {
		if (this.closedError !== undefined) return Promise.resolve();
		const delivery = this.deliveryTail.then(() => this.deliver(event, true));
		this.deliveryTail = delivery.catch(() => {});
		return delivery;
	}

	watch<T>(snapshot: T, filter: (event: HarnessEvent) => boolean): WatchHandle<T> {
		if (this.closedError !== undefined) throw this.closedError;
		const watcher = new BufferedEventWatcher(snapshot, async (error, event) => {
			if (event.type === "handler_error") return;
			const normalized = error instanceof Error ? error : new Error(String(error));
			const lane = "lane" in event && typeof event.lane === "string" ? event.lane : undefined;
			await this.emit({
				type: "handler_error",
				kind: "event",
				event: event.type,
				error: normalized.message,
				...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
				...(lane === undefined ? {} : { lane }),
			});
		});
		const watchListener: UntypedEventListener = (event) => {
			if (filter(event)) watcher.push(event);
		};
		this.watchListeners.add(watchListener);
		watcher.setUnsubscribe(() => this.watchListeners.delete(watchListener));
		return watcher;
	}

	close(error: Error): void {
		this.closedError ??= error;
		void this.deliveryTail.finally(() => {
			this.listeners.clear();
			this.watchListeners.clear();
		});
	}

	private async deliver(event: HarnessEvent, reportErrors: boolean): Promise<void> {
		const listeners = [...(this.listeners.get(event.type) ?? []), ...this.watchListeners];
		for (const listener of listeners) {
			try {
				await listener(structuredClone(event));
			} catch (error) {
				if (!reportErrors || event.type === "handler_error") continue;
				const normalized = error instanceof Error ? error : new Error(String(error));
				const lane = "lane" in event && typeof event.lane === "string" ? event.lane : undefined;
				const handlerError: HarnessEvent = {
					type: "handler_error",
					kind: "event",
					event: event.type,
					error: normalized.message,
					...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
					...(lane === undefined ? {} : { lane }),
				};
				await this.deliver(handlerError, false);
			}
		}
	}
}

class BufferedEventWatcher<T> implements WatchHandle<T> {
	readonly snapshot: T;
	private readonly onError: (error: unknown, event: HarnessEvent) => void | Promise<void>;
	private buffer: HarnessEvent[] = [];
	private listener: EventListener | undefined;
	private unsubscribeCallback: (() => void) | undefined;
	private deliveryTail: Promise<void> = Promise.resolve();
	private state: "buffering" | "started" | "unsubscribed" = "buffering";

	constructor(snapshot: T, onError: (error: unknown, event: HarnessEvent) => void | Promise<void>) {
		this.snapshot = snapshot;
		this.onError = onError;
	}

	start(listener: EventListener): void {
		if (this.state !== "buffering") throw new Error("WatchHandle.start() may be called only once");
		this.state = "started";
		this.listener = listener;
		const buffered = this.buffer;
		this.buffer = [];
		for (const event of buffered) this.enqueue(event);
	}

	unsubscribe(): void {
		if (this.state === "unsubscribed") return;
		this.state = "unsubscribed";
		this.buffer = [];
		this.listener = undefined;
		this.unsubscribeCallback?.();
		this.unsubscribeCallback = undefined;
	}

	push(event: HarnessEvent): void {
		if (this.state === "unsubscribed") return;
		if (this.state === "buffering") {
			this.buffer.push(event);
			return;
		}
		this.enqueue(event);
	}

	setUnsubscribe(callback: () => void): void {
		this.unsubscribeCallback = callback;
	}

	private enqueue(event: HarnessEvent): void {
		const listener = this.listener;
		if (listener === undefined) return;
		this.deliveryTail = this.deliveryTail
			.then(async () => {
				if (this.state === "started") await listener(event);
			})
			.catch(async (error) => {
				try {
					await this.onError(error, event);
				} catch {}
			});
	}
}
