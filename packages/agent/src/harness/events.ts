export interface Events {
	/**
	 * Register a passive listener for future events and return its unsubscribe function.
	 * Earlier events are not replayed and no current-state snapshot is provided; use a lane or session watch for both.
	 */
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}
