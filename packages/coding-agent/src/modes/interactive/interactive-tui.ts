import { ProcessTerminal, SwitchableTui, type Terminal } from "@draht/tui";
import type { UiMode } from "../../core/settings-manager.ts";
import { openBrowser } from "../../utils/open-browser.ts";

export interface InteractiveTuiOptions {
	uiMode: UiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
}

/** Interactive TUI with coding-agent mode names and URL activation. */
export class InteractiveTui extends SwitchableTui {
	constructor(options: InteractiveTuiOptions) {
		super(options.terminal ?? new ProcessTerminal(), {
			mode: options.uiMode === "fullscreen" ? "alternate" : "main",
			showHardwareCursor: options.showHardwareCursor,
			logDirectory: options.logDirectory,
			altScreen: { openUrl: openBrowser },
		});
	}

	get uiMode(): UiMode {
		return this.mode === "alternate" ? "fullscreen" : "regular";
	}

	setUiMode(mode: UiMode): boolean {
		return this.setMode(mode === "fullscreen" ? "alternate" : "main");
	}
}

export function createInteractiveTui(options: InteractiveTuiOptions): InteractiveTui {
	return new InteractiveTui(options);
}
