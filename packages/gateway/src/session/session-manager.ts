import type { EventBus } from "./event-bus.js";
import { Session } from "./session.js";

/**
 * SessionManager — domain service managing the full lifecycle of Session entities.
 *
 * Stores sessions in a private in-memory Map. Each instance owns its own store,
 * making it trivially injectable and testable without global state.
 *
 * Sessions are optionally backed by a real SessionProcess. When a command is
 * provided to create(), a subprocess is spawned and wired for lifecycle tracking.
 * Callers are responsible for deciding how to surface not-found conditions
 * (e.g. 404 HTTP responses) — this class never throws for missing sessions.
 *
 * An EventBus is required at construction time. Domain events are emitted on
 * every lifecycle transition: created, started, stopped, and destroyed.
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
	 * Spawn a new session and register it in the store.
	 *
	 * Emits `session:created` synchronously after the session is stored.
	 * When `command` is provided, a SessionProcess is created and attached to
	 * the session, with status transitions wired automatically through
	 * starting → running → stopped, and `session:started` / `session:stopped`
	 * emitted at the corresponding transition points.
	 *
	 * When no command is provided, the session has no backing process and
	 * status remains 'starting'. No `session:started` or `session:stopped`
	 * events are emitted.
	 *
	 * @param command - Optional command + arguments to spawn as a subprocess.
	 * @param cwd - Optional working directory for the process.
	 * @returns The newly created Session entity.
	 */
	create(command?: string[], cwd?: string): Session {
		const session = Session.create(command, cwd);
		this.#sessions.set(session.id, session);

		this.#bus.emit("session:created", {
			sessionId: session.id,
			createdAt: session.createdAt,
		});

		if (command !== undefined && session.process !== undefined) {
			const proc = session.process;
			const sessionId = session.id;

			// Emit session:started when the process is confirmed running.
			// The .catch() prevents an unhandled rejection if the process fails
			// to start (e.g. binary not found — Bun rejects proc.ready).
			proc.ready
				.then(() => {
					this.#bus.emit("session:started", { sessionId });
				})
				.catch(() => {
					// Process failed to start; session will be marked stopped via exited.
				});

			// Emit session:stopped on process exit regardless of cause (natural exit,
			// SIGTERM, SIGKILL). The .catch() covers the rare edge case where Bun's
			// exited promise itself rejects.
			proc.exited
				.then(() => {
					this.#bus.emit("session:stopped", {
						sessionId,
						exitCode: proc.exitCode,
					});
				})
				.catch(() => {
					// Emit stopped with null exit code so listeners still clean up.
					this.#bus.emit("session:stopped", { sessionId, exitCode: null });
				});
		}

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
	 * to destroy() — which kills any backing process and emits `session:destroyed`
	 * via the EventBus. Safe to call when the store is empty (returns 0) and
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
	 * Destroy (terminate and remove) a session by id.
	 *
	 * If the session has a backing process, it is killed before the session is
	 * removed from the store. Emits `session:destroyed` after successful deletion.
	 * Returns false rather than throwing when the session does not exist — the
	 * caller decides whether absence is an error (e.g. 404) or a no-op.
	 *
	 * @param id - UUID v4 session identifier.
	 * @returns `true` if the session was found and removed; `false` otherwise.
	 */
	destroy(id: string): boolean {
		const session = this.#sessions.get(id);
		if (!session) return false;
		session.process?.kill();
		const deleted = this.#sessions.delete(id);
		if (deleted) {
			this.#bus.emit("session:destroyed", { sessionId: id });
		}
		return deleted;
	}
}
