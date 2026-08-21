import {
	CombinedAutocompleteProvider,
	Container,
	ScrollView,
	Spacer,
	type Terminal,
	Text,
	TuiAltScreen,
	VStack,
} from "@draht/tui";
import { type AppKeybinding, KeybindingsManager } from "../../../../../src/core/keybindings.ts";
import { CustomEditor } from "../../../../../src/modes/interactive/components/custom-editor.ts";
import type { SessionClient } from "../../lib/index.ts";
import type { CodingAgentPlugin } from "../plugins.ts";
import { type LaneConfiguration, Models } from "../services.ts";
import { PluginFooter } from "./footer.ts";
import {
	accent,
	bold,
	border,
	dim,
	errorStyle,
	type TuiCommand,
	type TuiContext,
	type ViewRenderer,
} from "./shared.ts";

/** Alternate-screen client whose commands and views are supplied by plugins. */
export class MinimalCodingAgentTui {
	readonly done: Promise<void>;
	readonly tui: TuiAltScreen;
	private readonly actions = new Map<AppKeybinding, () => void | Promise<void>>();
	private readonly client: SessionClient;
	private readonly commands = new Map<string, TuiCommand>();
	private readonly editor: CustomEditor;
	private readonly editorContainer = new Container();
	private readonly models: Models;
	private readonly renderers = new Map<string, ViewRenderer>();
	private readonly resolveDone: () => void;
	private readonly root: VStack;
	private readonly statusContainer = new Container();
	private readonly transcript = new Container();
	private activeView: string | undefined;
	private lastClearTime = 0;
	private lastConfiguration: LaneConfiguration;
	private query = "";
	private stopped = false;
	private unsubscribe: (() => void) | undefined;

	constructor(terminal: Terminal, client: SessionClient, plugins: readonly CodingAgentPlugin[]) {
		this.client = client;
		this.models = client.use(Models);
		this.lastConfiguration = structuredClone(this.models.state.value.configuration);
		const context: TuiContext = {
			actions: { register: (id, handler) => this.actions.set(id, handler) },
			commands: { register: (command) => this.commands.set(command.name, command) },
			use: (service) => client.use(service),
			views: {
				close: () => this.closeView(),
				open: (component, query = "") => this.openView(component, query),
				register: (component, renderer) => this.renderers.set(component, renderer),
			},
		};
		for (const plugin of plugins) plugin.client?.(context);

		this.tui = new TuiAltScreen(terminal);
		this.editor = new CustomEditor(
			this.tui,
			{
				borderColor: border,
				selectList: {
					description: dim,
					noMatch: dim,
					scrollInfo: dim,
					selectedPrefix: accent,
					selectedText: accent,
				},
			},
			new KeybindingsManager(),
			{ paddingX: 1 },
		);
		for (const [id, handler] of this.actions) {
			this.editor.onAction(
				id,
				() => void Promise.resolve(handler()).catch((error: unknown) => this.showError(error)),
			);
		}
		this.editor.onAction("app.clear", () => this.handleClear());
		this.editor.onSubmit = (value) => {
			this.editor.addToHistory(value);
			this.submit(value);
		};
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[
					...[...this.commands.values()].map(({ name, description, argumentHint }) => ({
						name,
						description,
						argumentHint,
					})),
					{ name: "quit", description: "Exit the plugin application" },
				],
				process.cwd(),
			),
		);
		this.editorContainer.addChild(this.editor);
		this.transcript.addChild(new Text(`${bold(accent("pi"))}${dim(" plugin application")}`, 1, 0));
		this.transcript.addChild(new Spacer(1));
		this.transcript.addChild(new Text("Remote session connected. Type /model to select a model.", 1, 0));
		const dock = new VStack([
			{ component: this.statusContainer, shrink: 1, minSize: 0 },
			{ component: this.editorContainer, shrink: 1, minSize: 3 },
			{ component: new PluginFooter(this.models.state, () => client.store.updates), basis: 2, shrink: 0 },
		]);
		this.root = new VStack([
			{
				component: new ScrollView(this.transcript, {
					follow: "end",
					primary: true,
					overscroll: "chain",
					scrollbar: "auto",
				}),
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 1,
			},
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		let settleDone!: () => void;
		this.done = new Promise<void>((resolve) => {
			settleDone = resolve;
		});
		this.resolveDone = settleDone;
	}

	start(): void {
		if (this.unsubscribe || this.stopped) return;
		this.unsubscribe = this.client.store.subscribe(() => {
			const connection = this.client.store.connection.value;
			if (connection.status === "disconnected") this.showStatus(`Disconnected: ${connection.reason}`, true);
			this.applyConfiguration();
			this.renderView();
			this.updateEditorBorder();
			this.tui.requestRender();
		});
		this.renderView();
		this.tui.setLayoutRoot(this.root);
		this.tui.start();
	}

	submit(input: string): void {
		const value = input.trim();
		if (!value) return;
		if (value === "/quit" || value === "quit") {
			this.stop();
			return;
		}
		if (!value.startsWith("/")) {
			this.showError(new Error("Only slash commands are supported by this test app"));
			return;
		}
		const separator = value.indexOf(" ");
		const name = value.slice(1, separator < 0 ? undefined : separator);
		const args = separator < 0 ? "" : value.slice(separator + 1).trim();
		const command = this.commands.get(name);
		if (!command) {
			this.showError(new Error(`Unknown command: ${name}`));
			return;
		}
		if (name !== "model") {
			this.transcript.addChild(new Spacer(1));
			this.transcript.addChild(new Text(`${accent("> ")}${value}`, 1, 0));
		}
		void Promise.resolve(command.run(args)).catch((error: unknown) => this.showError(error));
		this.tui.requestRender();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.client.close();
		this.tui.stop({ preserveScreen: true });
		this.resolveDone();
	}

	private applyConfiguration(): void {
		const current = this.models.state.value.configuration;
		if (
			this.lastConfiguration.model?.provider !== current.model?.provider ||
			this.lastConfiguration.model?.modelId !== current.model?.modelId
		) {
			this.showStatus(current.model ? `Model: ${current.model.modelId}` : "Model cleared");
		} else if (this.lastConfiguration.thinkingLevel !== current.thinkingLevel) {
			this.showStatus(`Thinking level: ${current.thinkingLevel}`);
		}
		this.lastConfiguration = structuredClone(current);
	}

	private openView(component: string, query: string): void {
		this.activeView = component;
		this.query = query;
		this.renderView();
		this.tui.requestRender();
	}

	private closeView(): void {
		this.activeView = undefined;
		this.query = "";
		this.renderView();
		this.tui.requestRender();
	}

	private renderView(): void {
		this.editorContainer.clear();
		if (!this.activeView) {
			this.editorContainer.addChild(this.editor);
			this.tui.setFocus(this.editor);
			return;
		}
		const renderer = this.renderers.get(this.activeView);
		if (!renderer) {
			this.editorContainer.addChild(new Text(dim(`No TUI renderer for ${this.activeView}`), 1, 0));
			this.tui.setFocus(null);
			return;
		}
		const rendered = renderer({
			close: () => this.closeView(),
			query: this.query,
			setQuery: (query) => {
				this.query = query;
			},
		});
		this.editorContainer.addChild(rendered.component);
		this.tui.setFocus(rendered.focus);
	}

	private handleClear(): void {
		const now = Date.now();
		if (now - this.lastClearTime < 500) {
			this.stop();
			return;
		}
		this.editor.setText("");
		this.showStatus(undefined);
		this.lastClearTime = now;
		this.tui.requestRender();
	}

	private showError(error: unknown): void {
		this.showStatus(error instanceof Error ? error.message : String(error), true);
		this.tui.requestRender();
	}

	private showStatus(message: string | undefined, isError = false): void {
		this.statusContainer.clear();
		if (message) this.statusContainer.addChild(new Text(isError ? errorStyle(message) : accent(message), 1, 0));
	}

	private updateEditorBorder(): void {
		const state = this.models.state.value;
		const current = state.configuration.model;
		const selected = current
			? state.catalog.availableModels.find(
					(model) => model.provider === current.provider && model.modelId === current.modelId,
				)
			: undefined;
		this.editor.borderColor = selected?.reasoning ? accent : border;
	}
}
