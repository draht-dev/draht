/**
 * xAI (Grok) OAuth flow — SuperGrok / X Premium+ subscription login.
 *
 * Mirrors the flow the official Grok CLI uses: PKCE authorization code
 * against auth.x.ai's OIDC discovery document. Tokens are scoped for the
 * Grok CLI proxy (cli-chat-proxy.grok.com) rather than the pay-per-token
 * api.x.ai endpoint, so `toAuth`/`modifyModels` route requests there.
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback
 * server. It is only intended for CLI use, not browser environments.
 */

import type { Server } from "node:http";
import type { OAuthAuth } from "../../auth/types.ts";
import { getProviderEnvValue } from "../provider-env.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.ts";

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const OAUTH_ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${OAUTH_ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = "/callback";
const REFRESH_SKEW_MS = 2 * 60 * 1000;

/** OAuth-authenticated requests are proxied through the Grok CLI endpoint, not api.x.ai directly. */
export const XAI_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

type XaiDiscovery = { authorizationEndpoint: string; tokenEndpoint: string };
type XaiTokenPayload = { access_token?: string; refresh_token?: string; expires_in?: number };

async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("xAI OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

/** Reject discovery responses that don't point back at x.ai, in case DNS/discovery is ever compromised. */
function validateXaiEndpoint(url: string): string {
	const parsed = new URL(url);
	const host = parsed.hostname.toLowerCase();
	if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`xAI OAuth discovery returned an unexpected endpoint: ${url}`);
	}
	return url;
}

async function discoverXaiEndpoints(): Promise<XaiDiscovery> {
	const response = await fetch(DISCOVERY_URL, { headers: { Accept: "application/json" } });
	if (!response.ok) {
		throw new Error(`xAI OAuth discovery failed: ${response.status} ${await response.text()}`);
	}

	const data = (await response.json()) as { authorization_endpoint?: string; token_endpoint?: string };
	if (!data.authorization_endpoint || !data.token_endpoint) {
		throw new Error("xAI OAuth discovery response did not include authorization/token endpoints");
	}

	return {
		authorizationEndpoint: validateXaiEndpoint(data.authorization_endpoint),
		tokenEndpoint: validateXaiEndpoint(data.token_endpoint),
	};
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", `http://${CALLBACK_HOST}`);
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("xAI authentication did not complete.", `Error: ${error}`));
					return;
				}

				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("xAI authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

async function postForm(url: string, body: Record<string, string>): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();
	if (!response.ok) {
		throw new Error(`xAI token request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}
	return responseBody;
}

function credentialsFromTokenPayload(data: XaiTokenPayload, fallbackRefresh = ""): OAuthCredentials {
	if (!data.access_token) {
		throw new Error("xAI token response did not include an access token");
	}

	const refresh = data.refresh_token || fallbackRefresh;
	if (!refresh) {
		throw new Error("xAI token response did not include a refresh token");
	}

	return {
		access: data.access_token,
		refresh,
		expires: Date.now() + (data.expires_in ?? 3600) * 1000 - REFRESH_SKEW_MS,
	};
}

/**
 * Login with xAI OAuth (SuperGrok / X Premium+ subscription, authorization code + PKCE)
 */
export async function loginXai(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
}): Promise<OAuthCredentials> {
	const discovery = await discoverXaiEndpoints();
	const { verifier, challenge } = await generatePKCE();
	const server = await startCallbackServer(verifier);

	try {
		const authParams = new URLSearchParams({
			response_type: "code",
			client_id: CLIENT_ID,
			redirect_uri: server.redirectUri,
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});

		options.onAuth({
			url: `${discovery.authorizationEndpoint}?${authParams.toString()}`,
			instructions:
				"Sign in with your SuperGrok or X Premium+ account. If the browser is on another machine, paste the final redirect URL here.",
		});

		let code: string | undefined;

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			const result = await server.waitForCode();

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
			} else if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== verifier) {
					throw new Error("OAuth state mismatch");
				}
				code = parsed.code;
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseAuthorizationInput(manualInput);
					if (parsed.state && parsed.state !== verifier) {
						throw new Error("OAuth state mismatch");
					}
					code = parsed.code;
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) {
				code = result.code;
			}
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: server.redirectUri,
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== verifier) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		options.onProgress?.("Exchanging xAI authorization code...");
		const responseBody = await postForm(discovery.tokenEndpoint, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			redirect_uri: server.redirectUri,
			code_verifier: verifier,
		});
		return credentialsFromTokenPayload(JSON.parse(responseBody) as XaiTokenPayload);
	} finally {
		server.server.close();
	}
}

/**
 * Refresh xAI OAuth token
 */
export async function refreshXaiToken(refreshToken: string): Promise<OAuthCredentials> {
	const discovery = await discoverXaiEndpoints();
	const responseBody = await postForm(discovery.tokenEndpoint, {
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: refreshToken,
	});
	return credentialsFromTokenPayload(JSON.parse(responseBody) as XaiTokenPayload, refreshToken);
}

export const xaiOAuth: OAuthAuth = {
	name: "xAI (Grok)",

	async login(callbacks) {
		// The manual_code prompt races the local callback server; abort it once
		// the flow settles so the UI can dismiss the pending input.
		const manualAbort = new AbortController();
		try {
			const credentials = await loginXai({
				onAuth: (info) => callbacks.notify({ type: "auth_url", url: info.url, instructions: info.instructions }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				onPrompt: (prompt) =>
					callbacks.prompt({ type: "text", message: prompt.message, placeholder: prompt.placeholder }),
				onManualCodeInput: () =>
					callbacks.prompt({
						type: "manual_code",
						message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
						placeholder: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
						signal: manualAbort.signal,
					}),
			});
			return { ...credentials, type: "oauth" };
		} finally {
			manualAbort.abort();
		}
	},

	async refresh(credential) {
		return { ...(await refreshXaiToken(credential.refresh)), type: "oauth" };
	},

	async toAuth(credential) {
		return { apiKey: credential.access, baseUrl: XAI_OAUTH_BASE_URL };
	},
};

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI (Grok)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXai({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
