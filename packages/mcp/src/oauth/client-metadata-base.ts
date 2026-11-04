/**
 * draht: the operator's Client ID Metadata Document base URL (`oauth.clientMetadataBaseUrl`).
 *
 * Upstream lets the application name where its documents live (pi's are on pi.dev) and uses them
 * automatically whenever an authorization server supports them (`clientRegistration: "auto"`). draht has
 * no hosted documents and must never identify with a document its operator did not configure, so the
 * base comes only from configuration, `cimd` is opt-in, and dynamic client registration is the default.
 * The base is validated by the configuration boundary and again wherever sign-in or refresh uses it.
 */

/**
 * The normalized base: an absolute https URL without userinfo, query, or fragment, whose path ends in
 * exactly one `/`, so `client.json` and `<id>/client.json` resolve below the configured path prefix.
 * `undefined` when `value` is not such a URL.
 */
export function parseClientMetadataBaseUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !URL.canParse(value)) return undefined;
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password) return undefined;
	// `search` and `hash` are empty for a bare `?` or `#`, which `href` keeps.
	if (url.href.includes("?") || url.href.includes("#")) return undefined;
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
	return url.href;
}
