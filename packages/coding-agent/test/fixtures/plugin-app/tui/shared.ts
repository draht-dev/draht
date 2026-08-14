import type { Component } from "@draht/tui";
import type { CodingAgentSnapshot, WireView } from "../protocol.ts";

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

export interface RenderedView {
	component: Component;
	focus: Component;
}

export interface ViewRendererContext {
	app: CodingAgentSnapshot;
	query: string;
	onQueryChange(query: string): void;
	send(message: unknown): Promise<void>;
	view: WireView;
}

export type ViewRenderer = (context: ViewRendererContext) => RenderedView;

export interface TuiPlugin {
	id: string;
	setup(renderers: Map<string, ViewRenderer>): void;
}
