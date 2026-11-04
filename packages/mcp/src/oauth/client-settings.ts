/**
 * The OAuth client that sign-in and refreshes use for one MCP server: its settings, how it identifies
 * itself (a pre-registered client, the operator's Client ID Metadata Document, or dynamic client
 * registration), and the `McpOAuthProvider` built from them.
 */

import { createHash } from "node:crypto";
import type { McpFetch } from "../auth-provider.ts";
import { parseClientMetadataBaseUrl } from "./client-metadata-base.ts";
import type { OAuthClientMetadataDocument } from "./flow.ts";
import { McpOAuthProvider, type McpOAuthState, type McpOAuthStateStore } from "./provider.ts";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed } from "./types.ts";

/** Client settings of one MCP server, usually from the application's configuration. */
export interface McpOAuthSettings {
	/** Pre-registered client id. Without it, sign-in uses a Client ID Metadata Document or registers a client. */
	clientId?: string;
	/** Already resolved. */
	clientSecret?: string;
	/**
	 * Port of the loopback callback server, for clients registered with a fixed redirect URI. Without
	 * `callbackUrl`, the redirect URI is `http://127.0.0.1:<port>/callback`. Only `listenForLoopbackSignIn`
	 * and the redirect URI of refreshes use it; `startMcpSignIn` and `completeMcpSignIn` take theirs from
	 * the caller.
	 */
	callbackPort?: number;
	/**
	 * Loopback redirect URI registered for `clientId`, for example `http://localhost:8080/oauth/callback`.
	 * Without a port, the callback server listens on `callbackPort` or a free port, which is added to the
	 * URI (RFC 8252). Default: `http://127.0.0.1/callback`. Like `callbackPort`, only `listenForLoopbackSignIn`
	 * and refreshes use it.
	 */
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. Default: the scopes the server advertises. */
	scope?: string;
	/** `client_name` for dynamic client registration. Default: the application's `clientName`. */
	clientName?: string;
	/**
	 * How to identify without `clientId`. `dcr` (default): dynamic client registration. `cimd`: the
	 * operator's Client ID Metadata Document under `clientMetadataBaseUrl`, and sign-in fails when the
	 * authorization server does not support documents for public clients.
	 *
	 * draht: upstream's `auto` (the application's documents whenever the server supports them) is not
	 * offered and is rejected: a document is only ever used when the operator configured one.
	 */
	clientRegistration?: "dcr" | "cimd";
	/**
	 * draht: required for `cimd` and rejected otherwise. The https base the operator hosts the documents
	 * under (`client.json` and `<callback ID>/client.json`); see `parseClientMetadataBaseUrl`. `cimd`
	 * cannot be combined with `clientId`, `clientName`, or `clientSecret`: the document is a public client.
	 */
	clientMetadataBaseUrl?: string;
	/**
	 * Authorization server metadata document to use instead of discovery through the server, for servers
	 * that advertise a wrong authorization server or none. It is trusted as configured.
	 */
	authServerMetadataUrl?: URL;
}

/**
 * The redirect URIs the operator's Client ID Metadata Documents list: `<base>/client.json` lists the
 * redirect URI itself, and `<base>/<callback ID>/client.json` the URI with the path `<path>/<callback ID>`.
 *
 * draht: upstream's `baseUrl` field is left out. It let the application name the document host (pi.dev
 * for pi), so documents could be used that no operator configured. The base comes only from
 * `McpOAuthSettings.clientMetadataBaseUrl`.
 */
export interface McpClientMetadataDocuments {
	/** Whether the documents list `redirectUrl`. Loopback redirect URIs match on any port (RFC 8252). */
	listsRedirectUrl(redirectUrl: string): boolean;
}

/** State store of one MCP server, with a lock that keeps other processes from refreshing at the same time. */
export interface McpOAuthServerStore extends McpOAuthStateStore {
	/**
	 * Run `fn` while no other process refreshes the server's tokens. Not reentrant: `startMcpSignIn` and
	 * `createMcpAuthProvider` take it themselves, so never call them from `fn`.
	 */
	withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** The OAuth client of one MCP server: where its state lives, its settings, and the application's identity. */
export interface McpOAuthClientOptions {
	serverUrl: string;
	store: McpOAuthServerStore;
	settings: McpOAuthSettings;
	/** `client_name` for dynamic client registration unless `settings.clientName` names another: the application. */
	clientName: string;
	/** Which redirect URIs the operator's documents list. Omitted: `cimd` fails. */
	clientMetadataDocuments?: McpClientMetadataDocuments;
}

/**
 * The validated Client ID Metadata Document base of `settings`: the normalized `clientMetadataBaseUrl`
 * for `cimd`, `undefined` for dynamic client registration or a pre-registered client. Throws for settings
 * the configuration boundary rejects, so an application that skips that validation still cannot fall into
 * a document the operator did not configure or send a secret for a public client.
 */
export function clientMetadataBaseUrl(settings: McpOAuthSettings): string | undefined {
	const registration: unknown = settings.clientRegistration;
	if (registration !== undefined && registration !== "dcr" && registration !== "cimd") {
		throw new Error('oauth.clientRegistration must be "dcr" or "cimd"');
	}
	if (registration !== "cimd") {
		if (settings.clientMetadataBaseUrl !== undefined) {
			throw new Error('oauth.clientMetadataBaseUrl requires oauth.clientRegistration "cimd"');
		}
		return undefined;
	}
	if (settings.clientId !== undefined || settings.clientName !== undefined || settings.clientSecret !== undefined) {
		throw new Error(
			'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId, oauth.clientName, or oauth.clientSecret',
		);
	}
	if (settings.clientMetadataBaseUrl === undefined)
		throw new Error('oauth.clientMetadataBaseUrl is required for "cimd"');
	const base = parseClientMetadataBaseUrl(settings.clientMetadataBaseUrl);
	if (!base) {
		throw new Error(
			'oauth.clientMetadataBaseUrl is required for "cimd" and must be an absolute HTTPS URL without userinfo, query, or fragment',
		);
	}
	return base;
}

/** An `McpOAuthProvider` for the client, redirecting to `redirectUrl` or the document's variant of it. */
export function createOAuthClientProvider(
	options: McpOAuthClientOptions,
	redirectUrl: string,
	onRedirect: (url: URL) => void = () => {},
): McpOAuthProvider {
	const { serverUrl, settings, clientMetadataDocuments: documents } = options;
	const baseUrl = clientMetadataBaseUrl(settings);
	return new McpOAuthProvider({
		serverUrl,
		redirectUrl,
		clientMetadata: { client_name: settings.clientName ?? options.clientName },
		clientMetadataDocument: baseUrl
			? (metadata) => {
					if (!documents?.listsRedirectUrl(redirectUrl)) {
						throw new Error(
							`oauth.clientRegistration "cimd" needs Client ID Metadata Documents that list the redirect URI ${redirectUrl}`,
						);
					}
					return clientMetadataDocument(baseUrl, serverUrl, redirectUrl, metadata);
				}
			: undefined,
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		store: options.store,
		onRedirect,
	});
}

/**
 * Whether the client identifies with a Client ID Metadata Document instead of registering: only with
 * `cimd` and the operator's validated base. draht: upstream's `auto` also used the application's
 * documents when the server supported them; that mode does not exist here.
 */
export function offersClientMetadataDocument(settings: McpOAuthSettings): boolean {
	return clientMetadataBaseUrl(settings) !== undefined;
}

/**
 * The operator's Client ID Metadata Document to use, chosen like Codex chooses its own. Without the `iss`
 * parameter in authorization responses (RFC 9207), the redirect URI and the document are specific to the
 * MCP server, so a response cannot be mixed up with one from another authorization server (RFC 9700
 * section 4.4.2.2). Fails when the authorization server does not support documents for public clients:
 * draht never falls back to registering a client the operator did not ask for.
 */
function clientMetadataDocument(
	baseUrl: string,
	serverUrl: string,
	redirectUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
): OAuthClientMetadataDocument {
	if (
		!metadata?.client_id_metadata_document_supported ||
		!metadata.token_endpoint_auth_methods_supported?.includes("none")
	) {
		throw new Error(
			'The authorization server does not support Client ID Metadata Documents for public clients; remove oauth.clientRegistration "cimd"',
		);
	}
	const [shared, serverSpecific] = clientMetadataDocumentUrls(baseUrl, serverUrl);
	if (metadata.authorization_response_iss_parameter_supported) return { url: shared, redirectUrl };
	const redirect = new URL(redirectUrl);
	redirect.pathname = serverSpecificPath(redirect.pathname, serverUrl);
	return { url: serverSpecific, redirectUrl: redirect.href };
}

/** The shared and the server-specific document URL under the normalized `baseUrl`, keeping its path prefix. */
function clientMetadataDocumentUrls(baseUrl: string, serverUrl: string): [string, string] {
	return [new URL("client.json", baseUrl).href, new URL(`${callbackId(serverUrl)}/client.json`, baseUrl).href];
}

/**
 * Whether stored credentials belong to the client the current settings identify as: the same MCP server
 * URL, and tokens issued to a document under `baseUrl` (the validated base, see `clientMetadataBaseUrl`)
 * or, without one, to a registered or pre-registered client. draht: cached tokens are never sent or
 * refreshed after the registration mode or the metadata base changed; the user signs in again.
 */
export function matchesClient(
	state: McpOAuthState | undefined,
	serverUrl: string,
	baseUrl: string | undefined,
): boolean {
	if (!state || state.serverUrl !== new URL(serverUrl).href) return false;
	if (!baseUrl) return state.clientMetadataUrl === undefined;
	return (
		state.clientMetadataUrl !== undefined &&
		clientMetadataDocumentUrls(baseUrl, serverUrl).includes(state.clientMetadataUrl)
	);
}

/** The path of the redirect URI of a server-specific Client ID Metadata Document: `<path>/<callback ID>`. */
export function serverSpecificPath(path: string, serverUrl: string): string {
	return `${path.replace(/\/$/, "")}/${callbackId(serverUrl)}`;
}

/** 12 characters identifying an MCP server URL in callback paths, computed like Codex does. */
function callbackId(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.hash = "";
	return createHash("sha256").update(url.href).digest().subarray(0, 9).toString("base64url");
}

/** Redirect URIs a stored client was registered with. */
export function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

/**
 * Bounds each request to the authorization server, so an unresponsive one cannot hold the refresh lock,
 * delay shutdown, or keep a sign-in waiting for long.
 */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/** `fetch` with `OAUTH_REQUEST_TIMEOUT_MS` per request, on top of the request's own signal. */
export function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
	return (input, init) => {
		const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
		return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
	};
}

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";

/** Redirect URI when the settings name none and no client is stored. */
export const DEFAULT_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;

/** Where the loopback callback server listens and the redirect URI it serves, from `callbackUrl` and `callbackPort`. */
export interface LoopbackSettings {
	/** The redirect URI, without the port unless one is configured. */
	url: string;
	/** Address to listen on. */
	host: string;
	/** Host name in the redirect URI. */
	redirectHost: string;
	port: number | undefined;
	path: string;
	/** The exact redirect URI, when the port is fixed. */
	fixedRedirectUrl: string | undefined;
}

/** The loopback callback settings of `settings`. */
export function loopbackSettings(settings: McpOAuthSettings): LoopbackSettings {
	const configured = settings.callbackUrl ?? DEFAULT_REDIRECT_URL;
	const url = new URL(configured);
	const address = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port ? Number(url.port) : settings.callbackPort;
	let fixedRedirectUrl: string | undefined;
	// A configured URI with a port is sent exactly as written, since servers compare it as a string.
	if (url.port) fixedRedirectUrl = settings.callbackUrl;
	else if (port !== undefined) {
		url.port = String(port);
		fixedRedirectUrl = url.href;
	}
	return {
		url: configured,
		// `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
		host: address === "localhost" ? CALLBACK_HOST : address,
		redirectHost: address,
		port,
		path: url.pathname,
		fixedRedirectUrl,
	};
}
