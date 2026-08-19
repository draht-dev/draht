import {
	type Component,
	Container,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@draht/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";

const SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Single-step submenu that shows a titled select list.
 */
export class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// Description
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// Spacer
		this.addChild(new Spacer(1));

		// Select list
		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SUBMENU_SELECT_LIST_LAYOUT,
		);

		// Pre-select current value
		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		// Hint
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

// ============================================================================
// SteppedSubmenu — reusable multi-step selector
// ============================================================================

/** One step in a {@link SteppedSubmenu}. */
export interface SteppedSubmenuStep {
	/** Unique key — the selected value is stored in the result context under this key. */
	key: string;
	/** Title shown at the top of the step. Receives prior selections. */
	title: string | ((context: Record<string, string>) => string);
	/** Description shown below the title. Receives prior selections. */
	description: string | ((context: Record<string, string>) => string);
	/** Build the option list for this step. Called fresh each time the step is shown. */
	options: (context: Record<string, string>) => SelectItem[];
	/** Optionally pre-select a value when entering this step. */
	preselect?: (context: Record<string, string>) => string | undefined;
}

interface SteppedSubmenuOptions {
	/** Start at this step index (0-based), skipping earlier steps. Requires initialContext for skipped keys. */
	startAtStep?: number;
	/** Pre-fill selections for skipped steps. */
	initialContext?: Record<string, string>;
	/** After completing the last step, loop back to step 0 instead of closing. */
	loop?: boolean;
}

/**
 * Generic N-step submenu built on top of {@link SelectSubmenu}.
 *
 * Each step's options can depend on prior selections via the shared context.
 * Esc goes back one step; Esc at step 0 cancels.
 * With `loop: true`, completing the final step invokes `onComplete` then returns to step 0.
 */
export class SteppedSubmenu extends Container {
	private readonly steps: SteppedSubmenuStep[];
	private readonly onComplete: (context: Record<string, string>) => void;
	private readonly onCancel: () => void;
	private readonly opts: SteppedSubmenuOptions;
	private activeComponent: Component;
	private context: Record<string, string>;

	constructor(
		steps: SteppedSubmenuStep[],
		onComplete: (context: Record<string, string>) => void,
		onCancel: () => void,
		opts: SteppedSubmenuOptions = {},
	) {
		super();
		this.steps = steps;
		this.onComplete = onComplete;
		this.onCancel = onCancel;
		this.opts = opts;
		this.context = { ...(opts.initialContext ?? {}) };
		this.activeComponent = this.buildStep(opts.startAtStep ?? 0);
	}

	private buildStep(stepIndex: number): Component {
		const step = this.steps[stepIndex];
		const total = this.steps.length;
		const stepLabel = total > 1 ? `Step ${stepIndex + 1}/${total} · ` : "";

		const title = typeof step.title === "function" ? step.title(this.context) : step.title;
		const desc = typeof step.description === "function" ? step.description(this.context) : step.description;
		const items = step.options(this.context);
		const preselect = step.preselect?.(this.context) ?? "";

		return new SelectSubmenu(
			title,
			`${stepLabel}${desc}`,
			items,
			preselect,
			(value) => {
				this.context[step.key] = value;

				if (stepIndex < total - 1) {
					// Advance to next step
					this.activeComponent = this.buildStep(stepIndex + 1);
				} else {
					// Final step — deliver result
					this.onComplete({ ...this.context });

					if (this.opts.loop) {
						this.context = {};
						this.activeComponent = this.buildStep(0);
					} else {
						this.onCancel();
					}
				}
			},
			() => {
				if (stepIndex > 0) {
					delete this.context[step.key];
					this.activeComponent = this.buildStep(stepIndex - 1);
				} else {
					this.onCancel();
				}
			},
		);
	}

	render(width: number): string[] {
		return this.activeComponent.render(width);
	}

	handleInput(data: string): void {
		this.activeComponent.handleInput?.(data);
	}

	invalidate(): void {
		this.activeComponent.invalidate?.();
	}
}
