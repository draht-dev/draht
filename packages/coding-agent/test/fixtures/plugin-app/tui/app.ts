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
import { KeybindingsManager } from "../../../../src/core/keybindings.ts";
import { CustomEditor } from "../../../../src/modes/interactive/components/custom-editor.ts";
import type { SessionClient } from "../client.ts";
import type { CodingAgentEvent } from "../protocol.ts";
import { PluginFooter } from "./footer.ts";
import { accent, bold, border, dim, errorStyle, type TuiPlugin, type ViewRenderer } from "./shared.ts";

/** Alternate-screen projection of the remote client store. */
export class MinimalCodingAgentTui {
	readonly done: Promise<void>;
	readonly tui: TuiAltScreen;
	private readonly client: SessionClient;
	private readonly editor: CustomEditor;
	private readonly editorContainer = new Container();
	private readonly renderers = new Map<string, ViewRenderer>();
	private readonly resolveDone: () => void;
	private readonly root: VStack;
	private readonly statusContainer = new Container();
	private readonly transcript = new Container();
	private eventIndex = 0;
	private lastClearTime = 0;
	private query = "";
	private stopped = false;
	private unsubscribe: (() => void) | undefined;

	constructor(terminal: Terminal, client: SessionClient, plugins: readonly TuiPlugin[]) {
		this.client = client;
		for (const plugin of plugins) plugin.setup(this.renderers);
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
		this.editor.onAction("app.clear", () => this.handleClear());
		this.editor.onSubmit = (value) => {
			this.editor.addToHistory(value);
			this.submit(value);
		};
		this.editorContainer.addChild(this.editor);
		this.transcript.addChild(new Text(`${bold(accent("pi"))}${dim(" plugin application")}`, 1, 0));
		this.transcript.addChild(new Spacer(1));
		this.transcript.addChild(new Text("Remote session connected. Type /model to select a model.", 1, 0));

		const dock = new VStack([
			{ component: this.statusContainer, shrink: 1, minSize: 0 },
			{ component: this.editorContainer, shrink: 1, minSize: 3 },
			{ component: new PluginFooter(client.store), basis: 2, shrink: 0 },
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
		for (const action of this.client.store.app.actions) {
			this.editor.onAction(action.id, () => {
				void this.client.invokeAction(action.id).catch((error: unknown) => this.showError(error));
			});
		}
		this.editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider(
				[...this.client.store.app.commands, { name: "quit", description: "Exit the plugin application" }],
				process.cwd(),
			),
		);
		this.unsubscribe = this.client.store.subscribe(() => {
			this.reduceEvents();
			this.renderView();
			this.updateEditorBorder();
			this.tui.requestRender();
		});
		this.renderView();
		this.tui.setLayoutRoot(this.root);
		this.tui.start();
	}

	submit(input: string): void {
		const command = input.trim();
		if (!command) return;
		if (command === "/quit" || command === "quit") {
			this.stop();
			return;
		}
		if (command !== "/model") {
			this.transcript.addChild(new Spacer(1));
			this.transcript.addChild(new Text(`${accent(">")} ${command}`, 1, 0));
			this.showStatus(`Running ${command}`);
		}
		void this.client.submit(command).catch((error: unknown) => this.showError(error));
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

	private reduceEvents(): void {
		while (this.eventIndex < this.client.store.events.length) {
			this.applyEvent(this.client.store.events[this.eventIndex++]!);
		}
	}

	private applyEvent(event: CodingAgentEvent): void {
		if (event.type !== "config_update") return;
		if (
			event.previous.model?.provider !== event.value.model?.provider ||
			event.previous.model?.modelId !== event.value.model?.modelId
		) {
			this.showStatus(event.value.model ? `Model: ${event.value.model.modelId}` : "Model cleared");
		} else if (event.previous.thinkingLevel !== event.value.thinkingLevel) {
			this.showStatus(`Thinking level: ${event.value.thinkingLevel}`);
		}
	}

	private renderView(): void {
		this.editorContainer.clear();
		const view = this.client.store.views[0];
		if (!view) {
			this.query = "";
			this.editorContainer.addChild(this.editor);
			this.tui.setFocus(this.editor);
			return;
		}
		const renderer = this.renderers.get(view.component);
		if (!renderer) {
			this.editorContainer.addChild(new Text(dim(`No TUI renderer for ${view.component}`), 1, 0));
			this.tui.setFocus(null);
			return;
		}
		const rendered = renderer({
			app: this.client.store.app,
			query: this.query,
			onQueryChange: (query) => {
				this.query = query;
			},
			send: (message) => this.client.sendView(view.id, message),
			view,
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
		const snapshot = this.client.store.app;
		const current = snapshot.configuration.model;
		const currentSpec = current
			? snapshot.providers.availableModels.find(
					(model) => model.provider === current.provider && model.modelId === current.modelId,
				)
			: undefined;
		this.editor.borderColor = currentSpec?.reasoning ? accent : border;
	}
}
