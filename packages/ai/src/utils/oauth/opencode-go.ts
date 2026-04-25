/**
 * OpenCode Go login flow.
 *
 * OpenCode Go (https://opencode.ai/zen/go) does not use OAuth — the user signs
 * in to the OpenCode Zen dashboard, copies an API key, and pastes it back.
 * We model it as an OAuth provider so it shows up in the same /login UI as the
 * real OAuth providers; credentials are stored with `access` = API key and a
 * far-future `expires` so the refresh path is never taken.
 */

import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

const DASHBOARD_URL = "https://opencode.ai/zen";
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export async function loginOpenCodeGo(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
}): Promise<OAuthCredentials> {
	options.onAuth({
		url: DASHBOARD_URL,
		instructions: "Sign in to OpenCode Zen, subscribe to Go, then copy your API key.",
	});

	const key = (await options.onPrompt({ message: "Paste your OpenCode API key:" })).trim();
	if (!key) {
		throw new Error("Missing OpenCode API key");
	}

	return {
		access: key,
		refresh: key,
		expires: NEVER_EXPIRES,
	};
}

export async function refreshOpenCodeGoToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	return { ...credentials, expires: NEVER_EXPIRES };
}

export const opencodeGoOAuthProvider: OAuthProviderInterface = {
	id: "opencode-go",
	name: "OpenCode Go",

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginOpenCodeGo({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshOpenCodeGoToken(credentials);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
