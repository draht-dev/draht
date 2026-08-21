/**
 * R34-PERM.2 — honest surface arbitration.
 *
 * The relay decorator must never make `runner.hasUI()` lie. If it did, the loud fail-closed block
 * in the permission gate ("no UI available to request approval") would silently become the wrapped
 * no-op's instant `false`, which the gate reports as "User denied approval" — a fabricated user
 * action in the transcript.
 *
 * It must also never lose a race. The winner resolves the outer promise BEFORE the losing surface
 * is aborted, because interactive mode honours an abort by resolving its confirm to `false`.
 */

import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "../src/core/extensions/index.ts";
import type { PermissionAskDetail } from "../src/core/extensions/types.ts";
import type { PermissionRelay, RelayAnswer, RelayAsk, RelayDecider } from "../src/core/permission-relay/index.ts";
import { createRelayUIContext, noOpRelayBaseUIContext } from "../src/core/permission-relay/index.ts";
import { theme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const REMOTE_DECIDER: RelayDecider = { surface: "attach", clientId: "phone-1" };
const SYSTEM_DECIDER: RelayDecider = { surface: "system", clientId: null };
const LOCAL_DECIDER: RelayDecider = { surface: "tui", clientId: null };

/**
 * A tool-permission detail carrying the vocabulary T5 supplies.
 *
 * Every option states its own `decision`: the type makes a permission vocabulary that does not say
 * which of its options are denials unrepresentable.
 */
function permissionDetail(options: PermissionAskDetail["options"]): PermissionAskDetail {
	return {
		kind: "tool_permission",
		toolCallId: "call-1",
		toolName: "bash",
		cwd: "/tmp/project",
		command: "rm -rf build",
		reason: "destructive command",
		options,
	};
}

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

interface FakeRelay extends PermissionRelay {
	/** Shared ordering log, so relay and base events interleave in one observable sequence. */
	events: string[];
	asks: RelayAsk[];
	withdrawals: { requestId: string; decidedBy: RelayDecider }[];
	/** Resolve the pending `raise()` with an answer, or with `undefined` for "no answer". */
	answer(answer: RelayAnswer | undefined): void;
	/** Reject the pending `raise()` — the losing-side rejection case. */
	fail(error: unknown): void;
	setClientCount(count: number): void;
}

function createFakeRelay(
	options: {
		clients?: number;
		events?: string[];
		/** Throw synchronously from `withdraw`. */
		withdrawThrows?: boolean;
		/** Reject ASYNCHRONOUSLY from `withdraw` — the shape a socket-writing registry has. */
		withdrawRejects?: boolean;
	} = {},
): FakeRelay {
	const events = options.events ?? [];
	let clients = options.clients ?? 1;
	let resolveRaise: ((answer: RelayAnswer | undefined) => void) | undefined;
	let rejectRaise: ((error: unknown) => void) | undefined;
	const asks: RelayAsk[] = [];
	const withdrawals: { requestId: string; decidedBy: RelayDecider }[] = [];

	return {
		events,
		asks,
		withdrawals,
		readWriteClientCount: () => clients,
		raise(ask) {
			events.push("relay-raise");
			asks.push(ask);
			return new Promise<RelayAnswer | undefined>((resolve, reject) => {
				resolveRaise = resolve;
				rejectRaise = reject;
			});
		},
		withdraw(requestId, decidedBy) {
			events.push("relay-withdraw");
			withdrawals.push({ requestId, decidedBy });
			if (options.withdrawThrows === true) {
				throw new Error("relay socket closed");
			}
			if (options.withdrawRejects === true) {
				// `withdraw` is declared `void`, so an `async` implementation is perfectly legal — and
				// is what writing to a socket produces. Its rejection must not escape either.
				return Promise.reject(new Error("relay socket closed asynchronously"));
			}
		},
		answer(answer) {
			resolveRaise?.(answer);
		},
		fail(error) {
			rejectRaise?.(error);
		},
		setClientCount(count) {
			clients = count;
		},
	};
}

interface BaseSpy {
	context: ExtensionUIContext;
	events: string[];
	lastConfirmOptions: () => ExtensionUIDialogOptions | undefined;
	resolveConfirm(value: boolean): void;
	resolveSelect(value: string | undefined): void;
	resolveInput(value: string | undefined): void;
	rejectConfirm(error: unknown): void;
	getEditorText: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	themeReads: () => number;
}

/**
 * A base context whose `confirm` stays pending until the test settles it.
 *
 * `onAbort: "resolve-false"` mimics interactive mode, which maps an aborted selector to `false`.
 * `onAbort: "ignore"` leaves the dialog pending so a test can deliver a LATE answer by hand.
 */
function createBaseSpy(options: { onAbort?: "resolve-false" | "ignore"; events?: string[] } = {}): BaseSpy {
	const events = options.events ?? [];
	const onAbort = options.onAbort ?? "resolve-false";
	let settleConfirm: ((value: boolean) => void) | undefined;
	let settleSelect: ((value: string | undefined) => void) | undefined;
	let settleInput: ((value: string | undefined) => void) | undefined;
	let failConfirm: ((error: unknown) => void) | undefined;
	let confirmOptions: ExtensionUIDialogOptions | undefined;
	let themeReads = 0;

	const getEditorText = vi.fn(() => "base editor text");
	const setWidget = vi.fn();

	const context: ExtensionUIContext = {
		select: (_title: string, _options: string[], opts?: ExtensionUIDialogOptions) => {
			events.push("base-select");
			return new Promise<string | undefined>((resolve) => {
				settleSelect = resolve;
				opts?.signal?.addEventListener("abort", () => {
					events.push("base-abort");
					if (onAbort === "resolve-false") {
						resolve(undefined);
					}
				});
			});
		},
		confirm: (_title: string, _message: string, opts?: ExtensionUIDialogOptions) => {
			events.push("base-confirm");
			confirmOptions = opts;
			return new Promise<boolean>((resolve, reject) => {
				settleConfirm = resolve;
				failConfirm = reject;
				opts?.signal?.addEventListener("abort", () => {
					events.push("base-abort");
					if (onAbort === "resolve-false") {
						resolve(false);
					}
				});
			});
		},
		// Pending like the other two: an instantly-resolving local arm would win every race and
		// hide whatever the remote answered.
		input: (_title: string, _placeholder?: string, opts?: ExtensionUIDialogOptions) => {
			events.push("base-input");
			return new Promise<string | undefined>((resolve) => {
				settleInput = resolve;
				opts?.signal?.addEventListener("abort", () => {
					events.push("base-abort");
					if (onAbort === "resolve-false") {
						resolve(undefined);
					}
				});
			});
		},
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget,
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText,
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			themeReads++;
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	return {
		context,
		events,
		lastConfirmOptions: () => confirmOptions,
		resolveConfirm: (value) => settleConfirm?.(value),
		resolveSelect: (value) => settleSelect?.(value),
		resolveInput: (value) => settleInput?.(value),
		rejectConfirm: (error) => failConfirm?.(error),
		getEditorText,
		setWidget,
		themeReads: () => themeReads,
	};
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Observe whether a promise has settled, without awaiting one that legitimately never does. */
function watch<T>(promise: Promise<T>): () => boolean {
	let done = false;
	const mark = (): void => {
		done = true;
	};
	promise.then(mark, mark);
	return () => done;
}

// ---------------------------------------------------------------------------------------------

describe("RelayUIContext surface arbitration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	describe("hasUI() honesty", () => {
		it("stays false for an attachable session with a relay but zero clients", async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			const runner = harness.session.extensionRunner;

			expect(runner.hasUI()).toBe(false);

			harness.session.setPermissionRelay(createFakeRelay({ clients: 0 }));

			// The decorator really is installed (so this is not a false negative from a missing wrap)...
			expect(typeof runner.getUIContext().hasAnswerSurface).toBe("function");
			// ...and it still reports no answer surface, so the gate keeps its loud fail-closed block
			// instead of fabricating "User denied approval".
			expect(runner.hasUI()).toBe(false);
		});

		it("follows the client count live on one and the same context object", async () => {
			const harness = await createHarness();
			harnesses.push(harness);
			const runner = harness.session.extensionRunner;
			const relay = createFakeRelay({ clients: 0 });

			harness.session.setPermissionRelay(relay);
			const installed = runner.getUIContext();

			expect(runner.hasUI()).toBe(false);

			relay.setClientCount(1);
			expect(runner.hasUI()).toBe(true);
			expect(runner.getUIContext()).toBe(installed);

			relay.setClientCount(0);
			expect(runner.hasUI()).toBe(false);
			expect(runner.getUIContext()).toBe(installed);
		});

		it("reports an answer surface whenever the mode bound a live context", () => {
			const base = createBaseSpy();
			const relay = createFakeRelay({ clients: 0 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			expect(wrapped.hasAnswerSurface?.()).toBe(true);
		});
	});

	describe("racing contract", () => {
		it("returns the remote answer and ignores a late local resolution", async () => {
			const events: string[] = [];
			const base = createBaseSpy({ onAbort: "ignore", events });
			const relay = createFakeRelay({ clients: 1, events });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build");
			await tick();

			expect(relay.asks).toHaveLength(1);
			const ask = relay.asks[0];
			expect(ask.method).toBe("confirm");
			expect(ask.options.map((option) => option.id)).toEqual(["approve", "deny"]);

			relay.answer({ requestId: ask.requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);

			// The losing surface was told to go away...
			expect(events).toContain("base-abort");
			// ...and its LATE answer cannot overwrite the winner.
			base.resolveConfirm(false);
			await tick();
			await expect(pending).resolves.toBe(true);
		});

		it("resolves before aborting, so an abort-induced local deny cannot win", async () => {
			const events: string[] = [];
			// This base mimics interactive mode: an abort resolves the confirm to `false`.
			const base = createBaseSpy({ onAbort: "resolve-false", events });
			const relay = createFakeRelay({ clients: 1, events });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build");
			await tick();
			const ask = relay.asks[0];
			relay.answer({ requestId: ask.requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });

			// Had the abort run before the settle, this would be `false`.
			await expect(pending).resolves.toBe(true);

			// settle -> resolve -> abort the losing surface -> withdraw, in that order.
			expect(events).toEqual(["base-confirm", "relay-raise", "base-abort", "relay-withdraw"]);
			expect(relay.withdrawals).toEqual([{ requestId: ask.requestId, decidedBy: REMOTE_DECIDER }]);
		});

		it("withdraws exactly once with the local decider when the local surface wins", async () => {
			const events: string[] = [];
			const base = createBaseSpy({ events });
			const relay = createFakeRelay({ clients: 1, events });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.confirm("Approve tool call?", "bash: ls");
			await tick();

			base.resolveConfirm(true);
			await expect(pending).resolves.toBe(true);

			expect(relay.withdrawals).toEqual([
				{ requestId: relay.asks[0].requestId, decidedBy: { surface: "tui", clientId: null } },
			]);

			// A late remote answer changes nothing and withdraws nothing further.
			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await tick();
			expect(relay.withdrawals).toHaveLength(1);
			await expect(pending).resolves.toBe(true);
		});

		it("asks nobody when there is no live base and no client", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 0 });
			const wrapped = createRelayUIContext(base.context, relay, false);

			const pending = wrapped.confirm("Approve tool call?", "bash: ls");
			await tick();

			expect(relay.asks).toHaveLength(0);
			// The base was still consulted, so the caller's own fail-closed branch fires unchanged.
			expect(base.events).toEqual(["base-confirm"]);
			// It was handed the caller's options verbatim — no relay AbortSignal was substituted.
			expect(base.lastConfirmOptions()).toBeUndefined();

			base.resolveConfirm(false);
			await expect(pending).resolves.toBe(false);
		});

		it("swallows a late rejection from the losing surface", async () => {
			const rejections: unknown[] = [];
			const guard = (reason: unknown): void => {
				rejections.push(reason);
			};
			process.on("unhandledRejection", guard);
			try {
				const base = createBaseSpy({ onAbort: "ignore" });
				const relay = createFakeRelay({ clients: 1 });
				const wrapped = createRelayUIContext(base.context, relay, true);

				const pending = wrapped.confirm("Approve tool call?", "bash: ls");
				await tick();
				relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
				await expect(pending).resolves.toBe(true);

				// The losing surface blows up after the ask is already settled.
				base.rejectConfirm(new Error("selector torn down"));
				await tick();
				await tick();

				expect(rejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", guard);
			}
		});

		it("swallows a late rejection from the relay", async () => {
			const rejections: unknown[] = [];
			const guard = (reason: unknown): void => {
				rejections.push(reason);
			};
			process.on("unhandledRejection", guard);
			try {
				const base = createBaseSpy();
				const relay = createFakeRelay({ clients: 1 });
				const wrapped = createRelayUIContext(base.context, relay, true);

				const pending = wrapped.confirm("Approve tool call?", "bash: ls");
				await tick();
				base.resolveConfirm(true);
				await expect(pending).resolves.toBe(true);

				relay.fail(new Error("socket closed"));
				await tick();
				await tick();

				expect(rejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", guard);
			}
		});
	});

	describe("a base that is not live never decides", () => {
		it("waits for the remote instead of letting the no-op base's instant false win", async () => {
			const events: string[] = [];
			// Exactly the shape print/json, SDK and draht-acp sessions get: no mode context at all.
			const relay = createFakeRelay({ clients: 1, events });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build");
			const isSettled = watch(pending);

			// Two macrotasks — far more than the microtask `async () => false` needs to resolve.
			await tick();
			await tick();

			expect(relay.asks).toHaveLength(1);
			// Nothing may be withdrawn before the human on the phone has had a chance to answer.
			expect(events).toEqual(["relay-raise"]);
			expect(relay.withdrawals).toEqual([]);
			expect(isSettled()).toBe(false);

			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);
			expect(relay.withdrawals).toEqual([{ requestId: relay.asks[0].requestId, decidedBy: REMOTE_DECIDER }]);
		});

		it("falls back to the fail-closed default, attributed to nobody, when the relay gives up", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build");
			await tick();

			// Withdrawn, expired, or every client detached: no answer at all.
			relay.answer(undefined);

			await expect(pending).resolves.toBe(false);
			// The denial is the decorator's own fail-closed default — NOT a fabricated TUI decision.
			expect(relay.withdrawals).toEqual([{ requestId: relay.asks[0].requestId, decidedBy: SYSTEM_DECIDER }]);
		});
	});

	describe("the type system, not a runtime check, forbids a meaningless vocabulary", () => {
		it("cannot express a permission option that does not say what it means", () => {
			// A COMPILE-level assertion: `@ts-expect-error` is itself an error when the line compiles
			// cleanly, so this fails the typecheck the moment `decision` stops being required. A
			// vocabulary that does not say which of its options are denials is not a permission
			// vocabulary, and no positional rule is left anywhere to guess for it.
			const undeclared: PermissionAskDetail["options"] = [
				// @ts-expect-error - `decision` is required: an option must state its own semantics.
				{ id: "allow", label: "Allow" },
				// @ts-expect-error - and "maybe" is not a decision a permission ask can carry.
				{ id: "maybe", label: "Maybe", decision: "maybe" },
			];

			expect(undeclared).toHaveLength(2);
		});
	});

	describe("answers are interpreted against the offered set", () => {
		it("mints a select's offered set from the CALLER's options, never from detail.options", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			// Probe 2f, ported: a same-length detail array in a DIFFERENT order from the labels. The
			// old positional/label matching answered "deny" with the caller-side string "Allow".
			const labels = ["Allow", "Deny"];
			const pending = wrapped.select("Approve tool call?", labels, {
				detail: permissionDetail([
					{ id: "deny", label: "Deny", decision: "deny" },
					{ id: "allow", label: "Allow", decision: "approve" },
				]),
			});
			await tick();

			const ask = relay.asks[0];
			// The offered set is the caller's own list, in the caller's own order...
			expect(ask.options.map((option) => option.label)).toEqual(["Allow", "Deny"]);
			// ...and detail.options contributed nothing answerable, though it still travels for
			// rendering.
			expect(ask.options.map((option) => option.id)).not.toContain("deny");
			expect(ask.detail?.options.map((option) => option.id)).toEqual(["deny", "allow"]);

			// Each offered option resolves to the very label it was minted from.
			const denyOption = ask.options.find((option) => option.label === "Deny");
			expect(denyOption).toBeDefined();
			relay.answer({ requestId: ask.requestId, optionId: String(denyOption?.id), decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe("Deny");
		});

		it("keeps two identical select labels two distinct answers", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.select("Pick a branch", ["main", "main"]);
			await tick();

			const ask = relay.asks[0];
			// Two options, two distinct ids — an id-keyed offered set must not collapse them.
			expect(ask.options).toHaveLength(2);
			expect(new Set(ask.options.map((option) => option.id)).size).toBe(2);

			relay.answer({ requestId: ask.requestId, optionId: ask.options[1].id, decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe("main");
		});

		it("reads a confirm answer off the option's declared decision, not its position", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.confirm("Approve tool call?", "bash: ls", {
				detail: permissionDetail([
					{ id: "grant", label: "Grant", decision: "approve" },
					{ id: "refuse", label: "Refuse", decision: "deny" },
				]),
			});
			await tick();

			const ask = relay.asks[0];
			expect(ask.options.map((option) => option.id)).toEqual(["grant", "refuse"]);
			// A remote APPROVAL must not silently become a denial just because the id is not "approve".
			relay.answer({ requestId: ask.requestId, optionId: "grant", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);
		});

		it("keeps a denial a denial when it is neither first nor last (probe 2d)", async () => {
			const vocabulary = [
				{ id: "allow", label: "Allow", decision: "approve" },
				{ id: "deny-once", label: "Deny once", decision: "deny" },
				{ id: "deny-always", label: "Deny always", decision: "deny" },
			] as const;

			// A denial in the MIDDLE — the case a "the last option is the negative" rule inverts,
			// turning a human's denial into a caller-side approval and running the destructive call.
			for (const [optionId, expected] of [
				["allow", true],
				["deny-once", false],
				["deny-always", false],
			] as const) {
				const base = createBaseSpy({ onAbort: "ignore" });
				const relay = createFakeRelay({ clients: 1 });
				const wrapped = createRelayUIContext(base.context, relay, true);

				const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
					detail: permissionDetail([...vocabulary]),
				});
				await tick();

				relay.answer({ requestId: relay.asks[0].requestId, optionId, decidedBy: REMOTE_DECIDER });
				await expect(pending).resolves.toBe(expected);
			}
		});

		it("answers a single-option confirm vocabulary with what that option declares (probe 2e)", async () => {
			for (const [option, expected] of [
				[{ id: "approve", label: "Yes", decision: "approve" }, true],
				[{ id: "deny", label: "No", decision: "deny" }, false],
			] as const) {
				const base = createBaseSpy({ onAbort: "ignore" });
				const relay = createFakeRelay({ clients: 1 });
				const wrapped = createRelayUIContext(base.context, relay, true);

				const pending = wrapped.confirm("Approve tool call?", "bash: ls", {
					detail: permissionDetail([option]),
				});
				await tick();

				const ask = relay.asks[0];
				expect(ask.options).toHaveLength(1);
				// The ONLY option offered. A length-based rule made answering it mean the opposite.
				relay.answer({ requestId: ask.requestId, optionId: option.id, decidedBy: REMOTE_DECIDER });
				await expect(pending).resolves.toBe(expected);
			}
		});

		it("makes every broadcast option answerable, on every method (probe 6)", async () => {
			// Probe 6 found a dialog whose options all carried `resolution: undefined`: fully tappable
			// on the phone, every answer discarded as silence. An offered option now cannot be
			// constructed without its caller-side value, so this walks each broadcast option and
			// asserts it really does resolve the caller.
			const cases: {
				name: string;
				/** Free-text asks offer no answerable option at all — see the `input` suite below. */
				offersNothing?: boolean;
				run: (ui: ExtensionUIContext) => Promise<unknown>;
			}[] = [
				{
					name: "confirm (default vocabulary)",
					run: (ui: ExtensionUIContext) => ui.confirm("Approve?", "bash: ls"),
				},
				{
					name: "confirm (caller vocabulary)",
					run: (ui: ExtensionUIContext) =>
						ui.confirm("Approve?", "bash: ls", {
							detail: permissionDetail([
								{ id: "allow", label: "Allow", decision: "approve" },
								{ id: "deny-once", label: "Deny once", decision: "deny" },
								{ id: "deny-always", label: "Deny always", decision: "deny" },
							]),
						}),
				},
				{
					name: "select",
					run: (ui: ExtensionUIContext) => ui.select("Pick", ["One", "Two", "Three"]),
				},
				{
					name: "input",
					offersNothing: true,
					run: (ui: ExtensionUIContext) =>
						ui.input("Name?", "placeholder", {
							detail: permissionDetail([
								{ id: "suggest-a", label: "Suggestion A", decision: "approve" },
								{ id: "suggest-b", label: "Suggestion B", decision: "deny" },
							]),
						}),
				},
			];

			for (const testCase of cases) {
				// Discover the broadcast set once...
				const probeBase = createBaseSpy({ onAbort: "ignore" });
				const probeRelay = createFakeRelay({ clients: 1 });
				const probeUi = createRelayUIContext(probeBase.context, probeRelay, true);
				void testCase.run(probeUi);
				await tick();
				const broadcast = probeRelay.asks[0].options;
				if (testCase.offersNothing === true) {
					// Vacuously answerable: a free-text ask broadcasts NO option, so there is no id
					// namespace for typed text to collide with.
					expect(broadcast).toEqual([]);
					continue;
				}
				expect(broadcast.length).toBeGreaterThan(0);

				// ...then answer EVERY option of it in a fresh ask and require a real settlement.
				for (const option of broadcast) {
					const base = createBaseSpy({ onAbort: "ignore" });
					const relay = createFakeRelay({ clients: 1 });
					const ui = createRelayUIContext(base.context, relay, true);
					const pending = testCase.run(ui);
					const isSettled = watch(pending);
					await tick();

					relay.answer({ requestId: relay.asks[0].requestId, optionId: option.id, decidedBy: REMOTE_DECIDER });
					await tick();
					await tick();

					expect(isSettled(), `${testCase.name}: option "${option.id}" was discarded as silence`).toBe(true);
					// A real answer is a real decision: it is withdrawn under the REMOTE decider.
					expect(relay.withdrawals).toEqual([{ requestId: relay.asks[0].requestId, decidedBy: REMOTE_DECIDER }]);
				}
			}
		});

		it("treats an id outside the offered set as silence, never as a dismissal", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build");
			const isSettled = watch(pending);
			await tick();

			// Nobody offered this id, so nobody chose it: it is not an answer.
			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve-always", decidedBy: REMOTE_DECIDER });
			await tick();
			await tick();

			expect(isSettled()).toBe(false);
			expect(relay.withdrawals).toEqual([]);

			// The local surface is still up and still decides.
			base.resolveConfirm(true);
			await expect(pending).resolves.toBe(true);
			expect(relay.withdrawals).toEqual([
				{ requestId: relay.asks[0].requestId, decidedBy: { surface: "tui", clientId: null } },
			]);
		});
	});

	describe("an invalid vocabulary fails closed instead of being replaced by a fabricated one", () => {
		/**
		 * Three shapes a caller can hand us that are NOT a usable permission vocabulary.
		 *
		 * Each one used to produce an approval the caller never authorised, or a value outside the
		 * declared return type. They share one root cause — the vocabulary was never validated — so
		 * they share one gate, and this table is what proves the gate covers all three.
		 */
		const invalid: { name: string; options: PermissionAskDetail["options"]; answerId: string }[] = [
			// A policy layer filtered its vocabulary down to nothing. Substituting the DEFAULT pair
			// broadcasts a "Yes" nobody authorised; tapping it runs the gated tool call.
			{ name: "an empty vocabulary", options: [], answerId: "approve" },
			// Last-wins Map insertion let ARRAY POSITION pick which of two same-id options survived,
			// while detail.options — the documented rendering carrier — still showed both. A client
			// rendered a tappable "Deny"; tapping it echoed id "x" and resolved the caller `true`.
			{
				name: "two options sharing one id",
				options: [
					{ id: "x", label: "Deny", decision: "deny" },
					{ id: "x", label: "Allow", decision: "approve" },
				],
				answerId: "x",
			},
			// Total over the TYPE, not over runtime values: a detail that crossed a wire or came from
			// a JS extension carried `decision: "maybe"`, and answering it resolved a
			// `Promise<boolean>` with `undefined`.
			{
				name: "a decision that is not a decision at runtime",
				options: [{ id: "maybe", label: "Maybe", decision: "maybe" }] as unknown as PermissionAskDetail["options"],
				answerId: "maybe",
			},
		];

		for (const testCase of invalid) {
			it(`offers nothing remotely and fails closed for ${testCase.name}`, async () => {
				const relay = createFakeRelay({ clients: 1 });
				const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

				const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
					detail: permissionDetail(testCase.options),
				});
				await tick();

				const ask = relay.asks[0];
				// Nothing answerable was offered — the caller's vocabulary was not replaced by ours.
				expect(ask.options).toEqual([]);
				// The detail still travels for rendering; it just never becomes an offered set.
				expect(ask.detail?.options).toHaveLength(testCase.options.length);

				// An id from the rejected vocabulary is not an answer: it is silence.
				relay.answer({ requestId: ask.requestId, optionId: testCase.answerId, decidedBy: REMOTE_DECIDER });

				const value = await pending;
				// A real boolean, never `undefined` leaking out of a `Promise<boolean>`...
				expect(typeof value).toBe("boolean");
				// ...and it is the method's fail-closed default, attributed to nobody.
				expect(value).toBe(false);
				expect(relay.withdrawals).toEqual([{ requestId: ask.requestId, decidedBy: SYSTEM_DECIDER }]);
			});
		}

		it("falls through to the live local surface rather than denying on its own", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.confirm("Approve tool call?", "bash: ls", {
				detail: permissionDetail([]),
			});
			const isSettled = watch(pending);
			await tick();

			expect(relay.asks[0].options).toEqual([]);
			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await tick();
			await tick();

			// The remote could not answer, so nothing was decided remotely...
			expect(isSettled()).toBe(false);
			// ...and the human at the terminal still decides.
			base.resolveConfirm(true);
			await expect(pending).resolves.toBe(true);
			expect(relay.withdrawals).toEqual([{ requestId: relay.asks[0].requestId, decidedBy: LOCAL_DECIDER }]);
		});

		it("still mints the default pair when the caller supplied no vocabulary at all", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			// Absent is not invalid: the existing, correct behaviour must survive the new gate.
			const pending = wrapped.confirm("Approve tool call?", "bash: ls");
			await tick();

			expect(relay.asks[0].options.map((option) => option.id)).toEqual(["approve", "deny"]);
			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);
		});
	});

	describe("a permission ask never throws out of the caller's call", () => {
		for (const [name, timeout] of [
			// `Number(process.env.DRAHT_PERMISSION_TIMEOUT_MS)` with the var unset.
			["NaN", Number.NaN],
			// The idiomatic "never expire".
			["Infinity", Number.POSITIVE_INFINITY],
			["-Infinity", Number.NEGATIVE_INFINITY],
		] as const) {
			it(`denies rather than throwing a RangeError for a ${name} timeout`, async () => {
				const relay = createFakeRelay({ clients: 1 });
				const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

				// A synchronous throw here never reaches the relay and never fails closed: the
				// permission gate reports it as a TOOL ERROR, not as a denial.
				let pending: Promise<boolean> | undefined;
				expect(() => {
					pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", { timeout });
				}).not.toThrow();
				await tick();

				expect(relay.asks).toHaveLength(1);
				// A non-finite instant is not a deadline; the advisory field says so honestly.
				expect(relay.asks[0].deadline).toBeNull();

				relay.answer(undefined);
				await expect(pending).resolves.toBe(false);
			});
		}

		it("still advertises a deadline for a real, finite timeout", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const before = Date.now();
			const pending = wrapped.confirm("Approve tool call?", "bash: ls", { timeout: 60_000 });
			await tick();

			const deadline = relay.asks[0].deadline;
			expect(typeof deadline).toBe("string");
			expect(Date.parse(String(deadline))).toBeGreaterThanOrEqual(before + 60_000);

			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);
		});
	});

	describe("a free-text ask has no id namespace to collide with", () => {
		it("returns the text a human TYPED even when it equals a suggestion's id", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.input("Name?", "placeholder", {
				detail: permissionDetail([{ id: "allow-once", label: "Allow once", decision: "approve" }]),
			});
			await tick();

			const ask = relay.asks[0];
			// `input` mints NO offered set from detail.options — exactly what `select` already does.
			expect(ask.options).toEqual([]);
			// The detail still travels for rendering.
			expect(ask.detail?.options.map((option) => option.id)).toEqual(["allow-once"]);

			// A human typed the literal string "allow-once". Identity matching handed back the LABEL.
			relay.answer({ requestId: ask.requestId, optionId: "allow-once", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe("allow-once");
		});
	});

	describe("the wire carries the decision the decorator already knows", () => {
		it("puts `decision` on every confirm option and on no select option", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			// A client rendering a destructive deny button must not have to join two arrays by id —
			// and for `select` the two arrays share no ids at all, so the join is impossible.
			void wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
				detail: permissionDetail([
					{ id: "allow", label: "Allow", decision: "approve" },
					{ id: "deny-once", label: "Deny once", decision: "deny" },
					{ id: "deny-always", label: "Deny always", decision: "deny" },
				]),
			});
			await tick();

			expect(relay.asks[0].options).toEqual([
				{ id: "allow", label: "Allow", decision: "approve" },
				{ id: "deny-once", label: "Deny once", decision: "deny" },
				{ id: "deny-always", label: "Deny always", decision: "deny" },
			]);

			const bareBase = createBaseSpy({ onAbort: "ignore" });
			const bareRelay = createFakeRelay({ clients: 1 });
			const bare = createRelayUIContext(bareBase.context, bareRelay, true);
			void bare.confirm("Approve tool call?", "bash: ls");
			await tick();

			// The default pair states its own semantics too.
			expect(bareRelay.asks[0].options.map((option) => option.decision)).toEqual(["approve", "deny"]);

			const selectBase = createBaseSpy({ onAbort: "ignore" });
			const selectRelay = createFakeRelay({ clients: 1 });
			const selectUi = createRelayUIContext(selectBase.context, selectRelay, true);
			void selectUi.select("Pick", ["Allow", "Deny"], {
				detail: permissionDetail([
					{ id: "deny", label: "Deny", decision: "deny" },
					{ id: "allow", label: "Allow", decision: "approve" },
				]),
			});
			await tick();

			// `select` has no permission semantics, and must not borrow detail.options' — that is the
			// very inference that once resolved an answered "Deny" to the caller-side string "Allow".
			for (const option of selectRelay.asks[0].options) {
				expect(option.decision).toBeUndefined();
			}
		});
	});

	describe("teardown is throw-free and leaves nothing behind", () => {
		it("resolves the caller even when the relay throws on withdraw", async () => {
			const rejections: unknown[] = [];
			const guard = (reason: unknown): void => {
				rejections.push(reason);
			};
			process.on("unhandledRejection", guard);
			try {
				const base = createBaseSpy({ onAbort: "ignore" });
				const relay = createFakeRelay({ clients: 1, withdrawThrows: true });
				const wrapped = createRelayUIContext(base.context, relay, true);

				const pending = wrapped.confirm("Approve tool call?", "bash: ls");
				await tick();
				relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });

				await expect(pending).resolves.toBe(true);
				await tick();
				await tick();

				// `settle` runs inside a discarded `.then`: a throw there is an unhandled rejection.
				expect(rejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", guard);
			}
		});

		it("resolves the caller when an ASYNC withdraw rejects (probe 7)", async () => {
			const rejections: unknown[] = [];
			const guard = (reason: unknown): void => {
				rejections.push(reason);
			};
			process.on("unhandledRejection", guard);
			try {
				const base = createBaseSpy({ onAbort: "ignore" });
				// The obvious shape once the registry writes to a socket: `async withdraw()`.
				const relay = createFakeRelay({ clients: 1, withdrawRejects: true });
				const wrapped = createRelayUIContext(base.context, relay, true);

				const pending = wrapped.confirm("Approve tool call?", "bash: ls");
				await tick();
				relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });

				await expect(pending).resolves.toBe(true);
				await tick();
				await tick();

				// A try/catch around the teardown step only catches SYNCHRONOUS throws; this rejection
				// escapes it and is fatal under --unhandled-rejections=throw.
				expect(rejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", guard);
			}
		});

		it("removes its abort listener from a caller-owned signal that outlives the ask", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);
			// One long-lived signal, many asks — a subagent run reuses its abort signal like this.
			const caller = new AbortController();

			for (let index = 0; index < 5; index++) {
				const pending = wrapped.confirm("Approve tool call?", `bash: ls ${index}`, { signal: caller.signal });
				await tick();
				relay.answer({ requestId: relay.asks[index].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
				await expect(pending).resolves.toBe(true);
			}

			expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
		});
	});

	describe("the caller's declared timeout is a real bound when nothing else is", () => {
		it("settles on the method's fail-closed default, attributed to nobody, when it expires", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			// No live base: this decorator holds the only arm. Without honouring `timeout`, a relay
			// that never resolves leaves the caller waiting forever, where the same session with no
			// relay installed would have failed closed instantly.
			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", { timeout: 20 });

			await expect(pending).resolves.toBe(false);
			expect(relay.withdrawals).toEqual([{ requestId: relay.asks[0].requestId, decidedBy: SYSTEM_DECIDER }]);
		});

		it("uses each method's own fail-closed default on expiry", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			await expect(wrapped.select("Pick", ["One", "Two"], { timeout: 20 })).resolves.toBeUndefined();
			expect(relay.withdrawals).toEqual([{ requestId: relay.asks[0].requestId, decidedBy: SYSTEM_DECIDER }]);
		});

		it("adds NO clock of its own when the caller declared none", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build");
			const isSettled = watch(pending);
			await delay(40);

			// The bound for a timeout-less ask is the pending registry's own fail-closed timer
			// (R34-PERM.6) — one clock, owned there. This decorator must not invent a second default.
			expect(isSettled()).toBe(false);
			expect(relay.withdrawals).toEqual([]);

			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);
		});

		it("leaves the timeout to the live local surface when there is one", async () => {
			const base = createBaseSpy({ onAbort: "ignore" });
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			const pending = wrapped.confirm("Approve tool call?", "bash: ls", { timeout: 10 });
			const isSettled = watch(pending);
			await delay(40);

			// Interactive mode runs the caller's countdown itself; a second clock here would race it.
			expect(isSettled()).toBe(false);
			base.resolveConfirm(true);
			await expect(pending).resolves.toBe(true);
		});

		it("disarms the expiry once the ask is answered", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const pending = wrapped.confirm("Approve tool call?", "bash: ls", { timeout: 20 });
			await tick();
			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);

			await delay(40);
			// The expired clock must not fabricate a second, contradicting resolution or withdrawal.
			await expect(pending).resolves.toBe(true);
			expect(relay.withdrawals).toEqual([{ requestId: relay.asks[0].requestId, decidedBy: REMOTE_DECIDER }]);
		});
	});

	describe("the gate reads each field once and offers its OWN snapshot", () => {
		/**
		 * An option whose `decision` answers one way to the validation read and another to the mint.
		 *
		 * Two reads of memory this file does not own is all a defect needs: while the verdict handed
		 * the caller's array straight back, the gate PROVED one vocabulary and OFFERED a different
		 * one.
		 */
		function flippingDecision(): PermissionAskDetail["options"][number] {
			let reads = 0;
			return {
				id: "x",
				label: "Deny",
				get decision(): "approve" | "deny" {
					reads += 1;
					return reads === 1 ? "deny" : "approve";
				},
			};
		}

		/** An option whose `id` is unique while uniqueness is being proved and shared afterwards. */
		function flippingId(
			proved: string,
			minted: string,
			label: string,
			decision: "approve" | "deny",
		): PermissionAskDetail["options"][number] {
			let reads = 0;
			return {
				get id(): string {
					reads += 1;
					// Two reads inside the uniqueness pass (`has` then `add`), so only the FIRST is the
					// one the proof is allowed to see.
					return reads === 1 ? proved : minted;
				},
				label,
				decision,
			};
		}

		it("cannot be told one decision at validation and another at mint", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
				detail: permissionDetail([flippingDecision()]),
			});
			await tick();

			const ask = relay.asks[0];
			expect(ask.options).toHaveLength(1);
			// The one and only read said "deny", so "deny" is what the wire renders...
			expect(ask.options[0].decision).toBe("deny");

			relay.answer({ requestId: ask.requestId, optionId: ask.options[0].id, decidedBy: REMOTE_DECIDER });
			// ...and "deny" is what the tapped option resolves. Before the snapshot, the wire said
			// "Deny" and the caller got `true`.
			await expect(pending).resolves.toBe(false);
		});

		it("cannot prove uniqueness on one set of ids and mint another", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
				detail: permissionDetail([
					flippingId("deny-1", "same", "Deny", "deny"),
					flippingId("allow-1", "same", "Allow", "approve"),
				]),
			});
			await tick();

			const ask = relay.asks[0];
			// Both options survive, under the very ids their uniqueness was PROVEN on: no last-wins
			// collapse into one option while `detail.options` still renders two.
			expect(ask.options.map((option) => option.id)).toEqual(["deny-1", "allow-1"]);
			expect(ask.options.map((option) => option.label)).toEqual(["Deny", "Allow"]);

			relay.answer({ requestId: ask.requestId, optionId: "deny-1", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(false);
		});

		/**
		 * Shapes the gate's own expressions used to THROW on — the data it exists to police.
		 *
		 * `vocabulary.length` on `null`, `for...of` over an array-like, a property read on a
		 * non-object: each escaped `confirm()` synchronously as a TypeError, so the ask reached
		 * neither surface and the permission gate saw a tool error rather than a denial.
		 */
		const malformed: { name: string; options: unknown }[] = [
			{ name: "null", options: null },
			{ name: "an array-like object", options: { 0: { id: "a", label: "Allow", decision: "approve" }, length: 1 } },
			{ name: "a bare option object", options: { id: "a", label: "Allow", decision: "approve" } },
			{ name: "a number", options: 3 },
			{ name: "a string", options: "approve" },
			{ name: "an array holding null", options: [null] },
			{ name: "an array holding undefined", options: [undefined] },
			{ name: "an array holding a string", options: ["approve"] },
			{ name: "a non-string id", options: [{ id: 1, label: "Deny", decision: "deny" }] },
			{ name: "an empty-string id", options: [{ id: "", label: "Deny", decision: "deny" }] },
			{ name: "a non-string label", options: [{ id: "a", label: 7, decision: "approve" }] },
		];

		for (const testCase of malformed) {
			it(`treats ${testCase.name} as an invalid vocabulary rather than throwing`, async () => {
				const relay = createFakeRelay({ clients: 1 });
				const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

				let pending: Promise<boolean> | undefined;
				expect(() => {
					pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
						detail: permissionDetail(testCase.options as PermissionAskDetail["options"]),
					});
				}).not.toThrow();
				await tick();

				// It reached the relay at all, and offered nothing it could not honour.
				expect(relay.asks).toHaveLength(1);
				expect(relay.asks[0].options).toEqual([]);

				relay.answer(undefined);
				await expect(pending).resolves.toBe(false);
			});
		}

		it("rejects a numeric id whose String() form names its sibling", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			// SameValueZero says `1 !== "1"`, so this passed the uniqueness proof and both options were
			// broadcast. A client honouring its own wire type — `RelayAnswer.optionId` is `string` —
			// then echoed `String(1)`, which named the APPROVAL while the human had tapped "Deny". The
			// type-conforming client was the one that got it wrong.
			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
				detail: permissionDetail([
					{ id: 1, label: "Deny", decision: "deny" },
					{ id: "1", label: "Allow", decision: "approve" },
				] as unknown as PermissionAskDetail["options"]),
			});
			await tick();

			expect(relay.asks[0].options).toEqual([]);
			relay.answer({ requestId: relay.asks[0].requestId, optionId: String(1), decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(false);
		});

		it("ignores a `decision` inherited from Object.prototype", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			// Non-enumerable on purpose: an enumerable prototype property would break `for...in`
			// everywhere in the process, including inside vitest.
			Object.defineProperty(Object.prototype, "decision", {
				value: "approve",
				writable: true,
				configurable: true,
				enumerable: false,
			});
			try {
				const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
					detail: permissionDetail([{ id: "d", label: "Deny" }] as unknown as PermissionAskDetail["options"]),
				});
				await tick();

				// The option declared NOTHING. An inherited word is not a declaration, and this must not
				// be broadcast as an approval whose "Deny" label resolves `true`.
				expect(relay.asks[0].options).toEqual([]);
				relay.answer({ requestId: relay.asks[0].requestId, optionId: "d", decidedBy: REMOTE_DECIDER });
				await expect(pending).resolves.toBe(false);
			} finally {
				Reflect.deleteProperty(Object.prototype, "decision");
			}
		});
	});

	describe("a declared timeout beyond what can be armed is no timeout at all", () => {
		it("does not throw for the idiomatic Number.MAX_SAFE_INTEGER 'never expire'", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			let pending: Promise<boolean> | undefined;
			expect(() => {
				pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
					timeout: Number.MAX_SAFE_INTEGER,
				});
			}).not.toThrow();
			await tick();

			// `new Date(Date.now() + t).toISOString()` threw `RangeError: Invalid time value` here, so
			// the ask reached NEITHER surface and the permission gate got an exception, not a decision.
			expect(relay.asks).toHaveLength(1);
			// An instant that cannot be represented is not a deadline; the advisory field says so.
			expect(relay.asks[0].deadline).toBeNull();

			relay.answer({ requestId: relay.asks[0].requestId, optionId: "deny", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(false);
		});

		it("never fabricates a system denial milliseconds into a 30-day timeout", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			// Above 2^31-1 ms `setTimeout` clamps the delay to 1 and warns. Armed, this advertised a
			// deadline a month out and settled `false` two milliseconds later, attributed to nobody —
			// before the phone could render the ask at all.
			const pending = wrapped.confirm("Approve tool call?", "bash: rm -rf build", {
				timeout: 30 * 24 * 60 * 60 * 1000,
			});
			const isSettled = watch(pending);
			await delay(40);

			expect(isSettled()).toBe(false);
			expect(relay.withdrawals).toEqual([]);
			// No clock was armed, so nothing may be advertised as if one had been.
			expect(relay.asks[0].deadline).toBeNull();

			// The human still decides, whenever they get to it.
			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);
		});

		it("still arms the largest timeout setTimeout will honour", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const before = Date.now();
			// The boundary itself: a real clock, and a representable instant to advertise.
			const pending = wrapped.confirm("Approve tool call?", "bash: ls", { timeout: 2_147_483_647 });
			await tick();

			expect(Date.parse(String(relay.asks[0].deadline))).toBeGreaterThanOrEqual(before + 2_147_483_647);

			relay.answer({ requestId: relay.asks[0].requestId, optionId: "approve", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe(true);
		});
	});

	describe("a sparse option list never crashes the caller", () => {
		// `labels.map` preserves array holes and `new Map` throws on them, so before the fix
		// `ui.select` threw "Iterator value undefined is not an entry object" synchronously out of
		// the caller's own call — including on the no-surface path where the decorator is supposed
		// to be transparent, and where the undecorated base does not throw.
		function sparseLabels(): string[] {
			const items = [
				{ name: "Allow", keep: true },
				{ name: "Maybe", keep: false },
				{ name: "Deny", keep: true },
			];
			// Ordinary TypeScript: an index-filter loop. No casts, no `any`.
			const labels: string[] = [];
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item?.keep) labels[i] = item.name;
			}
			return labels;
		}

		it("offers only the positions that hold a label, keeping their own index", async () => {
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			const labels = sparseLabels();
			expect(Object.keys(labels)).toEqual(["0", "2"]);

			const pending = wrapped.select("Pick one", labels);
			await tick();

			// The hole is not a tappable option, and the survivors keep their original positions —
			// so what is offered is exactly what can be resolved.
			expect(relay.asks[0].options).toEqual([
				{ id: "option-0", label: "Allow" },
				{ id: "option-2", label: "Deny" },
			]);

			relay.answer({ requestId: relay.asks[0].requestId, optionId: "option-2", decidedBy: REMOTE_DECIDER });
			await expect(pending).resolves.toBe("Deny");
		});

		it("does not throw on the no-surface path, where the decorator must be transparent", async () => {
			const relay = createFakeRelay({ clients: 0 });
			const wrapped = createRelayUIContext(noOpRelayBaseUIContext, relay, false);

			// Requirement (f): nobody can answer, so the relay is never raised and the base decides.
			await expect(wrapped.select("Pick one", sparseLabels())).resolves.toBeUndefined();
			expect(relay.asks).toHaveLength(0);
		});
	});

	describe("hand-delegation of the non-decorated members", () => {
		it("forwards synchronous getters, the theme and component factories to the base", () => {
			const base = createBaseSpy();
			const relay = createFakeRelay({ clients: 1 });
			const wrapped = createRelayUIContext(base.context, relay, true);

			expect(wrapped.getEditorText()).toBe("base editor text");
			expect(base.getEditorText).toHaveBeenCalledTimes(1);

			expect(wrapped.theme).toBe(theme);
			expect(base.themeReads()).toBe(1);

			wrapped.setWidget("k", ["one", "two"]);
			expect(base.setWidget).toHaveBeenCalledWith("k", ["one", "two"], undefined);
		});
	});
});
