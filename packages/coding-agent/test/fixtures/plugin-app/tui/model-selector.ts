import { type Component, Container, type Focusable, getKeybindings, Input, Spacer, Text } from "@draht/tui";
import { rpcOptions } from "../kernel.ts";
import type { ModelSpec, ModelsService, ModelsState } from "../protocol.ts";
import { accent, border, dim, success, type TuiContext, warning } from "./shared.ts";

class Rule implements Component {
	invalidate(): void {}
	render(width: number): string[] {
		return [border("─".repeat(Math.max(1, width)))];
	}
}

export function registerModelTui(context: TuiContext, models: ModelsService): void {
	let refreshController: AbortController | undefined;
	const resolve = (query: string): ModelSpec | undefined => {
		const available = models.state.value.catalog.availableModels;
		const qualified = available.find((model) => `${model.provider}/${model.modelId}` === query);
		if (qualified) return qualified;
		const unqualified = available.filter((model) => model.modelId === query);
		return unqualified.length === 1 ? unqualified[0] : undefined;
	};
	context.commands.register({
		name: "model",
		description: "Select model",
		argumentHint: "[provider/]model",
		async run(args) {
			if (args) {
				let model = resolve(args);
				if (!model) {
					await models.refresh();
					model = resolve(args);
				}
				if (model) return models.select(model);
			}
			refreshController?.abort();
			const controller = new AbortController();
			refreshController = controller;
			context.views.open("model-selector", args);
			void models
				.refresh(rpcOptions({ signal: controller.signal }))
				.catch(() => {})
				.finally(() => {
					if (refreshController === controller) refreshController = undefined;
				});
		},
	});
	context.views.register("model-selector", (view) => {
		const close = () => {
			refreshController?.abort();
			refreshController = undefined;
			view.close();
		};
		const component = new ModelSelector({
			state: models.state.value,
			query: view.query,
			setQuery: view.setQuery,
			cancel: close,
			select: async (model) => {
				await models.select(model);
				close();
			},
		});
		return { component, focus: component };
	});
}

class ModelSelector extends Container implements Focusable {
	private readonly input = new Input();
	private readonly list = new Container();
	private readonly cancel: () => void;
	private readonly select: (model: ModelSpec) => Promise<void>;
	private readonly setQuery: (query: string) => void;
	private readonly state: ModelsState;
	private filtered: readonly ModelSpec[] = [];
	private selected = 0;
	private _focused = false;

	constructor(options: {
		state: ModelsState;
		query: string;
		setQuery(query: string): void;
		cancel(): void;
		select(model: ModelSpec): Promise<void>;
	}) {
		super();
		this.cancel = options.cancel;
		this.select = options.select;
		this.setQuery = options.setQuery;
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
		this.update();
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.up")) {
			if (this.filtered.length) this.selected = this.selected ? this.selected - 1 : this.filtered.length - 1;
		} else if (keys.matches(data, "tui.select.down")) {
			if (this.filtered.length) this.selected = this.selected === this.filtered.length - 1 ? 0 : this.selected + 1;
		} else if (keys.matches(data, "tui.select.confirm")) {
			const model = this.filtered[this.selected];
			if (model) void this.select(model);
			return;
		} else if (keys.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		} else {
			this.input.handleInput(data);
			this.setQuery(this.input.getValue());
			this.selected = 0;
		}
		this.update();
	}

	private update(): void {
		const query = this.input.getValue().trim().toLowerCase();
		const models = this.state.catalog.availableModels;
		this.filtered = query
			? models.filter((model) => `${model.provider} ${model.modelId} ${model.name}`.toLowerCase().includes(query))
			: models;
		this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
		this.list.clear();
		const start = Math.max(0, Math.min(this.selected - 5, this.filtered.length - 10));
		for (let index = start; index < Math.min(start + 10, this.filtered.length); index++) {
			const model = this.filtered[index];
			if (!model) continue;
			const selected = index === this.selected;
			this.list.addChild(
				new Text(
					`${selected ? accent("→ ") : "  "}${selected ? accent(model.modelId) : model.modelId} ${dim(`[${model.provider}]`)}`,
					0,
					0,
				),
			);
		}
		if (!this.filtered.length) this.list.addChild(new Text(dim("  No matching models"), 0, 0));
		else {
			const model = this.filtered[this.selected];
			if (model) {
				this.list.addChild(new Spacer(1));
				this.list.addChild(new Text(dim(`  Model Name: ${model.name}`), 0, 0));
			}
		}
		this.list.addChild(new Spacer(1));
		if (this.state.refresh.status === "refreshing")
			this.list.addChild(new Text(dim("  Refreshing model catalogs…"), 0, 0));
		else if (this.state.refresh.status === "warning")
			this.list.addChild(new Text(warning("  Could not refresh model catalogs; showing cached models."), 0, 0));
		else if (this.state.refresh.status === "done")
			this.list.addChild(new Text(success("  Model catalogs refreshed."), 0, 0));
	}
}
