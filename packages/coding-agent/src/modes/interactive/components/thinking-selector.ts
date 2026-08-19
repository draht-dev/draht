import type { ThinkingLevel } from "@draht/agent-core";
import {
	Container,
	type Focusable,
	getKeybindings,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@draht/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Maximum reasoning (~32k tokens)",
	max: "Unconstrained reasoning",
};

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
	private selectList: SelectList;
	private onSelectAsDefault?: (level: ThinkingLevel) => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
	) {
		super();
		this.onSelectAsDefault = onSelectAsDefault;

		const thinkingLevels: SelectItem[] = availableLevels.map((level) => ({
			value: level,
			label: level,
			description: LEVEL_DESCRIPTIONS[level],
		}));

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("Thinking Level", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyDisplayText("app.thinking.cycle")} cycles thinking levels in-session`, 0, 0));
		this.addChild(new Spacer(1));

		// Create selector
		this.selectList = new SelectList(
			thinkingLevels,
			thinkingLevels.length,
			getSelectListTheme(),
			THINKING_SELECT_LIST_LAYOUT,
		);

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex((item) => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as ThinkingLevel);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		const confirmKey = keyDisplayText("tui.select.confirm");
		const confirmAsDefaultKey = keyDisplayText("tui.select.confirmAsDefault");
		const cancelKey = keyDisplayText("tui.select.cancel");
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${confirmKey} to select · ${confirmAsDefaultKey} to set as default · ${cancelKey} to cancel`,
				),
				0,
				0,
			),
		);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (getKeybindings().matches(keyData, "tui.select.confirmAsDefault") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value as ThinkingLevel);
			return;
		}

		this.selectList.handleInput(keyData);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
