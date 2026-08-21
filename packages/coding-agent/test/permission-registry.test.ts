/**
 * T8-PIN — `PermissionRegistry`, the one clock and the one compare-and-swap, pinned.
 *
 * Nothing in the repo imported this class before this file existed. Every bound it declares (32
 * pending, 60 KB per entry, 4 MiB total, a 120 s tombstone window, 128 tombstones), every branch of
 * `resolvePermissionExpiryMs`, and both of the properties four adversarial rounds were spent on —
 * a refusal never consumes, and an answer's meaning is read off the chosen option's OWN `decision`
 * word — were reachable only through a live socket session. A bound with no test is a number in a
 * comment.
 *
 * These drive the REAL class. The only injected seam is `now()`, which the constructor already
 * exposes for exactly this, plus tiny `expiryMs` values so the fail-closed timer can be observed in
 * milliseconds rather than in the hour it defaults to.
 *
 * WHAT IS DELIBERATELY ASSERTED AS A KNOWN GAP: `decisionFor` says `approved` for a `select` entry
 * and for an `input`, because the wire union has no neutral member. That word is wrong and is
 * documented as wrong at both ends. It is pinned here so a protocol revision that adds `answered`
 * has to come through this file and say so, rather than changing the meaning of the durable record
 * by accident.
 */

import { describe, expect, it, vi } from "vitest";
import type { PermissionAskDetail } from "../src/core/extensions/types.ts";
import type { RelayAnswer, RelayAsk, RelayEnded } from "../src/core/permission-relay/index.ts";
import { PermissionDelivery } from "../src/core/socket-server/permission-delivery.ts";
import {
	DEFAULT_MAX_ENTRY_BYTES,
	DEFAULT_MAX_PENDING,
	DEFAULT_MAX_TOMBSTONES,
	DEFAULT_MAX_TOTAL_BYTES,
	DEFAULT_PERMISSION_EXPIRY_MS,
	DEFAULT_TOMBSTONE_TTL_MS,
	MAX_PERMISSION_EXPIRY_MS,
	MIN_PERMISSION_EXPIRY_MS,
	PERMISSION_EXPIRY_ENV,
	type PermissionEntry,
	type PermissionInsert,
	PermissionRegistry,
	type RegisteredOption,
	resolvePermissionExpiryMs,
} from "../src/core/socket-server/permission-registry.ts";
import {
	createSocketPermissionRelay,
	type PermissionRecorder,
	type PermissionSocketServer,
} from "../src/core/socket-server/permission-relay.ts";
import type { PermissionRequestMessage } from "../src/core/socket-server/types.ts";

const SESSION_ID = "session-under-test";
const OTHER_SESSION_ID = "some-other-session";

/**
 * The vocabulary the tool permission gate really supplies, with the denial NOT last.
 *
 * `[allow, deny-once, deny-always]` breaks every positional shortcut at once: the denial is in the
 * middle, there are TWO of them, and the last entry is a denial rather than the "extra" one. A
 * reading that used index 0 for approve and "the last one" for deny passes on `[approve, deny]` and
 * approves `deny-always` here.
 */
const TOOL_VOCABULARY: readonly RegisteredOption[] = Object.freeze([
	Object.freeze({ id: "allow", label: "Allow", decision: "approve" as const }),
	Object.freeze({ id: "deny-once", label: "Deny once", decision: "deny" as const }),
	Object.freeze({ id: "deny-always", label: "Deny always", decision: "deny" as const }),
]);

/** The same shape with the denial FIRST, so "the last option approves" also fails. */
const DENIAL_FIRST: readonly RegisteredOption[] = Object.freeze([
	Object.freeze({ id: "nope", label: "No", decision: "deny" as const }),
	Object.freeze({ id: "yep", label: "Yes", decision: "approve" as const }),
]);

function frameFor(requestId: string, message = "bash: touch /tmp/marker"): PermissionRequestMessage {
	return {
		type: "permission_request",
		requestId,
		method: "confirm",
		toolCallId: "call-1",
		toolName: "bash",
		cwd: "/tmp/project",
		title: "Approve tool call?",
		message,
		truncated: false,
		options: TOOL_VOCABULARY.map((option) => ({ id: option.id, label: option.label })),
		requestedAt: new Date().toISOString(),
		deadline: null,
	};
}

interface InsertOverrides {
	method?: RelayAsk["method"];
	options?: readonly RegisteredOption[];
	frame?: PermissionRequestMessage;
	detail?: PermissionAskDetail;
	resolve?: (answer: RelayAnswer | RelayEnded | undefined) => void;
}

function insertOf(requestId: string, overrides: InsertOverrides = {}): PermissionInsert {
	const frame = overrides.frame ?? frameFor(requestId);
	return {
		requestId,
		method: overrides.method ?? "confirm",
		options: overrides.options ?? TOOL_VOCABULARY,
		detail: overrides.detail,
		frame,
		requestedAt: frame.requestedAt,
		resolve: overrides.resolve ?? (() => {}),
	};
}

/** A registry whose clock the test owns outright. */
function fixedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
	let value = start;
	return {
		now: () => value,
		advance: (ms: number) => {
			value += ms;
		},
	};
}

/** Poll until `probe` is true, or fail loudly rather than hang the suite. */
async function until(probe: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (probe()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// resolvePermissionExpiryMs — every branch carries a paragraph of rationale; none was exercised
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("resolvePermissionExpiryMs — anything not thought about becomes the default", () => {
	it("falls back to one hour when the variable is unset", () => {
		expect(resolvePermissionExpiryMs({})).toBe(DEFAULT_PERMISSION_EXPIRY_MS);
		expect(DEFAULT_PERMISSION_EXPIRY_MS).toBe(60 * 60 * 1000);
	});

	it("treats empty and whitespace-only as unset rather than as zero", () => {
		// `Number("")` and `Number("  ")` are both 0, which would sail past `Number.isFinite` and
		// arm a timer that fires on the next tick — every ask failing closed instantly.
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: "" })).toBe(DEFAULT_PERMISSION_EXPIRY_MS);
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: "   " })).toBe(DEFAULT_PERMISSION_EXPIRY_MS);
	});

	it("never produces NaN from unparseable text", () => {
		// The named failure: `new Date(Date.now() + NaN)` throws a RangeError out of the ask
		// itself, which the gate reports as a TOOL ERROR — the ask neither fails closed nor
		// reaches anybody.
		for (const raw of ["abc", "5 minutes", "1e", "--3", "NaN"]) {
			const resolved = resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: raw });
			expect(Number.isNaN(resolved), `"${raw}" produced NaN`).toBe(false);
			expect(resolved).toBe(DEFAULT_PERMISSION_EXPIRY_MS);
		}
	});

	it("rejects Infinity rather than keeping an ask forever", () => {
		// Rejected, NOT clamped to the ceiling: `Infinity` means "this was not thought about".
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: "Infinity" })).toBe(DEFAULT_PERMISSION_EXPIRY_MS);
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: "-Infinity" })).toBe(DEFAULT_PERMISSION_EXPIRY_MS);
	});

	it("rejects zero and negatives rather than clamping them to the floor", () => {
		for (const raw of ["0", "-1", "-60000"]) {
			expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: raw }), raw).toBe(DEFAULT_PERMISSION_EXPIRY_MS);
		}
	});

	it("rejects a value below the floor a human could answer within", () => {
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: String(MIN_PERMISSION_EXPIRY_MS - 1) })).toBe(
			DEFAULT_PERMISSION_EXPIRY_MS,
		);
		// The floor itself is accepted — the bound is inclusive on both ends.
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: String(MIN_PERMISSION_EXPIRY_MS) })).toBe(
			MIN_PERMISSION_EXPIRY_MS,
		);
	});

	it("rejects a value above the 24-hour ceiling, and accepts the ceiling itself", () => {
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: String(MAX_PERMISSION_EXPIRY_MS + 1) })).toBe(
			DEFAULT_PERMISSION_EXPIRY_MS,
		);
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: String(MAX_PERMISSION_EXPIRY_MS) })).toBe(
			MAX_PERMISSION_EXPIRY_MS,
		);
		expect(MAX_PERMISSION_EXPIRY_MS).toBe(24 * 60 * 60 * 1000);
	});

	it("accepts a usable value and floors it to whole milliseconds", () => {
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: "2000" })).toBe(2000);
		expect(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: "1500.9" })).toBe(1500);
		// A whole-millisecond deadline: `setTimeout` truncates anyway, and a fractional value in
		// the record would be a deadline no clock ever had.
		expect(Number.isInteger(resolvePermissionExpiryMs({ [PERMISSION_EXPIRY_ENV]: "1500.9" }))).toBe(true);
	});

	it("reads process.env when nothing is passed", () => {
		vi.stubEnv(PERMISSION_EXPIRY_ENV, "3000");
		try {
			expect(resolvePermissionExpiryMs()).toBe(3000);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// insert — the bounds
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionRegistry.insert — every bound, and what a refusal leaves behind", () => {
	it("refuses a duplicate id without disturbing the ask already holding it", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		const first = registry.insert(insertOf("req-1"));
		expect(first.ok).toBe(true);

		const duplicate = registry.insert(insertOf("req-1", { frame: frameFor("req-1", "a different ask entirely") }));
		expect(duplicate).toMatchObject({ ok: false, reason: "duplicate_request" });

		// The original is untouched — an id collision means a caller reused one, and the ask that
		// got there first is the real one.
		expect(registry.pendingCount).toBe(1);
		expect(registry.get("req-1")?.frame.message).toBe("bash: touch /tmp/marker");
	});

	it("holds exactly DEFAULT_MAX_PENDING asks and refuses the next", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		for (let index = 0; index < DEFAULT_MAX_PENDING; index++) {
			expect(registry.insert(insertOf(`req-${index}`)).ok, `insert #${index}`).toBe(true);
		}
		expect(registry.pendingCount).toBe(DEFAULT_MAX_PENDING);
		expect(DEFAULT_MAX_PENDING).toBe(32);

		const refused = registry.insert(insertOf("req-one-too-many"));
		expect(refused).toMatchObject({ ok: false, reason: "too_many_pending" });
		if (refused.ok) throw new Error("unreachable");
		expect(refused.message).toContain(String(DEFAULT_MAX_PENDING));

		// The bound refuses the NEWCOMER. It never evicts an ask a human may be looking at.
		expect(registry.pendingCount).toBe(DEFAULT_MAX_PENDING);
		expect(registry.get("req-0")).toBeDefined();

		// And it is a bound, not a wall: answering one makes room for the next.
		registry.settle(SESSION_ID, "req-0", "allow", { surface: "attach", clientId: "phone" });
		expect(registry.insert(insertOf("req-after-room")).ok).toBe(true);
	});

	it("refuses an ask whose encoded frame exceeds the per-entry byte cap", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		const huge = frameFor("req-huge", "x".repeat(DEFAULT_MAX_ENTRY_BYTES + 1));
		const refused = registry.insert(insertOf("req-huge", { frame: huge }));

		expect(refused).toMatchObject({ ok: false, reason: "entry_too_large" });
		if (refused.ok) throw new Error("unreachable");
		expect(refused.message).toContain(String(DEFAULT_MAX_ENTRY_BYTES));
		expect(DEFAULT_MAX_ENTRY_BYTES).toBe(60_000);

		// Refused BEFORE anything was counted: the byte budget is not consumed by an ask that was
		// never held, so a normal ask right behind it still fits.
		expect(registry.pendingCount).toBe(0);
		expect(registry.insert(insertOf("req-normal")).ok).toBe(true);
	});

	it("counts bytes in UTF-8, not in code units", () => {
		// A 4-byte emoji is 2 UTF-16 code units. A registry that measured `.length` would accept a
		// frame the transport then refuses, which is the bridge-drops-the-renderer failure the cap
		// exists to prevent.
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, maxEntryBytes: 4_000 });
		const emoji = frameFor("req-emoji", "🙂".repeat(1_100)); // 2,200 code units, 4,400 bytes
		expect(registry.insert(insertOf("req-emoji", { frame: emoji }))).toMatchObject({
			ok: false,
			reason: "entry_too_large",
		});
	});

	it("refuses an ask that would push the total over the aggregate cap, and frees the bytes on settle", () => {
		// Small caps so the arithmetic is legible; the real ones are 60 KB and 4 MiB.
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, maxTotalBytes: 4_000 });
		const bulky = (id: string) => insertOf(id, { frame: frameFor(id, "y".repeat(1_200)) });

		expect(registry.insert(bulky("req-a")).ok).toBe(true);
		expect(registry.insert(bulky("req-b")).ok).toBe(true);
		const refused = registry.insert(bulky("req-c"));
		expect(refused).toMatchObject({ ok: false, reason: "total_too_large" });
		if (refused.ok) throw new Error("unreachable");
		expect(refused.message).toContain("4000");

		// Settling one returns its bytes to the budget. Without the decrement in `#remove` the
		// registry would refuse every ask forever after a busy minute.
		registry.settle(SESSION_ID, "req-a", "allow", { surface: "attach", clientId: "phone" });
		expect(registry.insert(bulky("req-c")).ok).toBe(true);

		expect(DEFAULT_MAX_TOTAL_BYTES).toBe(4 * 1024 * 1024);
	});

	it("freezes the offered set so nothing can change what was offered after the fact", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		const mutable = [{ id: "allow", label: "Allow", decision: "approve" as const }];
		const inserted = registry.insert(insertOf("req-frozen", { options: mutable }));
		if (!inserted.ok) throw new Error("insert refused");

		expect(Object.isFrozen(inserted.entry.options)).toBe(true);
		expect(Object.isFrozen(inserted.entry.options[0])).toBe(true);

		// The caller's array is COPIED: mutating it afterwards cannot add an answerable option.
		mutable.push({ id: "smuggled", label: "Smuggled", decision: "approve" as const });
		expect(inserted.entry.options).toHaveLength(1);
		expect(
			registry.settle(SESSION_ID, "req-frozen", "smuggled", { surface: "attach", clientId: "phone" }),
		).toMatchObject({ status: "refused", reason: "invalid_option" });
	});

	it("stamps the deadline off the registry's own clock", () => {
		const clock = fixedClock();
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs: 90_000, now: clock.now });
		const inserted = registry.insert(insertOf("req-deadline"));
		if (!inserted.ok) throw new Error("insert refused");

		expect(registry.expiryMs).toBe(90_000);
		expect(inserted.entry.deadlineAt).toBe(clock.now() + 90_000);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// settle — the two properties four adversarial rounds were spent on
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionRegistry.settle — a refusal never consumes the ask", () => {
	it("refuses an option nobody offered and leaves the ask answerable by the human", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		const answers: (RelayAnswer | RelayEnded | undefined)[] = [];
		registry.insert(insertOf("req-1", { resolve: (answer) => answers.push(answer) }));

		const refused = registry.settle(SESSION_ID, "req-1", "definitely-not-offered", {
			surface: "attach",
			clientId: "phone",
		});
		expect(refused).toMatchObject({ status: "refused", reason: "invalid_option" });

		// Nothing was resolved, nothing was removed, no tombstone was laid: one malformed frame
		// from any attached client must not silently deny a tool call the human never saw.
		expect(answers).toEqual([]);
		expect(registry.pendingCount).toBe(1);

		const real = registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" });
		expect(real).toMatchObject({ status: "resolved", decision: "approved", chosenOptionId: "allow" });
	});

	it("refuses an answer naming another session without revealing that the id exists here", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-1"));

		const refused = registry.settle(OTHER_SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" });
		expect(refused).toMatchObject({ status: "refused", reason: "cross_session" });
		if (refused.status !== "refused") throw new Error("unreachable");

		// Said EXACTLY the way an unknown id is said, so the refusal text is not an oracle for
		// which session ids exist.
		const unknown = registry.settle(SESSION_ID, "req-absent", "allow", { surface: "attach", clientId: "phone" });
		if (unknown.status !== "refused") throw new Error("unreachable");
		expect(refused.message).toBe(`No permission ask ${JSON.stringify("req-1")} is pending`);
		expect(unknown.message).toBe(`No permission ask ${JSON.stringify("req-absent")} is pending`);
		expect(refused.message).not.toContain(SESSION_ID);
		expect(refused.message).not.toContain(OTHER_SESSION_ID);

		// And it consumed nothing: the ask is still there for the surface that may answer it.
		expect(registry.pendingCount).toBe(1);
		expect(registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" })).toMatchObject({
			status: "resolved",
		});
	});

	it("refuses an id it has never seen", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		expect(registry.settle(SESSION_ID, "never-existed", "allow", { surface: "attach", clientId: "x" })).toMatchObject(
			{ status: "refused", reason: "unknown_request" },
		);
	});
});

describe("PermissionRegistry.settle — meaning comes from the option's own word, never its position", () => {
	it("denies on a denial that sits in the MIDDLE of the vocabulary", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-mid"));
		const result = registry.settle(SESSION_ID, "req-once", "x", { surface: "attach", clientId: "phone" });
		expect(result.status).toBe("refused");

		const denial = registry.settle(SESSION_ID, "req-mid", "deny-once", { surface: "attach", clientId: "phone" });
		expect(denial).toMatchObject({ status: "resolved", decision: "denied", chosenOptionId: "deny-once" });
	});

	it("denies on the LAST option too, when that option is the one that declares a denial", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-last"));
		expect(
			registry.settle(SESSION_ID, "req-last", "deny-always", { surface: "attach", clientId: "p" }),
		).toMatchObject({ status: "resolved", decision: "denied", chosenOptionId: "deny-always" });
	});

	it("denies on the FIRST option when the vocabulary puts its denial first", () => {
		// The mirror image: a rule of "index 0 approves" reads this as an approval and runs the
		// command. There is no positional rule that survives both this test and the one above.
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-first", { options: DENIAL_FIRST }));
		expect(registry.settle(SESSION_ID, "req-first", "nope", { surface: "attach", clientId: "p" })).toMatchObject({
			status: "resolved",
			decision: "denied",
			chosenOptionId: "nope",
		});

		const registry2 = new PermissionRegistry({ sessionId: SESSION_ID });
		registry2.insert(insertOf("req-first-2", { options: DENIAL_FIRST }));
		expect(registry2.settle(SESSION_ID, "req-first-2", "yep", { surface: "attach", clientId: "p" })).toMatchObject({
			decision: "approved",
			chosenOptionId: "yep",
		});
	});

	it("ignores id shape and label entirely — a denial labelled 'Allow' still denies", () => {
		// The label and the id both SAY approve; only `decision` says what it means, and only
		// `decision` may be read.
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(
			insertOf("req-liar", {
				options: [
					{ id: "approve", label: "Allow this command", decision: "deny" },
					{ id: "deny", label: "Block it", decision: "approve" },
				],
			}),
		);
		expect(registry.settle(SESSION_ID, "req-liar", "approve", { surface: "attach", clientId: "p" })).toMatchObject({
			decision: "denied",
		});
	});

	it("carries the answer back with the id verbatim and the decider that produced it", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		const answers: (RelayAnswer | RelayEnded | undefined)[] = [];
		registry.insert(insertOf("req-answer", { resolve: (answer) => answers.push(answer) }));

		const result = registry.settle(SESSION_ID, "req-answer", "allow", { surface: "attach", clientId: "phone-7" });
		if (result.status !== "resolved") throw new Error("unreachable");
		expect(result.answer).toEqual({
			requestId: "req-answer",
			optionId: "allow",
			decidedBy: { surface: "attach", clientId: "phone-7" },
		});

		// The registry HANDS BACK the resolver; it never runs it. Nothing has been resolved yet.
		expect(answers).toEqual([]);
		result.entry.resolve(result.answer);
		expect(answers).toEqual([result.answer]);
	});

	it("accepts ANY string for an input ask, verbatim, because every string is a valid answer", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-input", { method: "input", options: [] }));

		const typed = "  a value with spaces and a \\ backslash  ";
		const result = registry.settle(SESSION_ID, "req-input", typed, { surface: "attach", clientId: "phone" });
		if (result.status !== "resolved") throw new Error("unreachable");
		// Carried through untouched: for `input` this field is not an id at all, it is the answer.
		expect(result.chosenOptionId).toBe(typed);
		expect(result.answer.optionId).toBe(typed);
		// Even the empty string. Refusing it would hang the agent on an ask the client rendered as
		// fully answerable.
		const registry2 = new PermissionRegistry({ sessionId: SESSION_ID });
		registry2.insert(insertOf("req-empty", { method: "input", options: [] }));
		expect(registry2.settle(SESSION_ID, "req-empty", "", { surface: "attach", clientId: "p" })).toMatchObject({
			status: "resolved",
		});
	});

	it("KNOWN GAP: a plain select entry that declares nothing is reported `approved`", () => {
		// Pinned, not endorsed. `select` grants nothing, but the wire union has no neutral member,
		// so `decisionFor` says `approved` for it. It is contained — no audit row is written for an
		// ask with no `tool_permission` detail — and the relay refuses to spread the word (an
		// answered select withdrawn locally is recorded `cancelled`, see terminalDecisionFor).
		// A protocol revision that adds `answered` must come through THIS assertion and say so.
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(
			insertOf("req-select", {
				method: "select",
				options: [
					{ id: "opt-0", label: "First" },
					{ id: "opt-1", label: "Second" },
				],
			}),
		);
		expect(registry.settle(SESSION_ID, "req-select", "opt-1", { surface: "attach", clientId: "p" })).toMatchObject({
			status: "resolved",
			decision: "approved",
			chosenOptionId: "opt-1",
		});
	});

	it("refuses a confirm whose offered set is empty — nothing can be named", () => {
		// The shape a caller vocabulary that failed validation produces. The ask is shown for
		// context; echoing ANY id back is silence, not a dismissal.
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-context-only", { options: [] }));
		expect(
			registry.settle(SESSION_ID, "req-context-only", "anything", { surface: "attach", clientId: "p" }),
		).toMatchObject({ status: "refused", reason: "invalid_option" });
		expect(registry.pendingCount).toBe(1);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// exactly once — the second answer, and what it is told
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionRegistry — an ask is settled exactly once, and the loser is TOLD", () => {
	it("tells a second answer it was already resolved, by whom and to what", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-1"));

		expect(registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" })).toMatchObject({
			status: "resolved",
		});

		const late = registry.settle(SESSION_ID, "req-1", "deny-once", { surface: "attach", clientId: "desktop" });
		expect(late).toMatchObject({
			status: "already_resolved",
			decision: "approved",
			decidedBy: { surface: "attach", clientId: "phone" },
		});
		if (late.status !== "already_resolved") throw new Error("unreachable");
		expect(late.message).toContain("already resolved");
		// A definite account, not a bare unknown-id refusal that reads exactly like a lost answer.
		expect(late.message).toContain("attach");
	});

	it("removes the entry on the winning answer, so the second one cannot reach a resolver", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		const answers: (RelayAnswer | RelayEnded | undefined)[] = [];
		registry.insert(insertOf("req-1", { resolve: (answer) => answers.push(answer) }));

		const first = registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" });
		const second = registry.settle(SESSION_ID, "req-1", "deny-always", { surface: "attach", clientId: "desktop" });

		if (first.status !== "resolved") throw new Error("unreachable");
		expect(second.status).toBe("already_resolved");
		expect(registry.pendingCount).toBe(0);
		expect(registry.get("req-1")).toBeUndefined();
		// Only the winner has a resolver to run. A denial and an approval cannot both look accepted.
		expect("entry" in second).toBe(false);
	});

	it("remembers a withdrawal's REAL decision, so a late answer is not told a lie", () => {
		// The fix this task is guarding: `withdraw` used to hardcode `cancelled`. A phone whose
		// answer lost the race to a local approval must be told `approved`, not that the approved,
		// executed command was cancelled.
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-1"));

		registry.withdraw("req-1", { surface: "tui", clientId: null }, "approved");

		expect(registry.settle(SESSION_ID, "req-1", "deny-once", { surface: "attach", clientId: "phone" })).toMatchObject(
			{
				status: "already_resolved",
				decision: "approved",
				decidedBy: { surface: "tui", clientId: null },
			},
		);
	});

	it("forgets a settled ask once the tombstone window closes", () => {
		const clock = fixedClock();
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, tombstoneTtlMs: 1_000, now: clock.now });
		registry.insert(insertOf("req-1"));
		registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" });

		clock.advance(1_000);
		expect(registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" })).toMatchObject({
			status: "already_resolved",
		});

		clock.advance(1);
		// Past the window it is simply unknown again — the memory is a courtesy, not state.
		expect(registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "phone" })).toMatchObject({
			status: "refused",
			reason: "unknown_request",
		});

		expect(DEFAULT_TOMBSTONE_TTL_MS).toBe(120_000);
	});

	it("keeps at most maxTombstones, dropping the oldest first", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, maxTombstones: 2 });
		for (const id of ["req-1", "req-2", "req-3"]) {
			registry.insert(insertOf(id));
			registry.settle(SESSION_ID, id, "allow", { surface: "attach", clientId: "phone" });
		}

		// The oldest fell out of the window; the two newest still explain themselves.
		expect(registry.settle(SESSION_ID, "req-1", "allow", { surface: "attach", clientId: "p" })).toMatchObject({
			status: "refused",
			reason: "unknown_request",
		});
		for (const id of ["req-2", "req-3"]) {
			expect(registry.settle(SESSION_ID, id, "allow", { surface: "attach", clientId: "p" }), id).toMatchObject({
				status: "already_resolved",
			});
		}

		expect(DEFAULT_MAX_TOMBSTONES).toBe(128);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// withdraw / cancelAll
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionRegistry.withdraw — the one that ends it gets the entry, everyone else silence", () => {
	it("hands the entry back once and then returns undefined", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		registry.insert(insertOf("req-1"));

		expect(registry.withdraw("req-1", { surface: "tui", clientId: null }, "denied")?.requestId).toBe("req-1");
		// The decorator withdraws EVERY ask it settles, including ones a remote answer already
		// settled here. This silence is what stops a second broadcast and a second audit row.
		expect(registry.withdraw("req-1", { surface: "tui", clientId: null }, "denied")).toBeUndefined();
		expect(registry.withdraw("never-existed", { surface: "tui", clientId: null }, "denied")).toBeUndefined();
	});

	it("frees the byte budget the withdrawn ask was holding", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, maxTotalBytes: 2_000 });
		const bulky = (id: string) => insertOf(id, { frame: frameFor(id, "z".repeat(1_200)) });
		expect(registry.insert(bulky("req-1")).ok).toBe(true);
		expect(registry.insert(bulky("req-2")).ok).toBe(false);

		registry.withdraw("req-1", { surface: "system", clientId: null }, "cancelled");
		expect(registry.insert(bulky("req-2")).ok).toBe(true);
	});
});

describe("PermissionRegistry.cancelAll — a session going away takes its asks with it", () => {
	it("returns every pending ask, attributed to the system, and empties the registry", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		for (const id of ["req-1", "req-2", "req-3"]) registry.insert(insertOf(id));

		const cancelled = registry.cancelAll();
		expect(cancelled.map((entry) => entry.requestId)).toEqual(["req-1", "req-2", "req-3"]);
		expect(registry.pendingCount).toBe(0);

		// Each is remembered as cancelled BY THE SYSTEM — never attributed to a surface that did
		// not act.
		expect(registry.settle(SESSION_ID, "req-2", "allow", { surface: "attach", clientId: "p" })).toMatchObject({
			status: "already_resolved",
			decision: "cancelled",
			decidedBy: { surface: "system", clientId: null },
		});
	});

	it("returns the entries in insertion order, oldest first", () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID });
		for (const id of ["b", "a", "c"]) registry.insert(insertOf(id));
		expect(registry.pending().map((entry) => entry.requestId)).toEqual(["b", "a", "c"]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// the clock — T8-PIN behaviour (1) at the registry level, in milliseconds instead of an hour
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("PermissionRegistry — the fail-closed clock fires, and the expiry is recorded", () => {
	it("expires an unanswered ask, tells the listener, and attributes it to nobody", async () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs: 25 });
		const expired: PermissionEntry[] = [];
		registry.onExpired((entry) => expired.push(entry));
		registry.insert(insertOf("req-forgotten"));

		await until(() => expired.length === 1, "the ask to expire");
		expect(expired[0]?.requestId).toBe("req-forgotten");

		// The entry is ALREADY removed when the listener runs, so a late answer sees a tombstone
		// rather than a still-answerable ask.
		expect(registry.pendingCount).toBe(0);
		expect(registry.settle(SESSION_ID, "req-forgotten", "allow", { surface: "attach", clientId: "p" })).toMatchObject(
			{
				status: "already_resolved",
				decision: "expired",
				decidedBy: { surface: "system", clientId: null },
			},
		);
	});

	it("disarms the timer when the ask is answered first", async () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs: 20 });
		const expired: PermissionEntry[] = [];
		registry.onExpired((entry) => expired.push(entry));
		registry.insert(insertOf("req-answered"));

		registry.settle(SESSION_ID, "req-answered", "allow", { surface: "attach", clientId: "phone" });
		await new Promise((resolve) => setTimeout(resolve, 80));

		// An answered ask that later "expires" would broadcast a second resolution and write a
		// second audit row saying the approved call timed out.
		expect(expired).toEqual([]);
	});

	it("disarms the timer when the ask is withdrawn or cancelled first", async () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs: 20 });
		const expired: PermissionEntry[] = [];
		registry.onExpired((entry) => expired.push(entry));
		registry.insert(insertOf("req-withdrawn"));
		registry.insert(insertOf("req-cancelled"));

		registry.withdraw("req-withdrawn", { surface: "tui", clientId: null }, "approved");
		registry.cancelAll();
		await new Promise((resolve) => setTimeout(resolve, 80));

		expect(expired).toEqual([]);
	});

	it("expires each ask on its own deadline, not on the first one's", async () => {
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs: 30 });
		const expired: string[] = [];
		registry.onExpired((entry) => expired.push(entry.requestId));
		registry.insert(insertOf("req-a"));
		await new Promise((resolve) => setTimeout(resolve, 40));
		registry.insert(insertOf("req-b"));

		await until(() => expired.length === 2, "both asks to expire");
		expect(expired).toEqual(["req-a", "req-b"]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// the ADVISORY deadline on the wire — the earlier of the two clocks that really exist
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("the advertised deadline is the EARLIER of the caller's timeout and the registry's clock", () => {
	/** Raise one ask through the real relay and return the frame that went on the wire. */
	function raiseWith(declaredDeadline: string | null, expiryMs: number): PermissionRequestMessage {
		const requests: PermissionRequestMessage[] = [];
		const registry = new PermissionRegistry({ sessionId: SESSION_ID, expiryMs });
		const delivery = new PermissionDelivery<PermissionEntry>({ pending: () => registry.pending() });
		const server: PermissionSocketServer = {
			permissionCapableClientCount: 1,
			broadcastPermissionRequest(message) {
				requests.push(message);
				return ["phone"];
			},
			sendPermissionRequest() {},
			broadcastPermissionResolved() {},
			sendErrorToClient() {},
		};
		const recorder: PermissionRecorder = { appendPermissionResolution: () => "id" };
		const relay = createSocketPermissionRelay({
			registry,
			delivery,
			server: () => server,
			recorder: () => recorder,
			sessionId: SESSION_ID,
			cwd: "/tmp/project",
			onWarning: () => {},
		});

		void relay.raise({
			requestId: "req-deadline",
			method: "confirm",
			title: "Approve tool call?",
			options: TOOL_VOCABULARY.map((option) => ({ ...option })),
			requestedAt: new Date().toISOString(),
			deadline: declaredDeadline,
		});
		relay.cancelAll();

		const frame = requests[0];
		if (frame === undefined) throw new Error("nothing was broadcast");
		return frame;
	}

	it("shows the caller's timeout when it lands first", () => {
		const declared = new Date(Date.now() + 5_000).toISOString();
		// The registry would not end this ask for an hour; the caller's own timeout ends it in 5s.
		// A countdown drawn to the later instant ticks on past the moment the ask really stopped
		// being answerable.
		expect(raiseWith(declared, 3_600_000).deadline).toBe(declared);
	});

	it("shows the registry's clock when the caller's timeout is later", () => {
		const declared = new Date(Date.now() + 3_600_000).toISOString();
		const shown = raiseWith(declared, 30_000);
		expect(shown.deadline).not.toBe(declared);
		const shownAt = Date.parse(String(shown.deadline));
		expect(shownAt).toBeGreaterThan(Date.now());
		expect(shownAt).toBeLessThanOrEqual(Date.now() + 30_000);
	});

	it("shows the registry's clock when the caller declared none", () => {
		const shown = raiseWith(null, 45_000);
		const shownAt = Date.parse(String(shown.deadline));
		expect(Number.isFinite(shownAt)).toBe(true);
		expect(shownAt - Date.now()).toBeGreaterThan(40_000);
		expect(shownAt - Date.now()).toBeLessThanOrEqual(45_000);
	});

	it("falls back to the registry's clock when the caller's timeout is unparseable", () => {
		// A `NaN` deadline on the wire is a countdown a renderer cannot draw at all.
		const shown = raiseWith("not a date", 20_000);
		expect(Number.isFinite(Date.parse(String(shown.deadline)))).toBe(true);
		expect(Date.parse(String(shown.deadline)) - Date.now()).toBeLessThanOrEqual(20_000);
	});
});
