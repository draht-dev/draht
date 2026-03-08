import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Hono error handler — registered via `app.onError(errorHandler)`.
 *
 * - {@link HTTPException} instances: status code and message are preserved.
 * - All other errors: status 500, generic "Internal server error" message.
 *
 * Stack traces are **never** included in the response body.
 */
export const errorHandler: ErrorHandler = (err, c) => {
	if (err instanceof HTTPException) {
		return c.json({ error: err.message }, err.status);
	}
	return c.json({ error: "Internal server error" }, 500);
};

/**
 * Hono not-found handler — registered via `app.notFound(notFoundHandler)`.
 *
 * Returns a JSON `{ error: 'Not found' }` with HTTP 404 for any request that
 * does not match a registered route.
 */
export const notFoundHandler: NotFoundHandler = (c) => {
	return c.json({ error: "Not found" }, 404);
};
