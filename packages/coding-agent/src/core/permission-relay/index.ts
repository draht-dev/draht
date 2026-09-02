/**
 * Permission relay — the seam that lets a remote surface answer a local dialog.
 */

import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import type { ExtensionUIContext } from "../extensions/types.ts";

export { APPROVE_OPTION_ID, createRelayUIContext, DENY_OPTION_ID } from "./relay-ui-context.ts";
export type {
	LocalSurface,
	PermissionRelay,
	RelayAnswer,
	RelayAsk,
	RelayDecider,
	RelayEnded,
	RelayOutcome,
} from "./types.ts";
export { isRelayEnded, RELAY_ANSWERED, RELAY_CANCELLED } from "./types.ts";

/**
 * The base context to decorate when a mode bound none of its own.
 *
 * `noOpUIContext` in runner.ts is module-private, and the relay decorator needs SOMETHING to
 * delegate its ~25 non-decorated members to. This is that something: every answer is the
 * fail-closed one, and every side effect is a no-op. It exists so `hasAnswerSurface()` can stay
 * honest — a decorator over this base reports `baseIsLive: false`, so a session with zero attached
 * clients keeps `runner.hasUI() === false` and its callers keep their loud fail-closed block
 * instead of receiving a fabricated "denied".
 */
export const noOpRelayBaseUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};
