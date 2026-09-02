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

/**
 * The surface a LOCALLY raised dialog belongs to.
 *
 * `attach` is excluded because it is the REMOTE side by definition — an attached client's answer
 * comes back through {@link RelayAnswer.decidedBy} and is never what the decorator is describing.
 * `system` IS allowed and is the truthful value for a binding mode that shows no dialog to anybody
 * (`print`, `json`): if such a mode ever ends an ask, nobody acted.
 *
 * There is no default. The decorator is built at ONE seam that knows the mode, and a default here
 * would be exactly the hardcoded `tui` this type exists to abolish — an answer typed into the RPC
 * surface, and a process shutdown, both recorded as a human at a terminal that does not exist.
 */
export type LocalSurface = Exclude<RelayDecider["surface"], "attach">;

/**
 * WHAT ACTUALLY HAPPENED to an ask, as the surface that ended it knows it.
 *
 * This exists because a relay cannot GUESS. `withdraw` used to carry only the decider, so the
 * implementation hardcoded `cancelled` — and an approved, EXECUTED command was written into the
 * durable record and put on the wire as `cancelled`, with `chosenOptionId: null`. The decision was
 * known to the caller of `withdraw` all along; it simply had nowhere to put it.
 *
 *  - `approved` / `denied` — a surface ANSWERED, and the answer's own vocabulary says what that
 *    meant. `chosenOptionId` names the offered option when one was named, and is `null` when the
 *    answering surface did not name one (see below).
 *  - `answered` — a `select` or `input` was answered. Those methods carry NO permission semantics:
 *    nothing was approved and nothing was denied, so neither word may be used for them.
 *  - `cancelled` — the ask ended with NO answer at all: an abort, a shutdown, a session
 *    replacement, a declared timeout, or a relay that was spent before anybody could act.
 *
 * `chosenOptionId: null` on an `approved`/`denied` outcome is not a hole, it is the honest report
 * of a surface that answered WITHOUT naming an option — the local `ExtensionUIContext.confirm`
 * returns a bare `Promise<boolean>` and draws its own Yes/No, so it never chose one of the offered
 * ids. Reverse-mapping that boolean onto the offered set would be a derivation, and with a
 * vocabulary like `[allow, deny-once, deny-always]` it would name an option nobody touched.
 */
export type RelayOutcome =
	| { readonly kind: "approved"; readonly chosenOptionId: string | null }
	| { readonly kind: "denied"; readonly chosenOptionId: string | null }
	| { readonly kind: "answered" }
	| { readonly kind: "cancelled" };

/** The outcome of an ask that ended without anybody answering it. Shared, frozen, allocation-free. */
export const RELAY_CANCELLED: RelayOutcome = Object.freeze({ kind: "cancelled" as const });

/** The outcome of a `select` or `input` that WAS answered — no permission was granted or refused. */
export const RELAY_ANSWERED: RelayOutcome = Object.freeze({ kind: "answered" as const });

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

/**
 * The relay ITSELF ended the ask. Nobody answered, and nobody still can.
 *
 * THIS IS NOT THE SAME AS `raise()` RESOLVING `undefined`, and conflating the two was a FAIL-OPEN
 * defect. `undefined` means "the relay is spent" — it refused the ask at a bound, its socket was
 * already gone, or an answer named an option nobody offered. In every one of those the ask itself
 * is still live and a human at the LOCAL surface must still get to answer it.
 *
 * This value means the opposite: the ask is OVER. The registry's fail-closed clock ran out, or the
 * session it belonged to was stopped or replaced. The relay has already broadcast the ending and
 * written it down, so a surface that kept its dialog on screen after this would be offering a human
 * a button that can still run the command an audit row already records as expired — which is
 * exactly what happened: the durable record said `expired`, the human tapped Approve on the local
 * dialog nobody had taken down, and the command RAN.
 *
 * A decorator receiving this must settle its ask on the raising method's own fail-closed default,
 * abort the local surface, and attribute the ending to {@link RelayEnded.decidedBy} — which names
 * `system`, because nobody decided anything.
 */
export interface RelayEnded {
	/** The ask that ended. An `ended` naming any other ask is ignored, exactly as an answer is. */
	requestId: string;
	/** WHAT ended it. Never `approved`/`denied`: nobody answered, so nothing was granted or refused. */
	ended: "expired" | "cancelled";
	/** Who ended it. Always the system — an ask nobody answered may not be attributed to a person. */
	decidedBy: RelayDecider;
}

/** Whether a settled `raise()` is the relay reporting that the ask itself is OVER. */
export function isRelayEnded(value: RelayAnswer | RelayEnded | undefined): value is RelayEnded {
	return value !== undefined && "ended" in value;
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
	 * Broadcast an ask and resolve with the first valid answer — or with how the ask ENDED.
	 *
	 * THREE outcomes, and the last two are not the same thing:
	 *
	 *  - a {@link RelayAnswer}: somebody answered.
	 *  - a {@link RelayEnded}: the RELAY ended the ask. Its clock ran out, or the session was
	 *    stopped or replaced. The ask is over on every surface, the ending is already broadcast and
	 *    recorded, and the decorator must settle on the method's fail-closed default and take the
	 *    local dialog down. A decorator that kept waiting here leaves a live Approve button on an
	 *    ask the durable record already says expired — the fail-OPEN defect this member exists to
	 *    make unrepresentable.
	 *  - `undefined`: the relay is SPENT, but the ask is not over. It was refused at a bound, its
	 *    socket was already gone, or the answer named an option nobody offered. With a live local
	 *    surface the decorator keeps waiting and the human at the terminal still decides; WITHOUT
	 *    one — the headless case — it settles on the method's own fail-closed default, attributed
	 *    to the system rather than to any person.
	 */
	raise(ask: RelayAsk): Promise<RelayAnswer | RelayEnded | undefined>;
	/**
	 * Tell the relay this ask is over: WHO ended it, and WHAT HAPPENED.
	 *
	 * Both halves are required and neither may be inferred by the implementation. The caller has
	 * just settled the ask and holds the value; an implementation that reconstructs the outcome
	 * from anything else is guessing, and a guess written into the session's durable record is a
	 * decision that never happened.
	 *
	 * Withdrawing an ask that is already over MUST be silent — no second broadcast, no second audit
	 * row. The decorator withdraws every ask it settles, including the ones a remote answer already
	 * settled inside the relay.
	 */
	withdraw(requestId: string, decidedBy: RelayDecider, outcome: RelayOutcome): void;
}
