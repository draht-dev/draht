/**
 * permission-relay — the session's implementation of the {@link PermissionRelay} port.
 *
 * This is the piece that makes an ask raised by the agent reach a phone, and an answer from that
 * phone reach the agent. Everything it does is one of five things:
 *
 *   raise      build the frame, register it, fan it out, hand back a promise
 *   answer     first VALID answer wins, exactly once, and everybody is told
 *   withdraw   some other surface decided; the remote copies come down, saying WHAT it decided
 *   replay     a client that arrived late is shown what is still unanswered
 *   expire     nobody answered in time; fail closed, attributed to the system
 *
 * THE ORDER AFTER A WINNING ANSWER IS LOAD-BEARING, and it cost four adversarial rounds:
 *
 *   settle → resolve the raise() promise → broadcast `permission_resolved` → append the JSONL record
 *
 * The decorator that owns the caller's promise aborts the LOSING surfaces as part of resolving, and
 * it does so only after it has marked itself settled. Aborting before resolving is a real defect
 * with a real transcript consequence: interactive mode honours an abort by resolving its selector
 * to `undefined`, which its confirm wrapper maps to `false` — a FABRICATED local denial that would
 * overwrite the remote approval that just won, and be recorded as a human's refusal.
 *
 * NOTHING HERE FABRICATES A DECISION. An answer's meaning is read off the offered option's own
 * `decision`; an option nobody offered is silence and consumes nothing; an ask that expires or is
 * cancelled is attributed to `system`, never to a surface that did not act. AND NOTHING HERE
 * GUESSES ONE EITHER: `withdraw` is told what happened by the surface that settled the ask, because
 * when it guessed `cancelled` it wrote that word over an approval whose command had already run.
 */

import type { PermissionAskDetail } from "../extensions/types.js";
import type {
	PermissionRelay,
	RelayAnswer,
	RelayAsk,
	RelayDecider,
	RelayEnded,
	RelayOutcome,
} from "../permission-relay/types.js";
import type { PermissionResolution } from "../session-manager.js";
import type { PermissionDelivery } from "./permission-delivery.js";
import {
	CANCELLED_BY_SYSTEM,
	type PermissionEnding,
	type PermissionEntry,
	type PermissionRegistry,
	type RegisteredOption,
	type TerminalDecision,
} from "./permission-registry.js";
import { boundedSafeText } from "./safe-text.js";
import type { PermissionOption, PermissionRequestMessage, PermissionResolvedMessage } from "./types.js";

/**
 * The socket server, as this module uses it.
 *
 * Structural on purpose: `SocketServer` satisfies it without this module importing the class, so
 * the relay can be driven by a hand-written double in a unit test and there is no import cycle
 * between the server and the thing it hands answers to.
 */
export interface PermissionSocketServer {
	readonly permissionCapableClientCount: number;
	broadcastPermissionRequest(message: PermissionRequestMessage): string[];
	sendPermissionRequest(clientId: string, message: PermissionRequestMessage): void;
	broadcastPermissionResolved(message: PermissionResolvedMessage): void;
	sendErrorToClient(clientId: string, message: string, code?: string): void;
}

/** The session's own JSONL writer, as this module uses it. `SessionManager` satisfies it. */
export interface PermissionRecorder {
	appendPermissionResolution(resolution: PermissionResolution): string;
}

/**
 * What was asked, in exactly the terms an audit row needs.
 *
 * Two things can produce one: a still-pending {@link PermissionEntry}, and an ask this relay
 * REFUSED to raise at all (see {@link SocketPermissionRelayOptions} and `unraised` below). Both are
 * real endings of a real ask and both deserve a row, so the writer takes this rather than an entry.
 */
interface ResolutionSubject {
	readonly requestId: string;
	readonly detail: PermissionAskDetail | undefined;
	/** The offered set, in the order it was offered. Empty when nothing was ever offered. */
	readonly offeredOptionIds: readonly string[];
	readonly requestedAt: string;
	readonly deadline: string | null;
}

/**
 * How many refused-at-raise asks are remembered so their ending can still be recorded truthfully.
 *
 * An entry lives only until the decorator settles that ask and withdraws it, which it does for
 * every ask it settles — so in practice the map holds the handful currently in flight. The cap is
 * the backstop for the one path that settles WITHOUT withdrawing: a local surface whose promise
 * REJECTS, which resolves the caller by rejection and never reaches `settle`.
 */
const MAX_UNRAISED = 64;

/**
 * Grapheme budgets, one per wire field.
 *
 * Each is EXACTLY the bound `packages/geist-protocol/src/wire.ts` re-asserts for that field. They
 * are not a second policy: the mirrored schema counts grapheme clusters, `boundedSafeText` bounds
 * grapheme clusters AND UTF-8 bytes, and a frame constructed here therefore cannot be refused by
 * the bridge for its length — a refusal there drops the renderer's connection with close 1008,
 * which is the phone-killing failure the whole capability gate exists to prevent.
 */
const FIELD_BUDGET = {
	toolName: 128,
	cwd: 1024,
	title: 200,
	message: 4000,
	command: 4000,
	path: 1024,
	operation: 128,
	label: 200,
} as const;

/** Hard cap on every plain-string id on the wire, in UTF-16 code units. */
const MAX_ID_LENGTH = 128;

/** Most options a `permission_request` may carry. */
const MAX_OPTIONS = 16;

/** Errors a client gets back when its answer is refused. Codes, so a renderer can switch on them. */
const ERROR_UNKNOWN_REQUEST = "PERMISSION_UNKNOWN_REQUEST";
const ERROR_INVALID_OPTION = "PERMISSION_INVALID_OPTION";
const ERROR_ALREADY_RESOLVED = "PERMISSION_ALREADY_RESOLVED";

export interface SocketPermissionRelayOptions {
	registry: PermissionRegistry;
	delivery: PermissionDelivery<PermissionEntry>;
	/** Read live: the server is replaced when the session is, and stopped before it is. */
	server: () => PermissionSocketServer | null;
	/** Read live: the session's own JSONL writer, or null once the session is gone. */
	recorder: () => PermissionRecorder | null;
	/** The session id the registry is scoped to. */
	sessionId: string;
	/** The session's resolved working directory, for asks that carry no tool detail of their own. */
	cwd: string;
	/** Reports non-fatal problems. Defaults to stderr. */
	onWarning?: (message: string) => void;
}

/** The port, plus the four hooks the socket server drives it through. */
export interface SocketPermissionRelay extends PermissionRelay {
	/** A client answered. Validates, settles at most once, echoes, records. */
	handleResponse(message: { requestId: string; optionId: string }, clientId: string): void;
	/** A client attached: show it everything still unanswered, exactly once. */
	replayTo(clientId: string): void;
	/** A client's connection ended: drop its delivery record so a reconnect is shown everything. */
	forgetClient(clientId: string): void;
	/** The session is going away. Every pending ask ends fail-closed and is recorded as cancelled. */
	cancelAll(): void;
}

export function createSocketPermissionRelay(options: SocketPermissionRelayOptions): SocketPermissionRelay {
	const { registry, delivery, sessionId } = options;
	const warn = options.onWarning ?? ((message: string) => console.error(message));

	/**
	 * Asks this relay REFUSED to raise, kept until their real ending is known.
	 *
	 * A refusal is not a decision. `raise` hands back `undefined` for a bound it could not honour —
	 * `too_many_pending` at 33 concurrent asks, a frame too large, a socket already gone — and in a
	 * headless session with a phone attached that `undefined` became the decorator's fail-closed
	 * `false`, which the permission gate reports to the model as "User denied approval": a resource
	 * failure wearing a human's refusal. Nothing was written down, so the record could not
	 * contradict it either.
	 *
	 * Remembering the ask is what makes the two distinguishable AFTERWARDS, where it matters. The
	 * decorator withdraws every ask it settles, refused ones included, and it states what actually
	 * happened — so a bound that nobody could answer is recorded as `cancelled` by `system`, and a
	 * local human who answered the same ask anyway is recorded as having done exactly that.
	 */
	const unraised = new Map<string, RelayAsk>();

	/**
	 * Remember a refused ask and tell the caller the relay is spent.
	 *
	 * `reason` is warned about when it is given, and withheld for the ROUTINE refusal — a socket
	 * that is already gone, which happens on every session replacement and stop. This module's
	 * warnings default to `console.error`, and a session running under a TUI that owns the terminal
	 * gets its screen corrupted by an expected teardown message.
	 */
	const refuse = (ask: RelayAsk, reason?: string): Promise<undefined> => {
		if (reason !== undefined) warn(`Permission ask not relayed: ${reason}`);
		unraised.set(ask.requestId, ask);
		while (unraised.size > MAX_UNRAISED) {
			const oldest = unraised.keys().next();
			if (oldest.done === true) break;
			unraised.delete(oldest.value);
		}
		return Promise.resolve(undefined);
	};

	const subjectOf = (entry: PermissionEntry): ResolutionSubject => ({
		requestId: entry.requestId,
		detail: entry.detail,
		offeredOptionIds: entry.options.map((option) => option.id),
		requestedAt: entry.requestedAt,
		deadline: entry.frame.deadline,
	});

	const subjectOfAsk = (ask: RelayAsk): ResolutionSubject => ({
		requestId: ask.requestId,
		detail: ask.detail,
		offeredOptionIds: ask.options.map((option) => option.id),
		requestedAt: ask.requestedAt,
		deadline: ask.deadline,
	});

	/**
	 * Announce and record one terminal state.
	 *
	 * Called for every ending there is — approved, denied, cancelled, expired — because a record
	 * that only covers approvals is not an audit trail, it is a highlight reel.
	 */
	const finish = (
		entry: PermissionEntry,
		decision: TerminalDecision,
		chosenOptionId: string | null,
		decidedBy: RelayDecider,
	): void => {
		delivery.forgetRequest(entry.requestId);
		const resolved: PermissionResolvedMessage = {
			type: "permission_resolved",
			requestId: entry.requestId,
			decision,
			chosenOptionId,
			surface: decidedBy.surface,
			clientId: decidedBy.clientId,
		};
		try {
			options.server()?.broadcastPermissionResolved(resolved);
		} catch (error) {
			warn(`Permission relay could not announce a resolution: ${describe(error)}`);
		}
		appendResolution(subjectOf(entry), decision, chosenOptionId, decidedBy);
	};

	/**
	 * Record the ending of an ask that was never raised. NOTHING is announced.
	 *
	 * No surface was ever shown this ask, so there is no remote copy to take down and a
	 * `permission_resolved` naming it would be a resolution to a request no client has seen.
	 * Returns silently for any id that was not refused, which is the ordinary case — the decorator
	 * withdraws every ask it settles and almost all of them were raised normally.
	 */
	const finishUnraised = (
		requestId: string,
		decision: TerminalDecision,
		chosenOptionId: string | null,
		decidedBy: RelayDecider,
	): void => {
		const ask = unraised.get(requestId);
		if (ask === undefined) return;
		unraised.delete(requestId);
		appendResolution(subjectOfAsk(ask), decision, chosenOptionId, decidedBy);
	};

	/**
	 * Write the session's own record of how a TOOL permission ended.
	 *
	 * Scoped to tool permissions deliberately. `PermissionResolutionEntry` is a record ABOUT A TOOL
	 * CALL — it requires a `toolCallId`, a `toolName` and a cwd — and an extension's plain
	 * `confirm`/`select`/`input` has none of those. Synthesizing them so that every relayed dialog
	 * produced a row would put invented tool facts into the one artifact that is supposed to be
	 * evidence. The dialog is still relayed, still answerable and still echoed to every surface;
	 * it simply is not written down as a tool permission, because it is not one.
	 */
	const appendResolution = (
		subject: ResolutionSubject,
		decision: TerminalDecision,
		chosenOptionId: string | null,
		decidedBy: RelayDecider,
	): void => {
		const detail = subject.detail;
		if (detail === undefined || detail.kind !== "tool_permission") return;
		const recorder = options.recorder();
		if (recorder === null) return;
		try {
			recorder.appendPermissionResolution({
				requestId: subject.requestId,
				// The FULL id, not the wire's copy: the wire caps ids at 128 code units because a
				// renderer's schema does, and this record's job is to name the tool call the
				// transcript reports, which nothing here may abbreviate.
				toolCallId: detail.toolCallId,
				toolName: detail.toolName,
				cwd: detail.cwd,
				detail: { command: detail.command, path: detail.path, operation: detail.operation },
				offeredOptionIds: [...subject.offeredOptionIds],
				decision,
				chosenOptionId,
				decidedBy,
				requestedAt: subject.requestedAt,
				deadline: subject.deadline,
			});
		} catch (error) {
			// A session that cannot be written to must not take the answer down with it: the human
			// decided, the agent has its answer, and losing the audit row is the lesser failure.
			warn(`Permission relay could not record a resolution: ${describe(error)}`);
		}
	};

	/**
	 * Tell the raiser its ask is OVER — not merely that this relay is spent.
	 *
	 * The difference is a fail-OPEN defect. `resolve(undefined)` means "the relay gave up", and a
	 * decorator with a live local surface correctly keeps waiting on it. For an EXPIRY that reading
	 * is catastrophic: the relay has already broadcast `expired` and appended the audit row, and the
	 * local dialog was still on screen — a human tapping Approve after that ran the command the
	 * durable record says was refused. {@link RelayEnded} is the value that takes the ask down
	 * everywhere, and the ending it carries is the one the registry already tombstoned.
	 */
	const endAsk = (entry: PermissionEntry, ending: PermissionEnding): void => {
		const ended: RelayEnded = {
			requestId: entry.requestId,
			// The two words the wire can carry for an ask nobody answered. `approved`/`denied`
			// cannot reach here: this path exists precisely because nobody decided.
			ended: ending.decision === "expired" ? "expired" : "cancelled",
			decidedBy: ending.decidedBy,
		};
		entry.resolve(ended);
	};

	registry.onExpired((entry, ending) => {
		// Fail closed, attributed to nobody — and the ask comes down on EVERY surface, including
		// the local one this relay cannot see. `ending` is the registry's own value, not a second
		// literal saying the same thing; see PermissionEnding.
		endAsk(entry, ending);
		finish(entry, ending.decision, null, ending.decidedBy);
	});

	const relay: SocketPermissionRelay = {
		readWriteClientCount(): number {
			// Live, never cached: clients attach and detach while a session is running, and this
			// number is what `hasUI()` becomes for a headless session. Reporting a stale 1 here is
			// how "no UI available to request approval" turns into a fabricated "User denied
			// approval" in the transcript.
			return options.server()?.permissionCapableClientCount ?? 0;
		},

		raise(ask: RelayAsk): Promise<RelayAnswer | RelayEnded | undefined> {
			if (options.server() === null) {
				// The socket this relay belonged to is gone — the session was replaced or stopped.
				// Registering an ask nobody can be sent and nobody can answer would park the caller
				// on it until the clock ran out; saying "spent" immediately lets the local surface,
				// or the raising method's own fail-closed default, end it now.
				return refuse(ask);
			}
			const built = buildRequestFrame(ask, options.cwd, registry.expiryMs);
			if (built === undefined) {
				// The ask cannot be represented on the wire without changing what is being offered.
				// Offering a REPAIRED vocabulary would be worse than offering none: a surface
				// showing only the options that happened to fit — an "Approve" with its "Deny"
				// silently dropped — is a trap. Nothing is sent, so the local surface decides, or
				// the raising method's own fail-closed default does.
				return refuse(ask, "the ask cannot be represented on the wire without changing what is offered");
			}

			let resolveAsk!: (answer: RelayAnswer | RelayEnded | undefined) => void;
			const answered = new Promise<RelayAnswer | RelayEnded | undefined>((resolve) => {
				resolveAsk = resolve;
			});

			// REGISTERED BEFORE THE FIRST WRITE. A client can answer before the fan-out loop has
			// finished, and an answer naming an id the registry has never seen is refused as
			// unknown — which would refuse the first correct answer to a real ask.
			const inserted = registry.insert({
				requestId: ask.requestId,
				method: ask.method,
				options: built.options,
				detail: ask.detail,
				frame: built.frame,
				requestedAt: built.frame.requestedAt,
				resolve: resolveAsk,
			});
			if (!inserted.ok) {
				// A BOUND, not a decision. Remembered so the ending the decorator settles on is
				// still written down and can be told apart from a human's refusal.
				return refuse(ask, inserted.message);
			}

			try {
				const reached = options.server()?.broadcastPermissionRequest(built.frame) ?? [];
				for (const clientId of reached) delivery.markDelivered(clientId, ask.requestId);
			} catch (error) {
				// A write failure is not an answer. The ask stays pending: a client that reconnects
				// is replayed it, and the registry's clock still ends it if nobody ever does.
				warn(`Permission ask could not be broadcast: ${describe(error)}`);
			}

			return answered;
		},

		withdraw(requestId: string, decidedBy: RelayDecider, outcome: RelayOutcome): void {
			// WHAT HAPPENED comes from the caller, which has just settled the ask and holds the
			// value. This used to hardcode `cancelled`, and an approved bash call whose command had
			// already run was written into the JSONL — and broadcast to the attached phone — as
			// `{decision: "cancelled", chosenOptionId: null}`. Nothing here reconstructs an outcome.
			const decision = terminalDecisionFor(outcome);
			const chosenOptionId =
				outcome.kind === "approved" || outcome.kind === "denied" ? outcome.chosenOptionId : null;

			// The decorator withdraws EVERY ask it settles, including the ones a remote answer just
			// settled here. `withdraw` returns undefined for an ask that is already over, and that
			// silence is what stops a second broadcast and a second audit row.
			const entry = registry.withdraw(requestId, decidedBy, decision);
			if (entry === undefined) {
				// Either the ask is already over — the ordinary, silent case — or it was never
				// raised because a bound refused it. Only the second writes anything.
				finishUnraised(requestId, decision, chosenOptionId, decidedBy);
				return;
			}
			// The caller already has its answer from the surface that won; this only releases the
			// arm this relay was holding.
			entry.resolve(undefined);
			finish(entry, decision, chosenOptionId, decidedBy);
		},

		handleResponse(message: { requestId: string; optionId: string }, clientId: string): void {
			const decidedBy: RelayDecider = { surface: "attach", clientId };
			const result = registry.settle(sessionId, message.requestId, message.optionId, decidedBy);

			if (result.status === "refused") {
				// The entry is untouched and still answerable — by this client, by another surface,
				// or by nobody at all. Saying so beats silence: a phone must be able to tell
				// "answered" from "this draht never asked".
				options
					.server()
					?.sendErrorToClient(
						clientId,
						result.message,
						result.reason === "invalid_option" ? ERROR_INVALID_OPTION : ERROR_UNKNOWN_REQUEST,
					);
				return;
			}
			if (result.status === "already_resolved") {
				// A client that answered and then dropped its connection comes back to a definite
				// account of what happened, rather than to a bare unknown-id refusal that reads
				// exactly like a lost answer.
				options.server()?.sendErrorToClient(clientId, result.message, ERROR_ALREADY_RESOLVED);
				return;
			}

			// settle → resolve → (the decorator aborts the losing surfaces) → broadcast → record.
			result.entry.resolve(result.answer);
			finish(result.entry, result.decision, result.chosenOptionId, decidedBy);
		},

		replayTo(clientId: string): void {
			const server = options.server();
			if (server === null) return;
			for (const entry of delivery.pendingFor(clientId)) {
				try {
					// Targeted, not broadcast: every other client has already been shown this one.
					// The server drops it silently if this client is read-only or never declared
					// the capability, which is the correct outcome for both.
					server.sendPermissionRequest(clientId, entry.frame);
					delivery.markDelivered(clientId, entry.requestId);
				} catch (error) {
					warn(`Permission ask could not be replayed to ${clientId}: ${describe(error)}`);
				}
			}
		},

		forgetClient(clientId: string): void {
			delivery.forgetClient(clientId);
		},

		cancelAll(): void {
			const ending = CANCELLED_BY_SYSTEM;
			for (const entry of registry.cancelAll(ending.decidedBy)) {
				// Same reasoning as expiry: the session is going away, so the ask is OVER and the
				// local dialog must come down with it. A `undefined` here leaves a live Approve
				// button on an ask this very loop has already recorded as cancelled.
				endAsk(entry, ending);
				finish(entry, ending.decision, null, ending.decidedBy);
			}
			delivery.clear();
			// `unraised` is deliberately NOT cleared. Those asks were never broadcast, so there is
			// nothing of theirs on any client to sweep — and they may still be parked on a LIVE
			// local surface. The session's own recorder outlives this teardown (the bind hands over
			// `session.sessionManager`, which does not go null), so a human who answers one of them
			// a moment later still gets that answer written into the session it belongs to. The map
			// is bounded and dies with this relay object.
		},
	};

	return relay;
}

/**
 * The wire's word for an outcome. All four map exactly — the gap is closed.
 *
 * GAP CLOSED (geist/0.4). `RelayOutcome` has always carried an honest `answered` kind; what was
 * missing was a neutral member on the wire, so this function flattened `answered` onto `cancelled`.
 * That understated: it said an ask came down UNANSWERED about an ask a human had answered and whose
 * tool call had already RUN. The mirror-image falsehood lived in the registry's `decisionFor`,
 * which said `approved` — a grant nobody made — for the remote half of the very same case.
 *
 * The containment argument that let both survive Phase 34 — "no audit row is written for a `select`
 * or `input`, because `appendResolution` gates on a `tool_permission` detail and those never carry
 * one" — IS FALSE. Nothing stops an extension attaching such a detail to a `select`, and a probe
 * did; at that point the false word was written into the durable session JSONL, not merely
 * broadcast. See ROADMAP.md, "Owner: whoever next opens the wire".
 *
 * `answered` now exists on `TerminalDecision` (`permission-registry.ts`), on
 * `PermissionResolvedMessage.decision` (`socket-server/types.ts`), on
 * `PermissionResolutionEntry.decision` (`core/session-manager.ts`) and on
 * `PermissionResolvedFrameSchema.decision` (`packages/geist-protocol/src/wire.ts`, mirrored through
 * `MIRRORED_FRAMES` and frozen in the `geist-0.4` conformance corpus).
 *
 * IT GRANTS NOTHING. It is neutral, not permissive: any consumer branching on this value must treat
 * `answered` the way it treats `denied`, and only `approved` as permission. What was chosen travels
 * as `chosenOptionId`.
 */
function terminalDecisionFor(outcome: RelayOutcome): TerminalDecision {
	switch (outcome.kind) {
		case "approved":
			return "approved";
		case "denied":
			return "denied";
		case "answered":
			return "answered";
		case "cancelled":
			return "cancelled";
	}
}

/** What was put on the wire, and the offered set exactly as it was offered. */
interface BuiltRequest {
	readonly frame: PermissionRequestMessage;
	readonly options: readonly RegisteredOption[];
}

/**
 * Build the `permission_request` frame — the ONE place the wire text is constructed.
 *
 * Every free-text field goes through `boundedSafeText`, which neutralizes control, bidi and
 * invisible code points ONE FOR ONE (never deleting: dropping a control character welds `rm -r` +
 * `f /` into `rm -rf /`) and bounds the result in grapheme clusters AND UTF-8 bytes, preserving the
 * decisive TAIL. `truncated` is the OR of every field's own verdict, so a surface can say that a
 * decision is being made on an abbreviated string.
 *
 * THAT OR STARTS FROM THE PRODUCER'S VERDICT, NOT FROM `false`. The text arriving in `detail` was
 * already neutralized-and-bounded at construction, at a budget EIGHT TIMES TIGHTER than the wire's
 * (512 graphemes against `command`'s 4000) — so a 5000-character command reaches this function
 * already ~530 characters long, every `bound` call below leaves it untouched, and an OR that began
 * at `false` reported `truncated: false` about a string the human was shown 4,572 characters short
 * of. Re-bounding here can only ever discover elisions THIS function performs; the producer's is
 * unrecoverable from the value, so it is carried on the detail and read back below.
 *
 * Returns `undefined` when the ask cannot be carried WITHOUT CHANGING WHAT IS OFFERED — an option
 * id the wire cannot hold, or more options than it can carry. Repairing that would mean offering a
 * different vocabulary than the caller authorised.
 */
function buildRequestFrame(ask: RelayAsk, sessionCwd: string, registryExpiryMs: number): BuiltRequest | undefined {
	if (!isWireId(ask.requestId)) return undefined;
	if (ask.options.length > MAX_OPTIONS) return undefined;

	const detail: PermissionAskDetail | undefined =
		ask.detail !== undefined && ask.detail.kind === "tool_permission" ? ask.detail : undefined;

	// Seeded, not initialised to `false`: see the note above. A detail that never elided says
	// nothing, and a detail from a producer that does not carry the flag at all leaves this `false`
	// exactly as before — so this is additive, never a source of a fabricated `true`.
	let truncated = detail?.truncated === true;
	const bound = (raw: string, budget: number): string => {
		const result = boundedSafeText(raw, budget);
		truncated = truncated || result.truncated;
		return result.value;
	};

	const options: RegisteredOption[] = [];
	const wireOptions: PermissionOption[] = [];
	for (const option of ask.options) {
		if (!isWireId(option.id)) return undefined;
		options.push({ id: option.id, label: option.label, decision: option.decision });
		// `decision` rides in `detail.options` and in the registry, not here: the socket wire's
		// `PermissionOption` is `{id, label}` and the mirrored schema would strip anything else,
		// so adding it would produce a field a renderer can never rely on.
		wireOptions.push({ id: option.id, label: bound(option.label, FIELD_BUDGET.label) });
	}

	// An ask that gates no tool call still has to fill the frame's required identity fields. It is
	// labelled for what it IS — a UI dialog raised by the session — rather than dressed up as a
	// tool call that does not exist, and its id is its own request id so nothing joins it to a
	// tool call in the transcript.
	const toolCallId = clampId(detail?.toolCallId ?? ask.requestId);
	if (toolCallId.clamped) truncated = true;
	const toolName = bound(detail?.toolName ?? `ui:${ask.method}`, FIELD_BUDGET.toolName);
	const cwd = bound(detail?.cwd ?? sessionCwd, FIELD_BUDGET.cwd);

	const frame: PermissionRequestMessage = {
		type: "permission_request",
		requestId: ask.requestId,
		method: ask.method,
		toolCallId: toolCallId.value,
		toolName,
		cwd,
		title: bound(ask.title, FIELD_BUDGET.title),
		message: bound(ask.message ?? "", FIELD_BUDGET.message),
		truncated: false,
		options: wireOptions,
		requestedAt: ask.requestedAt,
		deadline: advisoryDeadline(ask.deadline, registryExpiryMs),
	};
	if (detail?.command !== undefined) frame.command = bound(detail.command, FIELD_BUDGET.command);
	if (detail?.path !== undefined) frame.path = bound(detail.path, FIELD_BUDGET.path);
	if (detail?.operation !== undefined) frame.operation = bound(detail.operation, FIELD_BUDGET.operation);
	// Set last: every `bound` call above contributes to it, on top of the producer's own verdict.
	frame.truncated = truncated;

	return { frame, options };
}

/**
 * The instant a surface may draw a countdown to — ADVISORY, and enforced by nobody remote.
 *
 * The earlier of the two clocks that really exist: the registry's own fail-closed timer, which is
 * armed for every ask, and the caller's declared timeout, which the decorator arms when it holds
 * the only arm and which interactive mode counts down itself. Showing the earlier of them is the
 * only honest countdown — showing the later one would tick past the moment the ask actually stopped
 * being answerable.
 *
 * NOTHING MAY DENY AN ASK BECAUSE THIS INSTANT PASSED. A client-side auto-deny would be a second
 * clock and a new denial path, and it would deny in the name of a human who simply had not looked
 * at their phone yet. Real expiry binds solely to the registry.
 */
function advisoryDeadline(declared: string | null, registryExpiryMs: number): string | null {
	const registryDeadline = new Date(Date.now() + registryExpiryMs).toISOString();
	if (declared === null) return registryDeadline;
	const declaredAt = Date.parse(declared);
	if (!Number.isFinite(declaredAt)) return registryDeadline;
	return declaredAt < Date.parse(registryDeadline) ? declared : registryDeadline;
}

/** Whether a plain (non-`safeText`) wire id fits its schema: non-empty, at most 128 code units. */
function isWireId(value: string): boolean {
	return value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * Fit an id the wire caps at 128 code units.
 *
 * Only ever applied to `toolCallId`, which is a JOIN KEY for rendering and not something a client
 * echoes back; the audit record keeps the full value. An option id is never clamped — a clamped id
 * would come back not matching the set it was offered from.
 */
function clampId(value: string): { value: string; clamped: boolean } {
	if (value.length <= MAX_ID_LENGTH) return { value, clamped: false };
	return { value: value.slice(0, MAX_ID_LENGTH), clamped: true };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
