/**
 * RelayUIContext — the decorator that lets a remote surface answer a local dialog.
 *
 * It wraps EXACTLY `confirm`, `select` and `input`. Every other `ExtensionUIContext` member is
 * hand-delegated verbatim. This is deliberately NOT a Proxy: `getEditorText`, `theme`,
 * `getAllThemes`, `getTheme`, `getToolsExpanded` and `getEditorComponent` are synchronous reads of
 * the base's local state, and `setWidget`/`setFooter`/`setHeader`/`custom` take component
 * factories that cannot be serialized. `editor` and `custom` therefore stay purely local by
 * documented exception.
 *
 * THE INVARIANT THIS FILE EXISTS TO HOLD: an offered option CARRIES the value the caller receives
 * when it comes back. Nothing derives that value later — not from the option's index, not from its
 * position relative to its siblings, not by matching labels across two arrays, not from a magic id.
 * Every past defect here (an approval read as a denial, a denial read as an approval, an answered
 * "Deny" resolved to the string "Allow") was one of those derivations. There is exactly one
 * constructor of an offered option, {@link offer}, and it takes the caller-side value as an
 * argument — so an option with no resolution cannot be built at all.
 *
 * ITS COROLLARY: a caller vocabulary this file cannot honour is REJECTED, never repaired.
 * {@link classifyVocabulary} is the one gate, and it has exactly three outcomes — absent, valid,
 * invalid. Invalid offers nothing remotely at all, so the ask falls to the local surface or to the
 * raising method's own fail-closed default. Quietly substituting our default pair for a caller's
 * rejected one would broadcast an approval that caller never authorised, and a human tapping it
 * would run the gated call.
 */

import { randomUUID } from "node:crypto";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@draht/tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	PermissionAskDetail,
	TerminalInputHandler,
	WorkingIndicatorOptions,
} from "../extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { PermissionRelay, RelayAnswer, RelayAsk, RelayDecider } from "./types.ts";

/** One entry of a permission vocabulary: an id, a label, and the decision it DECLARES. */
type PermissionOption = PermissionAskDetail["options"][number];

/**
 * One option this file has PROVEN valid: its three primitives, copied out and frozen.
 *
 * This is the gate's OWN data. Every field was read exactly once, during validation, and nothing
 * downstream ever touches the caller's array again — so the option that was validated and the
 * option that is offered are the same read BY CONSTRUCTION, and no getter, Proxy or later mutation
 * can separate them. Handing the caller's own array back as the verdict made proof and use two
 * different reads of memory this file does not own: a `decision` getter answering "deny" to the
 * validation read and "approve" to the mint produced a wire option labelled "Deny" that resolved
 * `true`, and an `id` getter unique during the uniqueness pass and shared at mint collapsed two
 * options into one while `detail.options` still rendered both.
 */
interface ValidatedOption {
	readonly id: string;
	readonly label: string;
	readonly decision: PermissionOption["decision"];
}

/**
 * The caller-side meaning of each declared decision.
 *
 * A total map from the vocabulary's own word to the boolean a `confirm` caller receives. It is not
 * a test of an id and not a position rule: the option says what it means, this only translates.
 */
const CONFIRM_RESOLUTION: Readonly<Record<PermissionOption["decision"], boolean>> = Object.freeze({
	approve: true,
	deny: false,
});

/**
 * The frozen two-way vocabulary a bare `confirm` offers when the caller supplied no
 * `detail.options`.
 *
 * These ids are a DEFAULT, never a test: a caller may offer any vocabulary it likes (T5's tool
 * permission ask does), and every vocabulary states its own semantics through `decision`. Nothing
 * in this file compares an answered id against a literal.
 */
export const APPROVE_OPTION_ID = "approve";
export const DENY_OPTION_ID = "deny";
const DEFAULT_CONFIRM_OPTIONS: readonly ValidatedOption[] = Object.freeze([
	Object.freeze({ id: APPROVE_OPTION_ID, label: "Yes", decision: "approve" as const }),
	Object.freeze({ id: DENY_OPTION_ID, label: "No", decision: "deny" as const }),
]);

/** The local surface, whoever it is, decided. */
const LOCAL_DECIDER: RelayDecider = { surface: "tui", clientId: null };
/**
 * Nobody decided: the ask was dismissed from outside via the caller's own AbortSignal, the relay
 * gave up while no local surface existed to fall back to, or the caller's own declared timeout
 * expired with the decorator holding the only arm.
 */
const SYSTEM_DECIDER: RelayDecider = { surface: "system", clientId: null };

/** An option as it travels on the wire. `decision` is rendering data; it interprets nothing. */
type WireOption = RelayAsk["options"][number];

/**
 * One offered option, together with the value the CALLER receives when that option comes back.
 *
 * `resolution` is REQUIRED. An offered option with no caller-side value is unrepresentable, which
 * is what makes "a fully tappable remote dialog whose every answer is discarded as silence"
 * impossible rather than merely unlikely.
 *
 * `declares` is the option's own `decision` word, carried ALONG so a remote client can render a
 * denial as destructive without joining two arrays by id. It is descriptive only: `resolution` was
 * already bound at construction, and nothing ever reads `declares` back to decide anything.
 */
interface OfferedOption<T> {
	readonly id: string;
	readonly label: string;
	readonly resolution: { readonly value: T };
	readonly declares?: PermissionOption["decision"];
}

/**
 * The offered set of one ask, keyed by the id that travels on the wire.
 *
 * Minted ONCE and the single authority for both halves of the round trip: its values are what gets
 * broadcast, and it is the only thing an answer is ever interpreted against. Because the broadcast
 * list is derived from this map, every option a remote surface can see is an option this map can
 * resolve.
 */
type OfferedSet<T> = ReadonlyMap<string, OfferedOption<T>>;

/**
 * The ONE place an offered option is constructed.
 *
 * The caller-side value is an argument, supplied at construction from data the caller actually
 * gave us — the option's own declared decision, or the very string the caller listed. No other
 * function in this file builds an `OfferedOption`, so there is no second path where a resolution
 * could be inferred after the fact.
 *
 * `declares` is optional and purely descriptive: `select` and `input` have no permission semantics
 * to state. Passing it never changes `resolution`.
 */
function offer<T>(id: string, label: string, value: T, declares?: PermissionOption["decision"]): OfferedOption<T> {
	return { id, label, resolution: { value }, declares };
}

/**
 * Index a freshly minted list by id. Ids are wire handles; they are never parsed or ordered.
 *
 * Callers must have proved the ids unique first — `new Map` is last-wins, and letting array
 * position silently pick which of two same-id options survives is precisely the inference this
 * file exists to abolish. {@link classifyVocabulary} is that proof for caller-supplied
 * vocabularies; the other two mints generate their own ids and cannot collide.
 */
function offeredSet<T>(options: readonly OfferedOption<T>[]): OfferedSet<T> {
	// Callers must hand this a DENSE array. `new Map` iterates, so a hole reaches it as `undefined`
	// and throws. Both mints guarantee density: `classifyVocabulary` builds its own frozen snapshot,
	// and `mintSelectOptions` skips holes by index.
	return new Map(options.map((option) => [option.id, option]));
}

/**
 * The offered set of an ask with NO remote answerable option.
 *
 * Two asks reach it: a free-text `input`, whose answer is the text itself, and a `confirm` whose
 * caller-supplied vocabulary did not survive validation. Both broadcast zero options, so both are
 * decided by the local surface or by the method's own fail-closed default — never by a fabrication.
 */
const NO_OFFERED_OPTIONS: OfferedSet<never> = new Map();

interface RaceSpec<T> {
	method: RelayAsk["method"];
	title: string;
	message?: string;
	/** Minted once: broadcast verbatim, and the sole interpreter of the answer. */
	offered: OfferedSet<T>;
	/**
	 * Free-text asks only: the answer's optionId IS the text, so an id outside the offered set is
	 * still a real answer. Absent for every ask with a fixed vocabulary.
	 */
	fromFreeText?: (text: string) => T;
	opts: ExtensionUIDialogOptions | undefined;
	/** Value returned when the ask ends without an answer. Always the fail-closed value. */
	fallback: T;
	runBase: (opts: ExtensionUIDialogOptions | undefined) => Promise<T>;
}

export function createRelayUIContext(
	base: ExtensionUIContext,
	relay: PermissionRelay,
	baseIsLive: boolean,
): ExtensionUIContext {
	/** Evaluated LIVE on every call: clients attach and detach while a session is running. */
	const hasAnswerSurface = (): boolean => baseIsLive || relay.readWriteClientCount() > 0;

	function race<T>(spec: RaceSpec<T>): Promise<T> {
		// (f) Nobody can answer. Do not raise anything anywhere — hand back the base's own value so
		// the caller's fail-closed branch fires exactly as it does with no relay installed.
		if (!baseIsLive && relay.readWriteClientCount() === 0) {
			return spec.runBase(spec.opts);
		}

		const externalSignal = spec.opts?.signal;
		if (externalSignal?.aborted === true) {
			// The undecorated surfaces check this upfront too; nothing should be shown at all.
			return Promise.resolve(spec.fallback);
		}

		// (a) One id and one AbortController per ask.
		const requestId = randomUUID();
		const controller = new AbortController();

		let settled = false;
		let resolveOuter!: (value: T) => void;
		let rejectOuter!: (reason: unknown) => void;
		const outer = new Promise<T>((resolve, reject) => {
			resolveOuter = resolve;
			rejectOuter = reject;
		});

		// The caller's own signal is replaced below by ours, so forward it or an extension's
		// programmatic dismissal would silently stop working under the decorator. It is removed
		// again the moment the ask settles: a caller-owned signal outlives the ask and would
		// otherwise collect one dead listener per dialog.
		const onExternalAbort = (): void => {
			settle(SYSTEM_DECIDER, spec.fallback);
		};
		const releaseExternalSignal = (): void => {
			externalSignal?.removeEventListener("abort", onExternalAbort);
		};

		/** (g) The caller's declared timeout, armed only when the decorator owns the only arm. */
		let expiry: ReturnType<typeof setTimeout> | undefined;
		const releaseTimeout = (): void => {
			if (expiry !== undefined) {
				clearTimeout(expiry);
				expiry = undefined;
			}
		};

		/**
		 * (c) SYNCHRONOUS from the settled check through resolve(). A single `await` between the
		 * check and the assignment lets both answers through and produces two conflicting
		 * resolutions with no error at all, because the second resolve() is a silent no-op.
		 *
		 * (d) Order after a winner: mark settled -> resolve -> abort the losing surfaces ->
		 * withdraw. Aborting BEFORE resolving is a real defect: interactive mode honours
		 * `opts.signal` by resolving its selector to `undefined`, which its confirm wrapper maps to
		 * `false` — an abort-first implementation would feed a FABRICATED local deny back through
		 * this decorator and overwrite a remote approve.
		 *
		 * (e) Each teardown step is wrapped on its own, and this is what that does and does not buy.
		 *
		 * GUARANTEED: a `withdraw` that throws synchronously, a `withdraw` that returns a rejected
		 * promise (the shape a socket-writing registry naturally has), and a throwing `interpret`
		 * cannot escape this discarded `.then` as an unhandled rejection — fatal under Node's default
		 * --unhandled-rejections=throw — and cannot prevent the teardown steps behind them from
		 * running. The caller already has its answer before any of this executes.
		 *
		 * NOT GUARANTEED: `quietly(() => controller.abort())` does NOT contain a throw from an abort
		 * listener the BASE surface registered. `AbortController.abort()` dispatches synchronously
		 * through EventTarget, which reports a listener exception as an `uncaughtException` — it never
		 * propagates to the `abort()` call site, so neither try/catch nor `.catch()` can see it. That
		 * is inherent to EventTarget dispatch and is not something this decorator can fix.
		 */
		const settle = (decidedBy: RelayDecider, value: T): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolveOuter(value);
			quietly(releaseExternalSignal);
			quietly(releaseTimeout);
			quietly(() => controller.abort());
			quietly(() => relay.withdraw(requestId, decidedBy));
		};

		let relayDone = false;
		let baseFailure: { error: unknown } | undefined;
		/** Both sides are spent and the only outcome was an error from the local surface. */
		const rejectIfExhausted = (): void => {
			if (settled || !relayDone || baseFailure === undefined) {
				return;
			}
			settled = true;
			rejectOuter(baseFailure.error);
			quietly(releaseExternalSignal);
			quietly(releaseTimeout);
		};

		/**
		 * The relay is spent without a usable answer: nobody answered, it was withdrawn, it
		 * expired, it failed, or the answer named an option that was never offered.
		 *
		 * With a live local surface we simply keep waiting on it. With NO local surface there is
		 * nothing left to wait for, so the ask ends on its own fail-closed default — the wrapped
		 * no-op's `false` must never stand in as a decision, because a caller reports that as a
		 * user action in the transcript.
		 */
		const relayExhausted = (): void => {
			if (!baseIsLive) {
				settle(SYSTEM_DECIDER, spec.fallback);
				return;
			}
			rejectIfExhausted();
		};

		/**
		 * The offered set is the ONLY interpreter, and it is a plain lookup by the id that was
		 * broadcast: the answered option already carries its caller-side value. A free-text ask
		 * carries its answer verbatim instead.
		 */
		const interpret = (optionId: string): { value: T } | undefined => {
			const chosen = spec.offered.get(optionId);
			if (chosen !== undefined) {
				return chosen.resolution;
			}
			try {
				return spec.fromFreeText === undefined ? undefined : { value: spec.fromFreeText(optionId) };
			} catch {
				// An interpreter that blows up produced no answer. It must not settle the ask, and
				// it must not escape this discarded `.then` as an unhandled rejection.
				return undefined;
			}
		};

		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

		// ONE usability verdict, read by the advisory `deadline` just below AND by the real clock at
		// the bottom of this function. Guarding the two expressions separately is how a `NaN` timeout
		// (an unset `Number(process.env.DRAHT_PERMISSION_TIMEOUT_MS)`) and an `Infinity` timeout (the
		// idiomatic "never expire") reached `new Date(...).toISOString()` and threw a RangeError
		// SYNCHRONOUSLY out of `confirm()`. Such an ask never reaches the relay and never fails
		// closed: it propagates as an exception the permission gate reports as a TOOL ERROR rather
		// than as a denial. A permission ask must fail closed; it must never throw. The verdict also
		// bounds the MAGNITUDE, for the same reason and in the same one place — see
		// {@link MAX_USABLE_TIMEOUT_MS}.
		const declaredTimeout = usableTimeout(spec.opts?.timeout);

		const ask: RelayAsk = {
			requestId,
			method: spec.method,
			title: spec.title,
			message: spec.message,
			detail: spec.opts?.detail,
			// Derived from the offered set itself: nothing can be shown that cannot be answered.
			// `decision` rides along for rendering — see OfferedOption.declares.
			options: [...spec.offered.values()].map(
				({ id, label, declares }): WireOption =>
					declares === undefined ? { id, label } : { id, label, decision: declares },
			),
			requestedAt: new Date().toISOString(),
			// Advisory rendering data only. Real expiry binds to the clock below, never to this.
			deadline: declaredTimeout === undefined ? null : new Date(Date.now() + declaredTimeout).toISOString(),
		};

		// (b) Start BOTH surfaces — but ONLY when the mode actually bound one. A base that is not
		// live is the barrel's no-op, whose `confirm` resolves `false` on the very next microtask:
		// started, it wins every race outright and fabricates a user denial before the phone can
		// even render the ask. (e) Both handlers swallow late results and late REJECTIONS against a
		// settled ask — an unswallowed rejection is fatal under --unhandled-rejections=throw.
		if (baseIsLive) {
			callSafely(() => spec.runBase({ ...spec.opts, signal: controller.signal })).then(
				(value) => settle(LOCAL_DECIDER, value),
				(error: unknown) => {
					baseFailure = { error };
					rejectIfExhausted();
				},
			);
		}

		callSafely<RelayAnswer | undefined>(() => relay.raise(ask)).then(
			(answer) => {
				relayDone = true;
				if (answer === undefined || answer.requestId !== requestId) {
					relayExhausted();
					return;
				}
				const decided = interpret(answer.optionId);
				if (decided === undefined) {
					// An id nobody offered is not a choice anybody made: it is silence, not a dismissal.
					relayExhausted();
					return;
				}
				settle(answer.decidedBy, decided.value);
			},
			() => {
				relayDone = true;
				relayExhausted();
			},
		);

		// (g) With a live base, the local surface runs the caller's timeout itself (interactive mode
		// shows the countdown) and this decorator must not add a second clock. With NO live base the
		// decorator holds the only arm, so an unhonoured `opts.timeout` means the caller waits
		// forever whenever the relay never resolves — where without a relay it would have failed
		// closed instantly. On expiry the ask ends on the method's own fail-closed default,
		// attributed to the system: nobody decided.
		//
		// This is deliberately NOT a default clock. When the caller declares no timeout — or declares
		// one too large to arm honestly, see usableTimeout — the bound is the pending registry's own
		// fail-closed timer (R34-PERM.6, a later task): one clock, owned there. All that happens here
		// is that the caller's OWN declared timeout is respected, when it is a duration we can keep.
		if (!baseIsLive && declaredTimeout !== undefined) {
			expiry = setTimeout(() => {
				settle(SYSTEM_DECIDER, spec.fallback);
			}, declaredTimeout);
		}

		return outer;
	}

	return {
		select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
			return race<string | undefined>({
				method: "select",
				title,
				offered: mintSelectOptions(options),
				opts,
				fallback: undefined,
				runBase: (baseOpts) => base.select(title, options, baseOpts),
			});
		},

		confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
			return race<boolean>({
				method: "confirm",
				title,
				message,
				offered: mintConfirmOptions(opts?.detail?.options),
				opts,
				fallback: false,
				runBase: (baseOpts) => base.confirm(title, message, baseOpts),
			});
		},

		input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
			return race<string | undefined>({
				method: "input",
				title,
				message: placeholder,
				// A free-text ask offers NOTHING answerable, exactly as `select` takes nothing from
				// `detail.options`. Minting suggestions by id put the id namespace and the free-text
				// namespace in one map, and the map was consulted first: a human who TYPED the literal
				// text "allow-once" into an ask carrying a suggestion with that id got the suggestion's
				// LABEL back instead of what they typed. `detail` still travels, for rendering only.
				offered: NO_OFFERED_OPTIONS,
				// The answer IS the text, verbatim.
				fromFreeText: (text) => text,
				opts,
				fallback: undefined,
				runBase: (baseOpts) => base.input(title, placeholder, baseOpts),
			});
		},

		// ---------------------------------------------------------------------------------------
		// Hand-delegated, verbatim. Not a Proxy — see the file header.
		// ---------------------------------------------------------------------------------------

		notify(message: string, type?: "info" | "warning" | "error"): void {
			base.notify(message, type);
		},
		onTerminalInput(handler: TerminalInputHandler): () => void {
			return base.onTerminalInput(handler);
		},
		setStatus(key: string, text: string | undefined): void {
			base.setStatus(key, text);
		},
		setWorkingMessage(message?: string): void {
			base.setWorkingMessage(message);
		},
		setWorkingVisible(visible: boolean): void {
			base.setWorkingVisible(visible);
		},
		setWorkingIndicator(options?: WorkingIndicatorOptions): void {
			base.setWorkingIndicator(options);
		},
		setHiddenThinkingLabel(label?: string): void {
			base.setHiddenThinkingLabel(label);
		},
		// `content` is `never` so this single implementation satisfies both declared overloads.
		setWidget(key: string, content: never, options?: ExtensionWidgetOptions): void {
			base.setWidget(key, content, options);
		},
		setFooter(
			factory:
				| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
				| undefined,
		): void {
			base.setFooter(factory);
		},
		setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void {
			base.setHeader(factory);
		},
		setTitle(title: string): void {
			base.setTitle(title);
		},
		/** Local by documented exception: the factory produces a live component. */
		custom<T>(
			factory: (
				tui: TUI,
				componentTheme: Theme,
				keybindings: KeybindingsManager,
				done: (result: T) => void,
			) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
			options?: {
				overlay?: boolean;
				overlayOptions?: OverlayOptions | (() => OverlayOptions);
				onHandle?: (handle: OverlayHandle) => void;
			},
		): Promise<T> {
			return base.custom<T>(factory, options);
		},
		pasteToEditor(text: string): void {
			base.pasteToEditor(text);
		},
		setEditorText(text: string): void {
			base.setEditorText(text);
		},
		getEditorText(): string {
			return base.getEditorText();
		},
		/** Local by documented exception: a multi-line editor is not a one-shot answerable ask. */
		editor(title: string, prefill?: string): Promise<string | undefined> {
			return base.editor(title, prefill);
		},
		addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
			base.addAutocompleteProvider(factory);
		},
		setEditorComponent(factory: EditorFactory | undefined): void {
			base.setEditorComponent(factory);
		},
		getEditorComponent(): EditorFactory | undefined {
			return base.getEditorComponent();
		},
		get theme(): Theme {
			return base.theme;
		},
		getAllThemes(): { name: string; path: string | undefined }[] {
			return base.getAllThemes();
		},
		getTheme(name: string): Theme | undefined {
			return base.getTheme(name);
		},
		setTheme(newTheme: string | Theme): { success: boolean; error?: string } {
			return base.setTheme(newTheme);
		},
		getToolsExpanded(): boolean {
			return base.getToolsExpanded();
		},
		setToolsExpanded(expanded: boolean): void {
			base.setToolsExpanded(expanded);
		},

		hasAnswerSurface,
	};
}

/** Turn a synchronous throw into a rejected promise so both race arms behave identically. */
function callSafely<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return fn();
	} catch (error) {
		return Promise.reject(error);
	}
}

/**
 * Run one teardown step and swallow whatever it fails with — synchronously OR asynchronously.
 *
 * Teardown happens after the caller already has its answer, from inside a discarded `.then`: a
 * surface that blows up while being torn down cannot un-answer a settled ask, and must not become
 * an unhandled rejection. `relay.withdraw` is declared `void` but the real registry writes to a
 * socket, so the natural implementation is `async` — catching only synchronous throws would leave
 * exactly that shape fatal. Each step is wrapped on its own so a failure in one does not skip the
 * rest.
 */
function quietly(step: () => unknown): void {
	try {
		void Promise.resolve(step()).catch(() => {
			// Deliberately ignored — see above.
		});
	} catch {
		// Deliberately ignored — see above.
	}
}

/**
 * The verdict on a caller-supplied vocabulary. Exactly three outcomes, and no fourth.
 *
 * "Invalid" is deliberately NOT "fall back to the default": substituting our own words for a
 * caller's rejected ones is how an unauthorised approval gets broadcast.
 */
type VocabularyVerdict =
	| { readonly kind: "absent" }
	| { readonly kind: "valid"; readonly options: readonly ValidatedOption[] }
	| { readonly kind: "invalid" };

/**
 * The only words a permission vocabulary may use, as RUNTIME values rather than as a type.
 *
 * Derived from {@link CONFIRM_RESOLUTION}'s own keys so the two cannot drift: a word passes this
 * gate if and only if there is a caller-side value to translate it into.
 */
const DECISION_WORDS: ReadonlySet<string> = new Set<string>(Object.keys(CONFIRM_RESOLUTION));

/** Narrow a value read out of untyped data to a decision word. */
function isDecisionWord(value: unknown): value is PermissionOption["decision"] {
	return typeof value === "string" && DECISION_WORDS.has(value);
}

/**
 * THE ONE PLACE a caller's vocabulary is validated.
 *
 * `CONFIRM_RESOLUTION` is total over the declared TYPE but not over runtime values: a detail that
 * crossed a wire or came from an untyped JS extension can carry `decision: "maybe"`, and without
 * this gate that option was offered, broadcast, answerable, and resolved a `Promise<boolean>` with
 * `undefined`. Ids likewise must be unique before {@link offeredSet}'s last-wins `new Map` sees
 * them, or ARRAY POSITION decides which of two same-id options survives while `detail.options` —
 * the documented rendering carrier — still shows both, letting a tapped "Deny" resolve `true`.
 *
 * This is a validity test, not a meaning rule: no branch here reads an option's COUNT, POSITION or
 * ID to decide what that option means. The emptiness check asks "is this a vocabulary at all", and
 * a vocabulary of zero words is not one.
 *
 * It is TOTAL over runtime values, and its parameter is `unknown` to say so. The declared type is
 * exactly what a detail crossing a wire or coming from an untyped JS extension need not honour, and
 * every expression this gate writes must survive being handed the data it exists to police:
 * `vocabulary.length` threw a TypeError on `null`, `for...of` threw "is not iterable" on an
 * array-like `{0: {…}, length: 1}`, and a non-object entry threw on the first property read. A
 * malformed container is INVALID — an outcome this file already knows how to fail closed on — and
 * never an exception out of `confirm()`.
 *
 * Every field is read EXACTLY ONCE, here, and the verdict carries {@link ValidatedOption} copies
 * rather than the caller's array. See {@link ValidatedOption} for what that buys.
 */
function classifyVocabulary(vocabulary: unknown): VocabularyVerdict {
	if (vocabulary === undefined) {
		return { kind: "absent" };
	}
	if (!Array.isArray(vocabulary)) {
		return { kind: "invalid" };
	}
	const entries: readonly unknown[] = vocabulary;
	// A caller whose policy layer filtered its vocabulary down to nothing offered nothing. It did
	// not ask for OUR yes/no pair, and must never have a "Yes" broadcast in its name.
	if (entries.length === 0) {
		return { kind: "invalid" };
	}
	const ids = new Set<string>();
	const snapshot: ValidatedOption[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) {
			return { kind: "invalid" };
		}
		// The decision must be the option's OWN word. A bare `DECISION_WORDS.has(option.decision)`
		// walks the prototype chain: with `Object.prototype.decision = "approve"` set anywhere in the
		// process, an option that declared NOTHING was broadcast as an approval, and tapping its
		// "Deny" label resolved `true`.
		if (!Object.hasOwn(entry, "decision")) {
			return { kind: "invalid" };
		}
		// One read per field, into locals. Everything below inspects these locals, never `entry`.
		const { id, label, decision } = entry as { id?: unknown; label?: unknown; decision?: unknown };
		// `RelayAnswer.optionId` is typed `string`, so a non-string id is a promise the wire cannot
		// keep: `[{id: 1, …deny}, {id: "1", …approve}]` passed the SameValueZero uniqueness proof
		// (1 !== "1"), broadcast both, and a client honouring its own wire type by sending
		// `String(1)` named the APPROVAL while the human had tapped "Deny". The type-conforming
		// client was the one that got it wrong. An empty id is no handle at all.
		if (typeof id !== "string" || id.length === 0) {
			return { kind: "invalid" };
		}
		if (typeof label !== "string") {
			return { kind: "invalid" };
		}
		if (!isDecisionWord(decision)) {
			return { kind: "invalid" };
		}
		// KNOWN LATENT (accepted, not fixed): this proof is exact-string, so two ids differing only
		// by Unicode normalisation form ("café" NFC vs NFD) are two distinct options here and one
		// option in any client that normalises. Harmless for a hand-written vocabulary; a real risk
		// the moment option ids are DERIVED from tool, path or command data — normalise here then.
		if (ids.has(id)) {
			return { kind: "invalid" };
		}
		ids.add(id);
		snapshot.push(Object.freeze({ id, label, decision }));
	}
	return { kind: "valid", options: Object.freeze(snapshot) };
}

/**
 * Mint the vocabulary of a `confirm`, ONCE, behind the one validation gate.
 *
 * Each offered option's caller-side value is read off the option ITSELF, from the `decision` its
 * vocabulary declares. There is no position rule, so a denial in the middle of the list, a
 * vocabulary with several denials, and a single-option vocabulary are all simply what they say they
 * are. With NO caller vocabulary, the default yes/no pair is minted through the same one path.
 *
 * With an INVALID caller vocabulary, nothing is offered at all: the ask broadcasts an empty option
 * list, so it is decided by the local surface if one is live and otherwise by `confirm`'s own
 * fail-closed `false`. An invalid vocabulary is never silently replaced by a fabricated one, and it
 * can never approve anything.
 *
 * Nothing is logged here on purpose. This decorator runs under a TUI that owns the terminal, and a
 * stray `console.warn` mid-render corrupts the screen; the rejection is visible instead as an ask
 * that carries the caller's `detail` but offers no remote option.
 *
 * An id that is not in the set at all is not an answer, which is where fail-closed lives: it can
 * never become a decision attributed to a human who never touched it.
 */
function mintConfirmOptions(vocabulary: readonly PermissionOption[] | undefined): OfferedSet<boolean> {
	const verdict = classifyVocabulary(vocabulary);
	if (verdict.kind === "invalid") {
		return NO_OFFERED_OPTIONS;
	}
	// BOTH arms are frozen data this file owns — the gate's snapshot, or our own default pair. The
	// caller's array is never read again past validation, so what is minted here is exactly what was
	// proved valid there.
	const options = verdict.kind === "absent" ? DEFAULT_CONFIRM_OPTIONS : verdict.options;
	return offeredSet(
		options.map((option) => offer(option.id, option.label, CONFIRM_RESOLUTION[option.decision], option.decision)),
	);
}

/**
 * The largest timeout this decorator will arm: `2^31-1` ms, about 24.85 days.
 *
 * ONE bound, because it is the smaller of the two real ceilings and therefore covers both.
 *
 * `setTimeout` stores its delay in a signed 32-bit int: anything larger is CLAMPED to 1ms with a
 * `TimeoutOverflowWarning`. A 30-day timeout therefore advertised a deadline a month out and then
 * settled `false` two milliseconds later, attributed to nobody — with no live base, every such ask
 * fabricated a system denial before the phone could render it. Fail-closed, so it could not
 * approve, but it contradicted this file's own promise that real expiry binds to the clock, and it
 * broke the walk-away premise the relay exists for.
 *
 * Far above that, `new Date(Date.now() + t)` leaves the representable range (~8.64e15 ms from the
 * epoch) and `.toISOString()` throws `RangeError: Invalid time value` SYNCHRONOUSLY, so
 * `{ timeout: Number.MAX_SAFE_INTEGER }` — the idiomatic "never expire", which compiles cleanly —
 * never reached either surface and arrived at the permission gate as a tool error, not a decision.
 */
const MAX_USABLE_TIMEOUT_MS = 2_147_483_647;

/**
 * ONE verdict for a caller's declared timeout: a real, ARMABLE duration, or nothing at all.
 *
 * A DELIBERATE choice, stated because both readings are defensible: a declared timeout above
 * {@link MAX_USABLE_TIMEOUT_MS} is treated as NO timeout at all, not as one capped to the maximum.
 * Capping invents a bound the caller never asked for and then acts on it — "never expire" would
 * become a fabricated system denial 24 days in, which is the very defect above, merely postponed.
 * And `Number.MAX_SAFE_INTEGER` and `Infinity` are two spellings of one intent, so they must not
 * behave differently. "No usable timeout" already has a documented meaning here: the ask carries
 * `deadline: null`, this decorator arms no clock of its own, and the bound falls to the pending
 * registry's own fail-closed timer (R34-PERM.6) — one clock, owned there.
 */
function usableTimeout(timeout: number | undefined): number | undefined {
	return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 && timeout <= MAX_USABLE_TIMEOUT_MS
		? timeout
		: undefined;
}

/**
 * Mint the vocabulary of a `select`, ONCE, from the caller's OWN option list and nothing else.
 *
 * Every offered option resolves to the very string it was minted from, bound at construction. The
 * id is a wire handle and nothing more: it is never parsed back into a position, and two identical
 * labels stay two distinct answers.
 *
 * `detail.options` is a permission-DETAIL carrier and deliberately contributes nothing here. Laying
 * a permission vocabulary over a label list — by position, or by label match — is exactly the
 * inference that once resolved an answered "Deny" to the caller-side string "Allow". The detail
 * still travels on the ask for rendering; it just never decides anything.
 */
function mintSelectOptions(labels: readonly string[]): OfferedSet<string | undefined> {
	// Iterate by index rather than with `labels.map`, which PRESERVES array holes: `new Map` then
	// iterates the array iterator, hits the hole's `undefined` and throws "Iterator value undefined
	// is not an entry object" synchronously out of the caller's `ui.select`. A caller reaches that
	// with ordinary TypeScript — `for (…) if (keep) labels[i] = name` builds a sparse `string[]` —
	// and the undecorated base does not throw, so the decorator would be introducing the crash.
	// A hole has no label to render and no value to resolve to, so it is not offered at all; the
	// surviving positions keep their own index in the id, so what IS offered stays answerable.
	const options: OfferedOption<string | undefined>[] = [];
	for (let position = 0; position < labels.length; position++) {
		const label = labels[position];
		if (typeof label !== "string") continue;
		options.push(offer(`option-${position}`, label, label));
	}
	return offeredSet(options);
}
