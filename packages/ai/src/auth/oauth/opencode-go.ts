/**
 * OpenCode Go login flow.
 *
 * OpenCode Go (https://opencode.ai/zen/go) does not use OAuth — the user signs
 * in to the OpenCode Zen dashboard, copies an API key, and pastes it back.
 * We model it as an OAuth flow so it shows up in the same /login UI as the
 * real OAuth providers; credentials are stored with `access` = API key and a
 * far-future `expires` so the refresh path is never taken.
 */

import type { AuthInteraction, OAuthAuth, OAuthCredential } from "../types.ts";

const DASHBOARD_URL = "https://opencode.ai/zen";
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export async function loginOpenCodeGo(interaction: AuthInteraction): Promise<OAuthCredential> {
	interaction.notify({
		type: "auth_url",
		url: DASHBOARD_URL,
		instructions: "Sign in to OpenCode Zen, subscribe to Go, then copy your API key.",
	});

	const key = (await interaction.prompt({ type: "secret", message: "Paste your OpenCode API key:" })).trim();
	if (!key) {
		throw new Error("Missing OpenCode API key");
	}

	return {
		type: "oauth",
		access: key,
		refresh: key,
		expires: NEVER_EXPIRES,
	};
}

export async function refreshOpenCodeGoToken(credential: OAuthCredential): Promise<OAuthCredential> {
	return { ...credential, expires: NEVER_EXPIRES };
}

export const opencodeGoOAuth: OAuthAuth = {
	name: "OpenCode Go",
	loginLabel: "Paste an OpenCode Zen API key",
	login: loginOpenCodeGo,
	refresh: (credential) => refreshOpenCodeGoToken(credential),

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
