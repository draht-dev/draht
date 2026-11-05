import type { EventBus } from "./event-bus.js";
import { Session } from "./session.js";

/**
 * SessionManager — domain service managing the full lifecycle of Session entities.
 *
 * Stores sessions in a private in-memory Map. Each instance owns its own store,
 * making it trivially injectable and testable without global state.
 *
 * A session is a record, and this class never starts a process. Callers are
 * responsible for deciding how to surface not-found conditions
 * (e.g. 404 HTTP responses) — this class never throws for missing sessions.
 *
 * An EventBus is required at construction time. `session:created` and
 * `session:destroyed` are emitted here. `session:started` and `session:stopped`
 * stay declared on the bus for subscribers of the SSE vocabulary, but only a
 * process has those transitions, so nothing emits them.
 */
export class SessionManager {
	/** Private store: session id → Session entity. */
	readonly #sessions = new Map<string, Session>();

	/** Domain event bus for lifecycle event emission. */
	readonly #bus: EventBus;

	/**
	 * Construct a SessionManager wired to the given EventBus.
	 *
	 * @param bus - The domain event bus; receives all session lifecycle events.
	 */
	constructor(bus: EventBus) {
		this.#bus = bus;
	}

	/**
	 * Register a new session record in the store.
	 *
	 * Emits `session:created` synchronously after the session is stored. The
	 * session has no backing process and its status remains 'starting'.
	 *
	 * @returns The newly created Session entity.
	 */
	create(): Session {
		const session = Session.create();
		this.#sessions.set(session.id, session);

		this.#bus.emit("session:created", {
			sessionId: session.id,
			createdAt: session.createdAt,
		});

		return session;
	}

	/**
	 * List all active sessions.
	 *
	 * @returns A snapshot array of all sessions currently in the store.
	 *          Returns an empty array when no sessions exist.
	 */
	list(): Session[] {
		return [...this.#sessions.values()];
	}

	/**
	 * Look up a session by its unique id.
	 *
	 * @param id - UUID v4 session identifier.
	 * @returns The matching Session, or `undefined` if not found.
	 */
	get(id: string): Session | undefined {
		return this.#sessions.get(id);
	}

	/**
	 * Destroy all active sessions in the store.
	 *
	 * Snapshots the current session ids before iterating, then delegates each
	 * to destroy() — which emits `session:destroyed` via the EventBus. Safe to call when the store is empty (returns 0) and
	 * idempotent: a second call on an already-empty store also returns 0.
	 *
	 * @returns The number of sessions that were destroyed.
	 */
	destroyAll(): number {
		const ids = [...this.#sessions.keys()];
		for (const id of ids) {
			this.destroy(id);
		}
		return ids.length;
	}

	/**
	 * Destroy (remove) a session by id.
	 *
	 * Emits `session:destroyed` after successful deletion.
	 * Returns false rather than throwing when the session does not exist — the
	 * caller decides whether absence is an error (e.g. 404) or a no-op.
	 *
	 * @param id - UUID v4 session identifier.
	 * @returns `true` if the session was found and removed; `false` otherwise.
	 */
	destroy(id: string): boolean {
		const session = this.#sessions.get(id);
		if (!session) return false;
		const deleted = this.#sessions.delete(id);
		if (deleted) {
			this.#bus.emit("session:destroyed", { sessionId: id });
		}
		return deleted;
	}
}
