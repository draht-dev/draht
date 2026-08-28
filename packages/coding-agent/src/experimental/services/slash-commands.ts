import { type Context, defineService } from "@draht/agent-core";

export interface SlashCommandCompletion {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface SlashCommandSelectItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface SlashCommandExecutionContext {
	readonly operation: Context;
	select(title: string, items: readonly SlashCommandSelectItem[], selectedValue?: string): Promise<string | undefined>;
	submitPrompt(message: string): Promise<void>;
	showStatus(message: string): void;
}

export interface SlashCommandContribution {
	readonly name: string;
	readonly description?: string;
	readonly argumentHint?: string;
	getArgumentCompletions?(
		argumentPrefix: string,
	): readonly SlashCommandCompletion[] | null | Promise<readonly SlashCommandCompletion[] | null>;
	run(args: string, context: SlashCommandExecutionContext): void | Promise<void>;
}

export interface SlashCommands {
	register(command: SlashCommandContribution): () => void;
	list(): readonly SlashCommandContribution[];
	subscribe(listener: (commands: readonly SlashCommandContribution[]) => void): () => void;
}

export const SlashCommands = defineService<SlashCommands>("pi.local.slash-commands", { local: true });
