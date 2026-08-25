import { defineService } from "@draht/agent-core";
import type { Models } from "./models.ts";

export interface Tui {
	registerModelSelection(models: Models): () => void;
	refresh(): void;
	setStatus(status: string): void;
}

export const Tui = defineService<Tui>("pi.local.tui", { rpc: false });
