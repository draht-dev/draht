import { type Context, defineRemoteService, type RemoteState } from "@draht/agent-core";

export interface AccountSummary {
	provider: string;
	configured: boolean;
}

export interface AccountsState {
	providers: AccountSummary[];
}

export interface AccountsService {
	readonly state: RemoteState<AccountsState>;
	remove(provider: string, context: Context): Promise<void>;
}

export const Accounts = defineRemoteService<AccountsService>("accounts");
