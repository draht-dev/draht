/**
 * The single fleet observer: one scanner, one reaper, one ordered truth
 * (R35-ALWAYS.10).
 *
 * Before this file every connection scanned the socket directory for itself.
 * `buildFleetFrame` is synchronous and runs on every `hello`, so N connected
 * phones meant N independent readings of one directory, each with its own
 * `epoch`/`seq` — and `seq` was the count of snapshots THAT PROCESS had emitted,
 * which is a number about the daemon's chattiness rather than about the fleet.
 * There was no delta of any kind: a phone that slept woke up to a full reload or
 * to nothing.
 *
 * ## Why this is a correctness change and not a performance one
 *
 * {@link listAttachableSessions} REAPS AS A SIDE EFFECT. It removes the socket
 * and lock of a pair whose owner is dead, a `.sock` with no `.lock`, a `.sock`
 * that is not a socket, and a `.lock` with no `.sock` whose owner is gone. A
 * reader that runs on every HTTP request and on every `hello` is therefore a
 * WRITER that runs on every HTTP request and on every `hello`, and the number of
 * writers to one directory is not a thing to leave to how many phones are
 * connected. Concentrating the scan here makes the count exactly one, whatever
 * the daemon is fronting.
 *
 * The second half — and the half a test can actually falsify — is ORDERING. A
 * `fleet_delta` is only meaningful against the snapshot it follows, and "the
 * snapshot it follows" is a sentence with no referent when the snapshot came
 * from one scan and the delta from another. Here the snapshot, the deltas, the
 * `epoch` and the `seq` all come from ONE state machine:
 *
 *   - `epoch` identifies this observer RUN. It is a fresh uuid per instance, so a
 *     daemon restart is visible on the wire: a renderer that sees an epoch it has
 *     not seen throws away everything it holds. That leaks a daemon restart into
 *     the protocol, which is honest and is exactly what a renderer needs.
 *   - `seq` counts STATE TRANSITIONS within an epoch, not emissions. A tick that
 *     changes nothing does not move it, so two renderers that connected at
 *     different moments agree on what `seq` 7 describes, and a renderer that
 *     receives `seq` 9 after `seq` 7 knows it missed one and asks for
 *     `fleet_resync`.
 *
 * ## Poll, do not watch
 *
 * Measured cost of one scan: 0.019 ms at n=0, 0.141 ms at 10 live sessions,
 * 0.764 ms at 50, 2.878 ms at 200 — roughly 14 µs per live session. A 1 Hz poll
 * is free at any plausible fleet size and avoids platform watcher semantics
 * (inotify budgets, network filesystems that report no events, sandboxes that
 * refuse the syscall) entirely. `fs.watch` was rejected for that reason, and for
 * a second one that no watcher can fix: **a status change produces no filesystem
 * event in the socket directory at all.** `git status` moving from clean to dirty
 * is invisible there. So the tick is the only place `changed` could ever come
 * from, and a watcher would still have needed a poll beside it.
 *
 * The observable "appeared" transition is `.sock` CREATION, not `.lock`
 * creation: `SocketServer.start()` claims the lock BEFORE it binds the socket,
 * so a lock-keyed observer would announce a session that has not bound and may
 * never bind. This observer inherits the right key for free by delegating to
 * {@link listAttachableSessions}, which iterates `.sock` entries only.
 *
 * ## The timer is armed by demand, not by construction
 *
 * A daemon nobody has attached to has nothing to deliver a delta to, and a
 * process-lifetime timer in a module every test constructs is a process-lifetime
 * timer in every test. So the poll is armed by the first subscriber and
 * disarmed by the last. Everything else — `hello`, `fleet_resync`, `GET /fleet`
 * — drives the scan ON DEMAND through {@link FleetObserver.refreshNow}, which is
 * still the same single scanner.
 */

import { randomUUID } from "node:crypto";
import type { AttachableSession, FleetDeltaChange, FleetDeltaFrame, FleetFrame } from "@draht/geist-protocol";
import type { HistorySession } from "./history-sessions.js";
import { type FleetProjectionOptions, listAttachableSessions } from "./socket-sessions.js";
import type { FleetStatusSource } from "./status-probe.js";

/** How often the fleet is re-scanned while at least one subscriber wants deltas. */
export const DEFAULT_FLEET_POLL_MS = 1_000;

/**
 * How long a history reading is reused before the store is walked again.
 *
 * The socket directory is a handful of small files; the session store is 1,854
 * of them and every one is `stat`ed on every enumeration (mtime is the sort
 * key). Walking it at the socket cadence would be ~1,850 stats a second for the
 * life of the daemon, for a half of the projection that changes when a session
 * ENDS rather than continuously. So the two halves tick at different rates, and
 * anything that needs the store read right now says so — see the `freshHistory`
 * option on {@link FleetObserver.tick}.
 */
export const DEFAULT_FLEET_HISTORY_REFRESH_MS = 5_000;

/**
 * Minimum gap between two on-demand scans.
 *
 * `hello` and `fleet_resync` both scan, and both are client-driven. Without a
 * floor a client that sends `fleet_resync` in a loop turns one connection into a
 * readdir generator. 25 ms is far below any interval a human perceives and far
 * above the cost of the scan it is bounding.
 */
export const DEFAULT_FLEET_COALESCE_MS = 25;

/**
 * The most changes one `fleet_delta` may carry.
 *
 * Mirrors `FleetDeltaFrameSchema`'s own `.max(256)`. A tick that moves more rows
 * than this is delivered as a SNAPSHOT rather than as a truncated delta: half a
 * delta is worse than a reload, because the renderer cannot tell it is half.
 */
export const MAX_FLEET_DELTA_CHANGES = 256;

/**
 * What a subscriber is told when the fleet moves.
 *
 * Two shapes rather than one because the observer, not the transport, is what
 * knows a tick has outgrown a delta frame. A subscriber that only ever received
 * deltas would have to discover the 256-change cap by having its frame refused.
 */
export type FleetUpdate =
	| { readonly kind: "delta"; readonly delta: FleetDeltaFrame }
	| { readonly kind: "snapshot"; readonly snapshot: FleetFrame };

/** Told the fleet moved. Never given the observer's own arrays to mutate. */
export type FleetUpdateListener = (update: FleetUpdate) => void;

/**
 * The observer as a CONSUMER needs it.
 *
 * A port rather than the class, for the reason every other port in this package
 * is one: {@link AttachBridge} is constructed per connection and must be
 * testable with a fleet that does not touch a filesystem, and the daemon must be
 * able to hand every bridge the same instance without the bridge knowing whether
 * it owns it.
 */
export interface FleetSource {
	/** Identity of this observer run. Opaque; a renderer only compares it. */
	readonly epoch: string;
	/** State transitions within {@link FleetSource.epoch}. */
	readonly seq: number;
	/** The current state, with no scan. */
	snapshot(): FleetFrame;
	/** Scan (subject to the coalescing floor) and return the state that results. */
	refreshNow(): FleetFrame;
	/** Be told about every subsequent transition. Returns the unsubscribe. */
	subscribe(listener: FleetUpdateListener): () => void;
}

export interface FleetObserverOptions {
	/** Directory the fleet publishes itself in. See `resolveSocketDir`. */
	socketDir: string;
	/**
	 * The history rows to merge in, read at the observer's own cadence.
	 *
	 * A function rather than an array because the store keeps changing, and
	 * because reading it is the history index's budget to spend, not this
	 * module's. Absent means "live sockets only", which is what a host with no
	 * session store has.
	 */
	history?: () => readonly HistorySession[];
	/**
	 * Where `status` comes from. Read synchronously off its cache during a tick;
	 * refreshed — which SPAWNS — only from {@link FleetObserver.refreshStatuses}
	 * and from the background kick the poll makes, never inline in a scan.
	 */
	statuses?: FleetStatusSource;
	/** Poll period while subscribed. Defaults to {@link DEFAULT_FLEET_POLL_MS}. */
	pollIntervalMs?: number;
	/** History cadence. Defaults to {@link DEFAULT_FLEET_HISTORY_REFRESH_MS}. */
	historyRefreshMs?: number;
	/** On-demand scan floor. Defaults to {@link DEFAULT_FLEET_COALESCE_MS}. */
	coalesceMs?: number;
	/** Clock seam. Tests inject one; nothing else should. */
	now?: () => number;
	/**
	 * The scan itself.
	 *
	 * A seam so a test can drive transitions without a filesystem. Defaults to
	 * {@link listAttachableSessions}, and there is exactly one call to it in this
	 * process because there is exactly one observer.
	 */
	scan?: (socketDir: string, options: FleetProjectionOptions) => AttachableSession[];
	/** Fresh epoch per run by default. Injectable only so a test can pin it. */
	epoch?: string;
}

/** Whether two readings of one session id describe the same row. */
function sameSession(left: AttachableSession, right: AttachableSession): boolean {
	return (
		left.id === right.id &&
		left.cwd === right.cwd &&
		left.pid === right.pid &&
		left.startedAt === right.startedAt &&
		left.origin === right.origin &&
		left.attachable === right.attachable &&
		left.resumable === right.resumable &&
		left.status === right.status &&
		left.statusAt === right.statusAt
	);
}

export class FleetObserver implements FleetSource {
	readonly epoch: string;

	readonly #socketDir: string;
	readonly #history: (() => readonly HistorySession[]) | null;
	readonly #statuses: FleetStatusSource | null;
	readonly #pollIntervalMs: number;
	readonly #historyRefreshMs: number;
	readonly #coalesceMs: number;
	readonly #now: () => number;
	readonly #scan: (socketDir: string, options: FleetProjectionOptions) => AttachableSession[];

	#seq = 0;
	/** The current state, sorted by id — the order `listAttachableSessions` gives. */
	#rows: AttachableSession[] = [];
	#index = new Map<string, AttachableSession>();

	#historyRows: readonly HistorySession[] = [];
	#historyAtMs = Number.NEGATIVE_INFINITY;
	#lastScanMs = Number.NEGATIVE_INFINITY;

	readonly #listeners = new Set<FleetUpdateListener>();
	#timer: ReturnType<typeof setInterval> | null = null;
	/** Whether a background status refresh is already in flight. */
	#probing = false;

	constructor(options: FleetObserverOptions) {
		this.#socketDir = options.socketDir;
		this.#history = options.history ?? null;
		this.#statuses = options.statuses ?? null;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_FLEET_POLL_MS;
		this.#historyRefreshMs = options.historyRefreshMs ?? DEFAULT_FLEET_HISTORY_REFRESH_MS;
		this.#coalesceMs = options.coalesceMs ?? DEFAULT_FLEET_COALESCE_MS;
		this.#now = options.now ?? Date.now;
		this.#scan = options.scan ?? listAttachableSessions;
		this.epoch = options.epoch ?? randomUUID();
	}

	/** State transitions observed in this epoch. */
	get seq(): number {
		return this.#seq;
	}

	/** How many connections are being fed deltas. Diagnostic only. */
	get subscribers(): number {
		return this.#listeners.size;
	}

	/**
	 * The state as a `fleet` frame, WITHOUT scanning.
	 *
	 * The array is copied on the way out: a renderer's frame must not be a
	 * live view of the observer's own state, or a later tick would rewrite a
	 * snapshot somebody is still encoding.
	 */
	snapshot(): FleetFrame {
		return { type: "fleet", sessions: [...this.#rows], epoch: this.epoch, seq: this.#seq };
	}

	/**
	 * Scan and return the state that results, unless a scan just happened.
	 *
	 * This is the door `hello` and `fleet_resync` come through. The floor is
	 * {@link DEFAULT_FLEET_COALESCE_MS}: within it, the cached state IS the
	 * current state to any precision a client can observe, and skipping the scan
	 * is what stops a client-driven verb from being a readdir amplifier.
	 */
	refreshNow(): FleetFrame {
		if (this.#now() - this.#lastScanMs >= this.#coalesceMs) this.tick();
		return this.snapshot();
	}

	/**
	 * One scan, one diff, at most one update to every subscriber.
	 *
	 * SYNCHRONOUS FROM END TO END, and that is the ordering guarantee itself: on
	 * a single-threaded runtime nothing can run between the scan and the
	 * notification, so a snapshot taken outside this method and the deltas taken
	 * inside it cannot describe two different worlds. Nothing here spawns — the
	 * status source is READ, never refreshed (see {@link FleetObserver.refreshStatuses}).
	 *
	 * @param options - `freshHistory` forces the session store to be re-read even
	 *                  if its cadence has not come round. `GET /fleet` sets it;
	 *                  the poll does not.
	 * @returns the update delivered to subscribers, or null when nothing moved.
	 */
	tick(options: { freshHistory?: boolean } = {}): FleetUpdate | null {
		const nowMs = this.#now();
		this.#lastScanMs = nowMs;

		if (
			this.#history !== null &&
			(options.freshHistory === true || nowMs - this.#historyAtMs >= this.#historyRefreshMs)
		) {
			this.#historyAtMs = nowMs;
			try {
				this.#historyRows = this.#history();
			} catch {
				// A history store that cannot be read is not a reason to lose the live
				// fleet. The previous rows stand until it can be.
			}
		}

		let rows: AttachableSession[];
		try {
			rows = this.#scan(this.#socketDir, {
				history: this.#historyRows,
				statuses: this.#statuses ?? undefined,
			});
		} catch {
			// The scan already swallows an unreadable directory; this is the bound on
			// everything it does not. A failed scan reports NO CHANGE rather than an
			// empty fleet: "I could not look" must never be delivered as "they are
			// all gone", which is what a bare `catch` returning `[]` would do.
			return null;
		}

		const next = new Map<string, AttachableSession>();
		for (const row of rows) next.set(row.id, row);

		const changes: FleetDeltaChange[] = [];
		for (const row of rows) {
			const previous = this.#index.get(row.id);
			if (previous === undefined) {
				// The full body, never just an id: a renderer REPLACES on `appeared`,
				// and a resume reuses one id with a new pid and a new `startedAt`.
				changes.push({ kind: "appeared", session: row });
			} else if (!sameSession(previous, row)) {
				changes.push({ kind: "changed", session: row });
			}
		}
		for (const id of this.#index.keys()) {
			if (!next.has(id)) changes.push({ kind: "disappeared", id });
		}

		this.#rows = rows;
		this.#index = next;
		if (changes.length === 0) return null;

		this.#seq += 1;
		const update: FleetUpdate =
			changes.length > MAX_FLEET_DELTA_CHANGES
				? { kind: "snapshot", snapshot: this.snapshot() }
				: { kind: "delta", delta: { type: "fleet_delta", epoch: this.epoch, seq: this.#seq, changes } };
		this.#notify(update);
		return update;
	}

	/**
	 * Bring the status cache up to date, then fold the result into the state.
	 *
	 * THE ONLY DOOR A GIT PROBE COMES THROUGH on this object, and it is `async`
	 * for exactly that reason. A probe is a subprocess with a 500 ms deadline;
	 * running one inside {@link FleetObserver.tick} would put N × 500 ms on the
	 * `hello` path, where a single wedged repository would stall the daemon for
	 * every connected phone. Callers that can wait — an HTTP request — await
	 * this; callers that cannot get whatever the cache already holds.
	 *
	 * The leading `tick()` is what makes the probe list right: the cwds worth
	 * probing are the ones that are live NOW.
	 */
	async refreshStatuses(): Promise<void> {
		const refresh = this.#statuses?.refresh;
		if (refresh === undefined || this.#statuses === null) return;
		this.tick();
		const cwds = this.#rows.filter((row) => row.origin === "socket").map((row) => row.cwd);
		await refresh.call(this.#statuses, cwds);
	}

	/**
	 * Be told about every transition from now on.
	 *
	 * Arms the poll on the first subscriber and disarms it on the last, so a
	 * daemon nobody is watching does no periodic work at all and a test that
	 * never attaches leaves no timer behind.
	 *
	 * @returns the unsubscribe. Idempotent; always safe to call from a close path.
	 */
	subscribe(listener: FleetUpdateListener): () => void {
		this.#listeners.add(listener);
		this.#arm();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) this.stop();
		};
	}

	/** Disarm the poll. The state and the epoch survive; only the timer stops. */
	stop(): void {
		if (this.#timer === null) return;
		clearInterval(this.#timer);
		this.#timer = null;
	}

	#arm(): void {
		if (this.#timer !== null) return;
		const timer = setInterval(() => {
			this.tick();
			this.#kickStatusProbe();
		}, this.#pollIntervalMs);
		// Like every other timer in this package: never the reason a daemon
		// refuses to exit.
		timer.unref?.();
		this.#timer = timer;
	}

	/**
	 * Start a status refresh beside the poll, never inside it.
	 *
	 * This is where `changed` gets a source that no filesystem event could give
	 * it: a working tree going clean → dirty moves nothing in the socket
	 * directory, so unless somebody probes on a timer, `status` is only ever as
	 * fresh as the last HTTP request. Fire-and-forget and strictly
	 * non-overlapping — the result lands in the cache and the NEXT tick reads it,
	 * which is what keeps the probe off the delivery path.
	 */
	#kickStatusProbe(): void {
		if (this.#probing || this.#statuses?.refresh === undefined) return;
		this.#probing = true;
		void this.refreshStatuses()
			.catch(() => {
				// A probe that could not run leaves the cache as it was; the rows keep
				// their last reading and its timestamp, which is what `statusAt` is for.
			})
			.finally(() => {
				this.#probing = false;
			});
	}

	/** Deliver to every subscriber, isolating each from the others. */
	#notify(update: FleetUpdate): void {
		// A copy: a listener may unsubscribe itself — a bridge that refuses its
		// connection does exactly that — and mutating the set mid-iteration would
		// skip whoever came after it.
		for (const listener of [...this.#listeners]) {
			try {
				listener(update);
			} catch {
				// One renderer's failure is not the fleet's. The bridge already turns
				// its own overflow into a typed refusal on its own connection.
			}
		}
	}
}
