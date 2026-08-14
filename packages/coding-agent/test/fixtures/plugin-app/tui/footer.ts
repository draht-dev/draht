import { homedir } from "node:os";
import { type Component, truncateToWidth, visibleWidth } from "@draht/tui";
import type { CodingAgentClientStore } from "../client.ts";
import { dim } from "./shared.ts";

export class PluginFooter implements Component {
	private readonly store: CodingAgentClientStore;

	constructor(store: CodingAgentClientStore) {
		this.store = store;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const snapshot = this.store.app;
		const home = homedir();
		const cwd = process.cwd();
		const displayCwd = cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
		const current = snapshot.configuration.model;
		const currentSpec = current
			? snapshot.providers.availableModels.find(
					(model) => model.provider === current.provider && model.modelId === current.modelId,
				)
			: undefined;
		const model = current
			? `(${current.provider}) ${current.modelId}${
					currentSpec?.reasoning
						? snapshot.configuration.thinkingLevel === "off"
							? " • thinking off"
							: ` • ${snapshot.configuration.thinkingLevel}`
						: ""
				}`
			: "no-model";
		const left = `events ${this.store.events.length} · catalogue r${snapshot.providers.revision}`;
		const right = truncateToWidth(model, Math.max(0, width - visibleWidth(left) - 2), "");
		const padding = " ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right)));
		return [truncateToWidth(dim(displayCwd), width, dim("...")), dim(`${left}${padding}${right}`)];
	}
}
