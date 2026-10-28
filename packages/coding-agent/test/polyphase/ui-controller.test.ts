import type {
	Component,
	KeybindingsManager as KeybindingsManagerType,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@draht/tui";
import { KeybindingsManager, setKeybindings } from "@draht/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionContext,
	ExtensionUIContext,
	TerminalInputHandler,
	UIPromptKind,
} from "../../src/core/extensions/types.ts";
import { KEYBINDINGS } from "../../src/core/keybindings.ts";
import { disposePolyphaseSession, getPolyphaseSession } from "../../src/core/polyphase/session.ts";
import type { AgentModelInfo } from "../../src/core/polyphase/types.ts";
import {
	installPolyphaseUi,
	type PolyphaseUiController,
	type PolyphaseUiOptions,
} from "../../src/core/polyphase/ui/controller.ts";
import type { InspectorDeps } from "../../src/core/polyphase/ui/inspector.ts";
import { PolyphaseInspector } from "../../src/core/polyphase/ui/inspector.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestUiContext } from "../suite/harness.ts";

vi.mock("../../src/core/polyphase/ui/inspector.ts", () => ({
	PolyphaseInspector: vi.fn(),
}));

initTheme("dark");
setKeybindings(new KeybindingsManager(KEYBINDINGS));

const sessionKeys: object[] = [];

function trackedKey(): object {
	const key = {};
	sessionKeys.push(key);
	return key;
}

/** The real `PolyphaseInspector` is mocked out for these tests (they exercise the controller's
 * wiring, not the inspector's rendering/navigation, which has its own suite) - cast through
 * `unknown` since a plain `Component` stub cannot structurally satisfy the class's private
 * fields. */
function fakeInspectorComponent(): PolyphaseInspector {
	const component: Component & { dispose?(): void } = { render: () => [], invalidate: () => {}, dispose: () => {} };
	return component as unknown as PolyphaseInspector;
}

let capturedInspectorDeps: InspectorDeps | undefined;

beforeEach(() => {
	capturedInspectorDeps = undefined;
	vi.mocked(PolyphaseInspector).mockReset();
	vi.mocked(PolyphaseInspector).mockImplementation((deps: InspectorDeps) => {
		capturedInspectorDeps = deps;
		return fakeInspectorComponent();
	});
});

afterEach(() => {
	for (const key of sessionKeys.splice(0)) {
		disposePolyphaseSession(key, "test");
	}
	vi.useRealTimers();
});

function pendingModel(): AgentModelInfo {
	return { source: "inherited", requested: "claude-sonnet-5", confirmed: false };
}

interface CustomCall {
	options?: { overlay?: boolean; overlayOptions?: OverlayOptions | (() => OverlayOptions) };
}

interface WidgetCall {
	key: string;
	hasContent: boolean;
}

interface TestUi {
	ctx: ExtensionContext;
	customCalls: CustomCall[];
	widgetCalls: WidgetCall[];
	editorTexts: string[];
	terminalInput(data: string): { consume?: boolean } | undefined;
	onTerminalInputCallCount(): number;
}

/** A fake `ExtensionContext` built on `createTestUiContext` (so a controller change that starts
 * calling some other `ExtensionUIContext` method hits a harmless no-op, not `undefined`), with
 * `onTerminalInput`/`custom`/`setWidget`/`setEditorText` overridden to actually invoke the
 * `custom()` factory (as the real TUI runner does), so `installPolyphaseUi`'s captured `done`
 * callback is the same function this harness resolves/rejects the returned promise with -
 * exercising the "close only through done()" contract for real, not just recording what was
 * passed. */
function buildTestUi(mode: "tui" | "rpc" = "tui"): TestUi {
	const customCalls: CustomCall[] = [];
	const widgetCalls: WidgetCall[] = [];
	const editorTexts: string[] = [];
	let handler: TerminalInputHandler | undefined;
	let onTerminalInputCalls = 0;

	const fakeTui = { terminal: { rows: 24, columns: 80 }, requestRender: vi.fn() } as unknown as TUI;
	const keybindings = new KeybindingsManager(KEYBINDINGS) as unknown as KeybindingsManagerType;

	const custom = (<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			kb: KeybindingsManagerType,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> => {
		customCalls.push({ options });
		return new Promise<T>((resolve, reject) => {
			try {
				Promise.resolve(factory(fakeTui, theme, keybindings, resolve)).catch(reject);
			} catch (err) {
				reject(err);
			}
		});
	}) as ReturnType<typeof createTestUiContext>["custom"];

	const setWidget = ((key: string, content: unknown) => {
		widgetCalls.push({ key, hasContent: content !== undefined });
	}) as ReturnType<typeof createTestUiContext>["setWidget"];

	const onTerminalInput = ((h: TerminalInputHandler) => {
		handler = h;
		onTerminalInputCalls++;
		return () => {
			if (handler === h) handler = undefined;
		};
	}) as ReturnType<typeof createTestUiContext>["onTerminalInput"];

	const setEditorText = ((text: string) => {
		editorTexts.push(text);
	}) as ReturnType<typeof createTestUiContext>["setEditorText"];

	const ui = createTestUiContext({ onTerminalInput, custom, setWidget, setEditorText });
	const ctx = { mode, hasUI: true, ui } as unknown as ExtensionContext;

	return {
		ctx,
		customCalls,
		widgetCalls,
		editorTexts,
		terminalInput: (data: string) => handler?.(data),
		onTerminalInputCallCount: () => onTerminalInputCalls,
	};
}

function buildOptions(testUi: TestUi): PolyphaseUiOptions {
	const key = trackedKey();
	const session = getPolyphaseSession(key, undefined);
	return {
		ctx: testUi.ctx,
		session,
		getArchivedRuns: () => [],
		getSavedWorkflows: () => [],
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

/** Mirrors `extensions/runner.ts`'s `withUIPrompt`: a depth counter that calls
 * `notePromptStart`/`notePromptEnd` only for the outermost prompt bracket, folding a prompt that
 * starts before the outer one has finished closing into that same bracket instead of starting a
 * new one. The real runner defers the emission by a `queueMicrotask`; this calls the controller
 * synchronously, which does not change the depth bookkeeping under test. */
function wrapWithPromptDepth(
	ui: ExtensionUIContext,
	controllerRef: { current?: PolyphaseUiController },
): ExtensionUIContext {
	let depth = 0;
	const wrap = <T>(kind: UIPromptKind, run: () => Promise<T>): Promise<T> => {
		if (depth++ === 0) controllerRef.current?.notePromptStart(kind);
		const finish = () => {
			if (--depth > 0) return;
			depth = 0;
			controllerRef.current?.notePromptEnd();
		};
		return run().finally(finish);
	};
	const custom = (<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			kb: KeybindingsManagerType,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> => wrap("custom", () => ui.custom(factory, options))) as ExtensionUIContext["custom"];
	const confirm = ((title: string, message: string, opts?: Parameters<ExtensionUIContext["confirm"]>[2]) =>
		wrap("confirm", () => ui.confirm(title, message, opts))) as ExtensionUIContext["confirm"];
	return { ...ui, custom, confirm };
}

describe("installPolyphaseUi", () => {
	it("opens the inspector overlay on alt+a and consumes the key", () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const setInspectorOpenSpy = vi.spyOn(options.session, "setInspectorOpen");
		const controller = installPolyphaseUi(options);

		const result = testUi.terminalInput("\x1ba");

		expect(result).toEqual({ consume: true });
		expect(controller.isInspectorOpen()).toBe(true);
		expect(testUi.customCalls).toHaveLength(1);
		expect(testUi.customCalls[0]?.options?.overlay).toBe(true);
		const overlayOptions = testUi.customCalls[0]?.options?.overlayOptions;
		const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
		expect(resolved).toEqual({ anchor: "center", width: "100%", maxHeight: "100%", margin: 1 });
		expect(PolyphaseInspector).toHaveBeenCalledTimes(1);
		expect(setInspectorOpenSpy).toHaveBeenCalledWith(true);

		controller.dispose();
	});

	it("closes on a second alt+a, through done()", async () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);

		const result = testUi.terminalInput("\x1ba");
		expect(result).toEqual({ consume: true });
		await flushMicrotasks();

		expect(controller.isInspectorOpen()).toBe(false);
		controller.dispose();
	});

	it("blocks opening while an outer prompt is active", () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		controller.notePromptStart("confirm");
		const result = testUi.terminalInput("\x1ba");

		expect(result).toBeUndefined();
		expect(controller.isInspectorOpen()).toBe(false);
		expect(testUi.customCalls).toHaveLength(0);

		controller.notePromptEnd();
		testUi.terminalInput("\x1ba");
		expect(testUi.customCalls).toHaveLength(1);

		controller.dispose();
	});

	it("closes the inspector when the session notifies a parent prompt", async () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);

		options.session.notifyParentPrompt();
		await flushMicrotasks();

		expect(controller.isInspectorOpen()).toBe(false);
		controller.dispose();
	});

	it("keeps a parent confirm reachable when it starts before the inspector's own prompt bracket has finished closing", async () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		let resolveConfirm: (() => void) | undefined;
		const confirmableUi: ExtensionUIContext = {
			...testUi.ctx.ui,
			confirm: () =>
				new Promise<boolean>((resolve) => {
					resolveConfirm = () => resolve(true);
				}),
		};
		const controllerRef: { current?: PolyphaseUiController } = {};
		const wrappedOptions: PolyphaseUiOptions = {
			...options,
			ctx: { ...options.ctx, ui: wrapWithPromptDepth(confirmableUi, controllerRef) },
		};
		const controller = installPolyphaseUi(wrappedOptions);
		controllerRef.current = controller;

		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);

		// Mirrors the subagent gate: `notifyParentPrompt()` right before `ctx.ui.confirm(...)`, in
		// the same synchronous tick - before the inspector's own "custom" prompt bracket has
		// actually finished closing, so the runner folds the confirm into that still-open bracket
		// instead of starting a new one (§12.1).
		options.session.notifyParentPrompt();
		const confirmPromise = wrappedOptions.ctx.ui.confirm("Run workflow?", "message");
		await flushMicrotasks();

		expect(controller.isInspectorOpen()).toBe(false);
		expect(testUi.terminalInput("\x1ba")).toBeUndefined();
		expect(testUi.customCalls).toHaveLength(1);

		resolveConfirm?.();
		await confirmPromise;
		await flushMicrotasks();

		expect(testUi.terminalInput("\x1ba")).toEqual({ consume: true });
		expect(testUi.customCalls).toHaveLength(2);

		controller.dispose();
	});

	it("recovers from a factory that rejects, so the inspector can be reopened", async () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);
		const setInspectorOpenSpy = vi.spyOn(options.session, "setInspectorOpen");

		vi.mocked(PolyphaseInspector).mockImplementationOnce(() => {
			throw new Error("boom");
		});

		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);
		await flushMicrotasks();

		expect(controller.isInspectorOpen()).toBe(false);
		expect(setInspectorOpenSpy).toHaveBeenLastCalledWith(false);

		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);
		expect(testUi.customCalls).toHaveLength(2);

		controller.dispose();
	});

	it("wires the inspector's insertCommand to ctx.ui.setEditorText", () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		testUi.terminalInput("\x1ba");
		expect(capturedInspectorDeps).toBeDefined();
		capturedInspectorDeps?.insertCommand("/review-pr ");

		expect(testUi.editorTexts).toEqual(["/review-pr "]);
		controller.dispose();
	});

	it("calls getArchivedRuns/getSavedWorkflows as methods of the options object passed to installPolyphaseUi, not of some unrelated object", () => {
		// Shorthand methods that read sibling data through `this` are a common way to pass a
		// "deps bag" like `PolyphaseUiOptions`: the bug this guards against is the controller handing
		// the inspector a reference that gets invoked as a method of some other object instead (the
		// inspector's own deps, built fresh on every open), which would silently see `undefined` here.
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const extendedOptions = {
			...options,
			archivedLabel: "archived-from-options",
			savedLabel: "saved-from-options",
			getArchivedRuns(): readonly [] {
				if (this.archivedLabel !== "archived-from-options") throw new Error("lost `this`");
				return [];
			},
			getSavedWorkflows(): readonly [] {
				if (this.savedLabel !== "saved-from-options") throw new Error("lost `this`");
				return [];
			},
		};
		const controller = installPolyphaseUi(extendedOptions);

		testUi.terminalInput("\x1ba");
		expect(capturedInspectorDeps).toBeDefined();
		expect(() => capturedInspectorDeps?.getArchivedRuns()).not.toThrow();
		expect(() => capturedInspectorDeps?.getSavedWorkflows()).not.toThrow();

		controller.dispose();
	});

	it("defaults showThinking to true when no hideThinkingBlock option is given", () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		testUi.terminalInput("\x1ba");
		expect(capturedInspectorDeps?.showThinking).toBe(true);

		controller.dispose();
	});

	it("hides thinking when hideThinkingBlock() returns true", () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi({ ...options, hideThinkingBlock: () => true });

		testUi.terminalInput("\x1ba");
		expect(capturedInspectorDeps?.showThinking).toBe(false);

		controller.dispose();
	});

	it("shows the dock widget while a run is active and removes it once it finishes", () => {
		vi.useFakeTimers();
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		installPolyphaseUi(options);

		const run = options.session.store.createRun({
			id: "run-dock",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "do a thing",
			budgetTokens: null,
		});
		run.addAgent({ label: "worker", agentType: "worker", task: "do the thing", model: pendingModel() });
		vi.advanceTimersByTime(300);

		expect(testUi.widgetCalls.some((call) => call.key === "polyphase" && call.hasContent)).toBe(true);

		run.finish("done");
		vi.advanceTimersByTime(300);

		const last = testUi.widgetCalls[testUi.widgetCalls.length - 1];
		expect(last).toEqual({ key: "polyphase", hasContent: false });
	});

	it("never shows the dock widget when settings.dock is false", () => {
		vi.useFakeTimers();
		const testUi = buildTestUi();
		const key = trackedKey();
		const session = getPolyphaseSession(key, { dock: false });
		const options: PolyphaseUiOptions = {
			ctx: testUi.ctx,
			session,
			getArchivedRuns: () => [],
			getSavedWorkflows: () => [],
		};
		installPolyphaseUi(options);

		const run = session.store.createRun({
			id: "run-dock-off",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "do a thing",
			budgetTokens: null,
		});
		run.addAgent({ label: "worker", agentType: "worker", task: "do the thing", model: pendingModel() });
		vi.advanceTimersByTime(300);

		expect(testUi.widgetCalls.some((call) => call.hasContent)).toBe(false);
	});

	it("is inert outside tui mode, with no onTerminalInput registration", () => {
		const testUi = buildTestUi("rpc");
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		expect(testUi.onTerminalInputCallCount()).toBe(0);
		controller.openInspector();
		expect(controller.isInspectorOpen()).toBe(false);
		expect(testUi.customCalls).toHaveLength(0);
		expect(PolyphaseInspector).not.toHaveBeenCalled();
		controller.notePromptStart("confirm");
		controller.notePromptEnd();
		controller.closeInspector();
		controller.dispose();
	});

	it("dispose removes the dock widget and listeners, closes an open inspector, and releases the store and parent-prompt subscriptions", async () => {
		vi.useFakeTimers();
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		const run = options.session.store.createRun({
			id: "run-dispose",
			kind: "subagent",
			origin: "tool",
			mode: "single",
			title: "do a thing",
			budgetTokens: null,
		});
		run.addAgent({ label: "worker", agentType: "worker", task: "do the thing", model: pendingModel() });
		vi.advanceTimersByTime(300);
		expect(testUi.widgetCalls.some((call) => call.hasContent)).toBe(true);

		// Opened and left open, so dispose's `closeInspector()` call (and not just the never-opened
		// no-op path) is actually exercised below.
		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);
		expect(testUi.customCalls).toHaveLength(1);

		controller.dispose();
		await flushMicrotasks();
		expect(controller.isInspectorOpen()).toBe(false);

		const widgetCallsAtDispose = testUi.widgetCalls.length;
		const last = testUi.widgetCalls[testUi.widgetCalls.length - 1];
		expect(last).toEqual({ key: "polyphase", hasContent: false });
		expect(testUi.terminalInput("\x1ba")).toBeUndefined();

		// The store subscription is released: finishing the run and flushing produces no further
		// `setWidget` calls.
		run.finish("done");
		vi.advanceTimersByTime(300);
		expect(testUi.widgetCalls.length).toBe(widgetCallsAtDispose);

		// The parent-prompt listener is released too: notifying has no observable effect (no further
		// `custom()` call, no change to `isInspectorOpen()`).
		options.session.notifyParentPrompt();
		expect(controller.isInspectorOpen()).toBe(false);
		expect(testUi.customCalls).toHaveLength(1);
	});

	it("closing the inspector through its own close() settles the controller the same way as the alt+a toggle", async () => {
		const testUi = buildTestUi();
		const options = buildOptions(testUi);
		const controller = installPolyphaseUi(options);

		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);
		expect(capturedInspectorDeps).toBeDefined();

		capturedInspectorDeps?.close();
		await flushMicrotasks();

		expect(controller.isInspectorOpen()).toBe(false);

		// Reopening afterwards must work, proving the controller's internal state was actually
		// cleared and not just coincidentally read as closed.
		testUi.terminalInput("\x1ba");
		expect(controller.isInspectorOpen()).toBe(true);

		controller.dispose();
	});
});
