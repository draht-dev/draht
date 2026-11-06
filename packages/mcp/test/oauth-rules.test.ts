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
 * - R5: the loopback callback checks the browser's Host, origin, and path before it looks at the state, so
 *   a failed check consumes nothing; a valid state on another of its paths does end the sign-in (mix-up
 *   detection, R4). A pasted redirect URL must match origin and path; a mismatch ends the draht loopback
 *   sign-in without consuming its state or verifier.
 * - R6: reading a cached token never calls `settings`, which may resolve secrets.
 * - R7: both halves of a sign-in use one client and authorization server, and complete once: the code and
 *   the verifier never go to another client, authorization server, or token endpoint.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** The `.ts` files at `path`: the file itself, or those in the directory and its subdirectories. */
function typeScriptFiles(path: string): string[] {
	if (!statSync(path).isDirectory()) return [path];
	return readdirSync(path, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".ts"))
		.map((file) => join(path, file))
		.sort();
}

/** Characters after which a `/` starts a regular expression rather than a division. */
const BEFORE_REGEX = "(,=:[!&|?{};";

/**
 * `source` without its comments. Strings, template literals, and regular expression literals are kept
 * whole, so a `//` inside them is not taken for a comment. Good enough for this repository's sources;
 * nested template literals inside `${}` are not tracked.
 */
function withoutComments(source: string): string {
	let out = "";
	let previous = "";
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			out += " ";
			continue;
		}
		const regex = char === "/" && (previous === "" || BEFORE_REGEX.includes(previous));
		if (char === '"' || char === "'" || char === "`" || regex) {
			let j = i + 1;
			let inClass = false;
			while (j < source.length) {
				const inner = source[j];
				if (inner === "\\") {
					j += 2;
					continue;
				}
				if (regex) {
					if (inner === "\n") break;
					if (inner === "[") inClass = true;
					else if (inner === "]") inClass = false;
					else if (inner === "/" && !inClass) break;
				} else if (inner === char) break;
				j++;
			}
			out += source.slice(i, j + 1);
			i = j + 1;
			previous = char;
			continue;
		}
		out += char;
		if (!/\s/.test(char)) previous = char;
		i++;
	}
	return out;
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

	it("strips comments but keeps strings, templates, and regular expressions when scanning sources", () => {
		const code = [
			'const a = "https://pi.dev/oauth"; // pi.dev',
			"/* pi.dev */ const b = `https://pi.dev/path`;",
			"const c = /https?:\\/\\/[/*]/; const d = 'pi.dev'; // https://x",
		].join("\n");
		const stripped = withoutComments(`/**\n * https://pi.dev in a doc comment\n */\n${code}\n// pi.dev`);
		expect(stripped.match(/\bpi\.dev\b/g)).toHaveLength(3);
		expect(stripped).toContain('"https://pi.dev/oauth"');
		expect(stripped).toContain("`https://pi.dev/path`");
		expect(stripped).toContain("/https?:\\/\\/[/*]/;");
		expect(stripped).toContain("'pi.dev'");
		expect(stripped).not.toContain("https://x");
		expect(withoutComments("// https://pi.dev\n/* pi.dev */")).not.toMatch(/pi\.dev/);
	});

	it("names no document host in the MCP sources outside comments", () => {
		const root = join(import.meta.dirname, "../..");
		const sources = ["mcp/src", "coding-agent/src/extensions/mcp", "coding-agent/src/core/mcp-servers.ts"].flatMap(
			(path) => typeScriptFiles(join(root, path)),
		);
		expect(sources).toContain(join(root, "mcp/src/oauth/client-settings.ts"));
		expect(sources).toContain(join(root, "coding-agent/src/extensions/mcp/oauth.ts"));
		expect(sources).toContain(join(root, "coding-agent/src/core/mcp-servers.ts"));
		for (const source of sources) {
			expect({ source, code: withoutComments(readFileSync(source, "utf8")) }).not.toMatchObject({
				code: expect.stringMatching(/\bpi\.dev\b/),
			});
		}
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

	/**
	 * draht's loopback sign-in (coding-agent's `signInMcpServer`): listen, start, wait for the browser or a
	 * pasted redirect URL, complete, and close the callback server whatever happened.
	 */
	async function loopbackSignIn(server: AuthorizationServer, paste: (location: URL) => string | undefined) {
		const store = memoryStore();
		const loopback = await listenForLoopbackSignIn({ serverUrl: server.serverUrl, store, settings: CIMD });
		const signInOptions = options(server, CIMD, { store, redirectUrl: loopback.redirectUrl });
		const authorization = await startRedirect(signInOptions);
		const location = new URL(await authorizeInBrowser(authorization.authorizationUrl));
		const pending = await store.load();
		const outcome = (async () => {
			try {
				const response = await waitForLoopbackSignIn({
					callback: loopback.callback,
					authorization,
					promptForRedirectUrl: async (signal) => {
						const pasted = paste(location);
						if (pasted !== undefined) return pasted;
						// No paste: the prompt stays open until the browser's redirect arrives.
						return new Promise<string>((resolve) => signal.addEventListener("abort", () => resolve("")));
					},
				});
				await completeMcpSignIn({ ...signInOptions, authorization, response });
			} finally {
				await loopback.callback.close();
			}
		})();
		return { store, signInOptions, authorization, location, pending, outcome };
	}

	it.each([
		["another host", { hostname: "localhost" }],
		["another port", { port: "2" }],
		["another scheme", { protocol: "https:" }],
		["the shared path instead of the server-specific one", { pathname: "/callback" }],
	] as const)("ends the loopback sign-in on a pasted URL with %s, consuming nothing", async (_, change) => {
		const server = await startAuthorizationServer({ cimd: true });
		const signIn = await loopbackSignIn(server, (location) => {
			const pasted = Object.assign(new URL(location), change);
			return pasted.href;
		});
		await expect(signIn.outcome).rejects.toThrow("does not match this sign-in's redirect URI");
		expect(server.tokenRequests).toEqual([]);
		// By design the sign-in is over: the browser's genuine redirect finds no callback server anymore.
		await expect(fetch(signIn.location)).rejects.toThrow();
		// The bad paste consumed neither the state nor the verifier: the genuine response still completes.
		const state = await signIn.store.load();
		expect(state?.oauthState).toBe(signIn.authorization.state);
		expect(state?.codeVerifier).toBe(signIn.pending?.codeVerifier);
		await completeMcpSignIn({
			...signIn.signInOptions,
			authorization: signIn.authorization,
			response: responseFromRedirectUrl(signIn.location.href, signIn.authorization),
		});
		expect((await signIn.store.load())?.tokens?.access_token).toBe("access-1");
	});

	it("completes the loopback sign-in with the genuine pasted URL or the browser's redirect", async () => {
		const server = await startAuthorizationServer({ cimd: true });
		const pasted = await loopbackSignIn(server, (location) => location.href);
		await pasted.outcome;
		expect((await pasted.store.load())?.tokens?.access_token).toBe("access-1");

		const browser = await loopbackSignIn(server, () => undefined);
		expect((await fetch(browser.location)).status).toBe(200);
		await browser.outcome;
		expect((await browser.store.load())?.tokens?.access_token).toBe("access-2");
		expect(server.tokenRequests.map((request) => request.get("redirect_uri"))).toEqual([
			pasted.authorization.redirectUrl,
			browser.authorization.redirectUrl,
		]);
	});
});

describe("R7: both halves of a sign-in use one client and authorization server, once", () => {
	it.each([
		["cimd", CIMD],
		["a pre-registered client", { clientId: "client-other" }],
	] as const)("refuses to complete a registered client's sign-in as %s", async (_, completeWith) => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const store = memoryStore();
		const authorization = await startRedirect(options(server, {}, { store }));
		const response = await browse(authorization);
		await expect(
			completeMcpSignIn({ ...options(server, completeWith, { store }), authorization, response }),
		).rejects.toThrow("but the authorization request used client-1; sign in again");
		expect(server.tokenRequests).toEqual([]);
		// With the settings it started with, the sign-in still completes.
		await completeMcpSignIn({ ...options(server, {}, { store }), authorization, response });
		expect(server.tokenRequests.map((request) => request.get("client_id"))).toEqual(["client-1"]);
	});

	it("refuses to complete at another authorization server or token endpoint", async () => {
		const server = await startAuthorizationServer();
		const other = await startAuthorizationServer();
		const otherOrigin = new URL(other.serverUrl).origin;
		const store = memoryStore();
		const authorization = await startRedirect(options(server, {}, { store }));
		const response = await browse(authorization);

		const elsewhere = { authServerMetadataUrl: new URL(`${otherOrigin}/.well-known/oauth-authorization-server`) };
		await expect(
			completeMcpSignIn({ ...options(server, elsewhere, { store }), authorization, response }),
		).rejects.toThrow(`would use the authorization server ${otherOrigin}, but`);

		const state = await store.load();
		const discovery = state?.discovery;
		const metadata = discovery?.authorizationServerMetadata;
		if (!state || !discovery || !metadata) throw new Error("Expected cached discovery");
		await store.save({
			...state,
			discovery: {
				...discovery,
				authorizationServerMetadata: { ...metadata, token_endpoint: `${otherOrigin}/token` },
			},
		});
		await expect(completeMcpSignIn({ ...options(server, {}, { store }), authorization, response })).rejects.toThrow(
			`would use the token endpoint ${otherOrigin}/token, but`,
		);
		expect(server.tokenRequests).toEqual([]);
		expect(other.tokenRequests).toEqual([]);
	});

	it("refuses to complete at the authorization server a refresh rediscovered after invalid_client", async () => {
		// Without the iss parameter, only the binding tells the two authorization servers apart.
		const server = await startAuthorizationServer({ cimd: true });
		const other = await startAuthorizationServer({ cimd: true });
		const otherOrigin = new URL(other.serverUrl).origin;
		const store = memoryStore();
		await signIn(options(server, CIMD, { store }));
		// A step-up sign-in waits for the browser and keeps the tokens meanwhile.
		const stepUp = options(server, CIMD, { store, challenge: { error: "insufficient_scope", scope: "more" } });
		const authorization = await startRedirect(stepUp);
		const response = await browse(authorization);
		const pending = await store.load();

		// The refresh fails with invalid_client, and the resource now names another authorization server.
		server.failNextRefresh("invalid_client");
		server.useAuthorizationServer(otherOrigin);
		await expect(
			provider(server, store, BASE, () => CIMD).onUnauthorized?.(unauthorized(server, "access-1")),
		).rejects.toBeInstanceOf(McpOAuthAuthorizationRequiredError);
		const state = await store.load();
		expect(state?.discovery?.authorizationServerUrl).toBe(otherOrigin);
		expect(state?.oauthState).toBe(pending?.oauthState);
		expect(state?.codeVerifier).toBe(pending?.codeVerifier);
		expect(state?.authorizationRequest).toEqual(pending?.authorizationRequest);

		await expect(completeMcpSignIn({ ...stepUp, authorization, response })).rejects.toThrow(
			`would use the authorization server ${otherOrigin}, but`,
		);
		expect(other.tokenRequests).toEqual([]);
		expect(server.tokenRequests.map((request) => request.get("grant_type"))).toEqual([
			"authorization_code",
			"refresh_token",
		]);
	});

	it("fails closed when the authorization request is not stored", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const signInOptions = options(server, CIMD);
		const authorization = await startRedirect(signInOptions);
		const response = await browse(authorization);
		const stored = await signInOptions.store.load();
		if (!stored) throw new Error("Expected a pending sign-in");
		const { authorizationRequest: _dropped, ...withoutRequest } = stored;
		await signInOptions.store.save(withoutRequest);
		await expect(completeMcpSignIn({ ...signInOptions, authorization, response })).rejects.toThrow(
			"The authorization request of this sign-in is not stored",
		);
		expect(server.tokenRequests).toEqual([]);
	});

	it("refuses to complete a completed sign-in again, keeping its tokens", async () => {
		const server = await startAuthorizationServer({ cimd: true, issParameter: true });
		const signInOptions = options(server, CIMD);
		const authorization = await startRedirect(signInOptions);
		const response = await browse(authorization);
		await completeMcpSignIn({ ...signInOptions, authorization, response });
		const state = await signInOptions.store.load();
		expect(state?.oauthState).toBeUndefined();
		expect(state?.codeVerifier).toBeUndefined();
		expect(state?.authorizationRequest).toBeUndefined();

		await expect(completeMcpSignIn({ ...signInOptions, authorization, response })).rejects.toThrow(
			"No sign-in to this MCP server is pending",
		);
		expect(server.tokenRequests).toHaveLength(1);
		expect((await signInOptions.store.load())?.tokens?.access_token).toBe("access-1");
	});

	it("refuses to exchange a code again through McpOAuthProvider", async () => {
		const server = await startAuthorizationServer();
		const store = memoryStore();
		const authorization = await startRedirect(options(server, {}, { store }));
		const response = await browse(authorization);
		const oauthProvider = new McpOAuthProvider({
			serverUrl: server.serverUrl,
			redirectUrl: LOOPBACK,
			clientMetadata: { client_name: "draht" },
			store,
			onRedirect: () => {},
		});
		const exchange = { serverUrl: server.serverUrl, authorizationCode: response.code };
		expect(await authorizeMcp(oauthProvider, exchange)).toBe("AUTHORIZED");
		await expect(authorizeMcp(oauthProvider, exchange)).rejects.toThrow("No OAuth PKCE code verifier is stored");
		expect(server.tokenRequests).toHaveLength(1);
		expect((await store.load())?.tokens?.access_token).toBe("access-1");
	});

	it("saves the scope the flow requested, not one the authorization endpoint carries", async () => {
		const server = await startAuthorizationServer({ authorizationEndpointQuery: "?scope=admin" });
		const unscoped = options(server, {});
		const authorization = await startRedirect(unscoped);
		expect(new URL(authorization.authorizationUrl).searchParams.get("scope")).toBe("admin");
		expect(authorization.scope).toBeUndefined();
		await completeMcpSignIn({ ...unscoped, authorization, response: await browse(authorization) });
		expect((await unscoped.store.load())?.tokens).toMatchObject({ access_token: "access-1" });
		expect((await unscoped.store.load())?.tokens?.scope).toBeUndefined();

		// A requested scope replaces the endpoint's and is saved.
		const scoped = options(server, { scope: "issues:read" });
		const requested = await startRedirect(scoped);
		expect(new URL(requested.authorizationUrl).searchParams.get("scope")).toBe("issues:read");
		expect(requested.scope).toBe("issues:read");
		await completeMcpSignIn({ ...scoped, authorization: requested, response: await browse(requested) });
		expect((await scoped.store.load())?.tokens?.scope).toBe("issues:read");
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
