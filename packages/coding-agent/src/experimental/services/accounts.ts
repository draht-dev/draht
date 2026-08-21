import { type Context, defineService, type ReplicatedState } from "@draht/agent-core";

export interface AccountSummary {
	provider: string;
	configured: boolean;
}

export interface AccountsState {
	providers: AccountSummary[];
}

export interface Accounts {
	readonly state: ReplicatedState<AccountsState>;
	remove(provider: string, context: Context): Promise<void>;
}

export const Accounts = defineService<Accounts>("pi.accounts");
