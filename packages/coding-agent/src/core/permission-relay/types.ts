/**
 * The port the relay UI decorator talks to.
 *
 * This file deliberately imports NOTHING from the socket server. The decorator must be usable
 * with a hand-written fake in tests and must not drag the attach wire into the agent core.
 */

import type { PermissionAskDetail } from "../extensions/types.ts";

/** Which surface produced an answer, and which client on that surface (when it has clients). */
export interface RelayDecider {
	surface: "tui" | "attach" | "rpc" | "acp" | "system";
	clientId: string | null;
}

/** A single ask broadcast to every attached read-write client. */
export interface RelayAsk {
	/** Stable id for this ask, minted once per raised dialog. */
	requestId: string;
	/** Which UI primitive raised it. */
	method: "confirm" | "select" | "input";
	/** Headline for the ask. Render it as the dialog's title on every surface. */
	title: string;
	/**
	 * Secondary text — but NOT the same thing on every method.
	 *
	 * For `confirm` and `select` it is body copy. For `input` it is the field's PLACEHOLDER, because
	 * that is the only string `ExtensionUIContext.input` carries. A renderer that paints it as body
	 * copy leaves the text field with no placeholder and shows a hint where a prompt belongs.
	 */
	message?: string;
	/**
	 * Canonical detail for a tool permission ask, when the caller supplied one.
	 *
	 * `detail.options` is a rendering carrier that states each option's own `decision`. It is NOT a
	 * second offered set: what may be answered is {@link RelayAsk.options} below, and only that.
	 */
	detail?: PermissionAskDetail;
	/**
	 * The immutable set of options offered for this request — the ONLY answerable set.
	 *
	 * Ids here are opaque handles minted with the ask. A client echoes one back verbatim; it must
	 * never derive an option's meaning from its position in this array or from the shape of its id,
	 * and the decorator that minted them never does either: each option's caller-side value was
	 * bound when the option was constructed.
	 *
	 * `decision` states what choosing that option MEANS, so a client can render a denial as
	 * destructive without joining this array to `detail.options` by id — a join that is impossible
	 * for `select`, whose two arrays share no ids at all. It is present on every option of a
	 * `confirm` and absent for `select` and `input`, where the concept does not apply. It is
	 * rendering data: what an answer resolves to was fixed when the option was minted, and echoing
	 * a different `decision` back changes nothing.
	 *
	 * An EMPTY array means no option can be named BY ID. It does NOT mean the ask is unanswerable —
	 * read {@link RelayAsk.method} for that, because the two empty-array cases behave OPPOSITELY:
	 *
	 * - `confirm` or `select` with an empty array: nothing is answerable. The ask is shown for
	 *   context only and is decided by the local surface or by the raising method's own fail-closed
	 *   default. This is what a `confirm` whose caller-supplied vocabulary failed validation looks
	 *   like. Echoing any id back is silence, not a dismissal — it decides nothing.
	 * - `input`: this array is ALWAYS empty, and the ask is nonetheless fully answerable — with free
	 *   text, sent verbatim as {@link RelayAnswer.optionId}. EVERY string is a valid answer. A client
	 *   that renders an input ask as informational-with-no-way-to-answer hangs the agent until the
	 *   ask expires.
	 *
	 * No separate "answerable" flag is added: `method` is already on the wire and already carries
	 * this distinction, and a second field asserting the same thing is a second thing that can
	 * disagree with it.
	 */
	options: readonly { id: string; label: string; decision?: "approve" | "deny" }[];
	/** ISO timestamp of when the ask was raised. */
	requestedAt: string;
	/**
	 * ISO timestamp for ADVISORY rendering only, or null when there is none.
	 *
	 * Real expiry binds solely to the pending registry's fail-closed timer — one clock. Nothing
	 * may deny an ask because this instant passed.
	 */
	deadline: string | null;
}

/** An answer that came back from some surface. */
export interface RelayAnswer {
	/** The ask being answered. An answer naming any other ask is ignored. */
	requestId: string;
	/**
	 * WHAT was answered — and for a free-text ask, the answer ITSELF.
	 *
	 * For `confirm` and `select`: one {@link RelayAsk.options} id, echoed back verbatim. An id that
	 * was never offered is silence — it can never become a decision attributed to a human.
	 *
	 * For `input`, whose `options` is always empty: the TYPED TEXT, carried in this field and
	 * returned to the caller unchanged. The name says `optionId` because one wire shape serves all
	 * three methods; for an input ask it is not an id at all, and there is no id namespace for it to
	 * collide with — text that happens to equal some other ask's option id is still just text.
	 */
	optionId: string;
	/** Which surface, and which client on it, produced this answer. */
	decidedBy: RelayDecider;
}

/**
 * Handle onto the session's pending-ask registry.
 *
 * Implemented outside the agent core (the registry lives in the attach bind closure, because the
 * ExtensionRunner — and therefore the decorator — is rebuilt on every reload).
 */
export interface PermissionRelay {
	/** How many attached clients could answer right now. Evaluated live, never cached. */
	readWriteClientCount(): number;
	/**
	 * Broadcast an ask and resolve with the first valid answer.
	 *
	 * Resolves with `undefined` when the relay gives up without an answer (no client, withdrawn,
	 * or expired). What follows depends on whether a local surface exists: with one, the decorator
	 * keeps waiting on it and the human at the terminal still decides; WITHOUT one — the headless
	 * case a registry implementer is usually writing for — the decorator settles the ask on the
	 * method's own fail-closed default, attributed to the system rather than to any person.
	 */
	raise(ask: RelayAsk): Promise<RelayAnswer | undefined>;
	/** Tell the relay this ask is over, and who decided it, so it can echo the resolution. */
	withdraw(requestId: string, decidedBy: RelayDecider): void;
}
