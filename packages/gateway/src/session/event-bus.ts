/**
 * DomainEvent — union of all session lifecycle event names.
 */
export type DomainEvent = "session:created" | "session:started" | "session:stopped" | "session:destroyed";

/** Payload emitted when a new session is created. */
export interface SessionCreatedPayload {
	sessionId: string;
	createdAt: Date;
}

/** Payload emitted when a session's process becomes running. */
export interface SessionStartedPayload {
	sessionId: string;
}

/** Payload emitted when a session's process exits. */
export interface SessionStoppedPayload {
	sessionId: string;
	exitCode: number | null;
}

/** Payload emitted when a session is destroyed and removed from the store. */
export interface SessionDestroyedPayload {
	sessionId: string;
}

/**
 * EventMap — maps each DomainEvent name to its typed payload interface.
 *
 * Used to enforce correct payload shapes at call sites of on/emit.
 */
export interface EventMap {
	"session:created": SessionCreatedPayload;
	"session:started": SessionStartedPayload;
	"session:stopped": SessionStoppedPayload;
	"session:destroyed": SessionDestroyedPayload;
}

/**
 * EventBus — typed, synchronous in-process pub/sub for session domain events.
 *
 * Implements the fan-out pattern: multiple subscribers may register for any
 * event, and each is called synchronously in registration order when the event
 * is emitted. Callers receive an unsubscribe handle from `on()` for clean
 * teardown (e.g. when an SSE connection closes).
 *
 * @example
 * ```ts
 * const bus = new EventBus();
 * const unsub = bus.on('session:created', ({ sessionId, createdAt }) => {
 *   console.log('session created', sessionId);
 * });
 * bus.emit('session:created', { sessionId: 'abc', createdAt: new Date() });
 * unsub(); // remove listener
 * ```
 */
export class EventBus {
	/** Private listener registry: event name → set of callbacks. */
	readonly #listeners = new Map<string, Set<(...args: never) => unknown>>();

	/**
	 * Register a typed listener for a domain event.
	 *
	 * The listener is called synchronously with the typed payload each time
	 * the event is emitted. Listeners are stored in a Set, so the same function
	 * reference registered twice results in a single invocation per emit.
	 *
	 * @param event - The domain event name to subscribe to.
	 * @param cb    - Callback receiving the typed payload for this event.
	 * @returns An unsubscribe function; calling it removes the listener immediately.
	 */
	on<E extends DomainEvent>(event: E, cb: (payload: EventMap[E]) => void): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(cb);
		return () => this.off(event, cb);
	}

	/**
	 * Unsubscribe a previously registered listener.
	 *
	 * If the callback was not registered, this is a no-op.
	 *
	 * @param event - The domain event name.
	 * @param cb    - The exact callback reference that was passed to `on()`.
	 */
	off<E extends DomainEvent>(event: E, cb: (payload: EventMap[E]) => void): void {
		this.#listeners.get(event)?.delete(cb as (...args: never) => unknown);
	}

	/**
	 * Emit a domain event, invoking all registered listeners synchronously.
	 *
	 * Copies the Set before iterating so that listeners removing themselves
	 * during iteration do not affect the current emission.
	 *
	 * @param event   - The domain event name to emit.
	 * @param payload - The typed payload for this event.
	 */
	emit<E extends DomainEvent>(event: E, payload: EventMap[E]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		// Copy before iterating to guard against mutation during emission
		for (const cb of [...set]) {
			(cb as (payload: EventMap[E]) => void)(payload);
		}
	}

	/**
	 * Return the number of listeners currently registered for an event.
	 *
	 * Primarily useful in tests and SSE cleanup verification.
	 *
	 * @param event - The domain event name to query.
	 * @returns The current listener count (0 if none registered).
	 */
	listenerCount(event: DomainEvent): number {
		return this.#listeners.get(event)?.size ?? 0;
	}
}
