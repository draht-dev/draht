import { type FleetRegistry, UnknownSessionError } from "../fleet-registry.js";

/**
 * A `Variant`'s lifecycle within its comparison (DOMAIN.md Tier F `Variant`:
 * "winner/pruned status"). `pending` until the comparison is closed; then
 * exactly one member becomes `winner` and every other becomes `pruned`.
 */
export type VariantStatus = "pending" | "winner" | "pruned";

/**
 * One member of a `variants n` comparison (DOMAIN.md Tier F `Variant`: "one
 * sibling worktree in a `variants n` comparison; carries its own harness … its
 * own sha ledger entry, winner/pruned status"). Modelled as a thin view over a
 * fleet-registered `HarnessSession`: `sessionId` is that session's id (its sha
 * ledger entry lives in the `FleetRegistry`, keyed by worktree), `harness` is a
 * snapshot of the session's harness taken at construction (so it survives the
 * session being pruned from the fleet), and `status` is the winner/pruned state.
 */
export interface Variant {
	readonly sessionId: string;
	readonly harness: string;
	readonly status: VariantStatus;
}

/** Raised by `pickWinner` when the chosen id is not a member of the comparison. */
export class NotAVariantError extends Error {
	constructor(sessionId: string) {
		super(`session is not a member of this variant set: ${sessionId}`);
		this.name = "NotAVariantError";
	}
}

/** Raised when `pickWinner` is called on a comparison that has already been closed. */
export class VariantSetResolvedError extends Error {
	constructor() {
		super("variant set already resolved: a winner has already been picked");
		this.name = "VariantSetResolvedError";
	}
}

/** Raised when a `VariantSet` is constructed with no members. */
export class EmptyVariantSetError extends Error {
	constructor() {
		super("variant set requires at least one member");
		this.name = "EmptyVariantSetError";
	}
}

interface MutableVariant {
	readonly sessionId: string;
	readonly harness: string;
	status: VariantStatus;
}

/**
 * A `variants n` comparison (spec §2/§16 M6, DOMAIN.md `Variant` +
 * `VariantWinnerPicked`) over sibling sessions that a caller has ALREADY
 * registered in the `FleetRegistry` — one per member, each on its own sibling
 * worktree. This phase does not spawn worktrees or subprocesses (that is
 * composition-root plumbing for a later phase); it owns the domain logic that
 * closes the comparison.
 *
 * `pickWinner` implements the `VariantWinnerPicked` event's semantics ("the
 * winning Variant's sha becomes the session's, siblings reset to `baseSha` and
 * are pruned", spec §16 "winner kept, siblings reset+pruned"):
 *   - the winner is APPROVED via the sha ledger and otherwise left untouched
 *     (its worktree/dirty state is kept exactly as-is — "winner kept"), and
 *   - every sibling is UNDONE (`reset --hard` to its ledger ref — "reset") and
 *     STOPPED (subprocess terminated + removed from the fleet — "pruned").
 *
 * The comparison is single-shot: once a winner is picked the set is resolved
 * and a second `pickWinner` throws.
 */
export class VariantSet {
	private readonly registry: FleetRegistry;
	private readonly variants: Map<string, MutableVariant>;
	private resolved = false;

	/**
	 * @param registry the fleet the members are already registered in — their
	 *   sha ledger entries and `HarnessSession`s live here.
	 * @param memberSessionIds the ids of the already-registered sibling sessions
	 *   that make up this comparison. Duplicates collapse; order is preserved.
	 * @throws {EmptyVariantSetError} if no members are given.
	 * @throws {UnknownSessionError} if any member id is not registered in `registry`.
	 */
	constructor(registry: FleetRegistry, memberSessionIds: readonly string[]) {
		if (memberSessionIds.length === 0) {
			throw new EmptyVariantSetError();
		}

		this.registry = registry;
		this.variants = new Map();
		for (const sessionId of memberSessionIds) {
			const entry = registry.getEntry(sessionId);
			if (!entry) {
				throw new UnknownSessionError(sessionId);
			}
			// Snapshot the harness now so `listVariants()` still reports it after
			// a pruned sibling has been removed from the fleet.
			this.variants.set(sessionId, { sessionId, harness: entry.session.harness, status: "pending" });
		}
	}

	/** Whether a winner has already been picked (the comparison is closed). */
	get isResolved(): boolean {
		return this.resolved;
	}

	/** The winning session id once resolved, else `undefined`. */
	get winnerId(): string | undefined {
		for (const variant of this.variants.values()) {
			if (variant.status === "winner") return variant.sessionId;
		}
		return undefined;
	}

	/** A snapshot of every member and its current winner/pruned status, in construction order. */
	listVariants(): Variant[] {
		return [...this.variants.values()].map((v) => ({ sessionId: v.sessionId, harness: v.harness, status: v.status }));
	}

	/** Whether `sessionId` is a member of this comparison. */
	has(sessionId: string): boolean {
		return this.variants.has(sessionId);
	}

	/**
	 * Closes the comparison in favour of `winnerSessionId` (spec §16 "winner
	 * kept, siblings reset+pruned"; DOMAIN.md `VariantWinnerPicked`):
	 *   - the winner is `approve`d (its sha becomes its `lastApprovedSha`) and
	 *     NOTHING else about its worktree is touched — no `undo`, no `stop`;
	 *   - every other member is `undo`ne (reset to its ledger ref) then `stop`ped
	 *     (subprocess terminated and removed from the fleet).
	 *
	 * Async because pruning a sibling awaits `FleetRegistry.stop`, which stops
	 * the underlying harness subprocess before removing it from the fleet.
	 *
	 * @throws {VariantSetResolvedError} if a winner has already been picked.
	 * @throws {NotAVariantError} if `winnerSessionId` is not a member.
	 */
	async pickWinner(winnerSessionId: string): Promise<void> {
		if (this.resolved) {
			throw new VariantSetResolvedError();
		}
		const winner = this.variants.get(winnerSessionId);
		if (!winner) {
			throw new NotAVariantError(winnerSessionId);
		}
		this.resolved = true;

		// Winner kept: approve marks its current HEAD as `lastApprovedSha` and
		// discards nothing — the worktree is left exactly as the user pointed at it.
		this.registry.approve(winnerSessionId);
		winner.status = "winner";

		// Siblings reset + pruned: undo resets the worktree to its ledger ref,
		// stop terminates the subprocess and frees its fleet slot.
		for (const variant of this.variants.values()) {
			if (variant.sessionId === winnerSessionId) continue;
			this.registry.undo(variant.sessionId);
			await this.registry.stop(variant.sessionId);
			variant.status = "pruned";
		}
	}
}
