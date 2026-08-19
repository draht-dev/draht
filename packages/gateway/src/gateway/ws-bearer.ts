/**
 * Carrying a bearer token on a browser's WebSocket upgrade (R32-FLEET.10).
 *
 * `new WebSocket(url)` accepts no headers, which is the entire reason
 * `bearerAuthMiddleware` still has a `?token=` query fallback — and R33-REACH.3
 * deletes that fallback, because spec §6.4 forbids credentials in query strings.
 * The replacement a browser can actually produce is the subprotocol list, which
 * Chromium sends as the `Sec-WebSocket-Protocol` *request header*:
 *
 *     new WebSocket(url, ["geist.bearer.<base64url(token)>"])
 *
 * Two facts make this work through `hono/bun`, both measured rather than assumed:
 *
 *  - Bun echoes the requested subprotocol on the 101 response. RFC 6455 requires
 *    the client to fail the connection if the server selects none, and hono's Bun
 *    adapter passes no `headers` of its own to `server.upgrade()` — so without
 *    that echo this scheme would not exist.
 *  - **base64url is mandatory.** A subprotocol must be an RFC 7230 token, and
 *    `/` and `=` are not tchars. Chromium rejects a raw base64 credential in the
 *    constructor, before anything reaches the network:
 *      SyntaxError: Failed to construct 'WebSocket': The subprotocol
 *      'geist.bearer.aGVsbG8/d29ybGQ=' is invalid
 *    The base64url alphabet (`A-Za-z0-9-_`) is entirely tchars.
 *
 * The encoder is mirrored by four lines in `packages/geist-console/bundle/console.js`,
 * which cannot import TypeScript. `scripts/geist-console-bundle.e2e.test.mjs` drives
 * the real pair with a token containing `+`, `/` and `=`, so the two halves cannot
 * drift apart silently.
 */

/** Namespace prefix, so an unrelated subprotocol is never read as a credential. */
export const WS_BEARER_SUBPROTOCOL_PREFIX = "geist.bearer.";

/** `token` → the subprotocol value a browser is allowed to request. */
export function encodeWsBearerSubprotocol(token: string): string {
	const bytes = new TextEncoder().encode(token);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${WS_BEARER_SUBPROTOCOL_PREFIX}${base64url}`;
}

function base64urlDecode(value: string): string {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/**
 * Read the credential out of a `Sec-WebSocket-Protocol` header, if it carries one.
 *
 * The header is a comma-separated preference list, so the namespaced entry is
 * searched for rather than assumed to be alone. Anything that is not decodable
 * is reported as "no credential" — never as a partial one — so a malformed value
 * fails the same 401 as a missing one instead of being compared against the
 * secret in some half-decoded form.
 */
export function decodeWsBearerSubprotocol(header: string | undefined): string | undefined {
	if (!header) return undefined;
	for (const entry of header.split(",")) {
		const offered = entry.trim();
		if (!offered.startsWith(WS_BEARER_SUBPROTOCOL_PREFIX)) continue;
		const encoded = offered.slice(WS_BEARER_SUBPROTOCOL_PREFIX.length);
		if (encoded === "") return undefined;
		try {
			return base64urlDecode(encoded);
		} catch {
			return undefined;
		}
	}
	return undefined;
}
