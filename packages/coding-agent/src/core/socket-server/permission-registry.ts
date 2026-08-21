/**
 * permission-registry — the session's bounded pending-ask registry, and the ONE clock.
 *
 * An ask raised by the agent parks the turn until somebody answers it. This module is what holds
 * that ask while it is unanswered: what was offered, who may answer it, when it stops being
 * answerable, and — once — who won.
 *
 * FOUR PROPERTIES ARE LOAD-BEARING, each paid for by a defect this file exists to make
 * unrepresentable:
 *
 *  1. {@link PermissionRegistry.settle} is SYNCHRONOUS from the pending-check through the removal.
 *     One `await` between "is it still pending?" and "mark it resolved" lets two answers both pass
 *     validation; the second `resolve()` on the caller's promise is a silent no-op, so a denial
 *     and an approval both look accepted and only one of them happened.
 *  2. AN ANSWER'S MEANING COMES FROM THE OFFERED OPTION'S OWN `decision`. Never from its position
 *     in the array, never from the shape of its id, never from a label. A vocabulary like
 *     `[allow, deny-once, deny-always]` has its denial in the middle and two of them.
 *  3. A REFUSAL NEVER CONSUMES. An unknown id, an id from another session, an option nobody
 *     offered — each returns a refusal VALUE and leaves the entry pending and still answerable.
 *     A refusal that consumed the ask would let one malformed frame from any attached client
 *     silently deny a tool call the human never saw.
 *  4. NOTHING IS FABRICATED. Every terminal state names a decider, and the only decider that is a
 *     person is one whose answer named an offered option. Expiry and cancellation are attributed
 *     to `system`, never to a surface that did not act.
 *
 * The registry is PURE: it performs no I/O, opens no socket, and touches no session. It imports
 * types only. What it holds is state plus the caller's own resolver, handed BACK on settle so the
 * caller runs it — the registry never calls out into the world by itself except through the expiry
 * listener, which exists because a deadline has to fire from somewhere.
 */

import type { PermissionAskDetail } from "../extensions/types.js";
import type { RelayAnswer, RelayAsk, RelayDecider, RelayEnded } from "../permission-relay/types.js";
import type { PermissionRequestMessage } from "./types.js";

/** Env var that overrides the fail-closed expiry. Milliseconds. */
export const PERMISSION_EXPIRY_ENV = "DRAHT_PERMISSION_EXPIRY_MS";

/**
 * How long an unanswered ask stays answerable: ONE HOUR.
 *
 * The number is chosen for the job this phase exists to do — a human walks away from the terminal
 * and answers from a phone. Every shorter candidate fails that job: 30s and 5m are shorter than a
 * meeting, a commute or a lunch, and an ask that expires while the person who would have approved
 * it is still walking back to their desk fails CLOSED, which reports to the model as a blocked tool
 * call and wastes the whole turn. The archived R34-PERM.8 measurement is what makes an hour safe to
 * pick: the agent core imposes NO deadline of its own (25 minutes parked in `beforeToolCall` with
 * zero degradation), so "hold the turn" is the mechanism and this timer is only the backstop that
 * stops a forgotten ask from parking a session forever.
 *
 * It is a BACKSTOP, not a policy: the expected end of an ask is a human answering it, and every
 * expiry is a small failure. That is also why it is not infinite — an ask nobody will ever answer
 * must eventually fail closed and say so, rather than leaving a session wedged with no diagnosis.
 */
export const DEFAULT_PERMISSION_EXPIRY_MS = 60 * 60 * 1000;

/** Floor for a configured expiry: below this a human cannot answer at all. */
export const MIN_PERMISSION_EXPIRY_MS = 1_000;

/**
 * Ceiling for a configured expiry: 24 hours.
 *
 * A bound exists so a typo cannot produce an ask that never expires. `Infinity`, `NaN` and a
 * negative number are all rejected in favour of the default rather than clamped, because each of
 * them means "this value was not thought about" rather than "keep it forever".
 */
export const MAX_PERMISSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** How many asks may be pending at once before new ones are refused. */
export const DEFAULT_MAX_PENDING = 32;

/**
 * Largest encoded ask the registry will hold, in bytes.
 *
 * Under the transport's 64 KiB frame cap with headroom: a frame larger than this could not be
 * relayed anyway (the attach bridge refuses an oversized permission frame rather than splitting it,
 * because half an ask is a dialog showing half a command with an Approve button under it), so it is
 * refused here, before anything is written, rather than after a renderer has been dropped.
 */
export const DEFAULT_MAX_ENTRY_BYTES = 60_000;

/** Total encoded bytes across all pending asks. */
export const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024;

/** How long a settled ask is remembered so a late answer is TOLD, rather than merely refused. */
export const DEFAULT_TOMBSTONE_TTL_MS = 120_000;

/** How many tombstones are kept. Oldest first out. */
export const DEFAULT_MAX_TOMBSTONES = 128;

/** Every way an ask can end. Mirrors the wire's `permission_resolved.decision`. */
export type TerminalDecision = "approved" | "denied" | "cancelled" | "expired";

/**
 * WHO ended an ask nobody answered, and WHAT that ending was — as ONE value.
 *
 * The two halves travel together because they are one fact and they were previously written down
 * twice: this file's expiry timer laid the tombstone from its own `{surface: "system"}` /
 * `"expired"` literals, and the relay's `onExpired` listener used a second, independent pair for
 * the broadcast and the audit row. They agreed, so nothing noticed — until a verifier mutated one
 * and the other carried on asserting the old word, which is a durable record and a live wire frame
 * disagreeing about the same ending with no test in a position to see it.
 */
export interface PermissionEnding {
	readonly decidedBy: RelayDecider;
	readonly decision: TerminalDecision;
}

/** Nobody decided. The only decider an unanswered ask may ever name. */
export const SYSTEM_DECIDER: RelayDecider = Object.freeze({ surface: "system", clientId: null });

/** THE expiry fact, stated once. The timer lays it and the listener is handed the very same value. */
export const EXPIRED_BY_SYSTEM: PermissionEnding = Object.freeze({
	decidedBy: SYSTEM_DECIDER,
	decision: "expired" as const,
});

/** THE cancellation fact, stated once, for a session that is being replaced or stopped. */
export const CANCELLED_BY_SYSTEM: PermissionEnding = Object.freeze({
	decidedBy: SYSTEM_DECIDER,
	decision: "cancelled" as const,
});

/**
 * Read the configured expiry, falling back to {@link DEFAULT_PERMISSION_EXPIRY_MS}.
 *
 * Anything unusable — unset, empty, non-numeric, zero, negative, `Infinity`, out of range — yields
 * the default. A permission deadline must never be `NaN`: `new Date(Date.now() + NaN)` throws a
 * RangeError out of the ask itself, which the permission gate reports as a TOOL ERROR rather than
 * as a denial, so the ask neither fails closed nor reaches anybody.
 */
export function resolvePermissionExpiryMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[PERMISSION_EXPIRY_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_PERMISSION_EXPIRY_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_PERMISSION_EXPIRY_MS;
	if (parsed < MIN_PERMISSION_EXPIRY_MS || parsed > MAX_PERMISSION_EXPIRY_MS) {
		return DEFAULT_PERMISSION_EXPIRY_MS;
	}
	return Math.floor(parsed);
}

/** One offered option, exactly as it was offered. Frozen on insert; never rebuilt. */
export interface RegisteredOption {
	readonly id: string;
	readonly label: string;
	/** What choosing this option MEANS, when the vocabulary declares it. Read, never inferred. */
	readonly decision?: "approve" | "deny";
}

/** A pending ask. Everything here was fixed when the ask was raised. */
export interface PermissionEntry {
	readonly sessionId: string;
	readonly requestId: string;
	readonly method: RelayAsk["method"];
	/** The immutable offered set — the ONLY answerable set. Frozen. */
	readonly options: readonly RegisteredOption[];
	/** Canonical detail, when this ask gates a tool call. Absent for a plain extension dialog. */
	readonly detail?: PermissionAskDetail;
	/** The exact frame that was broadcast, replayed verbatim to a client that arrives later. */
	readonly frame: PermissionRequestMessage;
	readonly requestedAt: string;
	/** Wall-clock instant this ask stops being answerable, in ms since the epoch. */
	readonly deadlineAt: number;
	/** Encoded size of {@link PermissionEntry.frame}, counted once at insert. */
	readonly bytes: number;
	/**
	 * The raiser's own resolver. The registry stores it and hands it back; it never calls it.
	 *
	 * It takes a {@link RelayEnded} as well as an answer because an ask that EXPIRED or was
	 * CANCELLED is over on every surface, and the raiser has to be told that rather than told the
	 * relay merely gave up — the two used to be the same `undefined`, and a decorator reading the
	 * second meaning kept a live Approve button on an ask already recorded as expired.
	 */
	readonly resolve: (answer: RelayAnswer | RelayEnded | undefined) => void;
}

/** Why an insert was refused. Each is a bound, not a failure of the asker. */
export type InsertRefusal = "duplicate_request" | "too_many_pending" | "entry_too_large" | "total_too_large";

export type InsertResult =
	| { readonly ok: true; readonly entry: PermissionEntry }
	| { readonly ok: false; readonly reason: InsertRefusal; readonly message: string };

/** Why an answer was refused. In every case the entry, if there is one, is left untouched. */
export type SettleRefusal = "unknown_request" | "cross_session" | "invalid_option";

export type SettleResult =
	| {
			readonly status: "resolved";
			readonly entry: PermissionEntry;
			readonly answer: RelayAnswer;
			readonly chosenOptionId: string;
			readonly decision: TerminalDecision;
	  }
	| { readonly status: "refused"; readonly reason: SettleRefusal; readonly message: string }
	| {
			readonly status: "already_resolved";
			readonly decidedBy: RelayDecider;
			readonly decision: TerminalDecision;
			readonly message: string;
	  };

/** A settled ask, remembered briefly so a late or reconnecting answerer learns WHY it is refused. */
interface Tombstone {
	readonly requestId: string;
	readonly decidedBy: RelayDecider;
	readonly decision: TerminalDecision;
	readonly at: number;
}

export interface PermissionRegistryOptions {
	/** The session these asks belong to. An answer naming any other session is refused. */
	sessionId: string;
	expiryMs?: number;
	maxPending?: number;
	maxEntryBytes?: number;
	maxTotalBytes?: number;
	tombstoneTtlMs?: number;
	maxTombstones?: number;
	/** Injectable for tests. Defaults to `Date.now`. */
	now?: () => number;
}

/** What {@link PermissionRegistry.insert} needs beyond the frame itself. */
export interface PermissionInsert {
	readonly requestId: string;
	readonly method: RelayAsk["method"];
	readonly options: readonly RegisteredOption[];
	readonly detail?: PermissionAskDetail;
	readonly frame: PermissionRequestMessage;
	readonly requestedAt: string;
	readonly resolve: (answer: RelayAnswer | RelayEnded | undefined) => void;
}

/**
 * The pending-ask registry for ONE session.
 *
 * Lifetime: it is built inside the attach bind closure, so it dies with the session and survives
 * client churn. It is deliberately NOT built in the UI decorator — a new `ExtensionRunner`, and
 * therefore a new decorator, is constructed on every extension reload, which would orphan every
 * ask raised before the reload with the agent still parked on it.
 */
export class PermissionRegistry {
	readonly #sessionId: string;
	readonly #expiryMs: number;
	readonly #maxPending: number;
	readonly #maxEntryBytes: number;
	readonly #maxTotalBytes: number;
	readonly #tombstoneTtlMs: number;
	readonly #maxTombstones: number;
	readonly #now: () => number;

	/** PENDING entries only. A settled entry is removed here and remembered as a tombstone. */
	readonly #entries = new Map<string, PermissionEntry>();
	readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #tombstones = new Map<string, Tombstone>();
	#totalBytes = 0;
	#expiryListener: ((entry: PermissionEntry, ending: PermissionEnding) => void) | null = null;

	constructor(options: PermissionRegistryOptions) {
		this.#sessionId = options.sessionId;
		this.#expiryMs = options.expiryMs ?? resolvePermissionExpiryMs();
		this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
		this.#maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
		this.#maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
		this.#tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
		this.#maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
		this.#now = options.now ?? Date.now;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	/** The one clock, in milliseconds. */
	get expiryMs(): number {
		return this.#expiryMs;
	}

	get pendingCount(): number {
		return this.#entries.size;
	}

	/**
	 * Called when an ask reaches its deadline with nobody having answered.
	 *
	 * The listener owns the fail-closed handling: end the raiser's ask, tell every surface, record
	 * it. The registry has already removed the entry by then, so a late answer sees a tombstone
	 * rather than a still-answerable ask.
	 *
	 * `ending` is THE SAME VALUE the tombstone was laid with — not a second copy of it. The
	 * listener must state the ending from this argument and never from a literal of its own; two
	 * literals for one fact is how a mutation to either survived every test in the suite.
	 */
	onExpired(listener: (entry: PermissionEntry, ending: PermissionEnding) => void): void {
		this.#expiryListener = listener;
	}

	/** Every still-pending ask, oldest first (insertion order). */
	pending(): readonly PermissionEntry[] {
		return [...this.#entries.values()];
	}

	get(requestId: string): PermissionEntry | undefined {
		return this.#entries.get(requestId);
	}

	/**
	 * Register an ask BEFORE the first socket write.
	 *
	 * Order matters and is not negotiable: a client can answer before the writer's loop has even
	 * finished fanning out, and an answer naming an id the registry has never seen is refused as
	 * unknown — which would refuse the very first, correct answer to a real ask.
	 */
	insert(input: PermissionInsert): InsertResult {
		if (this.#entries.has(input.requestId)) {
			// Ids are `crypto.randomUUID`; a collision means a caller reused one, which would make
			// one answer settle the wrong ask.
			return {
				ok: false,
				reason: "duplicate_request",
				message: `permission request ${JSON.stringify(input.requestId)} is already pending`,
			};
		}
		if (this.#entries.size >= this.#maxPending) {
			return {
				ok: false,
				reason: "too_many_pending",
				message: `at most ${this.#maxPending} permission asks may be pending at once`,
			};
		}

		const bytes = Buffer.byteLength(JSON.stringify(input.frame), "utf8");
		if (bytes > this.#maxEntryBytes) {
			return {
				ok: false,
				reason: "entry_too_large",
				message: `a permission ask must encode to at most ${this.#maxEntryBytes} bytes; this one is ${bytes}`,
			};
		}
		if (this.#totalBytes + bytes > this.#maxTotalBytes) {
			return {
				ok: false,
				reason: "total_too_large",
				message: `pending permission asks may hold at most ${this.#maxTotalBytes} bytes`,
			};
		}

		const entry: PermissionEntry = Object.freeze({
			sessionId: this.#sessionId,
			requestId: input.requestId,
			method: input.method,
			// Frozen twice over: the array cannot gain an option, and no option can change what it
			// declares. The set that was validated and the set that is offered are the same read.
			options: Object.freeze(input.options.map((option) => Object.freeze({ ...option }))),
			detail: input.detail,
			frame: input.frame,
			requestedAt: input.requestedAt,
			deadlineAt: this.#now() + this.#expiryMs,
			bytes,
			resolve: input.resolve,
		});

		this.#entries.set(entry.requestId, entry);
		this.#totalBytes += bytes;

		const timer = setTimeout(() => {
			this.#timers.delete(entry.requestId);
			// ONE value, laid into the tombstone and handed to the listener. See PermissionEnding.
			const expired = this.#take(entry.requestId, EXPIRED_BY_SYSTEM.decidedBy, EXPIRED_BY_SYSTEM.decision);
			if (expired === undefined) return;
			this.#expiryListener?.(expired, EXPIRED_BY_SYSTEM);
		}, this.#expiryMs);
		// A pending ask must not be the reason the process stays alive: the session's own run loop
		// decides that. An `unref`'d timer still fires for as long as anything else is running,
		// which is exactly as long as an ask can matter.
		timer.unref?.();
		this.#timers.set(entry.requestId, timer);

		return { ok: true, entry };
	}

	/**
	 * Answer an ask. SYNCHRONOUS from the pending-check through the removal — see property (1).
	 *
	 * Returns the entry and its resolver on success; the caller runs the resolver. Every refusal
	 * leaves the entry exactly as it was, still pending and still answerable by somebody else.
	 */
	settle(sessionId: string, requestId: string, optionId: string, decidedBy: RelayDecider): SettleResult {
		if (sessionId !== this.#sessionId) {
			// Said the same way as an unknown id on purpose: a client must not be able to use the
			// refusal text as an oracle for which session ids exist.
			return {
				status: "refused",
				reason: "cross_session",
				message: `No permission ask ${JSON.stringify(requestId)} is pending`,
			};
		}

		const entry = this.#entries.get(requestId);
		if (entry === undefined) {
			const tombstone = this.#tombstone(requestId);
			if (tombstone !== undefined) {
				return {
					status: "already_resolved",
					decidedBy: tombstone.decidedBy,
					decision: tombstone.decision,
					message: `Permission ask ${JSON.stringify(requestId)} was already resolved by ${tombstone.decidedBy.surface}`,
				};
			}
			return {
				status: "refused",
				reason: "unknown_request",
				message: `No permission ask ${JSON.stringify(requestId)} is pending`,
			};
		}

		const decision = decisionFor(entry, optionId);
		if (decision === undefined) {
			// An option nobody offered is SILENCE, not a dismissal. It decides nothing, it consumes
			// nothing, and it can never become a decision attributed to a human.
			return {
				status: "refused",
				reason: "invalid_option",
				message: `Option ${JSON.stringify(optionId)} was not offered for permission ask ${JSON.stringify(requestId)}`,
			};
		}

		// ── the compare-and-swap. Nothing above yields; nothing below may either. ──
		this.#remove(entry.requestId);
		this.#addTombstone({ requestId: entry.requestId, decidedBy, decision, at: this.#now() });

		return {
			status: "resolved",
			entry,
			answer: { requestId: entry.requestId, optionId, decidedBy },
			chosenOptionId: optionId,
			decision,
		};
	}

	/**
	 * End a pending ask that some OTHER surface decided.
	 *
	 * Returns the entry when this call is the one that ended it, and `undefined` when it was
	 * already over — which is the common case and must stay silent, because the relay decorator
	 * withdraws every ask it settles, including the ones a remote answer just settled here. A
	 * second broadcast and a second audit record would both be wrong.
	 */
	withdraw(requestId: string, decidedBy: RelayDecider, decision: TerminalDecision): PermissionEntry | undefined {
		return this.#take(requestId, decidedBy, decision);
	}

	/**
	 * End every pending ask, fail-closed.
	 *
	 * Used when the session is replaced or stopped: the asks belong to a session that is going
	 * away, so nothing they gate may proceed. Returns them so the caller can resolve, announce and
	 * record each one.
	 */
	cancelAll(decidedBy: RelayDecider = CANCELLED_BY_SYSTEM.decidedBy): PermissionEntry[] {
		const cancelled: PermissionEntry[] = [];
		for (const requestId of [...this.#entries.keys()]) {
			const entry = this.#take(requestId, decidedBy, CANCELLED_BY_SYSTEM.decision);
			if (entry !== undefined) cancelled.push(entry);
		}
		return cancelled;
	}

	#take(requestId: string, decidedBy: RelayDecider, decision: TerminalDecision): PermissionEntry | undefined {
		const entry = this.#entries.get(requestId);
		if (entry === undefined) return undefined;
		this.#remove(requestId);
		this.#addTombstone({ requestId, decidedBy, decision, at: this.#now() });
		return entry;
	}

	#remove(requestId: string): void {
		const entry = this.#entries.get(requestId);
		if (entry === undefined) return;
		this.#entries.delete(requestId);
		this.#totalBytes -= entry.bytes;
		const timer = this.#timers.get(requestId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.#timers.delete(requestId);
		}
	}

	#addTombstone(tombstone: Tombstone): void {
		this.#tombstones.set(tombstone.requestId, tombstone);
		while (this.#tombstones.size > this.#maxTombstones) {
			const oldest = this.#tombstones.keys().next();
			if (oldest.done === true) break;
			this.#tombstones.delete(oldest.value);
		}
	}

	#tombstone(requestId: string): Tombstone | undefined {
		const found = this.#tombstones.get(requestId);
		if (found === undefined) return undefined;
		if (this.#now() - found.at > this.#tombstoneTtlMs) {
			this.#tombstones.delete(requestId);
			return undefined;
		}
		return found;
	}
}

/**
 * What answering `optionId` MEANS for this ask, or `undefined` when it means nothing at all.
 *
 * The whole rule, in one place:
 *
 *  - `input` has no option ids and never had any: EVERY string is a valid answer, carried verbatim
 *    as the answer itself. Refusing free text here would hang the agent on an ask the client
 *    rendered as fully answerable.
 *  - otherwise the id must be one of the ids that were OFFERED, and what it means is that option's
 *    OWN `decision` — read off the option, never derived from its index, its id or its label.
 *  - an offered option that declares no `decision` (a plain `select`, whose entries are choices
 *    rather than a permission vocabulary) ends the ask by being ANSWERED. `approved` is the wire's
 *    word for that; the choice itself travels as `chosenOptionId`, and no audit record is written
 *    for an ask that gates no tool call — see the relay's `appendResolution`.
 *
 * KNOWN GAP — `approved` is the WRONG WORD for those last two, and it is used here only because the
 * wire union has no right one. `select` and `input` grant nothing and refuse nothing, so saying
 * "approved" about them states a decision that was never offered, let alone made. It is contained:
 * no audit row is written for either (both lack a `tool_permission` detail, which is what
 * `appendResolution` gates on), so the false word lives only in the transient `permission_resolved`
 * broadcast and never in the durable record.
 *
 * Closing it means adding a neutral `answered` member to `TerminalDecision`, to the socket wire in
 * `socket-server/types.ts`, to `PermissionResolutionEntry.decision`, to `geist-protocol`'s
 * `wire.ts` and its geist mirror, to `MIRRORED_FRAMES`, to the `geist-0.3` conformance corpus
 * (`permission_resolved.json`, `transcript.json`, the schema fingerprint) and to `MIGRATIONS.md`.
 * That is a protocol revision. Until it happens, the relay's own `terminalDecisionFor` refuses to
 * SPREAD the word: an ask the local surface answered is reported `cancelled` there rather than
 * `approved`, because `cancelled` grants nothing.
 */
export function decisionFor(entry: PermissionEntry, optionId: string): TerminalDecision | undefined {
	if (entry.method === "input") return "approved";
	const chosen = entry.options.find((option) => option.id === optionId);
	if (chosen === undefined) return undefined;
	if (chosen.decision === "deny") return "denied";
	return "approved";
}
