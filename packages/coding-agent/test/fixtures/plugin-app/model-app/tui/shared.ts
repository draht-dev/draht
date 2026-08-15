import type { Component } from "@draht/tui";
import type { AppKeybinding } from "../../../../../src/core/keybindings.ts";
import type { Service } from "../../lib/index.ts";

const style =
	(open: number, close: number) =>
	(text: string): string =>
		`\x1b[${open}m${text}\x1b[${close}m`;

export const bold = style(1, 22);
export const dim = style(2, 22);
export const accent = style(36, 39);
export const success = style(32, 39);
export const warning = style(33, 39);
export const errorStyle = style(31, 39);
export const border = (text: string): string => `\x1b[38;5;240m${text}\x1b[39m`;

export interface TuiCommand {
	name: string;
	description: string;
	argumentHint?: string;
	run(args: string): void | Promise<void>;
}

export interface RenderedView {
	component: Component;
	focus: Component;
}

export interface LocalViewContext {
	close(): void;
	query: string;
	setQuery(query: string): void;
}

export type ViewRenderer = (context: LocalViewContext) => RenderedView;

export interface TuiContext {
	actions: { register(id: AppKeybinding, handler: () => void | Promise<void>): void };
	commands: { register(command: TuiCommand): void };
	use<T>(service: Service<T>): T;
	views: {
		close(): void;
		open(component: string, query?: string): void;
		register(component: string, renderer: ViewRenderer): void;
	};
}
