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
 *
 * WHAT "EXACTLY ONCE" MEANS HERE, PRECISELY, BECAUSE THE PHRASE IS OTHERWISE A PROMISE THIS WIRE
 * CANNOT KEEP (R34-PERM.6). It means two things and no others:
 *
 *   1. EXACTLY ONE AUTHORITATIVE RESOLUTION per request. That is the registry's synchronous
 *      compare-and-swap in `permission-registry.ts`, not this file's business at all: however many
 *      copies of an ask were shown, however many answers come back, one of them settles it and
 *      every later one is refused with a tombstone.
 *   2. EXACTLY ONE REPLAY per (reconnect, still-pending request). That is this file: one send per
 *      connection per ask, deduplicated CLIENT-SIDE by `requestId` — a renderer that already has a
 *      dialog open for an id must update it rather than open a second one.
 *
 * TRUE END-TO-END EXACTLY-ONCE IS IMPOSSIBLE OVER THIS TRANSPORT AND MUST NOT BE ATTEMPTED. A
 * frame written to a socket that then dies may or may not have been rendered, and no acknowledgement
 * can close that gap: an ack that arrives says the ask was seen, an ack that never arrives says
 * nothing at all. The only two safe designs are "deliver at least once and dedupe by id" (this one)
 * and "deliver at most once", which loses asks. Anything that tried to make delivery authoritative
 * would have to make it a state transition — and that is precisely the wedge above.
 */

/** The least this module needs to know about an ask. The registry's entry satisfies it. */
export interface DeliverableAsk {
	readonly requestId: string;
	/**
	 * Encoded size of the frame this ask will be replayed as, in bytes, when the ask knows it.
	 *
	 * `PermissionEntry` counts it once at insert and carries it, so in production it is always
	 * there. It is optional because this module's contract is "the least it needs to know", and an
	 * ask that does not state its size is bounded by the COUNT cap alone — see
	 * {@link PermissionDeliveryOptions.maxReplayBytes}.
	 */
	readonly bytes?: number;
}

export interface PermissionDeliveryOptions<T extends DeliverableAsk> {
	/** Live view of what is still pending. Called on every replay; never cached. */
	pending: () => readonly T[];
	/** How many client records to keep. Beyond this, the least recently touched is dropped. */
	maxClients?: number;
	/** How many delivered ids to remember per client. */
	maxPerClient?: number;
	/**
	 * How many still-pending asks one attach may push at a client.
	 *
	 * The replay burst is the one place where a single client action — attaching — makes the
	 * server write an unbounded amount at it. Without a cap, a session sitting at the registry's
	 * pending limit hands every reconnecting phone the whole backlog in one loop.
	 */
	maxReplayAsks?: number;
	/**
	 * Total encoded bytes one attach may push at a client.
	 *
	 * The count cap alone is not a byte bound: an ask may legitimately carry a 60 KB command, so
	 * "at most 16 of them" is still nearly a megabyte. Both caps apply, whichever binds first.
	 */
	maxReplayBytes?: number;
}

/** Client records kept at once. Well above the socket server's own `maxClients` of 10. */
export const DEFAULT_MAX_DELIVERY_CLIENTS = 64;

/** Delivered ids remembered per client. Above the registry's pending bound, so it never binds first. */
export const DEFAULT_MAX_DELIVERED_PER_CLIENT = 256;

/**
 * Pending asks pushed on ONE attach. Half the registry's own pending bound.
 *
 * It is a BACKSTOP, not a queue. Nothing is dropped when it binds: the asks it did not send are
 * still pending, still answerable, and still counted down by the one clock. They are simply not
 * written in the same burst as everything else the newly attached client is being sent.
 *
 * Oldest first, because insertion order is deadline order — the ask closest to expiring is the one
 * a human has least time left to answer.
 */
export const DEFAULT_MAX_REPLAY_ASKS = 16;

/**
 * Total encoded bytes pushed on ONE attach: 256 KiB.
 *
 * Four full-sized asks at the registry's 60 KB per-entry ceiling, which is the realistic worst
 * case, and far above the few hundred bytes a real tool-permission frame occupies.
 */
export const DEFAULT_MAX_REPLAY_BYTES = 256 * 1024;

export class PermissionDelivery<T extends DeliverableAsk = DeliverableAsk> {
	readonly #pending: () => readonly T[];
	readonly #maxClients: number;
	readonly #maxPerClient: number;
	readonly #maxReplayAsks: number;
	readonly #maxReplayBytes: number;
	/** clientId → request ids that client has been sent on its CURRENT connection. */
	readonly #delivered = new Map<string, Set<string>>();

	constructor(options: PermissionDeliveryOptions<T>) {
		this.#pending = options.pending;
		this.#maxClients = options.maxClients ?? DEFAULT_MAX_DELIVERY_CLIENTS;
		this.#maxPerClient = options.maxPerClient ?? DEFAULT_MAX_DELIVERED_PER_CLIENT;
		this.#maxReplayAsks = options.maxReplayAsks ?? DEFAULT_MAX_REPLAY_ASKS;
		this.#maxReplayBytes = options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES;
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
	 * The still-pending asks this client has not been shown on this connection — BOUNDED.
	 *
	 * Read straight off the registry each time: an ask that was answered while the client was
	 * connecting is no longer pending and must not be replayed as if it still needed an answer.
	 *
	 * Both caps are applied here rather than at the call site so that no caller can replay an
	 * unbounded burst by accident. Truncating is NOT dropping: an ask left out of this list is
	 * untouched, still PENDING, and still the only thing that can end it is an answer, the clock,
	 * or a cancellation. Nothing about being unsent is a decision.
	 */
	pendingFor(clientId: string): T[] {
		const seen = this.#delivered.get(clientId);
		const undelivered = this.#pending().filter((ask) => seen?.has(ask.requestId) !== true);

		const bounded: T[] = [];
		let bytes = 0;
		for (const ask of undelivered) {
			if (bounded.length >= this.#maxReplayAsks) break;
			// An ask that does not state its size contributes nothing to the byte budget; the count
			// cap is what bounds it. See DeliverableAsk.bytes.
			const size = ask.bytes ?? 0;
			// The FIRST ask is always sent, whatever it weighs: refusing to replay the only
			// outstanding ask because it is large would leave the agent parked with no surface
			// able to see why.
			if (bounded.length > 0 && bytes + size > this.#maxReplayBytes) break;
			bounded.push(ask);
			bytes += size;
		}
		return bounded;
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
