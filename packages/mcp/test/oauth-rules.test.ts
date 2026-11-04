/**
 * draht's MCP OAuth rules (fork commit 59184c1f1), pinned at the @draht/mcp API so that taking upstream's
 * version of these modules unchanged fails here. Upstream identifies pi with its own Client ID Metadata
 * Documents on pi.dev and uses them automatically (`clientRegistration: "auto"`); draht has no hosted
 * documents, so:
 *
 * - R1: documents only under the operator's required, validated `clientMetadataBaseUrl`; no hardcoded
 *   host, no automatic mode; dynamic client registration is the default.
 * - R2: a base outside `cimd` is rejected, and so is a secret (or client id or name) for the public client.
 * - R3: the document identity is stored with the tokens; credentials are refused after the mode or base
 *   changed; the configured document is chosen before a stored registration.
 * - R4: public clients, RFC 9207 issuer check, PKCE and state, server-specific callback paths, exact
 *   redirect URIs.
 * - R5: the loopback callback checks the browser's Host and origin, and a pasted redirect URL its origin
 *   and path; a failed check does not consume the sign-in's state.
 * - R6: reading a cached token never calls `settings`, which may resolve secrets.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type McpServerConfigResult, validateMcpServerConfig } from "../src/index.ts";
import {
	adaptOAuthProvider,
	authorizeMcp,
	clientMetadataBaseUrl,
	completeMcpSignIn,
	createMcpAuthProvider,
	listenForLoopbackSignIn,
	type McpAuthorizationResponse,
	type McpClientMetadataDocuments,
	type McpLoopbackCallback,
	McpOAuthAuthorizationRequiredError,
	McpOAuthProvider,
	type McpOAuthServerStore,
	type McpOAuthSettings,
	type McpSignInOptions,
	type McpSignInRedirect,
	OAuthIssuerMismatchError,
	parseClientMetadataBaseUrl,
	responseFromRedirectUrl,
	startMcpSignIn,
	waitForLoopbackSignIn,
} from "../src/oauth/index.ts";
import {
	type AuthorizationServer,
	authorizeInBrowser,
	memoryStore,
	recordingStore,
	startAuthorizationServer,
} from "./authorization-server.ts";
import { closeServers } from "./helpers.ts";

const callbacks: McpLoopbackCallback[] = [];

afterEach(async () => {
	await Promise.all(callbacks.splice(0).map(({ callback }) => callback.close()));
	await closeServers();
});

const BASE = "https://client.example/team/oauth";
const NORMALIZED_BASE = `${BASE}/`;
const OTHER_BASE = "https://client.example/other/oauth/";
const LOOPBACK = "http://127.0.0.1:1/callback";
const CIMD: McpOAuthSettings = { clientRegistration: "cimd", clientMetadataBaseUrl: BASE };
/** The redirect URIs the operator's documents list; the application never says where they live. */
const LOOPBACK_DOCUMENTS: McpClientMetadataDocuments = {
	listsRedirectUrl: (redirectUrl) => {
		const url = new URL(redirectUrl);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/callback";
	},
};

function callbackId(serverUrl: string): string {
	return createHash("sha256").update(serverUrl).digest().subarray(0, 9).toString("base64url");
}

function options(server: AuthorizationServer, settings: McpOAuthSettings, extra: Partial<McpSignInOptions> = {}) {
	return {
		serverUrl: server.serverUrl,
		store: memoryStore(),
		settings,
		redirectUrl: LOOPBACK,
		clientName: "draht",
		clientMetadataDocuments: LOOPBACK_DOCUMENTS,
		...extra,
	} satisfies McpSignInOptions;
}

async function startRedirect(signIn: McpSignInOptions): Promise<McpSignInRedirect> {
	const started = await startMcpSignIn(signIn);
	if (started.kind !== "redirect") throw new Error("Expected the browser step");
	return started;
}

async function browse(authorization: McpSignInRedirect): Promise<McpAuthorizationResponse> {
	const query = new URL(await authorizeInBrowser(authorization.authorizationUrl)).searchParams;
	const iss = query.get("iss");
	return { code: query.get("code") ?? "", state: query.get("state") ?? "", ...(iss ? { iss } : {}) };
}

async function signIn(signIn: McpSignInOptions): Promise<McpSignInRedirect> {
	const authorization = await startRedirect(signIn);
	await completeMcpSignIn({ ...signIn, authorization, response: await browse(authorization) });
	return authorization;
}

/** Signed in afterwards: by refreshing the stored tokens, or through the browser step. */
async function signInOrRefresh(signIn: McpSignInOptions): Promise<void> {
	const started = await startMcpSignIn(signIn);
	if (started.kind === "redirect") {
		await completeMcpSignIn({ ...signIn, authorization: started, response: await browse(started) });
	}
}

function provider(
	server: AuthorizationServer,
	store: McpOAuthServerStore,
	base: string | undefined,
	settings: () => McpOAuthSettings,
) {
	return createMcpAuthProvider({
		serverUrl: server.serverUrl,
		store,
		clientName: "draht",
		clientMetadataDocuments: LOOPBACK_DOCUMENTS,
		clientMetadataBaseUrl: base,
		settings,
		onChallenge: () => {},
	});
}

function unauthorized(server: AuthorizationServer, token: string | undefined) {
	return { response: new Response(null, { status: 401 }), serverUrl: new URL(server.serverUrl), fetch, token };
}

function errorOf(result: McpServerConfigResult): string {
	return result.kind === "invalid" ? result.error : "";
}

const acceptCallback = { checkMetadataDocumentCallback: () => undefined };

function validate(oauth: Record<string, unknown>): McpServerConfigResult {
	return validateMcpServerConfig("s", { url: "https://mcp.example/mcp", oauth }, acceptCallback);
}

/** Nothing reached the authorization server's registration, authorization, or token endpoints. */
function expectUntouched(server: AuthorizationServer): void {
	expect(server.registrations).toEqual([]);
	expect(server.authorizations).toEqual([]);
	expect(server.tokenRequests).toEqual([]);
}

describe("R1: documents only from the operator's validated base, DCR by default", () => {
	it.each([
		"https://client.example/team/oauth",
		"https://client.example/team/oauth/",
		"https://client.example/team/oauth///",
	])("normalizes %s to one trailing slash and keeps the path prefix", (base) => {
		expect(parseClientMetadataBaseUrl(base)).toBe(NORMALIZED_BASE);
		expect(clientMetadataBaseUrl({ clientRegistration: "cimd", clientMetadataBaseUrl: base })).toBe(NORMALIZED_BASE);
		const result = validate({ clientRegistration: "cimd", clientMetadataBaseUrl: base });
		expect(result.kind === "http" && result.config.oauth?.clientMetadataBaseUrl).toBe(NORMALIZED_BASE);
	});

	it.each([
		undefined,
		"",
		42,
		"/oauth",
		"client.example/oauth",
		"http://client.example/oauth",
		"ftp://client.example/oauth",
		"https://user@client.example/oauth",
		"https://user:secret@client.example/oauth",
		"https://client.example/oauth?x=1",
		"https://client.example/oauth#x",
		"https://client.example/oauth?",
		"https://client.example/oauth#",
	])("rejects the base %s in the validator and at runtime", (base) => {
		expect(parseClientMetadataBaseUrl(base)).toBeUndefined();
		expect(errorOf(validate({ clientRegistration: "cimd", clientMetadataBaseUrl: base }))).toContain(
			'oauth.clientMetadataBaseUrl is required for "cimd"',
		);
		const settings = { clientRegistration: "cimd", clientMetadataBaseUrl: base } as McpOAuthSettings;
		expect(() => clientMetadataBaseUrl(settings)).toThrow('oauth.clientMetadataBaseUrl is required for "cimd"');
	});

	it("rejects an automatic mode in the validator and at runtime", async () => {
		expect(errorOf(validate({ clientRegistration: "auto" }))).toBe(
			'server "s": oauth.clientRegistration must be "dcr" or "cimd"',
		);
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const auto = { clientRegistration: "auto" } as unknown as McpOAuthSettings;
		await expect(startMcpSignIn(options(server, auto))).rejects.toThrow('must be "dcr" or "cimd"');
		await expect(
			listenForLoopbackSignIn({ serverUrl: server.serverUrl, store: memoryStore(), settings: auto }),
		).rejects.toThrow('must be "dcr" or "cimd"');
		expectUntouched(server);
	});

	it.each([true, false])(
		"registers dynamically by default although the server supports documents (iss=%s)",
		async (issParameter) => {
			const server = await startAuthorizationServer({ cimd: true, issParameter });
			// An application that still passes upstream's `baseUrl` with its documents gets no document from it.
			const upstreamShape = { baseUrl: "https://pi.dev/oauth", listsRedirectUrl: () => true };
			const authorization = await signIn(options(server, {}, { clientMetadataDocuments: upstreamShape }));
			expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe("client-1");
			expect(server.registrations).toHaveLength(1);
			expect(server.tokenRequests[0].get("client_id")).toBe("client-1");

			await expect(
				startMcpSignIn(options(server, { clientRegistration: "cimd" }, { clientMetadataDocuments: upstreamShape })),
			).rejects.toThrow('oauth.clientMetadataBaseUrl is required for "cimd"');
			expect(server.authorizations).toHaveLength(1);
		},
	);

	it.each([true, false])("uses only documents under the configured base (iss=%s)", async (issParameter) => {
		const server = await startAuthorizationServer({ cimd: true, issParameter });
		const signInOptions = options(server, CIMD);
		const authorization = await signIn(signInOptions);
		const document = issParameter
			? `${NORMALIZED_BASE}client.json`
			: `${NORMALIZED_BASE}${callbackId(server.serverUrl)}/client.json`;
		expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe(document);
		expect(server.tokenRequests.map((request) => request.get("client_id"))).toEqual([document]);
		expect(server.registrations).toEqual([]);
		expect((await signInOptions.store.load())?.clientMetadataUrl).toBe(document);
	});

	it("fails instead of registering when the server does not support documents", async () => {
		const server = await startAuthorizationServer({ issParameter: true });
		await expect(startMcpSignIn(options(server, CIMD))).rejects.toThrow(
			"does not support Client ID Metadata Documents for public clients",
		);
		expectUntouched(server);
	});

	it("fails with cimd when the application lists no redirect URIs for the documents", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		await expect(startMcpSignIn(options(server, CIMD, { clientMetadataDocuments: undefined }))).rejects.toThrow(
			"needs Client ID Metadata Documents that list the redirect URI",
		);
		expectUntouched(server);
	});

	it("names no document host in the OAuth sources", () => {
		const dir = join(import.meta.dirname, "../src/oauth");
		const sources = [
			...readdirSync(dir).map((file) => join(dir, file)),
			join(import.meta.dirname, "../src/config.ts"),
		];
		for (const source of sources) expect(readFileSync(source, "utf8")).not.toMatch(/https?:\/\/pi\.dev/);
	});
});

describe("R2: no base outside cimd, no secret for the public client", () => {
	it.each([undefined, "dcr"] as const)("rejects a base with clientRegistration %s", async (clientRegistration) => {
		const settings = { clientRegistration, clientMetadataBaseUrl: BASE };
		expect(errorOf(validate(settings))).toBe(
			'server "s": oauth.clientMetadataBaseUrl requires oauth.clientRegistration "cimd"',
		);
		expect(() => clientMetadataBaseUrl(settings)).toThrow('requires oauth.clientRegistration "cimd"');

		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const { store, lockRuns } = recordingStore();
		await expect(startMcpSignIn(options(server, settings, { store }))).rejects.toThrow(
			'requires oauth.clientRegistration "cimd"',
		);
		expect(lockRuns).toEqual([]);
		expectUntouched(server);
	});

	it.each([{ clientSecret: "secret" }, { clientId: "id" }, { clientName: "Other" }])(
		"rejects cimd combined with %o",
		async (extra) => {
			const settings = { ...CIMD, ...extra };
			expect(errorOf(validate(settings))).toBe(
				'server "s": oauth.clientRegistration "cimd" cannot be combined with oauth.clientId, oauth.clientName, or oauth.clientSecret',
			);
			expect(() => clientMetadataBaseUrl(settings)).toThrow("cannot be combined");

			const server = await startAuthorizationServer({ cimd: true, issParameter: true });
			const { store, lockRuns } = recordingStore();
			await expect(startMcpSignIn(options(server, settings, { store }))).rejects.toThrow("cannot be combined");
			await expect(listenForLoopbackSignIn({ serverUrl: server.serverUrl, store, settings })).rejects.toThrow(
				"cannot be combined",
			);
			expect(lockRuns).toEqual([]);
			expectUntouched(server);
		},
	);

	it("rejects an invalid base passed to createMcpAuthProvider", () => {
		const server = { serverUrl: "https://mcp.example/mcp" } as AuthorizationServer;
		expect(() => provider(server, memoryStore(), "http://client.example/oauth/", () => ({}))).toThrow(
			"oauth.clientMetadataBaseUrl must be an absolute HTTPS URL",
		);
	});
});

describe("R3: tokens are bound to the document identity", () => {
	it.each([true, false])(
		"refuses cached tokens and refreshes after the mode or base changed (iss=%s)",
		async (issParameter) => {
			const server = await startAuthorizationServer({ cimd: true, issParameter });
			const store = memoryStore();
			const other = { ...CIMD, clientMetadataBaseUrl: OTHER_BASE };
			for (const [before, after] of [
				[{}, CIMD],
				[CIMD, other],
				[other, {}],
			] as const) {
				await signInOrRefresh(options(server, before, { store }));
				const beforeBase = clientMetadataBaseUrl(before);
				const afterBase = clientMetadataBaseUrl(after);
				const oldToken = await provider(server, store, beforeBase, () => before).token();
				expect(oldToken).toBeDefined();

				const next = provider(server, store, afterBase, () => after);
				const tokenRequests = server.tokenRequests.length;
				expect(await next.token()).toBeUndefined();
				await expect(next.onUnauthorized?.(unauthorized(server, oldToken))).rejects.toBeInstanceOf(
					McpOAuthAuthorizationRequiredError,
				);
				// Signing in with the new settings does not refresh the former client's grant either, and drops it.
				const registrations = server.registrations.length;
				const authorization = await startRedirect(options(server, after, { store }));
				expect(server.tokenRequests).toHaveLength(tokenRequests);
				const state = await store.load();
				expect(state?.tokens).toBeUndefined();
				expect(state?.clientMetadataUrl).toBeUndefined();
				// A document is not stored as a client; dynamic registration registers anew instead of reusing one.
				if (afterBase) expect(state?.clientInformation).toBeUndefined();
				else expect(server.registrations).toHaveLength(registrations + 1);
				await completeMcpSignIn({
					...options(server, after, { store }),
					authorization,
					response: await browse(authorization),
				});
				expect(await next.token()).toBeDefined();
			}
		},
	);

	it("binds McpOAuthProvider's tokens to the document that issued them", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const store = memoryStore();
		await signIn(options(server, CIMD, { store }));
		expect((await store.load())?.clientMetadataUrl).toBe(`${NORMALIZED_BASE}client.json`);
		const oauthProvider = (document: string | undefined) => {
			const created = new McpOAuthProvider({
				serverUrl: server.serverUrl,
				redirectUrl: LOOPBACK,
				clientMetadata: { client_name: "draht" },
				store,
				onRedirect: () => {},
				clientMetadataDocument: document ? () => ({ url: document, redirectUrl: LOOPBACK }) : undefined,
			});
			created.clientMetadataDocument?.(undefined);
			return created;
		};
		expect((await oauthProvider(`${NORMALIZED_BASE}client.json`).tokens())?.access_token).toBe("access-1");
		for (const document of [undefined, `${OTHER_BASE}client.json`, `${NORMALIZED_BASE}other/client.json`]) {
			expect(await oauthProvider(document).tokens()).toBeUndefined();
			expect(await adaptOAuthProvider(oauthProvider(document)).token()).toBeUndefined();
		}
	});

	it("refuses a refresh whose settings name another base than the provider", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const store = memoryStore();
		await signIn(options(server, CIMD, { store }));
		const mismatched = provider(server, store, BASE, () => ({ ...CIMD, clientMetadataBaseUrl: OTHER_BASE }));
		expect(await mismatched.token()).toBe("access-1");
		await expect(mismatched.onUnauthorized?.(unauthorized(server, "access-1"))).rejects.toBeInstanceOf(
			McpOAuthAuthorizationRequiredError,
		);
		expect(server.tokenRequests).toHaveLength(1);
	});

	it("selects the configured document before a stored registration", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const store = memoryStore();
		await signIn(options(server, {}, { store }));
		expect((await store.load())?.clientInformation?.client_id).toBe("client-1");

		// At the flow level: a provider offering both picks the document. Its tokens are none here, since
		// keeping a registered grant from the document is McpOAuthProvider's part (pinned through sign-in below).
		let redirect: URL | undefined;
		const state = await store.load();
		const both = {
			redirectUrl: LOOPBACK,
			clientMetadata: { redirect_uris: [LOOPBACK], token_endpoint_auth_method: "none" },
			clientMetadataDocument: () => ({ url: `${NORMALIZED_BASE}client.json`, redirectUrl: LOOPBACK }),
			clientInformation: () => state?.clientInformation,
			tokens: () => undefined,
			saveTokens: () => {},
			redirectToAuthorization: (url: URL) => {
				redirect = url;
			},
			saveCodeVerifier: () => {},
			codeVerifier: () => "verifier",
			state: () => "state",
		};
		expect(await authorizeMcp(both, { serverUrl: server.serverUrl })).toBe("REDIRECT");
		expect(redirect?.searchParams.get("client_id")).toBe(`${NORMALIZED_BASE}client.json`);
		expect(server.tokenRequests).toHaveLength(1);

		// Through sign-in: switching to cimd uses the document, drops the registration, and registers nothing.
		const authorization = await startRedirect(options(server, CIMD, { store }));
		expect(new URL(authorization.authorizationUrl).searchParams.get("client_id")).toBe(
			`${NORMALIZED_BASE}client.json`,
		);
		expect((await store.load())?.clientInformation).toBeUndefined();
		expect(server.registrations).toHaveLength(1);
		expect(server.tokenRequests).toHaveLength(1);
	});
});

describe("R4: public client, issuer, PKCE and state, exact redirect URIs", () => {
	it("signs in as a public client with PKCE and a fresh state", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const signInOptions = options(server, CIMD);
		const first = await startRedirect(signInOptions);
		const second = await startRedirect(signInOptions);
		expect(second.state).not.toBe(first.state);
		const query = new URL(second.authorizationUrl).searchParams;
		expect(query.get("state")).toBe(second.state);
		expect(query.get("code_challenge_method")).toBe("S256");
		expect(query.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

		await completeMcpSignIn({ ...signInOptions, authorization: second, response: await browse(second) });
		const [exchange] = server.tokenRequests;
		expect(exchange.get("client_id")).toBe(`${NORMALIZED_BASE}client.json`);
		expect(exchange.get("client_secret")).toBeNull();
		// The authorization server checked the verifier against the challenge before issuing the tokens.
		expect(exchange.get("code_verifier")).toBeTruthy();
		expect((await signInOptions.store.load())?.tokens?.access_token).toBe("access-1");
	});

	it("refuses a response with another state and a superseded sign-in", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const signInOptions = options(server, CIMD);
		const first = await startRedirect(signInOptions);
		const firstResponse = await browse(first);
		await expect(
			completeMcpSignIn({ ...signInOptions, authorization: first, response: { ...firstResponse, state: "other" } }),
		).rejects.toThrow("belongs to a different sign-in");
		await startRedirect(signInOptions);
		await expect(
			completeMcpSignIn({ ...signInOptions, authorization: first, response: firstResponse }),
		).rejects.toThrow("Another sign-in to this MCP server started since");
		expect(server.tokenRequests).toEqual([]);
	});

	it("checks the iss parameter of the authorization response (RFC 9207)", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const signInOptions = options(server, CIMD);
		let authorization = await startRedirect(signInOptions);
		let response = await browse(authorization);
		await expect(
			completeMcpSignIn({
				...signInOptions,
				authorization,
				response: { ...response, iss: "https://attacker.example" },
			}),
		).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
		authorization = await startRedirect(signInOptions);
		response = await browse(authorization);
		const { iss: _omitted, ...withoutIss } = response;
		await expect(completeMcpSignIn({ ...signInOptions, authorization, response: withoutIss })).rejects.toBeInstanceOf(
			OAuthIssuerMismatchError,
		);
		expect(server.tokenRequests).toEqual([]);
	});

	it("uses a server-specific redirect URI without the iss parameter and exchanges only on it", async () => {
		const server = await startAuthorizationServer({ cimd: true });
		const signInOptions = options(server, CIMD);
		const authorization = await startRedirect(signInOptions);
		const id = callbackId(server.serverUrl);
		expect(authorization.redirectUrl).toBe(`${LOOPBACK}/${id}`);
		const response = await browse(authorization);
		// Completing with another redirect URI than the authorization request used fails before the exchange.
		await expect(
			completeMcpSignIn({ ...signInOptions, redirectUrl: "http://127.0.0.1:2/callback", authorization, response }),
		).rejects.toThrow(`but the authorization request used ${authorization.redirectUrl}`);
		expect(server.tokenRequests).toEqual([]);
		await completeMcpSignIn({ ...signInOptions, authorization, response });
		expect(server.tokenRequests[0].get("redirect_uri")).toBe(`${LOOPBACK}/${id}`);
	});

	it("serves the server-specific callback path only with cimd, and accepts the response only there", async () => {
		const serverUrl = "https://mcp.example/mcp";
		const id = callbackId(serverUrl);
		const plain = await listenForLoopbackSignIn({ serverUrl, store: memoryStore(), settings: {} });
		callbacks.push(plain);
		expect((await fetch(`${plain.redirectUrl}/${id}?code=c&state=s`)).status).toBe(404);

		const cimd = await listenForLoopbackSignIn({ serverUrl, store: memoryStore(), settings: CIMD });
		callbacks.push(cimd);
		const pending = { kind: "redirect", authorizationUrl: "https://auth.example/a", state: "s1" } as const;
		const mixedUp = waitForLoopbackSignIn({
			callback: cimd.callback,
			authorization: { ...pending, redirectUrl: `${cimd.redirectUrl}/${id}` },
		});
		mixedUp.catch(() => undefined);
		// A mixed-up authorization server redirects to the shared path.
		expect((await fetch(`${cimd.redirectUrl}?code=c&state=s1`)).status).toBe(400);
		await expect(mixedUp).rejects.toThrow("arrived on another redirect URI");

		const right = waitForLoopbackSignIn({
			callback: cimd.callback,
			authorization: { ...pending, state: "s2", redirectUrl: `${cimd.redirectUrl}/${id}` },
		});
		expect((await fetch(`${cimd.redirectUrl}/${id}?code=c&state=s2`)).status).toBe(200);
		expect(await right).toEqual({ code: "c", state: "s2" });
	});
});

/** A GET to the loopback callback server with a raw request target and Host header, which fetch would rewrite. */
function rawGet(
	callbackUrl: string,
	target: string,
	host: string,
): Promise<{ status: number | undefined; body: string }> {
	const url = new URL(callbackUrl);
	return new Promise((resolve, reject) => {
		get({ host: url.hostname, port: url.port, path: target, headers: { Host: host } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode, body }));
			response.on("error", reject);
		}).on("error", reject);
	});
}

describe("R5: the browser callback and pasted URLs come from the sign-in's redirect URI", () => {
	it("rejects another Host or origin without consuming the state", async () => {
		const serverUrl = "https://mcp.example/mcp";
		const loopback = await listenForLoopbackSignIn({ serverUrl, store: memoryStore(), settings: {} });
		callbacks.push(loopback);
		const { redirectUrl, callback } = loopback;
		const response = waitForLoopbackSignIn({
			callback,
			authorization: { kind: "redirect", authorizationUrl: "https://auth.example/a", redirectUrl, state: "s1" },
		});
		const query = "/callback?code=c&state=s1";
		const host = new URL(redirectUrl).host;

		expect(await rawGet(redirectUrl, query, "attacker.example")).toEqual({
			status: 400,
			body: "Unexpected redirect origin",
		});
		expect(await rawGet(redirectUrl, query, `localhost:${new URL(redirectUrl).port}`)).toMatchObject({ status: 400 });
		// An absolute request target names the origin itself.
		expect(await rawGet(redirectUrl, `http://attacker.example${query}`, host)).toMatchObject({ status: 400 });
		// The sign-in is still waiting: the genuine redirect completes it.
		expect(await rawGet(redirectUrl, query, host)).toMatchObject({ status: 200 });
		expect(await response).toEqual({ code: "c", state: "s1" });
	});

	it("rejects a pasted URL on another origin or path, and the sign-in stays completable", async () => {
		const server = await startAuthorizationServer({ cimd: true });
		const signInOptions = options(server, CIMD);
		const authorization = await startRedirect(signInOptions);
		const location = new URL(await authorizeInBrowser(authorization.authorizationUrl));
		const stored = await signInOptions.store.load();
		const variants = [
			(url: URL) => {
				url.hostname = "localhost";
			},
			(url: URL) => {
				url.port = "2";
			},
			(url: URL) => {
				url.protocol = "https:";
			},
			(url: URL) => {
				url.pathname = "/callback";
			},
		];
		for (const change of variants) {
			const pasted = new URL(location);
			change(pasted);
			expect(() => responseFromRedirectUrl(pasted.href, authorization)).toThrow(
				"does not match this sign-in's redirect URI",
			);
		}
		expect(await signInOptions.store.load()).toEqual(stored);
		await completeMcpSignIn({
			...signInOptions,
			authorization,
			response: responseFromRedirectUrl(location.href, authorization),
		});
		expect((await signInOptions.store.load())?.tokens?.access_token).toBe("access-1");
	});
});

describe("R6: reading a cached token never calls settings", () => {
	it.each([undefined, BASE])("reads the token without settings (base %s)", async (base) => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const store = memoryStore();
		await signIn(options(server, base ? CIMD : {}, { store }));
		let calls = 0;
		const settings = () => {
			calls++;
			throw new Error("oauth.clientSecret could not be resolved");
		};
		expect(await provider(server, store, base, settings).token()).toBe("access-1");
		// Tokens of another client are refused without settings, too.
		expect(await provider(server, store, base ? undefined : BASE, settings).token()).toBeUndefined();
		// A 401 for a token another request already replaced is retried without a refresh.
		const state = await store.load();
		if (!state?.tokens) throw new Error("Expected stored tokens");
		await provider(server, store, base, settings).onUnauthorized?.(unauthorized(server, "access-0"));
		expect(calls).toBe(0);
		// Only an actual refresh resolves the settings.
		await expect(
			provider(server, store, base, settings).onUnauthorized?.(unauthorized(server, "access-1")),
		).rejects.toThrow("oauth.clientSecret could not be resolved");
		expect(calls).toBe(1);
	});
});
