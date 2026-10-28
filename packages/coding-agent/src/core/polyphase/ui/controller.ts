/**
 * `installPolyphaseUi`: wires the `alt+a` agent inspector overlay and the above-editor dock
 * widget into one TUI session. Inert outside `ctx.mode === "tui" && ctx.hasUI` (§12.1, §12.7).
 */

import { getKeybindings } from "@draht/tui";
import type { ExtensionContext, UIPromptKind } from "../../extensions/types.ts";
import type { ArchivedRun } from "../details.ts";
import type { PolyphaseSession } from "../session.ts";
import type { SavedWorkflowSummary } from "../workflow/saved.ts";
import { PolyphaseDock } from "./dock.ts";
import { type InspectorInitialView, PolyphaseInspector } from "./inspector.ts";

export interface PolyphaseUiOptions {
	ctx: ExtensionContext;
	session: PolyphaseSession;
	getArchivedRuns(): readonly ArchivedRun[];
	getSavedWorkflows(): readonly SavedWorkflowSummary[];
	/** `!hideThinkingBlock` is the inspector's initial thinking visibility (§12.3). Defaults to
	 * showing thinking when omitted. */
	hideThinkingBlock?(): boolean;
}

export interface PolyphaseUiController {
	openInspector(initial?: InspectorInitialView): void;
	closeInspector(): void;
	isInspectorOpen(): boolean;
	notePromptStart(kind: UIPromptKind): void;
	notePromptEnd(): void;
	dispose(): void;
}

const DOCK_WIDGET_KEY = "polyphase";

function inertController(): PolyphaseUiController {
	return {
		openInspector: () => {},
		closeInspector: () => {},
		isInspectorOpen: () => false,
		notePromptStart: () => {},
		notePromptEnd: () => {},
		dispose: () => {},
	};
}

class PolyphaseUiControllerImpl implements PolyphaseUiController {
	private readonly options: PolyphaseUiOptions;
	private readonly unsubscribeTerminalInput: () => void;
	private readonly unsubscribeStore: () => void;
	private readonly unsubscribeParentPrompt: () => void;

	private inspectorActive = false;
	private activeDone: (() => void) | undefined;
	private dockVisible = false;
	/** The runner (`extensions/runner.ts` `withUIPrompt`) emits `ui_prompt_start`/`ui_prompt_end`
	 * only for the outermost prompt bracket, so this is always 0 or 1 - counting every pair,
	 * including our own inspector's "custom" prompt, keeps it correct when a nested prompt (e.g.
	 * the subagent gate's confirm) starts before our bracket has finished closing: the runner
	 * folds that nested prompt into the still-open outer bracket instead of starting a new one,
	 * so `outerPromptCount` only reaches 0 once the whole bracket - nested confirm included - ends.
	 * `handleTerminalInput` checks `inspectorActive` before this count, so our own prompt alone
	 * never blocks opening or closing. */
	private outerPromptCount = 0;
	private disposed = false;

	constructor(options: PolyphaseUiOptions) {
		this.options = options;
		this.unsubscribeTerminalInput = options.ctx.ui.onTerminalInput((data) => this.handleTerminalInput(data));
		this.unsubscribeStore = options.session.store.subscribe((change) => {
			if (change.type === "runs" && change.coarse) this.syncDockVisibility();
		});
		this.unsubscribeParentPrompt = options.session.onParentPrompt(() => this.closeInspector());
		this.syncDockVisibility();
	}

	private handleTerminalInput(data: string): { consume?: boolean } | undefined {
		if (!getKeybindings().matches(data, "app.polyphase.inspector")) return undefined;
		if (this.inspectorActive) {
			this.closeInspector();
			return { consume: true };
		}
		if (this.outerPromptCount > 0) return undefined;
		this.openInspector();
		return { consume: true };
	}

	openInspector(initial: InspectorInitialView = { view: "auto" }): void {
		if (this.disposed || this.inspectorActive) return;
		this.inspectorActive = true;
		this.options.session.setInspectorOpen(true);
		const settle = () => {
			this.inspectorActive = false;
			this.activeDone = undefined;
			this.options.session.setInspectorOpen(false);
		};
		this.options.ctx.ui
			.custom<void>(
				(tui, theme, keybindings, done) => {
					const inspector = new PolyphaseInspector({
						session: this.options.session,
						tui,
						theme,
						keybindings,
						getArchivedRuns: () => this.options.getArchivedRuns(),
						getSavedWorkflows: () => this.options.getSavedWorkflows(),
						initial,
						showThinking: !(this.options.hideThinkingBlock?.() ?? false),
						close: () => done(undefined),
						insertCommand: (text) => this.options.ctx.ui.setEditorText(text),
					});
					// Assigned only once construction succeeds, so a throwing constructor never leaves
					// `activeDone` pointing at a factory call that never produced a component.
					this.activeDone = () => done(undefined);
					return inspector;
				},
				{
					overlay: true,
					overlayOptions: () => ({ anchor: "center", width: "100%", maxHeight: "100%", margin: 1 }),
				},
			)
			// Both outcomes must clear `inspectorActive`/`activeDone` and flip the pump back to its
			// slow interval - otherwise a throwing factory (or a rejecting `custom()`) leaves the
			// inspector permanently unopenable and the session stuck on the fast inspector interval.
			.then(settle, settle);
	}

	closeInspector(): void {
		if (!this.inspectorActive) return;
		this.activeDone?.();
	}

	isInspectorOpen(): boolean {
		return this.inspectorActive;
	}

	notePromptStart(_kind: UIPromptKind): void {
		if (this.disposed) return;
		this.outerPromptCount++;
	}

	notePromptEnd(): void {
		if (this.disposed) return;
		this.outerPromptCount = Math.max(0, this.outerPromptCount - 1);
	}

	private syncDockVisibility(): void {
		if (this.disposed) return;
		const shouldShow = this.options.session.store.totals().running > 0 && this.options.session.settings().dock;
		if (shouldShow === this.dockVisible) return;
		this.dockVisible = shouldShow;
		this.setDockWidget(shouldShow);
	}

	private setDockWidget(visible: boolean): void {
		if (visible) {
			this.options.ctx.ui.setWidget(
				DOCK_WIDGET_KEY,
				(tui, theme) => new PolyphaseDock({ session: this.options.session, tui, theme }),
				{ placement: "aboveEditor" },
			);
		} else {
			this.options.ctx.ui.setWidget(DOCK_WIDGET_KEY, undefined);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribeTerminalInput();
		this.unsubscribeStore();
		this.unsubscribeParentPrompt();
		this.closeInspector();
		if (this.dockVisible) {
			this.dockVisible = false;
			this.setDockWidget(false);
		}
	}
}

export function installPolyphaseUi(options: PolyphaseUiOptions): PolyphaseUiController {
	if (options.ctx.mode !== "tui" || !options.ctx.hasUI) return inertController();
	return new PolyphaseUiControllerImpl(options);
}
