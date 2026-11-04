/**
 * The auth provider for connections to an OAuth-protected MCP server: it sends the stored access token
 * and refreshes it, but never starts a browser flow. When the user has to sign in, it fails with
 * `McpOAuthAuthorizationRequiredError` and the application runs `startMcpSignIn`.
 */

import type { AuthProvider, McpFetch } from "../auth-provider.ts";
import { parseClientMetadataBaseUrl } from "./client-metadata-base.ts";
import {
	clientMetadataBaseUrl,
	createOAuthClientProvider,
	DEFAULT_REDIRECT_URL,
	loopbackSettings,
	type McpOAuthClientOptions,
	type McpOAuthSettings,
	matchesClient,
	registeredRedirectUrls,
	timedFetch,
} from "./client-settings.ts";
import { parseWwwAuthenticate } from "./discovery.ts";
import { McpOAuthAuthorizationRequiredError } from "./errors.ts";
import { authorizeMcp, type OAuthFlowResult } from "./flow.ts";
import type { McpOAuthState } from "./provider.ts";
import type { OAuthChallenge } from "./types.ts";

/** An `AuthProvider` that can say when its refreshes have finished. */
export interface McpAuthProvider extends AuthProvider {
	/** Resolves when no refresh is running, so shutdown does not drop rotated tokens before they are saved. */
	settled(): Promise<void>;
}

/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;

/**
 * Auth provider for MCP connections: sends the stored access token and refreshes it when it is about
 * to expire or after a 401. Throws `McpOAuthAuthorizationRequiredError` when the user has to sign in,
 * including when the server asks for more scope (`insufficient_scope`). `onChallenge` receives the
 * server's `WWW-Authenticate` challenge so sign-in can use its resource metadata URL and scope.
 * `settings` is only called when a refresh is needed, so a secret that fails to resolve fails the
 * refresh instead of the whole connection setup, and reading a cached token never resolves one.
 *
 * Many servers rotate refresh tokens, so two refreshes with the same refresh token lose the grant.
 * Requests in this process share one refresh, and other processes are kept out by the store's
 * refresh lock, held from reading the tokens to saving new ones. Tokens that changed meanwhile
 * (another process refreshed them, or the user signed in) are used without refreshing.
 *
 * draht: stored tokens are only sent and refreshed when they belong to the client `clientMetadataBaseUrl`
 * names; tokens of a former registration mode or metadata base need a new sign-in.
 */
export function createMcpAuthProvider(
	options: Omit<McpOAuthClientOptions, "settings"> & {
		/**
		 * draht: the client stored tokens must belong to: the operator's validated `clientMetadataBaseUrl` with
		 * `cimd`, `undefined` otherwise. Passed apart from `settings` so reading a cached token never calls
		 * `settings`, which may resolve secrets. Must name the same base as `settings().clientMetadataBaseUrl`;
		 * a refresh with settings that name another one is refused.
		 */
		clientMetadataBaseUrl: string | undefined;
		settings: () => McpOAuthSettings;
		onChallenge: (challenge: OAuthChallenge) => void;
		/**
		 * A redirect URI the application signs in with, such as its https callback route. Refreshing tokens
		 * from a sign-in with a Client ID Metadata Document needs a redirect URI the documents list; a
		 * refresh never redirects, so any listed one works. Default: the loopback redirect URI of `settings`.
		 */
		redirectUrl?: string;
	},
): McpAuthProvider {
	const { serverUrl, store, redirectUrl } = options;
	const baseUrl =
		options.clientMetadataBaseUrl === undefined
			? undefined
			: parseClientMetadataBaseUrl(options.clientMetadataBaseUrl);
	if (options.clientMetadataBaseUrl !== undefined && !baseUrl) {
		throw new Error("oauth.clientMetadataBaseUrl must be an absolute HTTPS URL without userinfo, query, or fragment");
	}
	const owns = (state: McpOAuthState | undefined) => matchesClient(state, serverUrl, baseUrl);
	let refreshing: Promise<void> | undefined;

	/** Replace `staleToken`, the access token that expired or was rejected. */
	const refresh = (staleToken: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		refreshing ??= store
			.withRefreshLock(async () => {
				const state = await store.load();
				if (!owns(state)) throw new McpOAuthAuthorizationRequiredError();
				if (state?.tokens?.access_token !== staleToken) return;
				if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
				const client = { ...options, settings: options.settings() };
				const result = await refreshStoredTokens(client, state, { fetch, challenge, redirectUrl });
				if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
			})
			.finally(() => {
				refreshing = undefined;
			});
		return refreshing;
	};

	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = await store.load();
			if (!owns(state)) return undefined;
			const token = state?.tokens?.access_token;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			// Failures fall through: the request goes out with the old token and a 401 decides what happens.
			await refresh(token).catch(() => undefined);
			const refreshed = await store.load();
			return owns(refreshed) ? refreshed?.tokens?.access_token : undefined;
		},
		onUnauthorized: async (context) => {
			const challenge = parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			// A refresh keeps the granted scope, so more scope needs a new sign-in.
			if (challenge.error === "insufficient_scope") throw new McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
		settled: async () => {
			await refreshing?.catch(() => undefined);
		},
	};
}

/**
 * Refresh the tokens of `state` with the stored client (or the document it signed in with), or report
 * `REDIRECT` when that is not possible. `options.redirectUrl` is a redirect URI the application signs in
 * with, tried before the loopback ones of the settings and the stored client. Never registers a client or
 * prepares an authorization request, so a pending sign-in stays usable. Call while holding the store's
 * refresh lock. Not cancellable: a refresh the server answered may have rotated the refresh token, so its
 * answer must be saved.
 * draht: tokens that do not belong to the client `client.settings` identify as are not refreshed.
 */
export async function refreshStoredTokens(
	client: McpOAuthClientOptions,
	state: McpOAuthState,
	options: { fetch?: McpFetch; challenge?: OAuthChallenge; redirectUrl?: string } = {},
): Promise<OAuthFlowResult> {
	if (!matchesClient(state, client.serverUrl, clientMetadataBaseUrl(client.settings))) return "REDIRECT";
	// Refreshing never redirects the user; the redirect URI only decides whether tokens without a stored
	// client can be refreshed with a Client ID Metadata Document, so any URI the documents list works.
	const candidates = [
		options.redirectUrl,
		loopbackSettings(client.settings).fixedRedirectUrl,
		registeredRedirectUrls(state.clientInformation)[0],
	].filter((url) => url !== undefined);
	const redirectUrl =
		candidates.find((url) => client.clientMetadataDocuments?.listsRedirectUrl(url)) ?? DEFAULT_REDIRECT_URL;
	return authorizeMcp(createOAuthClientProvider(client, redirectUrl), {
		serverUrl: client.serverUrl,
		resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
		authorizationServerMetadataUrl: client.settings.authServerMetadataUrl,
		fetch: timedFetch(options.fetch),
		refreshOnly: true,
	});
}
