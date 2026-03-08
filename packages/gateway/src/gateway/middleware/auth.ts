import type { MiddlewareHandler } from "hono";

/**
 * Timing-safe byte-level string comparison.
 *
 * Compares two strings in constant time relative to the length of `expected`
 * to mitigate timing-based token oracle attacks. Always compares all bytes of
 * `expected` regardless of where a mismatch occurs.
 *
 * @param actual   - The token received from the client.
 * @param expected - The secret token the server expects.
 * @returns `true` only when both strings are identical.
 */
function timingSafeEqual(actual: string, expected: string): boolean {
	const enc = new TextEncoder();
	const a = enc.encode(actual);
	const b = enc.encode(expected);

	if (a.length !== b.length) {
		// Still iterate b to consume constant time relative to expected length,
		// then return false.
		let _dummy = 0;
		for (let i = 0; i < b.length; i++) {
			_dummy |= b[i]!;
		}
		return false;
	}

	let mismatch = 0;
	for (let i = 0; i < b.length; i++) {
		mismatch |= a[i]! ^ b[i]!;
	}
	return mismatch === 0;
}

/**
 * Bearer token authentication middleware.
 *
 * Validates the `Authorization: Bearer <token>` header on every request.
 * Returns a 401 JSON response for missing, malformed, or incorrect tokens.
 * Uses a timing-safe comparison to prevent token oracle attacks.
 * Use with `except` from `hono/combine` to exclude public endpoints like /health.
 *
 * @param expectedToken - The secret token that incoming requests must present.
 */
export function bearerAuthMiddleware(expectedToken: string): MiddlewareHandler {
	return async function bearerAuth(c, next) {
		const authHeader = c.req.header("Authorization");

		if (!authHeader) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const match = /^Bearer (.+)$/i.exec(authHeader);
		if (!match) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const token = match[1]!;
		if (!timingSafeEqual(token, expectedToken)) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		await next();
	};
}
