import type { EventListener, Events, HarnessEvent, HarnessEventType, WatchHandle } from "./agent-harness.ts";
import type { Context } from "./context.ts";

type UntypedEventListener = (event: HarnessEvent, context: Context) => void | Promise<void>;

export interface HarnessEventDelivery {
	start(): Promise<void>;
}

/** Passive harness event bus with isolated handler failures. */
export class HarnessEventBus implements Events {
	private readonly listeners = new Map<HarnessEventType, Set<UntypedEventListener>>();
	private readonly watchListeners = new Set<UntypedEventListener>();
	private readonly pendingStarts = new Set<() => void>();
	private deliveryTail: Promise<void> = Promise.resolve();
	private closedError: Error | undefined;

	on<TType extends HarnessEventType>(
		type: TType,
		listener: EventListener<Extract<HarnessEvent, { type: TType }>>,
	): () => void {
		if (this.closedError !== undefined) throw this.closedError;
		const wrapped: UntypedEventListener = (event, context) =>
			listener(event as Extract<HarnessEvent, { type: TType }>, context);
		let listeners = this.listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.listeners.set(type, listeners);
		}
		listeners.add(wrapped);
		return () => listeners?.delete(wrapped);
	}

	emit(event: HarnessEvent, context: Context): Promise<void> {
		return this.enqueue([event], context).start();
	}

	/**
	 * Bind and reserve one contiguous event batch without permitting listener execution until `start()`.
	 * Commit owners call this before releasing their serialization line, then call `start()` only after release.
	 * Prefer `Lane.command`; a dropped or early-started delivery breaks snapshot/event boundary semantics.
	 */
	enqueue(events: readonly HarnessEvent[], context: Context): HarnessEventDelivery {
		if (this.closedError !== undefined || events.length === 0) return { start: () => Promise.resolve() };
		const bound = events.map((event) => {
			const payload = structuredClone(event);
			return { payload, recipients: this.snapshotRecipients(payload) };
		});
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delivery = this.deliveryTail.then(async () => {
			await gate;
			for (const { payload, recipients } of bound) await this.deliver(payload, recipients, true, context);
		});
		this.deliveryTail = delivery.catch(() => {});
		let started = false;
		const start = (): void => {
			if (started) return;
			started = true;
			this.pendingStarts.delete(start);
			release?.();
		};
		this.pendingStarts.add(start);
		return {
			start: () => {
				start();
				return delivery;
			},
		};
	}

	watch<T>(snapshot: T, filter: (event: HarnessEvent) => boolean, _context: Context): WatchHandle<T> {
		if (this.closedError !== undefined) throw this.closedError;
		return this.installWatcher(snapshot, filter);
	}

	async watchFromSnapshot<T>(
		capture: (context: Context) => Promise<T>,
		filter: (event: HarnessEvent) => boolean,
		context: Context,
	): Promise<WatchHandle<T>> {
		if (this.closedError !== undefined) throw this.closedError;
		const watcher = this.installWatcher<T>(undefined, filter);
		try {
			watcher.setSnapshot(await capture(context));
			return watcher;
		} catch (error) {
			watcher.unsubscribe();
			throw error;
		}
	}

	close(error: Error): void {
		this.closedError ??= error;
		for (const start of [...this.pendingStarts]) start();
		void this.deliveryTail.finally(() => {
			this.listeners.clear();
			this.watchListeners.clear();
		});
	}

	private installWatcher<T>(
		snapshot: T | undefined,
		filter: (event: HarnessEvent) => boolean,
	): BufferedEventWatcher<T> {
		const watcher = new BufferedEventWatcher(snapshot, async (error, event, context) => {
			if (event.type === "handler_error") return;
			const normalized = error instanceof Error ? error : new Error(String(error));
			const lane = "lane" in event && typeof event.lane === "string" ? event.lane : undefined;
			await this.emit(
				{
					type: "handler_error",
					kind: "event",
					event: event.type,
					error: normalized.message,
					...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
					...(lane === undefined ? {} : { lane }),
				},
				context,
			);
		});
		const watchListener: UntypedEventListener = (event, context) => {
			if (filter(event)) watcher.push(event, context);
		};
		this.watchListeners.add(watchListener);
		watcher.setUnsubscribe(() => this.watchListeners.delete(watchListener));
		return watcher;
	}

	private snapshotRecipients(event: HarnessEvent): UntypedEventListener[] {
		return [...(this.listeners.get(event.type) ?? []), ...this.watchListeners];
	}

	private async deliver(
		event: HarnessEvent,
		recipients: readonly UntypedEventListener[],
		reportErrors: boolean,
		context: Context,
	): Promise<void> {
		for (const listener of recipients) {
			try {
				await listener(structuredClone(event), context);
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
				await this.deliver(handlerError, this.snapshotRecipients(handlerError), false, context);
			}
		}
	}
}

class BufferedEventWatcher<T> implements WatchHandle<T> {
	snapshot: T;
	private readonly onError: (error: unknown, event: HarnessEvent, context: Context) => void | Promise<void>;
	private buffer: Array<{ event: HarnessEvent; context: Context }> = [];
	private listener: EventListener | undefined;
	private unsubscribeCallback: (() => void) | undefined;
	private deliveryTail: Promise<void> = Promise.resolve();
	private state: "buffering" | "started" | "unsubscribed" = "buffering";

	constructor(
		snapshot: T | undefined,
		onError: (error: unknown, event: HarnessEvent, context: Context) => void | Promise<void>,
	) {
		this.snapshot = snapshot as T;
		this.onError = onError;
	}

	setSnapshot(snapshot: T): void {
		this.snapshot = snapshot;
	}

	start(listener: EventListener): void {
		if (this.state !== "buffering") throw new Error("WatchHandle.start() may be called only once");
		this.state = "started";
		this.listener = listener;
		const buffered = this.buffer;
		this.buffer = [];
		for (const bufferedEvent of buffered) this.enqueue(bufferedEvent.event, bufferedEvent.context);
	}

	unsubscribe(): void {
		if (this.state === "unsubscribed") return;
		this.state = "unsubscribed";
		this.buffer = [];
		this.listener = undefined;
		this.unsubscribeCallback?.();
		this.unsubscribeCallback = undefined;
	}

	push(event: HarnessEvent, context: Context): void {
		if (this.state === "unsubscribed") return;
		if (this.state === "buffering") {
			this.buffer.push({ event, context });
			return;
		}
		this.enqueue(event, context);
	}

	setUnsubscribe(callback: () => void): void {
		this.unsubscribeCallback = callback;
	}

	private enqueue(event: HarnessEvent, context: Context): void {
		const listener = this.listener;
		if (listener === undefined) return;
		this.deliveryTail = this.deliveryTail
			.then(async () => {
				if (this.state === "started") await listener(event, context);
			})
			.catch(async (error) => {
				try {
					await this.onError(error, event, context);
				} catch {}
			});
	}
}
