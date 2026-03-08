/**
 * StoppableServer — structural interface for anything that can stop accepting
 * new connections (e.g. the object returned by Bun.serve()).
 *
 * Using a structural interface rather than a concrete class keeps
 * GatewayLifecycle testable without importing Bun internals.
 */
export interface StoppableServer {
	stop(): void;
}

/**
 * DestroyableManager — structural interface for a session store that can
 * terminate all active sessions at once.
 *
 * Satisfied by SessionManager once destroyAll() is added (Plan 2, Task 1).
 */
export interface DestroyableManager {
	destroyAll(): number;
}

/**
 * GatewayLifecycle — coordinates orderly shutdown of the HTTP/WS server and
 * all managed sessions in response to SIGTERM / SIGINT.
 *
 * Shutdown sequence:
 *   1. server.stop()     — stop accepting new connections
 *   2. manager.destroyAll() — kill every active session and emit domain events
 *
 * The shutdown promise is memoised: concurrent or repeated calls all receive
 * the same Promise<number>, guaranteeing stop() and destroyAll() are each
 * invoked exactly once regardless of how many times shutdown() is called.
 */
export class GatewayLifecycle {
	readonly #server: StoppableServer;
	readonly #manager: DestroyableManager;
	#shutdownPromise: Promise<number> | null = null;

	/**
	 * @param server  - A running server instance (Bun.serve return value or mock).
	 * @param manager - The session manager owning all active sessions.
	 */
	constructor(server: StoppableServer, manager: DestroyableManager) {
		this.#server = server;
		this.#manager = manager;
	}

	/**
	 * Initiate an orderly shutdown.
	 *
	 * Stops the server, then destroys all sessions. Memoised: safe to call
	 * multiple times or concurrently — the cleanup runs exactly once and every
	 * caller receives the same resolved count.
	 *
	 * @returns A Promise that resolves to the number of sessions destroyed.
	 */
	shutdown(): Promise<number> {
		if (this.#shutdownPromise !== null) {
			return this.#shutdownPromise;
		}
		this.#shutdownPromise = Promise.resolve().then(() => {
			this.#server.stop();
			return this.#manager.destroyAll();
		});
		return this.#shutdownPromise;
	}
}
