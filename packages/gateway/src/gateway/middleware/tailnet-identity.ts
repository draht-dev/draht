import type { MiddlewareHandler } from "hono";

/**
 * The tailnet identity check — deny-only, and structurally unable to grant
 * (R33-REACH.8, spec §6.6).
 *
 * When `tailscale serve` fronts the daemon it adds an identity header naming
 * the tailnet user whose node made the request. That is useful information and
 * it is not a credential, for a reason that has nothing to do with Tailscale:
 * the daemon listens on 127.0.0.1, and a request arriving on loopback carries
 * no evidence of whether it came through the proxy or from a process on this
 * machine that wrote the header itself. **Anything that can reach the listener
 * can forge this header.** A check that reads it and lets the request past has
 * not authenticated anybody; it has invented an authentication.
 *
 * So this middleware only ever subtracts:
 *
 *   fronting not declared    → pass through; the header is not a signal at all
 *   header absent or empty   → pass through to the credential check that was
 *                              going to run anyway (absence never grants)
 *   value is not the owner   → 403, before any route or credential is consulted
 *   value *is* the owner     → pass through. Nothing more. The bearer middleware
 *                              and `/attach`'s device gate still decide.
 *
 * "Pass through" means `next()` and nothing else — no context variable, no
 * marker, no header written onto the response. A downstream handler cannot
 * learn from this module that a request was vouched for, because there is
 * nothing here for it to learn. `tailnet-identity.test.ts` asserts that
 * structurally (an empty `c.var` on every passing path, one status literal in
 * the file and it is a refusal) rather than by reading this comment.
 *
 * It is registered ahead of the bearer middleware in `server.ts`, so a
 * non-owner value is refused before a route is matched and without revealing
 * which routes exist. Being first is what makes it a *narrowing* of the
 * existing posture instead of a second, weaker path into it.
 */

/**
 * The identity header name a fronted deployment reads, unless config names
 * another.
 *
 * **This is a placeholder, not an observed header name.** The real one has
 * never been captured on this machine, and a header name authored from memory
 * is fiction that would be trusted as a contract. It is pinned in
 * `src/__tests__/fixtures/tailnet-identity.captured.json`, which also ships as
 * a placeholder, and a test in `tailnet-identity.test.ts` fails for as long as
 * both are unreplaced. Replace them together:
 *
 *   node scripts/geist-tailscale-serve.mjs --capture-identity --peer NODE \
 *     --out packages/gateway/src/__tests__/fixtures/tailnet-identity.captured.json
 *
 * Until then the default names a header no proxy will ever send, so the check
 * simply never fires — which is safe (this module cannot grant) but is *not*
 * the feature, and the failing test is what stops it being mistaken for it.
 */
export const DEFAULT_TAILNET_IDENTITY_HEADER = "X-Uncaptured-Tailnet-Identity-Header-Placeholder";

/** The `tailnet` block of the gateway config (`GatewaySettings.tailnet`). */
export interface TailnetFrontingSettings {
	/**
	 * Whether this deployment declares itself fronted by `tailscale serve`.
	 *
	 * False (or absent) means the header is not consulted at all — not that it
	 * is trusted. An undeclared deployment has no proxy to have written one.
	 */
	fronted: boolean;
	/** The tailnet login the header must name. Any other value is refused. */
	owner: string;
	/** Header to read. Defaults to {@link DEFAULT_TAILNET_IDENTITY_HEADER}. */
	header?: string;
}

/** Case- and whitespace-insensitive identity comparison. */
function namesOwner(presented: string, owner: string): boolean {
	return presented.trim().toLowerCase() === owner.trim().toLowerCase();
}

/**
 * Build the deny-only tailnet identity middleware.
 *
 * @param tailnet - The `tailnet` config block, or undefined when there is none.
 */
export function tailnetIdentityMiddleware(tailnet: TailnetFrontingSettings | undefined): MiddlewareHandler {
	const headerName = tailnet?.header ?? DEFAULT_TAILNET_IDENTITY_HEADER;

	return async function tailnetIdentity(c, next) {
		if (!tailnet?.fronted) {
			await next();
			return;
		}

		const presented = c.req.header(headerName);
		// Absent, or present-and-empty: the same nothing. A deployment where the
		// proxy stopped injecting the header must fall back on the credential, not
		// lock its owner out and not let the next caller in.
		if (presented === undefined || presented.trim() === "") {
			await next();
			return;
		}

		if (!namesOwner(presented, tailnet.owner)) {
			// The presented value is not echoed: it is attacker-controlled, and a
			// refusal that reflects it is a way to get bytes into someone's log.
			return c.json({ error: "Forbidden: tailnet identity does not match the configured owner" }, 403);
		}

		// The owner's own name is worth exactly nothing on its own. Carry on to
		// the credential check; do not record having seen it.
		await next();
	};
}
