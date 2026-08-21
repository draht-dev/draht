/**
 * permission-delivery — per-connection bookkeeping for asks that have been SHOWN to a client.
 *
 * THIS IS NOT STATE ABOUT THE ASK. It is state about a connection, and keeping the two apart is
 * the whole reason this is a separate module rather than a field on the registry entry.
 *
 * The defect it exists to make unrepresentable: if delivering an ask (or acknowledging one)
 * consumed it, a client that was shown the ask and then died would take it with it — the entry
 * gone, no other surface ever told, and the agent still parked in `beforeToolCall` waiting for an
 * answer that can no longer be given. Delivery is therefore idempotent and NEVER a state
 * transition: an ask stays PENDING until somebody ANSWERS it, it expires, or it is cancelled.
 *
 * What it buys instead is "exactly once per connection": a client that attaches after an ask was
 * raised is shown it once, on attach, right after `session_metadata` — and is not shown it again
 * on every subsequent broadcast. When that client disconnects its record is dropped, so a
 * reconnecting client (same id, new connection) is shown every still-pending ask again. It has to
 * be: it may be a fresh process that has never seen any of them.
 */

/** The least this module needs to know about an ask. The registry's entry satisfies it. */
export interface DeliverableAsk {
	readonly requestId: string;
}

export interface PermissionDeliveryOptions<T extends DeliverableAsk> {
	/** Live view of what is still pending. Called on every replay; never cached. */
	pending: () => readonly T[];
	/** How many client records to keep. Beyond this, the least recently touched is dropped. */
	maxClients?: number;
	/** How many delivered ids to remember per client. */
	maxPerClient?: number;
}

/** Client records kept at once. Well above the socket server's own `maxClients` of 10. */
export const DEFAULT_MAX_DELIVERY_CLIENTS = 64;

/** Delivered ids remembered per client. Above the registry's pending bound, so it never binds first. */
export const DEFAULT_MAX_DELIVERED_PER_CLIENT = 256;

export class PermissionDelivery<T extends DeliverableAsk = DeliverableAsk> {
	readonly #pending: () => readonly T[];
	readonly #maxClients: number;
	readonly #maxPerClient: number;
	/** clientId → request ids that client has been sent on its CURRENT connection. */
	readonly #delivered = new Map<string, Set<string>>();

	constructor(options: PermissionDeliveryOptions<T>) {
		this.#pending = options.pending;
		this.#maxClients = options.maxClients ?? DEFAULT_MAX_DELIVERY_CLIENTS;
		this.#maxPerClient = options.maxPerClient ?? DEFAULT_MAX_DELIVERED_PER_CLIENT;
	}

	/** Record that `clientId` has been sent `requestId`. Idempotent, and never a state transition. */
	markDelivered(clientId: string, requestId: string): void {
		let seen = this.#delivered.get(clientId);
		if (seen === undefined) {
			seen = new Set<string>();
			this.#delivered.set(clientId, seen);
			this.#evictOldestClients();
		}
		seen.add(requestId);
		while (seen.size > this.#maxPerClient) {
			const oldest = seen.values().next();
			if (oldest.done === true) break;
			seen.delete(oldest.value);
		}
	}

	hasDelivered(clientId: string, requestId: string): boolean {
		return this.#delivered.get(clientId)?.has(requestId) === true;
	}

	/**
	 * Every still-pending ask this client has not been shown on this connection.
	 *
	 * Read straight off the registry each time: an ask that was answered while the client was
	 * connecting is no longer pending and must not be replayed as if it still needed an answer.
	 */
	pendingFor(clientId: string): T[] {
		const seen = this.#delivered.get(clientId);
		return this.#pending().filter((ask) => seen?.has(ask.requestId) !== true);
	}

	/**
	 * Forget everything about a client, because its connection ended.
	 *
	 * A client that reconnects under the same id is a NEW connection with nothing on its screen,
	 * so it must be shown every pending ask again. Remembering across the gap would leave a phone
	 * that dropped its WebSocket staring at a session whose ask it can no longer see or answer.
	 */
	forgetClient(clientId: string): void {
		this.#delivered.delete(clientId);
	}

	/** Drop an ask from every client's record, because it is over. */
	forgetRequest(requestId: string): void {
		for (const seen of this.#delivered.values()) seen.delete(requestId);
	}

	clear(): void {
		this.#delivered.clear();
	}

	#evictOldestClients(): void {
		while (this.#delivered.size > this.#maxClients) {
			const oldest = this.#delivered.keys().next();
			if (oldest.done === true) break;
			this.#delivered.delete(oldest.value);
		}
	}
}
