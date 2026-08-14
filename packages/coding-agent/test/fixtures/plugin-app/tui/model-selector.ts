import { type Component, Container, type Focusable, getKeybindings, Input, Spacer, Text } from "@draht/tui";
import type { ModelSelectorState, ModelSpec } from "../protocol.ts";
import { accent, border, dim, success, type TuiPlugin, warning } from "./shared.ts";

class Rule implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return [border("─".repeat(Math.max(1, width)))];
	}
}

export function isModelSelectorState(value: unknown): value is ModelSelectorState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ModelSelectorState>;
	return candidate.schema === 1 && typeof candidate.catalogRevision === "number";
}

export const modelSelectorTui: TuiPlugin = {
	id: "@pi/model-selection-tui",
	setup(renderers) {
		renderers.set("model-selector", (context) => {
			if (!isModelSelectorState(context.view.state)) throw new Error("Invalid model-selector state");
			const component = new ModelSelectorComponent({
				state: context.view.state,
				models: context.app.providers.availableModels,
				query: context.query || context.view.state.query,
				onQueryChange: context.onQueryChange,
				send: context.send,
			});
			return { component, focus: component };
		});
	},
};

export class ModelSelectorComponent extends Container implements Focusable {
	private readonly input = new Input();
	private readonly list = new Container();
	private readonly models: readonly ModelSpec[];
	private readonly onQueryChange: (query: string) => void;
	private readonly send: (message: unknown) => Promise<void>;
	private readonly state: ModelSelectorState;
	private filteredModels: readonly ModelSpec[] = [];
	private selectedIndex = 0;
	private _focused = false;

	constructor(options: {
		state: ModelSelectorState;
		models: readonly ModelSpec[];
		query: string;
		onQueryChange(query: string): void;
		send(message: unknown): Promise<void>;
	}) {
		super();
		this.models = options.models;
		this.onQueryChange = options.onQueryChange;
		this.send = options.send;
		this.state = options.state;
		this.input.setValue(options.query);
		this.addChild(new Rule());
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(warning("Only showing models from configured providers. Use provider plugins to add more."), 0, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Rule());
		this.updateList();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
				this.updateList();
			}
		} else if (keybindings.matches(data, "tui.select.down")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateList();
			}
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			const model = this.filteredModels[this.selectedIndex];
			if (model) void this.send({ type: "select", provider: model.provider, modelId: model.modelId });
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			void this.send({ type: "cancel" });
		} else {
			this.input.handleInput(data);
			this.onQueryChange(this.input.getValue());
			this.selectedIndex = 0;
			this.updateList();
		}
	}

	private updateList(): void {
		const query = this.input.getValue().trim().toLowerCase();
		this.filteredModels = query
			? this.models.filter((model) =>
					`${model.provider} ${model.modelId} ${model.name}`.toLowerCase().includes(query),
				)
			: this.models;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.list.clear();
		const maxVisible = 10;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		for (let index = start; index < Math.min(start + maxVisible, this.filteredModels.length); index++) {
			const model = this.filteredModels[index];
			if (!model) continue;
			const selected = index === this.selectedIndex;
			this.list.addChild(
				new Text(
					`${selected ? accent("→ ") : "  "}${selected ? accent(model.modelId) : model.modelId} ${dim(`[${model.provider}]`)}`,
					0,
					0,
				),
			);
		}
		if (this.filteredModels.length === 0) {
			this.list.addChild(new Text(dim("  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.list.addChild(new Spacer(1));
				this.list.addChild(new Text(dim(`  Model Name: ${selected.name}`), 0, 0));
			}
		}
		this.list.addChild(new Spacer(1));
		if (this.state.refresh.status === "refreshing") {
			this.list.addChild(new Text(dim("  Refreshing model catalogs…"), 0, 0));
		} else if (this.state.refresh.status === "warning") {
			this.list.addChild(new Text(warning("  Could not refresh model catalogs; showing cached models."), 0, 0));
		} else {
			this.list.addChild(new Text(success("  Model catalogs refreshed."), 0, 0));
		}
	}
}
